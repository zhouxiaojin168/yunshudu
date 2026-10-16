'use strict';
/**
 * h3-power.js —— 自建 4090D 的「没人用就关机 / 有人用就开机」（R1187 王炸）
 *
 * 为什么放在服务器（114.66.16.225）而不是实例里：
 *   实例关机后自身的 cron 也停了，**开机这件事只能由外部来做**；服务器是 7x24 的天然落点。
 *
 * 两个方向：
 *   ① 空闲关机：轮询本机 relay(9123) 的 /healthz —— idle_s（距上次真实请求的秒数）
 *      + 上游 /healthz 的 queue / comfy_queue —— 全都闲够 idle_minutes 分钟 -> power_off
 *   ② 调用开机：上游不可达(ready=false / upstream_health!=200) 而 relay 最近有请求 ->
 *      power_on（带 cooldown 节流）。另外 relay 侧也能自己唤醒：H3R_WAKE_CMD 指向本脚本 on。
 *
 * 安全默认：config/autodl.json 的 enabled=false / dry_run=true —— 只记日志，绝不真开关机。
 *
 * 用法（服务器上）：
 *   node C:\yunshudu\app\scripts\power\h3-power.js status            # 查实例状态（要 token）
 *   node C:\yunshudu\app\scripts\power\h3-power.js list              # 原始列表（摸字段用）
 *   node C:\yunshudu\app\scripts\power\h3-power.js on | off          # 手动开关机
 *   node C:\yunshudu\app\scripts\power\h3-power.js watchdog [--once] # 常驻看门狗 / 单轮
 *   node C:\yunshudu\app\scripts\power\h3-power.js selftest          # 离线自测（不联网、不开关机）
 */
const fs = require('fs');
const path = require('path');
const api = require('./autodl-api.js');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const once = argv.includes('--once');

let ACT = { last_at: 0, last_kind: '', last_ok: null, idle_since: 0 };
let procStart = Date.now();

function nowSec() { return Math.round(Date.now() / 1000); }

function saveState(cfg) {
  try {
    fs.mkdirSync(path.dirname(cfg.state_file), { recursive: true });
    fs.writeFileSync(cfg.state_file, JSON.stringify(Object.assign({
      updated_at: new Date().toISOString(),
      instance_uuid: cfg.instance_uuid,
      enabled: cfg.enabled, dry_run: cfg.dry_run,
    }, ACT), null, 2), 'utf8');
  } catch (e) {}
}

async function getJSON(url, ms) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms || 8000) });
  return JSON.parse(await r.text());
}

/** 读 relay /healthz，判断「现在有没有人在用」 */
async function sense(cfg) {
  const out = { reachable: false, upstream_ok: false, busy: false, why: [], idle_s: null, req_count: null };
  let h = null;
  try { h = await getJSON(cfg.relay_health, 8000); } catch (e) { out.why.push('relay 不可达: ' + e.message); return out; }
  out.reachable = true;
  out.upstream_ok = h.upstream_health === 200;
  out.req_count = h.req_count === undefined ? null : Number(h.req_count);
  out.idle_s = (h.idle_s === null || h.idle_s === undefined) ? null : Number(h.idle_s);
  if (out.idle_s === null) out.idle_s = Math.round((Date.now() - procStart) / 1000);   // relay 从没被请求过

  if (!out.upstream_ok) {
    out.why.push('上游不可达(可能已关机) upstream_health=' + JSON.stringify(h.upstream_health));
    return out;
  }
  let ub = {};
  try { ub = JSON.parse(h.upstream_body || '{}'); } catch (e) {}
  const q = Number(ub.queue || 0);
  const cq = ub.comfy_queue || {};
  const run = Number(cq.running || 0), pend = Number(cq.pending || 0);
  if (q > 0 || run > 0 || pend > 0) { out.busy = true; out.why.push('在算: queue=' + q + ' comfy running=' + run + ' pending=' + pend); }
  return out;
}

async function cycle(cfg) {
  const s = await sense(cfg);
  const idleMinS = Math.max(60, Number(cfg.idle_minutes) * 60);
  const cooled = (nowSec() - ACT.last_at) >= Math.max(60, Number(cfg.cooldown_minutes) * 60);
  const line = 'sense: relay=' + (s.reachable ? 'ok' : 'DOWN') + ' 上游=' + (s.upstream_ok ? 'ok' : '不可达')
    + ' idle=' + s.idle_s + 's(阈值' + idleMinS + 's) req_count=' + s.req_count + ' 在算=' + s.busy
    + (s.why.length ? '  :: ' + s.why.join(' | ') : '');

  // —— ⓪ 保活：AutoDL 官方规则「连续关机 15 天释放实例（数据全部清空、不可恢复）」
  //     所以自动关机必须配一个"最长连关天数"，到点强制开一次机把计时器打回 0。
  if (s.reachable && !s.upstream_ok) { if (!ACT.first_off_at) { ACT.first_off_at = new Date().toISOString(); api.log(cfg, '记录本次"观察到关机"起点: ' + ACT.first_off_at); } }
  else if (s.upstream_ok && ACT.first_off_at) { api.log(cfg, '机器已开机 -> 清空关机起点（保活计时归零）'); ACT.first_off_at = null; }
  const offDays = ACT.first_off_at ? (Date.now() - Date.parse(ACT.first_off_at)) / 86400000 : 0;
  if (s.reachable && !s.upstream_ok && offDays >= Number(cfg.max_off_days || 13)) {
    api.log(cfg, line + '  -> ★ 已连续关机 ' + offDays.toFixed(2) + ' 天(上限 ' + (cfg.max_off_days || 13) + ' 天)，保活开机（防 AutoDL 15 天释放实例）');
    if (!cfg.enabled || cfg.dry_run) { api.log(cfg, '   未放开(disabled/dry_run) -> 只记日志；请尽快手动开机保活'); ACT.last_kind = 'on(keepalive,dry)'; saveState(cfg); return; }
    else { const r = await api.powerOn(cfg); ACT = { last_at: nowSec(), last_kind: 'on(keepalive)', last_ok: r.ok, idle_since: 0, first_off_at: null }; saveState(cfg); return; }
  }

  // —— ② 有人在用但机器不在 -> 尝试开机
  if (s.reachable && !s.upstream_ok && s.idle_s !== null && s.idle_s < 300) {
    if (!cooled) { api.log(cfg, line + '  -> 需要开机但冷却中(' + Math.round(nowSec() - ACT.last_at) + 's)'); saveState(cfg); return; }
    api.log(cfg, line + '  -> ★ 有调用且上游不可达，尝试开机');
    if (!cfg.enabled) api.log(cfg, '   enabled=false -> 只记日志（不真开机）');
    else if (cfg.dry_run) api.log(cfg, '   dry_run=true -> 只记日志（不真开机）');
    else { const r = await api.powerOn(cfg); ACT = { last_at: nowSec(), last_kind: 'on', last_ok: r.ok, idle_since: 0 }; saveState(cfg); return; }
    ACT.last_kind = 'on(dry)'; saveState(cfg); return;
  }

  // —— ① 闲够时间 -> 关机
  if (s.reachable && s.upstream_ok && !s.busy) {
    if (s.idle_s < idleMinS) {
      api.log(cfg, line + '  -> 还没闲够，继续等');
      saveState(cfg); return;
    }
    if (!cooled) { api.log(cfg, line + '  -> 闲够但冷却中(' + Math.round(nowSec() - ACT.last_at) + 's)'); saveState(cfg); return; }
    api.log(cfg, line + '  -> ★ 闲够 ' + s.idle_s + 's，关机（省 ¥' + cfg.h3_hourly_cny + '/h）');
    if (!cfg.enabled) { api.log(cfg, '   enabled=false -> 只记日志（不真关机）'); ACT.last_kind = 'off(dry)'; saveState(cfg); return; }
    if (cfg.dry_run) { api.log(cfg, '   dry_run=true -> 只记日志（不真关机）'); ACT.last_kind = 'off(dry)'; saveState(cfg); return; }
    const r = await api.powerOff(cfg);
    ACT = { last_at: nowSec(), last_kind: 'off', last_ok: r.ok, idle_since: 0 };
    saveState(cfg); return;
  }
  api.log(cfg, line + '  -> 保持现状');
  saveState(cfg);
}

async function selftest() {
  const { spawn } = require('child_process');
  const http = require('http');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'h3power-'));
  const port = 9411;
  // 假 relay：三种场景
  let mode = 'idle-long';
  const srv = http.createServer((req, res) => {
    let body;
    if (mode === 'idle-long') body = { upstream_health: 200, idle_s: 999999, req_count: 3, upstream_body: JSON.stringify({ queue: 0, comfy_queue: { running: 0, pending: 0 } }) };
    else if (mode === 'busy') body = { upstream_health: 200, idle_s: 2, req_count: 4, upstream_body: JSON.stringify({ queue: 1, comfy_queue: { running: 1, pending: 0 } }) };
    else if (mode === 'down-quiet') body = { upstream_health: 'ERR x', idle_s: 100000, req_count: 9, upstream_body: null };
    else body = { upstream_health: 'ERR x', idle_s: 5, req_count: 9, upstream_body: null };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise(r => srv.listen(port, '127.0.0.1', r));
  const cfg = {
    enabled: true, dry_run: true, relay_health: 'http://127.0.0.1:' + port + '/healthz',
    idle_minutes: 15, cooldown_minutes: 20, h3_hourly_cny: 2.93, max_off_days: 13,
    log_file: path.join(tmp, 'p.log'), state_file: path.join(tmp, 'p.json'), instance_uuid: 'SELFTEST',
    endpoints: { start: 'x', shutdown: 'x' },
  };
  const results = [];
  const rec = (k, v) => { results.push((v ? 'PASS  ' : 'FAIL  ') + k); return v; };
  ACT = { last_at: 0, last_kind: '', last_ok: null, idle_since: 0 };
  await cycle(cfg); rec('a) 闲够 -> 走关机分支(dry)', ACT.last_kind === 'off(dry)');
  mode = 'busy'; ACT = { last_at: 0, last_kind: '', last_ok: null, idle_since: 0 };
  await cycle(cfg); rec('b) 在算 -> 不关机', ACT.last_kind === '');
  mode = 'down'; ACT = { last_at: 0, last_kind: '', last_ok: null, idle_since: 0 };
  await cycle(cfg); rec('c) 上游不可达+刚有请求 -> 走开机分支(dry)', String(ACT.last_kind).indexOf('on') === 0);
  mode = 'down-quiet'; ACT = { last_at: 0, last_kind: 'off', last_ok: true, idle_since: 0, first_off_at: new Date(Date.now() - 14 * 86400000).toISOString() };
  await cycle(cfg); rec('f) 连续关机超上限(14天>13天) -> 保活开机(dry)', ACT.last_kind === 'on(keepalive,dry)');
  mode = 'down-quiet'; ACT = { last_at: 0, last_kind: 'off', last_ok: true, idle_since: 0, first_off_at: new Date(Date.now() - 2 * 86400000).toISOString() };
  await cycle(cfg); rec('g) 关机2天(未超上限)且无调用 -> 不动', ACT.last_kind === 'off');
  const lg = fs.readFileSync(cfg.log_file, 'utf8');
  rec('d) 日志里明确写了 dry-run 不真执行', /dry_run=true -> 只记日志/.test(lg));
  rec('e) 状态文件落盘', fs.existsSync(cfg.state_file));
  srv.close();
  console.log('\n=== h3-power selftest ===');
  results.forEach(r => console.log('  ' + r));
  const all = results.every(r => r.startsWith('PASS'));
  console.log(all ? '★ 全部符合预期' : '⚠ 有不符合项');
  process.exit(all ? 0 : 1);
}

(async () => {
  const cfg = api.loadCfg();
  if (cmd === 'help') {
    console.log('用法: status | list | on | off | watchdog [--once] | selftest');
    console.log('配置: ' + cfg.cfg_path + '  token=' + (api.getToken(cfg) ? 'set' : 'EMPTY') + '  uuid=' + (cfg.instance_uuid || 'EMPTY'));
    return;
  }
  if (cmd === 'selftest') return await selftest();
  if (cmd === 'list') {
    const r = await api.listInstances(cfg);
    console.log('http=' + r.http + '  url=' + r.url);
    console.log(JSON.stringify(r.body, null, 2));
    return;
  }
  if (cmd === 'status') {
    const r = await api.status(cfg);
    console.log('ok=' + r.ok + ' http=' + r.http + ' code=' + r.code + ' msg=' + (r.msg || ''));
    if (r.instance) console.log(JSON.stringify(r.instance, null, 2));
    else console.log(JSON.stringify(r.raw, null, 2));
    return;
  }
  if (cmd === 'on' || cmd === 'off') {
    api.log(cfg, '=== 手动 ' + cmd + ' ===  enabled=' + cfg.enabled + ' dry_run=' + cfg.dry_run + ' uuid=' + cfg.instance_uuid + ' token=' + (api.getToken(cfg) ? 'set' : 'EMPTY'));
    if (!api.getToken(cfg)) { api.log(cfg, '!! 没有 token -> 什么都不会发生（去 www.autodl.com 登录后取 localStorage.token）'); process.exitCode = 2; return; }
    if (!cfg.enabled || cfg.dry_run) { api.log(cfg, '   enabled/dry_run 未放开 -> 只记日志；要真执行：AUTODL_DRYRUN=0 且配置 enabled=true, dry_run=false'); return; }
    const r = cmd === 'on' ? await api.powerOn(cfg) : await api.powerOff(cfg);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (cmd === 'watchdog') {
    api.log(cfg, '=== h3-power 看门狗启动 === enabled=' + cfg.enabled + ' dry_run=' + cfg.dry_run
      + ' uuid=' + (cfg.instance_uuid || 'EMPTY') + ' token=' + (api.getToken(cfg) ? 'set' : 'EMPTY')
      + ' idle=' + cfg.idle_minutes + 'min poll=' + cfg.check_interval_sec + 's cooldown=' + cfg.cooldown_minutes + 'min once=' + once);
    if (!cfg.instance_uuid) api.log(cfg, '!! instance_uuid 为空 —— 请先在 config/autodl.json 填好');
    do {
      try { await cycle(cfg); } catch (e) { api.log(cfg, 'cycle 异常（已捕获，不退出）: ' + e.message); }
      if (once) break;
      await new Promise(r => setTimeout(r, Math.max(30, Number(cfg.check_interval_sec)) * 1000));
    } while (true);
    return;
  }
  console.log('未知命令: ' + cmd);
})().catch(e => { console.log('ERR ' + e.message); process.exitCode = 1; });