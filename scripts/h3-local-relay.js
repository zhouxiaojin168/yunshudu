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
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.H3R_PORT || 9123);
const STATE = process.env.H3R_STATE || path.join(ROOT, 'state', 'h3-local.json');
const FALLBACK = String(process.env.H3R_UPSTREAM || '').replace(/\/+$/, '');
const SELF_KEY = String(process.env.H3R_SELF_KEY || '');

function load() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return {}; }
}
function save(o) {
  try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {}
}
let st = load();
function upstream() { return String(st.url || FALLBACK || '').replace(/\/+$/, ''); }

function log(l) {
  const s = '[' + new Date().toISOString() + '] ' + l;
  console.log(s);
  try { fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true }); fs.appendFileSync(path.join(ROOT, 'logs', 'h3-local-relay.log'), s + '\n', 'utf8'); } catch (e) {}
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
    const body = { ok: true, ready: !!up, upstream: up || null, updated_at: st.updated_at || null, port: PORT, ts: new Date().toISOString() };
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

  const up = upstream();
  if (!up) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"no upstream registered yet (自建机还没上报地址)"}'); }

  const target = up + req.url;
  const h = {};
  for (const k of ['authorization', 'content-type', 'range', 'accept', 'user-agent', 'x-admin-key']) {
    if (req.headers[k]) h[k] = req.headers[k];
  }
  const init = { method: req.method, headers: h, redirect: 'manual' };
  if (req.method !== 'GET' && req.method !== 'HEAD') { init.body = req; init.duplex = 'half'; }
  try {
    const r = await fetch(target, init);
    const out = { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store' };
    for (const k of ['content-length', 'content-range', 'accept-ranges', 'content-disposition']) {
      const v = r.headers.get(k); if (v) out[k] = v;
    }
    res.writeHead(r.status, out);
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'upstream unreachable: ' + e.message, upstream: up }));
  }
});

server.listen(PORT, '127.0.0.1', () => log('h3-local-relay 启动 http://127.0.0.1:' + PORT + '  上游=' + (upstream() || '(未上报)') + '  selfKey=' + (SELF_KEY ? 'set' : 'EMPTY')));
process.on('SIGTERM', () => process.exit(0));
