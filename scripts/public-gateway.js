/**
 * public-gateway.js -- 暴露给公网隧道的「只读白名单」反代
 *
 *   node scripts/public-gateway.js
 *
 * 为什么需要它：
 *   1) 直接把 new-api(3300) 挂上隧道 = 把整个管理后台暴露在公网，绝对不行；
 *   2) GitHub Pages 与隧道域名不同源，必须由本层补 CORS 头，浏览器才读得到数据。
 *
 * 只放行门户真正需要的两个只读接口，其余一律 404。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.GW_PORT || 8898);
const UPSTREAM = process.env.GW_UPSTREAM || 'http://127.0.0.1:3300';
const LOGF = path.join(ROOT, 'runtime', 'logs', 'public-gateway.log');

/* ---- 白名单：门户(data视图)只用这两个，一个不多 ---- */
const ALLOW = new Set(['/api/status', '/api/pricing']);

/* ---- 极简限流：每 IP 每分钟 GW_RL_MAX 次（默认 120）---- */
const RL_WINDOW = 60000;
const RL_MAX = Number(process.env.GW_RL_MAX || 120);
const hits = new Map();   // ip -> number[] (timestamps)

let logBomDone = false;
function log(line) {
  const s = '[' + new Date().toISOString() + '] ' + line;
  console.log(s);
  try {
    fs.mkdirSync(path.dirname(LOGF), { recursive: true });
    if (!logBomDone && !fs.existsSync(LOGF)) fs.writeFileSync(LOGF, '\uFEFF', 'utf8');
    logBomDone = true;
    fs.appendFileSync(LOGF, s + '\n', 'utf8');
  } catch (e) {}
}

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RL_WINDOW);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();   // 防内存膨胀
  return arr.length > RL_MAX;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '600',
  'Cache-Control': 'no-store',
  'X-Public-Gateway': 'yunshudu-readonly-v1'
};

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const ipId = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '-');
  let p = '/';
  try { p = new URL(req.url, 'http://x').pathname; } catch (e) {}
  const finish = (code, note) => log(ipId + ' ' + req.method + ' ' + p + ' -> ' + code + (note ? ' (' + note + ')' : '') + ' ' + (Date.now() - t0) + 'ms');

  // CORS 预检
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, Object.assign({ 'Content-Type': 'application/json' }, CORS));
    res.end('{"success":false,"message":"read-only gateway: only GET/HEAD"}');
    return finish(405, 'method');
  }

  if (rateLimited(ipId)) {
    res.writeHead(429, Object.assign({ 'Content-Type': 'application/json', 'Retry-After': '60' }, CORS));
    res.end('{"success":false,"message":"rate limited"}');
    return finish(429, 'rate-limit');
  }

  if (p === '/healthz') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS));
    res.end(JSON.stringify({ ok: true, allow: [...ALLOW], upstream: UPSTREAM, ts: new Date().toISOString() }));
    return finish(200, 'healthz');
  }

  if (!ALLOW.has(p)) {
    res.writeHead(404, Object.assign({ 'Content-Type': 'application/json' }, CORS));
    res.end('{"success":false,"message":"path not allowed on public gateway"}');
    return finish(404, 'not-allowed');
  }

  try {
    const up = await fetch(UPSTREAM + p, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const body = await up.arrayBuffer();
    res.writeHead(up.status, Object.assign({
      'Content-Type': up.headers.get('content-type') || 'application/json',
      'Content-Length': body.byteLength
    }, CORS));
    if (req.method === 'HEAD') res.end(); else res.end(Buffer.from(body));
    return finish(up.status, 'proxied');
  } catch (e) {
    res.writeHead(502, Object.assign({ 'Content-Type': 'application/json' }, CORS));
    res.end('{"success":false,"message":"upstream unreachable"}');
    return finish(502, 'upstream: ' + e.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log('public-gateway 启动: http://127.0.0.1:' + PORT + '  -> ' + UPSTREAM + '  白名单=' + [...ALLOW].join(','));
});

process.on('SIGINT', () => { log('收到退出信号'); process.exit(0); });