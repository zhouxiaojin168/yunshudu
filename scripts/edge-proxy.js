/**
 * edge-proxy.js -- 边缘反代：80 -> new-api(3000)
 *
 *   为什么需要它：
 *     1) 给下游一个不带端口号的短 base url，例如 http://<host>/v1/chat/completions
 *     2) new-api 自己继续跑在 3000 上，老地址不断（向后兼容）
 *     3) 以后要挂域名 / TLS / 统一限流，都在这层加，不动核心服务
 *
 *   环境变量：
 *     EDGE_PORT        监听端口，默认 80
 *     EDGE_HOST        监听地址，默认 0.0.0.0
 *     EDGE_UPSTREAM    上游地址，默认 http://127.0.0.1:3000
 *     EDGE_LOG_DIR     日志目录，默认 <repo>/runtime/logs
 *     EDGE_ACCESS_LOG  '1' 时把每条请求也写日志（默认只记错误）
 *
 *   健康检查：GET /__edge/health  ->  { ok, upstream, uptimeSec, requests, errors }
 *
 *   零依赖，只用 Node 内置模块。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const NL = String.fromCharCode(10);
const BOM = String.fromCharCode(0xFEFF);

const PORT = Number(process.env.EDGE_PORT || 80);
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

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

function healthBody() {
  return JSON.stringify({
    ok: true,
    service: 'edge-proxy',
    pid: process.pid,
    port: PORT,
    host: HOST,
    upstream: UPSTREAM,
    uptimeSec: Math.round((Date.now() - T0) / 1000),
    requests: reqCount,
    errors: errCount,
    node: process.version,
    time: new Date().toISOString()
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/__edge/health' || req.url === '/__edge/health/') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(healthBody());
    return;
  }

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

  if (ACCESS_LOG) log('REQ ' + String(req.method) + ' ' + String(req.url) + ' <- ' + clientIp(req));
});

server.on('clientError', (err, sock) => { try { sock.destroy(); } catch (e) {} });

server.on('error', (e) => {
  log('LISTEN_ERROR ' + String(e && e.message));
  process.exit(3);
});

server.listen(PORT, HOST, () => {
  log('edge-proxy listening on ' + HOST + ':' + PORT + ' -> ' + UPSTREAM + ' (node ' + process.version + ', pid ' + process.pid + ')');
});

function bye(sig) { log('got ' + sig + ' -> exit'); try { server.close(); } catch (e) {} process.exit(0); }
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));
