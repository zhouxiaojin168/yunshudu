#!/usr/bin/env node
/**
 * mail-domain-health.js — 「哪个收信域还能收到 H3 的验证码」健康探针（R144i 新增）
 *
 * 背景（R144i 实测）：对 https://hailuoai.video 发码接口
 *   （R144y）默认只探「自有域 + tempmail 系」；外来 5 域已移出默认列表，需要时用 --foreign 取证
 *     -> HTTP 200 code=1200063 "Verification failed"      = 发不出去（域被 H3 拒）
 *   tempmail 系 / gmail / 163 / qq / 自建域
 *     -> HTTP 200 code=1200019 "temporarily unavailable"  = 软成功（邮件照发，R143 已验证能收到）
 * 所以「域健康」是可测的，且必须测——盲发只会白烧接码预算。
 *
 * 用法：
 *   node mail-domain-health.js                     # 探默认域表，写 state/mail-domain-health.json
 *   node mail-domain-health.js --domains a.com,b.com
 *   node mail-domain-health.js --out state/mail-domain-health.json --json
 *   node mail-domain-health.js --no-control         # 不带 gmail.com 对照
 * 环境：MAILHEALTH_PROXY / MAILHEALTH_TIMEOUT_MS / H3_BASE
 * 零依赖。
 */
'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
function argvVal(n, d) { const i = process.argv.indexOf(n); return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : d; }
function has(n) { return process.argv.indexOf(n) >= 0; }

const BASE = String(argvVal('--base', process.env.H3_BASE || 'https://hailuoai.video')).replace(/\/+$/, '');
const PROXY = argvVal('--proxy', process.env.MAILHEALTH_PROXY || '');
const TIMEOUT = parseInt(argvVal('--timeout-ms', process.env.MAILHEALTH_TIMEOUT_MS || '25000'), 10) || 25000;
const OUT = argvVal('--out', path.join(ROOT, 'state', 'mail-domain-health.json'));
const JSON_ONLY = has('--json');
const CONTROL = !has('--no-control');

const DEFAULT_DOMAINS = [
  /* 自建 / 高信任 */
  'qingzhou.autos',
  /* tempmail 系 */
  'mailto.plus', 'fexpost.com', 'fexbox.org', 'fexbox.net', 'tempmail.plus'
];

/* R144y: 外来 5 域（不属我方、公网 MX 在 45.207.214.211）——默认不探，仅存档取证：加 --foreign 才纳入 */
const FOREIGN_DOMAINS = ['jixuwz.com', 'allen23.online', 'lopwi.cyou', 'sghd.college', 'ytu.baby'];

function domains() {
  const d = argvVal('--domains', '');
  if (d) return d.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const list = DEFAULT_DOMAINS.slice();
  if (has('--foreign')) list.push.apply(list, FOREIGN_DOMAINS); /* R144y */
  if (CONTROL) list.push('gmail.com');
  return list;
}

function md5hex(s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); }
function sign(pq, body, unix) { return md5hex(encodeURIComponent(pq) + '_' + body + md5hex(String(unix)) + 'ooui'); }
function randTok(n) { let o = ''; const cs = 'abcdefghijkmnpqrstuvwxyz23456789'; for (let i = 0; i < n; i++) o += cs[Math.floor(Math.random() * cs.length)]; return o; }

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
        res.on('end', function () { resolve({ status: res.statusCode, text: b }); });
      });
      req.on('error', reject);
      req.setTimeout(TIMEOUT, function () { req.destroy(new Error('timeout')); });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    }
    if (!proxy) return doReq(null);
    let pu; try { pu = new URL(proxy); } catch (e) { return reject(new Error('bad proxy')); }
    const cr = http.request({ host: pu.hostname, port: pu.port || 8080, method: 'CONNECT', path: u.hostname + ':' + port, headers: { host: u.hostname + ':' + port } });
    cr.on('connect', function (res, sock) {
      if (res.statusCode !== 200) return reject(new Error('proxy CONNECT ' + res.statusCode));
      if (isHttps) { const ts = tls.connect({ socket: sock, servername: u.hostname }, function () { doReq(ts); }); ts.on('error', reject); }
      else doReq(sock);
    });
    cr.on('error', reject); cr.end();
  });
}

async function probeDomain(domain) {
  const local = 'hlh' + randTok(5);
  const email = local + '@' + domain;
  const unix = Date.now();
  const q = { device_platform: 'web', app_id: '3001', version_code: '22203', biz_id: '0', unix: String(unix) };
  const qs = Object.keys(q).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
  const full = '/v1/api/user/login/email/code?' + qs + '&email=' + encodeURIComponent(email);
  const body = '{}';
  const headers = {
    'yy': sign(full, body, unix), 'accept': 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json', 'origin': BASE, 'referer': BASE + '/', 'content-length': '2',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  };
  const rec = { domain: domain, email: email, checked_at: new Date().toISOString() };
  try {
    const r = await rawRequest(BASE + full, 'POST', headers, Buffer.from(body, 'utf8'), PROXY);
    let j = null; try { j = JSON.parse(r.text); } catch (e) {}
    const si = (j && j.statusInfo) || {};
    rec.http = r.status; rec.code = si.code !== undefined ? si.code : null; rec.msg = si.message || '';
    rec.status = (rec.code === 1200019) ? 'ok' : (rec.code === 1200063) ? 'blocked' : (r.status >= 500 ? 'error' : 'unknown');
  } catch (e) {
    rec.http = 0; rec.code = null; rec.msg = String(e.message); rec.status = (String(e.message) === 'timeout') ? 'timeout' : 'error';
  }
  return rec;
}

(async function main() {
  const list = domains();
  const rows = [];
  for (const d of list) {
    const rec = await probeDomain(d);
    rows.push(rec);
    if (!JSON_ONLY) console.log('[' + new Date().toISOString() + '] ' + rec.domain.padEnd(18) + ' -> ' + rec.status.padEnd(8) + ' code=' + rec.code + ' ' + String(rec.msg).slice(0, 48));
    await new Promise(function (r) { setTimeout(r, 1200); });
  }
  const domainsMap = {};
  rows.forEach(function (r) { domainsMap[r.domain] = { status: r.status, code: r.code, msg: r.msg, checked_at: r.checked_at }; });
  const doc = { version: 1, updated_at: new Date().toISOString(), base: BASE, proxy: PROXY ? 'enabled' : 'disabled', results: rows, domains: domainsMap };
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(doc, null, 1), 'utf8'); } catch (e) { console.error('write fail: ' + e.message); }
  const ok = rows.filter(function (r) { return r.status === 'ok'; }).map(function (r) { return r.domain; });
  const blocked = rows.filter(function (r) { return r.status === 'blocked'; }).map(function (r) { return r.domain; });
  if (JSON_ONLY) console.log(JSON.stringify(doc, null, 1));
  console.log('=== ok(' + ok.length + '): ' + ok.join(', '));
  console.log('=== blocked(' + blocked.length + '): ' + blocked.join(', '));
  console.log('=== out: ' + OUT);
})();