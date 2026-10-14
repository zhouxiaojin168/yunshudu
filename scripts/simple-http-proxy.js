#!/usr/bin/env node
/**
 * simple-http-proxy.js -- 零依赖 HTTP/HTTPS(CONNECT) 正向代理（自建出口用）
 * 用途：给 H3 批量登录工厂当「第二条出口」（一号一出口的另一个 IP）。
 * 鉴权：环境变量 PROXY_USER / PROXY_PASS（都设了才校验 Proxy-Authorization: Basic）。
 * 用法：PROXY_PORT=18080 PROXY_USER=u PROXY_PASS=p node simple-http-proxy.js
 */
'use strict';
const http = require('http');
const net = require('net');
const url = require('url');

const PORT = Number(process.env.PROXY_PORT || 18080);
const HOST = process.env.PROXY_HOST || '0.0.0.0';
const USER = process.env.PROXY_USER || '';
const PASS = process.env.PROXY_PASS || '';
const LOG = process.env.PROXY_LOG || '';

function log(s) {
  const line = '[' + new Date().toISOString() + '] ' + s;
  console.log(line);
  if (LOG) { try { require('fs').appendFileSync(LOG, line + String.fromCharCode(10)); } catch (e) {} }
}
function authed(req) {
  if (!USER && !PASS) return true;
  const h = req.headers['proxy-authorization'] || '';
  if (!h.startsWith('Basic ')) return false;
  const v = Buffer.from(h.slice(6), 'base64').toString('utf8');
  return v === (USER + ':' + PASS);
}
function deny(res) { res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="ysd"' }); res.end('proxy auth required'); }

const server = http.createServer(function (req, res) {
  if (!authed(req)) return deny(res);
  let target;
  try { target = new URL(req.url); } catch (e) { res.writeHead(400); return res.end('bad url'); }
  const opts = { host: target.hostname, port: Number(target.port || 80), path: target.pathname + target.search, method: req.method, headers: Object.assign({}, req.headers) };
  delete opts.headers['proxy-authorization']; delete opts.headers['proxy-connection'];
  opts.headers.host = target.host;
  const up = http.request(opts, function (ur) {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', function (e) { try { res.writeHead(502); res.end('upstream ' + e.code); } catch (e2) {} });
  req.pipe(up);
});

server.on('connect', function (req, socket, head) {
  if (!authed(req)) { socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return socket.destroy(); }
  const [h, p] = String(req.url).split(':');
  const up = net.connect({ host: h, port: Number(p || 443) }, function () {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', function () { try { socket.destroy(); } catch (e) {} });
  socket.on('error', function () { try { up.destroy(); } catch (e) {} });
});

server.listen(PORT, HOST, function () {
  log('simple-http-proxy listening ' + HOST + ':' + PORT + ' auth=' + (USER ? 'on(' + USER + ')' : 'off'));
});