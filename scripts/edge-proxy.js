/**
 * edge-proxy.js -- 边缘反代（默认 80,8080）-> new-api(3000)
 *
 *   为什么需要它：
 *     1) 给下游一个不带端口的短 base url（有域名/Tunnel 时尤其重要）
 *     2) new-api 自己继续跑在 3000 上，老地址不断（向后兼容）
 *     3) 统一访问日志 / 以后挂 TLS / 限流，都在这层加，不动核心服务
 *
 *   ⚠ 机房实测：本机（IDC 114.66.16.225）在 **公网 80 端口有透明截持**
 *     （Apache 301 -> http://183.136.132.24），流量到不了本进程。
 *     所以这里支持**多端口**：80 留着（备案/解封后自动可用），8080 立刻可用。
 *
 *   环境变量：
 *     EDGE_PORT        监听端口，支持逗号分隔，默认 80,8080
 *     EDGE_HOST        监听地址，默认 0.0.0.0
 *     EDGE_UPSTREAM    上游地址，默认 http://127.0.0.1:3000
 *     EDGE_LOG_DIR     日志目录，默认 <repo>/runtime/logs
 *     EDGE_ACCESS_LOG  '1' 时把每条请求也写日志（默认只记错误）
 *
 *   健康检查：GET /__edge/health  ->  { ok, ports, upstream, uptimeSec, requests, errors }
 *
 *   零依赖，只用 Node 内置模块。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const NL = String.fromCharCode(10);
const BOM = String.fromCharCode(0xFEFF);

const PORT_SPEC = String(process.env.EDGE_PORT || '80,8080');
const PORTS = PORT_SPEC.split(',').map((s) => Number(String(s).trim())).filter((n) => n > 0);
const HOST = process.env.EDGE_HOST || '0.0.0.0';
const UPSTREAM = process.env.EDGE_UPSTREAM || 'http://127.0.0.1:3000';
const US = new URL(UPSTREAM);
const UP_MOD = US.protocol === 'https:' ? https : http;
const UP_HOST = US.hostname;
const UP_PORT = Number(US.port || (US.protocol === 'https:' ? 443 : 80));
const LOGD = process.env.EDGE_LOG_DIR || path.resolve(__dirname, '..', 'runtime', 'logs');
const LOGF = path.join(LOGD, 'edge-proxy.log');
const ACCESS_LOG = process.env.EDGE_ACCESS_LOG === '1';
const T0 = Date.now();

let reqCount = 0;
let errCount = 0;
let bomDone = false;
const listening = [];

function log(line) {
  const s = '[' + new Date().toISOString() + '] ' + line;
  if (ACCESS_LOG || line.indexOf('ERROR') >= 0) console.log(s);
  try {
    fs.mkdirSync(LOGD, { recursive: true });
    if (!bomDone && !fs.existsSync(LOGF)) fs.writeFileSync(LOGF, BOM, 'utf8');
    bomDone = true;
    fs.appendFileSync(LOGF, s + NL, 'utf8');
  } catch (e) { /* 日志失败不影响转发 */ }
}

const RL_MAX = Number(process.env.EDGE_RL_MAX || 0);   // 每 IP 每分钟上限，0 = 不限流
const RL_WINDOW = 60000;
const rlHits = new Map();
let rlBlocked = 0;

function rateLimited(ip) {
  if (RL_MAX <= 0) return false;
  const now = Date.now();
  const arr = (rlHits.get(ip) || []).filter((t) => now - t < RL_WINDOW);
  arr.push(now);
  rlHits.set(ip, arr);
  if (rlHits.size > 5000) {
    const cutoff = now - RL_WINDOW;
    Array.from(rlHits.keys()).forEach((k) => {
      const v = rlHits.get(k);
      if (!v || !v.length || v[v.length - 1] < cutoff) rlHits.delete(k);
    });
  }
  if (arr.length > RL_MAX) { rlBlocked++; return true; }
  return false;
}


const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

function healthBody(port) {
  return JSON.stringify({
    ok: true,
    service: 'edge-proxy',
    pid: process.pid,
    thisPort: port,
    ports: PORTS,
    listening: listening,
    host: HOST,
    upstream: UPSTREAM,
    uptimeSec: Math.round((Date.now() - T0) / 1000),
    requests: reqCount,
    errors: errCount,
    rateLimitMax: RL_MAX,
    rateLimitedCount: rlBlocked,
    accessLog: ACCESS_LOG,
    node: process.version,
    time: new Date().toISOString()
  });
}

function handle(req, res) {
  const isHealth = (req.url === '/__edge/health' || req.url === '/__edge/health/');
  if (isHealth) {
    const self = (req.socket && req.socket.localPort) || 0;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(healthBody(self));
    return;
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: { message: 'edge proxy: rate limit exceeded', type: 'proxy_rate_limited' } }));
    if (rlBlocked === 1 || rlBlocked % 50 === 0) log('RATE_LIMIT ip=' + ip + ' blocked=' + rlBlocked);
    return;
  }

  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    if (ms > 5000) log('SLOW ' + String(req.method) + ' ' + String(req.url) + ' -> ' + res.statusCode + ' ' + ms + 'ms ip=' + ip);
  });



  reqCount++;
  const headers = Object.assign({}, req.headers);
  delete headers['connection'];
  delete headers['host'];
  headers['host'] = UP_HOST + ':' + UP_PORT;
  const prior = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = (prior ? String(prior) + ', ' : '') + clientIp(req);
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-host'] = String(req.headers['host'] || '');
  headers['x-edge-proxy'] = 'yunshudu-edge';

  const opt = {
    protocol: US.protocol,
    hostname: UP_HOST,
    port: UP_PORT,
    method: req.method,
    path: req.url,
    headers: headers
  };

  const up = UP_MOD.request(opt, (ur) => {
    const rh = Object.assign({}, ur.headers);
    Object.keys(rh).forEach((k) => { if (HOP.has(k.toLowerCase())) delete rh[k]; });
    res.writeHead(ur.statusCode || 502, rh);
    ur.pipe(res);
  });

  up.setTimeout(300000, () => { up.destroy(new Error('upstream timeout')); });

  up.on('error', (e) => {
    errCount++;
    log('UPSTREAM_ERROR ' + String(req.method) + ' ' + String(req.url) + ' :: ' + String(e && e.message));
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: 'edge proxy: upstream unreachable', type: 'proxy_error' } }));
  });

  req.pipe(up);

  if (ACCESS_LOG) log('REQ ' + String(req.method) + ' ' + String(req.url) + ' -> ' + res.statusCode + ' <- ' + ip);
}

function onClientError(err, sock) { try { sock.destroy(); } catch (e) {} }

const servers = [];
if (PORTS.length === 0) { log('NO_VALID_PORT from spec ' + PORT_SPEC); process.exit(3); }

PORTS.forEach((pt) => {
  const srv = http.createServer(handle);
  srv.on('clientError', onClientError);
  srv.on('error', (e) => {
    log('LISTEN_ERROR port=' + pt + ' :: ' + String(e && e.message));
  });
  srv.listen(pt, HOST, () => {
    listening.push(pt);
    log('edge-proxy listening on ' + HOST + ':' + pt + ' -> ' + UPSTREAM + ' (node ' + process.version + ', pid ' + process.pid + ')');
  });
  servers.push(srv);
});

function bye(sig) {
  log('got ' + sig + ' -> exit');
  servers.forEach((s) => { try { s.close(); } catch (e) {} });
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));
