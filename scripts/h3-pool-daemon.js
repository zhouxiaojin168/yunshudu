/**
 * h3-pool-daemon.js -- 海外海螺(Minimax Hub / hailuoai.video) 号池「调度层」
 *
 * 职责:
 *   1) 额度查询: 逐个号拉 /v1/api/user/info + /user/equity + /billing/credit
 *   2) 掉号检测: 401 / code 1000048(token失效) / 22(封禁) -> 标记 dead
 *   3) 自动补号: 存活数 < target 时调 h3-pool.js 补到目标数量
 *   4) token 轮转: --pick 输出「最肥优先 + 用的最少」的号(token|uuid|device_id)，并累加使用计数
 *
 * 用法:
 *   node scripts/h3-pool-daemon.js                 # 单次: 巡检 + 补号到 target (给 cron/计划任务)
 *   node scripts/h3-pool-daemon.js --loop           # 常驻: 每 interval 秒跑一轮
 *   node scripts/h3-pool-daemon.js --status         # 只看池子报表
 *   node scripts/h3-pool-daemon.js --pick           # 取一个可用号(轮转)
 *   node scripts/h3-pool-daemon.js --prune          # 把 dead 号从池文件剔掉(带 .bak)
 *
 * 参数:
 *   --pool      池文件 (默认 runtime/h3-accounts.jsonl)
 *   --state     状态文件 (默认 runtime/h3-pool-state.json)
 *   --dead      死号留档 (默认 runtime/h3-accounts.dead.jsonl)
 *   --target    目标存活数 (默认 200)
 *   --interval  常驻模式间隔秒 (默认 600)
 *   --concurrency 补号并发 (默认 6)
 *   --min-newuser 保留最少「新人期」号数告警阈值 (默认 0=不告警)
 * 环境变量: MF_BASE / MF_KEY / H3_HOST / H3_LANG
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const md5 = s => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const flag = n => process.argv.indexOf('--' + n) >= 0;
const ROOT = path.resolve(__dirname, '..');
const C = {
  pool: argOf('pool', process.env.H3_POOL || path.join(ROOT, 'runtime', 'h3-accounts.jsonl')),
  state: argOf('state', process.env.H3_STATE || path.join(ROOT, 'runtime', 'h3-pool-state.json')),
  dead: argOf('dead', process.env.H3_DEAD || path.join(ROOT, 'runtime', 'h3-accounts.dead.jsonl')),
  target: Number(argOf('target', process.env.H3_TARGET || '200')),
  interval: Number(argOf('interval', '600')),
  concurrency: Number(argOf('concurrency', '6')),
  minNewUser: Number(argOf('min-newuser', '0')),
  host: process.env.H3_HOST || 'hailuoai.video',
  lang: process.env.H3_LANG || 'en',
  mfBase: process.env.MF_BASE || 'http://114.66.16.225:8099',
  mfKey: process.env.MF_KEY || '',
};
fs.mkdirSync(path.dirname(C.state), { recursive: true });
fs.mkdirSync(path.dirname(C.pool), { recursive: true });
const EVID = path.join(ROOT, 'runtime', 'evidence');
fs.mkdirSync(EVID, { recursive: true });

/* ---------- 签名（与 h3-pool.js 一致） ---------- */
function signedUrl(pathname, body, method, acct) {
  const t = Date.now();
  const q = {
    device_platform: 'web', app_id: '3001', version_code: '22203', biz_id: '0',
    unix: String(t), lang: C.lang, uuid: acct.uuid || acct.device_id || 'anon',
    os_name: 'Windows', browser_name: 'Chrome',
    browser_language: C.lang === 'en' ? 'en-US' : 'zh-CN',
    browser_platform: 'Win32', screen_width: '1920', screen_height: '1080',
  };
  if (acct.device_id) q.device_id = acct.device_id;
  const qs = Object.keys(q).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
  const full = pathname + (pathname.includes('?') ? '&' : '?') + qs;
  const bs = (method === 'POST' || method === 'DELETE') ? JSON.stringify(body == null ? {} : body) : '{}';
  return { full, bs, yy: md5(encodeURIComponent(full) + '_' + bs + md5(String(t)) + 'ooui') };
}
function h3(method, pathname, body, acct, timeoutMs) {
  const s = signedUrl(pathname, body, method, acct);
  return new Promise(res => {
    const d = (method === 'POST' || method === 'DELETE') ? Buffer.from(s.bs, 'utf8') : null;
    const r = https.request({
      host: C.host, port: 443, path: s.full, method,
      headers: {
        'content-type': 'application/json', origin: 'https://' + C.host, referer: 'https://' + C.host + '/login',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        token: acct.token || '', yy: s.yy,
      },
    }, rsp => { let b = ''; rsp.on('data', x => b += x); rsp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ http: rsp.statusCode, j, raw: b.slice(0, 300) }); }); });
    r.setTimeout(timeoutMs || 25000, () => { r.destroy(new Error('timeout')); });
    r.on('error', e => res({ http: 0, j: null, raw: 'ERR ' + (e.code || e.message) }));
    if (d) r.write(d);
    r.end();
  });
}
const CODE_TO_STATE = { '1000048': 'dead-auth', '22': 'dead-banned', '2400026': 'dead-nocredit', '2400040': 'dead-nocredit' };

/* ---------- 池文件读写 ---------- */
function loadPool() {
  if (!fs.existsSync(C.pool)) return [];
  const out = [];
  for (const line of fs.readFileSync(C.pool, 'utf8').split(/\r?\n/)) {
    const t = line.trim(); if (!t) continue;
    try { const o = JSON.parse(t); if (o && o.token) out.push(o); } catch (e) {}
  }
  return out;
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(C.state, 'utf8')); } catch (e) { return { accounts: {} }; }
}
function saveState(st) { fs.writeFileSync(C.state, JSON.stringify(st, null, 1)); }

/* ---------- 巡检 ---------- */
async function checkOne(rec, st) {
  const acct = { token: rec.token, uuid: rec.uuid, device_id: rec.device_id };
  const info = await h3('GET', '/v1/api/user/info', null, acct);
  const code = info.j && info.j.statusInfo ? Number(info.j.statusInfo.code) : NaN;
  const s = st.accounts[rec.email] || (st.accounts[rec.email] = { email: rec.email, userID: rec.userID, usedCount: 0 });
  s.lastCheck = Math.round(Date.now() / 1000);
  s.http = info.http;
  if (info.http === 0) { s.status = 'unreachable'; s.message = info.raw; return s; }
  if (info.http === 401 || CODE_TO_STATE[String(code)]) {
    s.status = CODE_TO_STATE[String(code)] || 'dead-http401';
    s.message = (info.j && info.j.statusInfo && info.j.statusInfo.message) || info.raw;
    return s;
  }
  if (code !== 0) { s.status = 'error'; s.message = (info.j && info.j.statusInfo && info.j.statusInfo.message) || ''; return s; }
  s.status = 'alive';
  s.message = '';
  s.userID = (info.j.data && info.j.data.userInfo && info.j.data.userInfo.userID) || rec.userID;
  const eq = await h3('GET', '/v1/api/user/equity', null, acct);
  const d = eq.j && eq.j.data;
  if (d) {
    s.credits = d.totalCredits; s.videoCost = d.videoCost; s.isNewUser = !!d.isNewUser;
    s.trialExpireTime = d.trialExpireTime || 0; s.memberName = d.memberName; s.privilegeType = d.privilegeType;
  }
  const cr = await h3('GET', '/v1/api/billing/credit', null, acct);
  s.totalCredit = cr.j && cr.j.data ? cr.j.data.total_credit : null;
  s.lastOk = s.lastCheck;
  return s;
}

/* ---------- 轮转打分：最肥优先，其次用得最少 ---------- */
function score(s) {
  const now = Date.now();
  let v = 0;
  if (s.status === 'alive') v += 1e9;
  const trialAlive = s.trialExpireTime && s.trialExpireTime > now;
  if (s.isNewUser && trialAlive) v += 1e8;
  v += (Number(s.credits) || 0) * 1e4;
  v += (Number(s.totalCredit) || 0) * 1e4;
  v -= (Number(s.usedCount) || 0) * 100;
  v -= Math.floor((now - (s.lastUsedAt || 0)) / 3600000) * -1; /* 越久没用越优先 */
  return v;
}
function aliveList(st) { return Object.values(st.accounts).filter(a => a.status === 'alive'); }
function pick(st) {
  const list = aliveList(st).sort((a, b) => score(b) - score(a));
  if (!list.length) return null;
  const best = list[0];
  best.usedCount = (Number(best.usedCount) || 0) + 1;
  best.lastUsedAt = Date.now();
  return best;
}

/* ---------- 补号 ---------- */
function refill(need) {
  const script = path.join(__dirname, 'h3-pool.js');
  const args = [script, '--n', String(need), '--concurrency', String(C.concurrency), '--out', C.pool];
  console.log('[refill] 启动补号 need=' + need + ' 并发=' + C.concurrency);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: Object.assign({}, process.env, { MF_BASE: C.mfBase, MF_KEY: C.mfKey, H3_HOST: C.host, H3_LANG: C.lang }) });
  const line = { ts: Math.round(Date.now() / 1000), need, exit: r.status };
  fs.appendFileSync(path.join(EVID, 'h3-refill-log.jsonl'), JSON.stringify(line) + '\n');
  return r.status;
}

/* ---------- 主流程 ---------- */
async function pass(doRefill) {
  const pool = loadPool();
  const st = loadState();
  st.host = C.host; st.target = C.target; st.updatedAt = Math.round(Date.now() / 1000);
  const t0 = Date.now();
  let i = 0;
  const CONC = 8;
  const q = pool.slice();
  async function w() { while (q.length) { const rec = q.shift(); await checkOne(rec, st); i++; } }
  await Promise.all(Array.from({ length: Math.min(CONC, Math.max(1, pool.length)) }, w));
  const alive = aliveList(st);
  const dead = Object.values(st.accounts).filter(a => /^dead/.test(a.status));
  const unreach = Object.values(st.accounts).filter(a => a.status === 'unreachable');
  st.summary = {
    pool: pool.length, alive: alive.length, dead: dead.length, unreachable: unreach.length,
    newUserAlive: alive.filter(a => a.isNewUser).length,
    checkMs: Date.now() - t0,
  };
  saveState(st);
  const need = Math.max(0, C.target - alive.length);
  if (need > 0 && doRefill) { refill(need); st.lastRefill = { ts: Math.round(Date.now() / 1000), need }; saveState(st); }
  else if (need > 0) { console.log('[refill] 需要补 ' + need + ' 个（本次未执行，加 --once 或去掉 --no-refill）'); }
  return st;
}

function report(st) {
  const a = st.summary || {};
  console.log('\n==== 号池报表 ' + new Date().toISOString() + ' ====');
  console.log('池文件      : ' + C.pool);
  console.log('总数/存活/死/失联 : ' + a.pool + ' / ' + a.alive + ' / ' + a.dead + ' / ' + a.unreachable + '   (目标 ' + C.target + ')');
  console.log('新人期存活  : ' + a.newUserAlive + '   巡检耗时 ' + ((a.checkMs || 0) / 1000).toFixed(1) + 's');
  const rows = Object.values(st.accounts).filter(x => x.status === 'alive')
    .sort((x, y) => score(y) - score(x)).slice(0, 15);
  if (rows.length) {
    console.log('\n  # email                           userID           credit  videoCost 新人 用次数 trial到期');
    rows.forEach((r, n) => console.log('  ' + String(n + 1).padEnd(2) + ' ' + String(r.email).padEnd(32) + String(r.userID || '').padEnd(17) +
      String(r.credits == null ? '-' : r.credits).padEnd(8) + String(r.videoCost == null ? '-' : r.videoCost).padEnd(11) +
      String(r.isNewUser ? 'Y' : 'n').padEnd(5) + String(r.usedCount || 0).padEnd(7) + (r.trialExpireTime ? new Date(r.trialExpireTime).toISOString().slice(0, 10) : '-')));
  }
  const d = Object.values(st.accounts).filter(x => /^dead/.test(x.status));
  if (d.length) { console.log('\n死号: ' + d.length + ' -> ' + C.dead); d.forEach(x => { fs.appendFileSync(C.dead, JSON.stringify(x) + '\n'); }); }
  if (C.minNewUser && (a.newUserAlive || 0) < C.minNewUser) console.log('\n[WARN] 新人期号仅 ' + a.newUserAlive + ' 个，低于阈值 ' + C.minNewUser + '，建议加大补号');
}

(async () => {
  if (flag('pick')) {
    const st = loadState();
    const best = pick(st);
    if (!best) { console.error('no alive account'); process.exit(3); }
    saveState(st);
    const pool = loadPool();
    const rec = pool.find(x => x.email === best.email) || {};
    console.log([rec.token || '', rec.uuid || '', rec.device_id || ''].join('|'));
    process.exit(0);
  }
  if (flag('status')) { const st = loadState(); report(st); process.exit(0); }
  if (flag('prune')) {
    const st = loadState(); const pool = loadPool();
    const keep = pool.filter(x => { const s = st.accounts[x.email]; return !s || !/^dead/.test(s.status); });
    fs.copyFileSync(C.pool, C.pool + '.bak-' + Date.now());
    fs.writeFileSync(C.pool, keep.map(x => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : ''));
    console.log('prune: ' + pool.length + ' -> ' + keep.length + ' (备份 ' + path.basename(C.pool) + '.bak-*)');
    process.exit(0);
  }
  const once = flag('once') || !flag('loop');
  const st = await pass(once);
  report(st);
  if (flag('loop')) {
    console.log('\n常驻模式: 每 ' + C.interval + 's 一轮 (Ctrl+C 退出)');
    for (;;) { await new Promise(r => setTimeout(r, C.interval * 1000)); const s2 = await pass(true); report(s2); }
  }
})();