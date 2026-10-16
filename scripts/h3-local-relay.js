/**
 * h3-local-relay.js -- 「自建 4090D H3 算力」的稳定入口（王炸）
 *
 *   为什么要有它：
 *     自建机（AutoDL）的公网地址走的是 cloudflared 快速隧道，**重启会换域名**。
 *     若让 new-api 渠道直连那个随机域名，一换址全站就断。
 *     本服务在服务器本地开一个**固定端口**，把请求转给「当前有效」的自建机地址：
 *       new-api 渠道 base_url = http://127.0.0.1:<H3R_PORT>   （永久不变）
 *       门户/用户取片 URL    = http://<公网>:8080/h3/...      （走 edge 路由，永久不变）
 *     自建机每次公网地址变化时 POST /self 上报，本服务自动跟随。
 *
 *   路由：
 *     POST /self     自建机上报当前公网地址  {url};  头 x-self-key 必须等于 H3R_SELF_KEY
 *     GET  /healthz  健康 + 当前上游 + 上次上报时间
 *     *    /v1/**    反代到当前上游（流式，支持 Range/大文件 mp4）
 *
 *   环境变量：
 *     H3R_PORT       本地监听端口（默认 9123）
 *     H3R_STATE      状态文件（默认 <ROOT>\state\h3-local.json）
 *     H3R_UPSTREAM   兜底上游（默认空）
 *     H3R_SELF_KEY   上报鉴权 key（必填；服务器从 secrets.txt 注入）
 *     H3R_WAKE_CMD   自建机「唤醒/开机」命令（默认空=不启用）。
 *                    有请求打进来但上游不可用时会执行它，实现「有人调用就试着开机」。
 *                    AutoDL 若提供开机入口，把它写成对应的 curl/命令行即可；
 *                    没有入口时留空，本服务只记日志（并节流）。
 *     H3R_WAKE_MIN_INTERVAL  两次唤醒尝试的最小间隔秒数（默认 600）
 *     H3R_WAKE_STATE 唤醒节流状态文件（默认 <ROOT>\state\h3-wake.json）
 *
 *   路由补充：
 *     POST /wake     手动触发一次唤醒（头 x-self-key 同上）——给"预热按钮/定时任务"用
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { exec } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.H3R_PORT || 9123);
const STATE = process.env.H3R_STATE || path.join(ROOT, 'state', 'h3-local.json');
const FALLBACK = String(process.env.H3R_UPSTREAM || '').replace(/\/+$/, '');
const SELF_KEY = String(process.env.H3R_SELF_KEY || '');
const WAKE_CMD = String(process.env.H3R_WAKE_CMD || '');
const WAKE_MIN = Math.max(30, Number(process.env.H3R_WAKE_MIN_INTERVAL || 600));
const WAKE_STATE = process.env.H3R_WAKE_STATE || path.join(ROOT, 'state', 'h3-wake.json');

function load() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return {}; }
}
function save(o) {
  try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {}
}
let st = load();
// ★ R1187 运行指标：给「空闲自动关机看门狗」用——最后一次被请求的时间
let lastReqAt = 0;
let reqCount = 0;
function upstream() { return String(st.url || FALLBACK || '').replace(/\/+$/, ''); }

function log(l) {
  const s = '[' + new Date().toISOString() + '] ' + l;
  console.log(s);
  try { fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true }); fs.appendFileSync(path.join(ROOT, 'logs', 'h3-local-relay.log'), s + '\n', 'utf8'); } catch (e) {}
}

function loadWake() { try { return JSON.parse(fs.readFileSync(WAKE_STATE, 'utf8')); } catch (e) { return {}; } }
function saveWake(o) { try { fs.mkdirSync(path.dirname(WAKE_STATE), { recursive: true }); fs.writeFileSync(WAKE_STATE, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {} }

/** 有人调用但上游不可用 -> 尝试唤醒自建机；带最小间隔节流，避免刷爆。 */
function maybeWake(reason, force) {
  const now = Date.now();
  if (!WAKE_CMD) {
    log('wake 未配置(' + reason + ') -> 仅提示：上游不可用');
    return { fired: false, reason: 'not-configured' };
  }
  const w = loadWake();
  const last = Number(w.last_ms || 0);
  const gap = Math.round((now - last) / 1000);
  if (!force && last && (now - last) < WAKE_MIN * 1000) {
    return { fired: false, reason: 'throttled', waited_s: gap, next_in_s: WAKE_MIN - gap };
  }
  saveWake({ last_ms: now, last_at: new Date().toISOString(), reason: reason });
  log('★ 触发唤醒(' + reason + '): ' + WAKE_CMD);
  // ★ R1187 加固：唤醒命令绝不允许把本服务打崩（沙箱 / 无权限 / 命令不存在 / EPERM 都要能活）
  let spawnError = null;
  try {
    const child = exec(WAKE_CMD, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      log('  唤醒命令返回: ' + (err ? 'ERR ' + err.message : 'ok') +
          ' | out=' + String(stdout || '').trim().slice(0, 200) +
          ' | err=' + String(stderr || '').trim().slice(0, 200));
    });
    if (child && typeof child.on === 'function') {
      child.on('error', (e) => log('  唤醒命令启动失败(异步 error 事件，已吞掉不崩): ' + e.message));
    }
  } catch (e) {
    spawnError = String(e && e.message || e);
    log('  唤醒命令无法启动(同步异常，已捕获不崩): ' + spawnError);
  }
  return { fired: true, reason: reason, spawn_error: spawnError };
}

function readBody(req) {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => res(b));
    req.on('error', () => res(b));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/healthz') {
    // 语义分层（R1154 修正）：/healthz = 「本服务活着吗」-> 只要进程在听就 200；
    // 上游是否就绪放 ready 字段。否则 keeper/post-deploy 会把「还没上报上游」误判成 DOWN 反复重启。
    const up = upstream();
    const w = loadWake();
    const body = { ok: true, ready: !!up, upstream: up || null, updated_at: st.updated_at || null, port: PORT, ts: new Date().toISOString(),
      idle_s: lastReqAt ? Math.round((Date.now() - lastReqAt) / 1000) : null,
      last_req_at: lastReqAt ? new Date(lastReqAt).toISOString() : null,
      req_count: reqCount,
      wake: { configured: !!WAKE_CMD, min_interval_s: WAKE_MIN, last_at: w.last_at || null, last_reason: w.reason || null } };
    if (up) {
      try {
        const r = await fetch(up + '/healthz', { signal: AbortSignal.timeout(8000) });
        body.upstream_health = r.status;
        body.upstream_body = (await r.text()).slice(0, 400);
      } catch (e) { body.upstream_health = 'ERR ' + e.message; }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body));
  }

  if (p === '/self' && req.method === 'POST') {
    if (SELF_KEY && String(req.headers['x-self-key'] || '') !== SELF_KEY) {
      res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"bad self key"}');
    }
    const raw = await readBody(req);
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch (e) {}
    const url = String(j.url || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"bad url"}'); }
    const changed = url !== String(st.url || '');
    st = { url: url, updated_at: new Date().toISOString(), from: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') };
    save(st);
    log('self report: ' + url + (changed ? '  (CHANGED -> 跟随 جديد)' : '  (unchanged)'));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, url: url, changed: changed }));
  }

  if (p === '/wake' && req.method === 'POST') {
    if (SELF_KEY && String(req.headers['x-self-key'] || '') !== SELF_KEY) {
      res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"bad self key"}');
    }
    const r = maybeWake('manual-api', true);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(Object.assign({ ok: true, configured: !!WAKE_CMD }, r)));
  }

  const up = upstream();
  if (!up) {
    const w = maybeWake('no-upstream');
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: '上游未注册（自建机可能已关机/未上报）', wake: w }));
  }

  lastReqAt = Date.now(); reqCount++;
  const target = up + req.url;
  const h = {};
  for (const k of ['authorization', 'content-type', 'range', 'accept', 'user-agent', 'x-admin-key']) {
    if (req.headers[k]) h[k] = req.headers[k];
  }
  const init = { method: req.method, headers: h, redirect: 'manual' };
  if (req.method !== 'GET' && req.method !== 'HEAD') { init.body = req; init.duplex = 'half'; }
  try {
    const r = await fetch(target, init);
    // ★ R1187 实测坑：cloudflared 隧道死了会返回 **520~530 的 HTML 错误页**（HTTP 层面是"成功响应"），
    //   旧逻辑把它当正常响应透传，导致「有人调用」根本触发不了唤醒。必须识别成上游不可用。
    if (r.status >= 520 && r.status <= 530) {
      const w = maybeWake('upstream-tunnel-error-' + r.status);
      try { await r.text(); } catch (e) {}
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'upstream tunnel error ' + r.status + '（自建机可能已关机/隧道已断）', upstream: up, wake: w }));
    }
    const out = { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store' };
    for (const k of ['content-length', 'content-range', 'accept-ranges', 'content-disposition']) {
      const v = r.headers.get(k); if (v) out[k] = v;
    }
    res.writeHead(r.status, out);
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    const w = maybeWake('proxy-failed');
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'upstream unreachable: ' + e.message, upstream: up, wake: w }));
  }
});

server.listen(PORT, '127.0.0.1', () => log('h3-local-relay 启动 http://127.0.0.1:' + PORT + '  上游=' + (upstream() || '(未上报)') + '  selfKey=' + (SELF_KEY ? 'set' : 'EMPTY') + '  wake=' + (WAKE_CMD ? 'set(' + WAKE_MIN + 's)' : 'OFF')));
process.on('SIGTERM', () => process.exit(0));
