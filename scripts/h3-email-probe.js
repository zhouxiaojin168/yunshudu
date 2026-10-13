#!/usr/bin/env node
/**
 * h3-email-probe.js — H3 邮箱地址「形状验收」探针（+号寻址 / 大小写 / 畸形 是否被接受）
 * 只做一件事：POST /v1/api/user/login/email/code?email=<addr>，把上游 statusInfo 原样打出来。
 * 用法：
 *   node h3-email-probe.js --email hl144i+a@qingzhou.autos   （R144y：示例域改用自有域）
 *   node h3-email-probe.js --email a@b.c --base https://hailuoai.video --proxy http://127.0.0.1:10090
 *   node h3-email-probe.js --email x@y.z --noproxy       # 发码必须直连(CN IP)，默认就是直连
 * 零依赖。
 */
'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { URL } = require('url');

function argvVal(n, d) { const i = process.argv.indexOf(n); return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : d; }
const EMAIL = argvVal('--email', '');
const BASE = String(argvVal('--base', 'https://hailuoai.video')).replace(/\/+$/, '');
const PROXY = argvVal('--proxy', '');
const PATHX = argvVal('--path', '/v1/api/user/login/email/code');
const APPID = argvVal('--app-id', '3001');
const VC = argvVal('--version-code', '22203');
const BIZ = argvVal('--biz-id', '0');
if (!EMAIL) { console.log('need --email'); process.exit(2); }

function md5hex(s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); }
function sign(pq, body, unix) { return md5hex(encodeURIComponent(pq) + '_' + body + md5hex(String(unix)) + 'ooui'); }
function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 3 | 8); return v.toString(16); }); }

function rawRequest(fullUrl, method, headers, bodyBuf, proxy) {
  return new Promise(function (resolve, reject) {
    const u = new URL(fullUrl);
    const isHttps = u.protocol === 'https:';
    const port = u.port || (isHttps ? 443 : 80);
    function doReq(sock) {
      const opt = { method: method, hostname: u.hostname, port: port, path: u.pathname + u.search, headers: headers || {} };
      if (sock) { opt.createConnection = function () { return sock; }; opt.agent = false; }
      const mod = isHttps ? https : http;
      const req = mod.request(opt, function (res) {
        let b = ''; res.setEncoding('utf8');
        res.on('data', function (c) { b += c; });
        res.on('end', function () { resolve({ status: res.statusCode, text: b, headers: res.headers }); });
      });
      req.on('error', reject);
      req.setTimeout(30000, function () { req.destroy(new Error('timeout')); });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    }
    if (!proxy) return doReq(null);
    const pu = new URL(proxy);
    const cr = http.request({ host: pu.hostname, port: pu.port || 8080, method: 'CONNECT', path: u.hostname + ':' + port, headers: { host: u.hostname + ':' + port } });
    cr.on('connect', function (res, sock) {
      if (res.statusCode !== 200) return reject(new Error('proxy CONNECT ' + res.statusCode));
      if (isHttps) { const ts = tls.connect({ socket: sock, servername: u.hostname }, function () { doReq(ts); }); ts.on('error', reject); }
      else doReq(sock);
    });
    cr.on('error', reject); cr.end();
  });
}

(async function main() {
  const unix = Date.now();
  const q = { device_platform: 'web', app_id: APPID, version_code: VC, biz_id: BIZ, unix: String(unix) };
  const qs = Object.keys(q).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
  const pq = (PATHX.indexOf('?') >= 0 ? (PATHX + '&' + qs) : (PATHX + '?' + qs)) + (PATHX.indexOf('email=') >= 0 ? '' : '');
  const full = pq + '&email=' + encodeURIComponent(EMAIL);
  const body = '{}';
  const yy = sign(full, body, unix);
  const headers = {
    'yy': yy, 'accept': 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json', 'origin': BASE, 'referer': BASE + '/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'content-length': '2'
  };
  console.log('[' + new Date().toISOString() + '] email=' + JSON.stringify(EMAIL) + ' base=' + BASE + ' proxy=' + (PROXY || '(direct)'));
  try {
    const r = await rawRequest(BASE + full, 'POST', headers, Buffer.from(body, 'utf8'), PROXY);
    let j = null; try { j = JSON.parse(r.text); } catch (e) {}
    const si = (j && j.statusInfo) || {};
    console.log('  HTTP ' + r.status + ' code=' + si.code + ' msg=' + JSON.stringify(si.message) + ' data=' + JSON.stringify((j && j.data)));
    if (!j) console.log('  raw: ' + String(r.text).slice(0, 300));
  } catch (e) { console.log('  ERR ' + e.message); }
})();