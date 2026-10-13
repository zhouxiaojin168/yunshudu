#!/usr/bin/env node
/**
 * mail-compat-server.js - 取号三件套适配层（把 mailfarm / imap-bridge / tempmail.plus 统一成 dola 同形接口）
 *
 * 为什么要它：豆啦啦（DolaMultiBrowser）取 CK 用的是 tempmail.plus 的形状
 *   (1) 域名池（DolaRegisterSettings.Domains: mailto.plus / fexpost.com / fexbox.org / fexbox.net / tempmail.plus）
 *   (2) 端口  (3) 邮箱前缀 =8 字符，序号 001 起续编，email = 前缀+NNN@域名
 *   (4) 读码：GET https://tempmail.plus/api/mails?email=<addr>&limit=5 -> {mail_list:[{mail_id,subject}]}
 *            GET https://tempmail.plus/api/mails/<mail_id>?email=<addr> -> {subject,text}
 * 本服务把 (1)(2)(3) 换成本地域名/端口/前缀，把 (4) 用同形字段暴露（或直接转发 tempmail.plus），
 * 于是任何“dola 风格”的注册机都能不改一行地指到我们这边（H3 号厂同理）。
 *
 * 零依赖，只用 node 内置模块。
 *
 * 环境变量：
 *   COMPAT_MODE            mailfarm（默认，上游=自建收信）| tempmail（直接白嫖 tempmail.plus 公开 API）
 *   COMPAT_HOST            默认 127.0.0.1
 *   COMPAT_PORT            默认 8100
 *   COMPAT_DOMAINS         逗号分隔域名池
 *                          （R144y）mailfarm 模式默认自有域留空，外来域见 FOREIGN_DOMAINS 黑名单
 *                          tempmail 模式默认 mailto.plus,fexpost.com,fexbox.org,fexbox.net,tempmail.plus
 *   COMPAT_PREFIX          默认 hl（邮箱前缀）
 *   COMPAT_SERIAL_START    默认 1（本地序号起点；持久化在 COMPAT_STATE）
 *   COMPAT_STATE           默认 ../state/mail-compat.json（记录下一个序号）
 *   COMPAT_UPSTREAM        mailfarm 模式上游 base，默认 http://127.0.0.1:8099
 *   COMPAT_UPSTREAM_KEY    mailfarm 模式上游 x-api-key
 *   COMPAT_TM_BASE         tempmail 模式上游，默认 https://tempmail.plus
 *   COMPAT_PROXY           HTTP 代理（CONNECT 隧道），tempmail 模式出墙可用，例如 http://127.0.0.1:10090
 *   COMPAT_API_KEY         本服务自己的 x-api-key（留空=不鉴权，仅限 127.0.0.1 时可用）
 *
 * 对外接口（dola / tempmail.plus 同形 + 自有扩展）：
 *   GET  /healthz
 *   GET  /v1/recipe?prefix=hl&domain=xxx         <- 三件套一次拿全 {domain,port,prefix,address,template,code_api}
 *   GET  /v2/domains                             <- {domains:[...],prefix,port}
 *   POST /v1/mailboxes/acquire  {prefix?}        <- 取一个邮箱
 *   GET  /v1/mailboxes/{address}/code?timeout=90 <- 等验证码 {address,code,found}
 *   GET  /v1/mailboxes/{address}/messages?limit=5
 *   GET  /api/mails?email=<addr>&limit=5          <- tempmail.plus 同形 {mail_list:[{mail_id,subject,from,date}]}
 *   GET  /api/mails/{mail_id}?email=<addr>        <- tempmail.plus 同形 {id,subject,text,code,date}
 */
'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function env(k, d) { const v = process.env[k]; return (v === undefined || v === null || String(v) === '') ? (d === undefined ? '' : d) : String(v); }
function log(m) { console.log('[' + new Date().toISOString() + '] mail-compat ' + m); }

/* R144y: 外来域黑名单 —— 这 5 个域不属我方（RDAP 同为 Spaceship 注册；公网 MX 指向 45.207.214.211 那台
   我们读不到的 mailfarm，带我方 MAILFARM_API_KEY 访问其 8099 仍 401），且实测已被 H3 判 blocked(1200063)。
   永久禁用：即使被重新写进 COMPAT_DOMAINS / MF_DOMAINS，启动时也会被剔除。 */
const FOREIGN_DOMAINS = ['jixuwz.com', 'allen23.online', 'lopwi.cyou', 'sghd.college', 'ytu.baby'];
function notForeign(d) { return FOREIGN_DOMAINS.indexOf(String(d || '').toLowerCase()) < 0; }
function dropForeign(list) {
  const kept = [], dropped = [];
  (list || []).forEach(function (d) { (notForeign(d) ? kept : dropped).push(d); });
  if (dropped.length) log('[R144y] FOREIGN_DOMAINS dropped: ' + dropped.join(','));
  return kept;
}
/* R144y: mailfarm「自有收信域」默认留空（原硬编码的 5 个外来域已移除）。新自有域写 COMPAT_DOMAINS / COMPAT_MAILFARM_DOMAINS。 */
const MAILFARM_DOMAINS = env('COMPAT_MAILFARM_DOMAINS', '');
const TEMPMAIL_DOMAINS = 'mailto.plus,fexpost.com,fexbox.org,fexbox.net,tempmail.plus';

const MODE_RAW = env('COMPAT_MODE', 'mailfarm').toLowerCase();
/* R144i: dual(=auto) = mailfarm + tempmail 双通道并存：按「地址域名」路由上游，按「域健康度」挑域 */
const MODE = (MODE_RAW === 'tempmail') ? 'tempmail' : ((MODE_RAW === 'dual' || MODE_RAW === 'auto') ? 'dual' : 'mailfarm');

const CFG = {
  mode: MODE,
  host: env('COMPAT_HOST', '127.0.0.1'),
  port: parseInt(env('COMPAT_PORT', '8100'), 10),
  domains: dropForeign(env('COMPAT_DOMAINS', MODE === 'tempmail' ? TEMPMAIL_DOMAINS : (MODE === 'dual' ? (TEMPMAIL_DOMAINS + (MAILFARM_DOMAINS ? ',' + MAILFARM_DOMAINS : '')) : MAILFARM_DOMAINS))
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean)),
  prefix: env('COMPAT_PREFIX', 'hl'),
  serialStart: parseInt(env('COMPAT_SERIAL_START', '1'), 10) || 1,
  statePath: env('COMPAT_STATE', path.join(__dirname, '..', 'state', 'mail-compat.json')),
  upstream: env('COMPAT_UPSTREAM', 'http://127.0.0.1:8099').replace(/\/+$/, ''),
  upstreamKey: env('COMPAT_UPSTREAM_KEY', ''),
  tmBase: env('COMPAT_TM_BASE', 'https://tempmail.plus').replace(/\/+$/, ''),
  /* R144i: 域健康度（由 mail-domain-health.js 产出），blocked/dead 的域不再发号 */
  healthPath: env('COMPAT_HEALTH_FILE', path.join(__dirname, '..', 'state', 'mail-domain-health.json')),
  healthMaxAgeSec: parseInt(env('COMPAT_HEALTH_MAX_AGE', '86400'), 10) || 86400,
  mailfarmDomains: dropForeign(MAILFARM_DOMAINS.split(',').map(function (s) { return s.trim(); }).filter(Boolean)),
  tempmailDomains: TEMPMAIL_DOMAINS.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
  /* R144i: 第三通道 = 自建域 -> imap-bridge（默认关；配 COMPAT_BRIDGE_DOMAINS=qingzhou.autos 即启用） */
  bridge: env('COMPAT_BRIDGE', 'http://127.0.0.1:8098').replace(/\/+$/, ''),
  bridgeKey: env('COMPAT_BRIDGE_KEY', ''),
  bridgeDomains: dropForeign(env('COMPAT_BRIDGE_DOMAINS', '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean)),
  proxy: env('COMPAT_PROXY', ''),
  rand: env('COMPAT_RAND', MODE === 'tempmail' ? '1' : '0') === '1',
  apiKey: env('COMPAT_API_KEY', ''),
  /* R144q: 域 -> 固定收信邮箱（Cloudflare 转发落地），格式 domain=mailbox@host,domain2=... */
  forwardMap: (function () {
    const m = {};
    env('COMPAT_FORWARD_MAP', '').split(',').forEach(function (pair) {
      const i = pair.indexOf('=');
      if (i <= 0) return;
      const d = pair.slice(0, i).trim().toLowerCase();
      const mb = pair.slice(i + 1).trim().toLowerCase();
      if (d && mb) m[d] = mb;
    });
    return m;
  })(),
  /* R144q: 转发落地读信的上游基址（默认同 COMPAT_UPSTREAM；跨机时指向真正收信的 mailfarm） */
  forwardBase: (env('COMPAT_FORWARD_BASE', '') || env('COMPAT_UPSTREAM', 'http://127.0.0.1:8099')).replace(/\/+$/, '')
};

/* ---------- 序号持久化（dola 语义：前缀+序号 001 起续编，重启不重号） ---------- */
let serial = CFG.serialStart;
(function loadSerial() {
  try { if (fs.existsSync(CFG.statePath)) { const j = JSON.parse(fs.readFileSync(CFG.statePath, 'utf8')); if (j && j.next_serial) serial = parseInt(j.next_serial, 10) || serial; } } catch (e) { log('state load fail: ' + e.message); }
})();
function bumpSerial() {
  const cur = serial;
  serial = serial + 1;
  try { fs.mkdirSync(path.dirname(CFG.statePath), { recursive: true }); fs.writeFileSync(CFG.statePath, JSON.stringify({ next_serial: serial, updated_at: new Date().toISOString() }, null, 1)); } catch (e) { /* 内存序继续 */ }
  return cur;
}

/* ---------- HTTP(S) 客户端（可选 CONNECT 代理） ---------- */
function rawRequest(fullUrl, method, headers, bodyBuf, proxy) {
  return new Promise(function (resolve, reject) {
    const u = new URL(fullUrl);
    const isHttps = u.protocol === 'https:';
    const targetPort = u.port || (isHttps ? 443 : 80);
    function doReq(socket) {
      const opt = { method: method, hostname: u.hostname, port: targetPort, path: u.pathname + u.search, headers: headers || {} };
      if (socket) { opt.createConnection = function () { return socket; }; opt.agent = false; }
      const mod = isHttps ? https : http;
      const req = mod.request(opt, function (res) {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', function (c) { buf += c; });
        res.on('end', function () { resolve({ status: res.statusCode, text: buf, headers: res.headers }); });
      });
      req.setTimeout(30000, function () { req.destroy(new Error('timeout')); });
      req.on('error', reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    }
    if (!proxy) return doReq(null);
    let pu;
    try { pu = new URL(proxy); } catch (e) { return reject(new Error('bad proxy: ' + proxy)); }
    const connectReq = http.request({ host: pu.hostname, port: pu.port || 8080, method: 'CONNECT', path: u.hostname + ':' + targetPort, headers: { host: u.hostname + ':' + targetPort } });
    connectReq.on('connect', function (res, socket) {
      if (res.statusCode !== 200) { reject(new Error('proxy CONNECT ' + res.statusCode)); return; }
      if (isHttps) { const tsock = tls.connect({ socket: socket, servername: u.hostname }, function () { doReq(tsock); }); tsock.on('error', reject); }
      else doReq(socket);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

function reqJson(fullUrl, method, headers, bodyObj, proxy) {
  const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
  const h = Object.assign({}, headers || {});
  if (payload) { h['content-type'] = 'application/json'; h['content-length'] = String(payload.length); }
  return rawRequest(fullUrl, method, h, payload, proxy).then(function (r) {
    let j = null;
    try { j = JSON.parse(r.text); } catch (e) { j = null; }
    return { status: r.status, json: j, text: r.text };
  });
}

function up(pathAndQuery, method, bodyObj, base, key) {
  const h = {};
  const k = (key === undefined) ? CFG.upstreamKey : key;
  if (k) h['x-api-key'] = k;
  /* R144i: base 省略 = 老行为（mailfarm 8099）；bridge 通道走 imap-bridge */
  return reqJson((base || CFG.upstream) + pathAndQuery, method || 'GET', h, bodyObj, '');
}
/* R144i: 按通道选上游 —— mailfarm=8099 / bridge=imap-bridge / tempmail=tempmail.plus */
function upChannel(channel, pathAndQuery, method, bodyObj) {
  if (channel === 'tempmail') return tm(pathAndQuery, method);
  if (channel === 'bridge') return up(pathAndQuery, method, bodyObj, CFG.bridge, CFG.bridgeKey);
  return up(pathAndQuery, method, bodyObj);
}
function tm(pathAndQuery, method) {
  const h = { 'accept': 'application/json, text/plain, */*', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36' };
  return reqJson(CFG.tmBase + pathAndQuery, method || 'GET', h, null, CFG.proxy);
}
/* 注意：CFG.proxy 也可用于 mailfarm 上游（同机房流量走本机代理纯属多余，故上游固定直连） */

/* ---------- 取码正则（与 dola 号厂同优先级） ---------- */
const CODE_RES = [
  /(?:code|Code|CODE)[^0-9]{0,20}(\d{6})/,
  /verification code[^0-9]{0,20}(\d{6})/i,
  /(?:is|:)\s*(\d{6})/,
  /\b(\d{6})\b/
];
function extractCode(text) {
  const s = String(text || '');
  for (const re of CODE_RES) { const m = s.match(re); if (m) return m[1]; }
  return null;
}

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(b.length), 'access-control-allow-origin': '*' });
  res.end(b);
}
function badKey(req) {
  if (!CFG.apiKey) return false;
  const k = req.headers['x-api-key'] || req.headers['authorization'] || '';
  return String(k).replace(/^Bearer\s+/i, '') !== CFG.apiKey;
}
/* R144i: 地址域名 -> 上游通道 */
function channelOf(domain) {
  const d = String(domain || '').toLowerCase();
  if (CFG.mailfarmDomains.indexOf(d) >= 0) return 'mailfarm';
  if (CFG.bridgeDomains.indexOf(d) >= 0) return 'bridge';
  if (CFG.tempmailDomains.indexOf(d) >= 0) return 'tempmail';
  return CFG.mode === 'mailfarm' ? 'mailfarm' : 'tempmail';
}
/* R144q: 该域是否已转发到固定邮箱 */
function forwardOf(domain) {
  const d = String(domain || '').toLowerCase();
  return (CFG.forwardMap && CFG.forwardMap[d]) || '';
}
function fwdMatch(msg, target) {
  const hay = [msg.to, msg.delivered_to, msg.rcpt].filter(Boolean).join(' ').toLowerCase();
  if (!hay) return true;  /* 上游没给原始收件人 -> 不过滤，避免漏信 */
  return hay.indexOf(String(target).toLowerCase()) >= 0;
}
async function fwdFetch(mailbox, limit) {
  const r = await up('/v1/mailboxes/' + encodeURIComponent(mailbox) + '/messages?limit=' + (limit || 50), 'GET', null, CFG.forwardBase, CFG.upstreamKey);
  return (r.json && r.json.messages) || [];
}
/* R144q: 转发落地读信（mailbox = 固定邮箱，按原始收件人 target 过滤） */
async function handleForwardedRead(addr, mailbox, kind, q, res) {
  const target = String(addr).toLowerCase();
  const limit = Math.min(parseInt(q.get('limit') || '20', 10) || 20, 200);
  const timeoutS = Math.min(parseInt(q.get('timeout') || '90', 10) || 90, 300);
  const deadline = Date.now() + timeoutS * 1000;
  try {
    if (kind === 'code') {
      for (;;) {
        const all = await fwdFetch(mailbox, 50);
        const mine = all.filter(function (m) { return fwdMatch(m, target); });
        for (let i = mine.length - 1; i >= 0; i--) {
          const c = (mine[i].codes && mine[i].codes[0]) || extractCode(mine[i].text || '') || extractCode(mine[i].subject || '');
          if (c) return json(res, 200, { address: target, code: c, found: true, via: 'forward', mailbox: mailbox });
        }
        if (Date.now() >= deadline) return json(res, 200, { address: target, code: null, found: false, via: 'forward', mailbox: mailbox });
        await new Promise(function (r2) { setTimeout(r2, 1000); });
      }
    }
    const all = await fwdFetch(mailbox, limit);
    const mine = all.filter(function (m) { return fwdMatch(m, target); });
    return json(res, 200, { address: target, via: 'forward', mailbox: mailbox, count: mine.length, messages: mine.slice(-limit).reverse() });
  } catch (e) {
    return json(res, 502, { detail: 'forward upstream error: ' + e.message, mailbox: mailbox });
  }
}
/* R144i: 读域健康度（过期即忽略，避免陈旧结论锁死通道） */
function loadDomainHealth() {
  try {
    if (!fs.existsSync(CFG.healthPath)) return {};
    const j = JSON.parse(fs.readFileSync(CFG.healthPath, 'utf8'));
    const age = (Date.now() - Date.parse(j.updated_at || 0)) / 1000;
    if (!(age >= 0) || age > CFG.healthMaxAgeSec) return { _stale: true };
    return j.domains || {};
  } catch (e) { return {}; }
}
function domainUsable(domain, health) {
  const h = (health || {})[String(domain || '').toLowerCase()];
  if (!h) return true;
  return h.status !== 'blocked' && h.status !== 'dead';
}
function pickDomain(want) {
  const health = loadDomainHealth();
  const w = String(want || '').toLowerCase();
  if (w && CFG.domains.indexOf(w) >= 0 && domainUsable(w, health)) return w;
  const good = CFG.domains.filter(function (d) { return domainUsable(d, health); });
  return good[0] || CFG.domains[0] || 'example.com';
}
/* R144i: 取号前选通道 —— dual 下优先挑「健康且能收码」的 tempmail 域，避开被判 blocked 的 mailfarm 域 */
function pickChannel(want) {
  if (CFG.mode === 'tempmail') return 'tempmail';
  if (CFG.mode === 'mailfarm') return 'mailfarm';
  const w = String(want || '').toLowerCase();
  if (w) return channelOf(w);
  return 'tempmail';
}
function readBody(req) {
  return new Promise(function (resolve) {
    let buf = '';
    req.on('data', function (c) { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', function () { let j = null; try { j = buf ? JSON.parse(buf) : null; } catch (e) { j = null; } resolve(j); });
  });
}
function randTok(n) { let o = ''; const cs = 'abcdefghijkmnpqrstuvwxyz23456789'; for (let i = 0; i < n; i++) o += cs[Math.floor(Math.random() * cs.length)]; return o; }
function localAddress(prefix, domain) { return prefix + String(bumpSerial()).padStart(3, '0') + (CFG.rand ? randTok(4) : '') + '@' + domain; }
/* tempmail.plus 是公共收件箱：先查干净再用，避免读到别人的旧邮件 */
async function acquireTempmail(prefix, wantDomain) {
  for (let i = 0; i < 5; i++) {
    const domain = pickDomain(wantDomain);
    const addr = localAddress(prefix, domain);
    try {
      const r = await tm('/api/mails?email=' + encodeURIComponent(addr) + '&limit=1', 'GET');
      const list = (r.json && r.json.mail_list) || [];
      if (!list.length) return { address: addr, domain: domain };
      log('tempmail 已有旧邮件，换号: ' + addr + ' (' + list.length + ')');
    } catch (e) { return { address: addr, domain: domain, warn: 'clean-check failed: ' + e.message }; }
  }
  const domain = pickDomain(wantDomain);
  return { address: localAddress(prefix, domain), domain: domain, warn: 'clean-check exhausted' };
}

/* tempmail.plus 列表 -> dola 同形 mail_list */
function toMailList(address, list, limit) {
  const arr = (list || []).slice(0, limit || 5);
  return arr.map(function (m, i) {
    return {
      mail_id: String(m.mail_id !== undefined ? m.mail_id : (m.id !== undefined ? m.id : (i + 1))),
      id: String(m.mail_id !== undefined ? m.mail_id : (m.id !== undefined ? m.id : (i + 1))),
      subject: m.subject || '', from: m.from || '', date: m.date || m.received_at || '', to: address
    };
  });
}
function fromMailfarm(address, messages, limit) {
  const arr = (messages || []).slice(0, limit || 5);
  return arr.map(function (m, i) {
    return { mail_id: String(i + 1), id: String(i + 1), subject: m.subject || '', from: m.from || '', date: m.received_at || m.date || '', seen: !!m.seen, to: address };
  });
}

const server = http.createServer(async function (req, res) {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { return json(res, 400, { detail: 'bad url' }); }
  const p = decodeURIComponent(u.pathname);
  const q = u.searchParams;
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); return res.end(); }

  if (method === 'GET' && p === '/healthz') {
    return json(res, 200, {
      ok: true, service: 'mail-compat', version: '1.3.0', mode: CFG.mode, domains: CFG.domains, prefix: CFG.prefix,
      channels: { mailfarm: CFG.mailfarmDomains, tempmail: CFG.tempmailDomains, bridge: CFG.bridgeDomains }, foreign_domains: FOREIGN_DOMAINS, forward_map: CFG.forwardMap, domain_health: loadDomainHealth(),
      port: CFG.port, next_serial: serial, rand: CFG.rand, upstream: CFG.mode === 'tempmail' ? CFG.tmBase : CFG.upstream,
      proxy: CFG.proxy ? 'enabled' : 'disabled', api_key: CFG.apiKey ? 'enabled' : 'disabled'
    });
  }

  /* 三件套：域名 + 端口 + 前缀 -> 直接给一个可用地址 */
  if (method === 'GET' && p === '/v1/recipe') {
    if (badKey(req)) return json(res, 401, { detail: 'bad api key' });
    const prefix = (q.get('prefix') || CFG.prefix || 'hl').trim();
    const wantDomain = (q.get('domain') || '').trim();
    let address = '', domain = pickDomain(wantDomain);
    const _ch = pickChannel(wantDomain);
    if (_ch === 'mailfarm' || _ch === 'bridge') {
      try {
        const r = await upChannel(_ch, '/v1/mailboxes/acquire', 'POST', { prefix: prefix });
        if (r.status === 200 && r.json && r.json.address) { address = r.json.address; domain = address.split('@')[1] || domain; }
      } catch (e) { /* 上游不可用时退回本地构造（catch-all 时仍能收） */ }
    }
    if (!address) {
      if (_ch === 'tempmail') { const a = await acquireTempmail(prefix, wantDomain); address = a.address; domain = a.domain; }
      else address = localAddress(prefix, domain);
    }
    return json(res, 200, {
      mode: CFG.mode, domain: domain, port: CFG.port, prefix: prefix, address: address,
      template: prefix + '{NNN}@' + domain, domains: CFG.domains,
      code_api: 'GET /api/mails?email=' + address + '&limit=5',
      code_api_detail: 'GET /api/mails/{mail_id}?email=' + address
    });
  }

  if (method === 'GET' && p === '/v1/channels') {
    if (badKey(req)) return json(res, 401, { detail: 'bad api key' });
    return json(res, 200, { mode: CFG.mode, channels: { mailfarm: CFG.mailfarmDomains, tempmail: CFG.tempmailDomains, bridge: CFG.bridgeDomains }, foreign_domains: FOREIGN_DOMAINS, forward_map: CFG.forwardMap, domains: CFG.domains, health: loadDomainHealth() });
  }

  if (method === 'GET' && p === '/v2/domains') {
    if (badKey(req)) return json(res, 401, { detail: 'bad api key' });
    return json(res, 200, { mode: CFG.mode, domains: CFG.domains, prefix: CFG.prefix, port: CFG.port, template: CFG.prefix + '{NNN}@{domain}' });
  }

  if (method === 'POST' && p === '/v1/mailboxes/acquire') {
    if (badKey(req)) return json(res, 401, { detail: 'bad api key' });
    const b = (await readBody(req)) || {};
    const prefix = (b.prefix || CFG.prefix || 'hl').trim();
    const _ch = pickChannel((b.domain || '').trim());
    if (_ch === 'mailfarm' || _ch === 'bridge') {
      try { const r = await upChannel(_ch, '/v1/mailboxes/acquire', 'POST', { prefix: prefix }); return json(res, r.status, r.json || { detail: r.text }); }
      catch (e) { return json(res, 502, { detail: 'upstream error: ' + e.message }); }
    }
    const a = await acquireTempmail(prefix, (b.domain || '').trim());
    return json(res, 200, { address: a.address, domain: a.domain, mode: CFG.mode, warn: a.warn });
  }

  /* 透传（仅 mailfarm 模式）：/v1/mailboxes/{addr}/code|messages */
  let m = p.match(/^\/v1\/mailboxes\/(.+)\/(code|messages)$/);
  if (m && method === 'GET') {
    if (badKey(req)) return json(res, 401, { detail: 'bad api key' });
    const addr = m[1], kind = m[2];
    const _fx = forwardOf(addr.split('@')[1] || '');
    if (_fx) return handleForwardedRead(addr, _fx, kind, q, res);
    const _ch = channelOf(addr.split('@')[1] || '');
    if (_ch !== 'tempmail') {
      const suffix = kind === 'code' ? ('?timeout=' + encodeURIComponent(q.get('timeout') || '90')) : ('?limit=' + encodeURIComponent(q.get('limit') || '5'));
      try { const r = await upChannel(_ch, '/v1/mailboxes/' + encodeURIComponent(addr) + '/' + kind + suffix, 'GET', null); return json(res, r.status, r.json || { detail: r.text }); }
      catch (e) { return json(res, 502, { detail: 'upstream error: ' + e.message }); }
    }
    /* tempmail 模式：本地轮询实现 code / messages */
    for (let i = 0; i < 2; i++) { /* noop: 保持结构清晰 */ }
    return handleTempmailRead(addr, kind, q, res);
  }

  /* tempmail.plus 同形：列表 */
  if (method === 'GET' && p === '/api/mails') {
    const addr = q.get('email') || '';
    const limit = parseInt(q.get('limit') || '5', 10) || 5;
    if (!addr) return json(res, 400, { detail: 'email required' });
    const _fwd1 = forwardOf(addr.split('@')[1] || '');
    if (_fwd1) {
      try {
        const all = await fwdFetch(_fwd1, 50);
        const mine = all.filter(function (m) { return fwdMatch(m, addr); });
        return json(res, 200, { mail_list: fromMailfarm(addr, mine.slice(-limit).reverse(), limit), email: addr, count: mine.length, via: 'forward', mailbox: _fwd1 });
      } catch (e) { return json(res, 200, { mail_list: [], email: addr, detail: 'forward upstream error: ' + e.message }); }
    }
    if (channelOf(addr.split('@')[1] || '') === 'tempmail') {
      try {
        const r = await tm('/api/mails?email=' + encodeURIComponent(addr) + '&limit=' + limit, 'GET');
        const j = r.json || {};
        return json(res, 200, { mail_list: toMailList(addr, j.mail_list || [], limit), email: addr, count: (j.mail_list || []).length });
      } catch (e) { return json(res, 200, { mail_list: [], email: addr, detail: 'upstream error: ' + e.message }); }
    }
    try {
      const r = await upChannel(channelOf(addr.split('@')[1] || ''), '/v1/mailboxes/' + encodeURIComponent(addr) + '/messages?limit=' + limit, 'GET', null);
      const msgs = (r.json && r.json.messages) || [];
      return json(res, 200, { mail_list: fromMailfarm(addr, msgs, limit), email: addr, count: msgs.length });
    } catch (e) { return json(res, 200, { mail_list: [], email: addr, detail: 'upstream error: ' + e.message }); }
  }

  /* tempmail.plus 同形：详情（含 text 与抽好的 code） */
  let d = p.match(/^\/api\/mails\/([^\/]+)$/);
  if (d && method === 'GET') {
    const addr = q.get('email') || '';
    const id = d[1];
    if (!addr) return json(res, 400, { detail: 'email required' });
    const _fwd2 = forwardOf(addr.split('@')[1] || '');
    if (_fwd2) {
      try {
        const all = await fwdFetch(_fwd2, 50);
        const mine = all.filter(function (m) { return fwdMatch(m, addr); });
        const idx = parseInt(id, 10);
        const hit = mine[mine.length - (idx || 1)] || mine[mine.length - 1] || null;
        if (!hit) return json(res, 200, { id: id, subject: '', text: '', code: null, found: false, via: 'forward' });
        const text = hit.text || hit.preview || '';
        const code = (hit.codes && hit.codes[0]) || extractCode(text) || extractCode(hit.subject || '');
        return json(res, 200, { id: id, subject: hit.subject || '', text: text, html: '', from: hit.from || hit.sender || '', date: hit.received_at || '', code: code, found: !!code, via: 'forward' });
      } catch (e) { return json(res, 200, { id: id, subject: '', text: '', code: null, detail: 'forward upstream error: ' + e.message }); }
    }
    if (channelOf(addr.split('@')[1] || '') === 'tempmail') {
      try {
        const r = await tm('/api/mails/' + encodeURIComponent(id) + '?email=' + encodeURIComponent(addr), 'GET');
        const j = r.json || {};
        const text = j.text || j.body || j.message || '';
        const code = j.code || extractCode(text) || extractCode(j.subject || '');
        return json(res, 200, { id: id, subject: j.subject || '', text: text, html: j.html || '', from: j.from || '', date: j.date || '', code: code, found: !!code });
      } catch (e) { return json(res, 200, { id: id, subject: '', text: '', code: null, detail: 'upstream error: ' + e.message }); }
    }
    try {
      const r = await upChannel(channelOf(addr.split('@')[1] || ''), '/v1/mailboxes/' + encodeURIComponent(addr) + '/messages?limit=50', 'GET', null);
      const msgs = (r.json && r.json.messages) || [];
      const idx = parseInt(id, 10);
      const hit = msgs[idx - 1] || msgs[0] || null;
      if (!hit) return json(res, 200, { id: id, subject: '', text: '', code: null, found: false });
      const text = hit.text || hit.body || hit.preview || '';
      const code = hit.code || extractCode(text) || extractCode(hit.subject || '');
      return json(res, 200, { id: id, subject: hit.subject || '', text: text, html: hit.html || '', from: hit.from || '', date: hit.received_at || '', code: code, found: !!code });
    } catch (e) { return json(res, 200, { id: id, subject: '', text: '', code: null, detail: 'upstream error: ' + e.message }); }
  }

  return json(res, 404, { detail: 'Not Found', path: p });
});

/* tempmail 模式的等码：轮询 /api/mails + 详情，抽 6 位码 */
async function handleTempmailRead(addr, kind, q, res) {
  const limit = parseInt(q.get('limit') || '5', 10) || 5;
  const timeoutS = Math.min(parseInt(q.get('timeout') || '90', 10) || 90, 300);
  const started = Date.now();
  let last = { mail_list: [] };
  while (true) {
    try {
      const r = await tm('/api/mails?email=' + encodeURIComponent(addr) + '&limit=' + limit, 'GET');
      const j = r.json || {};
      const list = j.mail_list || [];
      last = { mail_list: toMailList(addr, list, limit) };
      if (kind === 'messages' && list.length) return json(res, 200, { address: addr, count: list.length, messages: list.map(function (x) { return { subject: x.subject, from: x.from, date: x.date, text: x.text || '', code: x.code || null }; }) });
      for (const it of last.mail_list) {
        let code = extractCode(it.subject);
        let text = '';
        if (!code) {
          const dr = await tm('/api/mails/' + encodeURIComponent(it.mail_id) + '?email=' + encodeURIComponent(addr), 'GET');
          const dj = dr.json || {};
          text = dj.text || dj.body || '';
          code = dj.code || extractCode(text) || extractCode(dj.subject || '');
        }
        if (code) return json(res, 200, { address: addr, code: code, found: true, subject: it.subject, text: text.slice(0, 500) });
      }
    } catch (e) { last.last_error = e.message; }
    if (Date.now() - started > timeoutS * 1000) return json(res, 200, { address: addr, code: null, found: false, waited_s: timeoutS, last: last });
    await new Promise(function (x) { setTimeout(x, 3000); });
  }
}

server.listen(CFG.port, CFG.host, function () {
  log('1.1.0 listening http://' + CFG.host + ':' + CFG.port + ' mode=' + CFG.mode);
  log('domains=' + CFG.domains.join(',') + ' prefix=' + CFG.prefix + ' next_serial=' + serial + ' upstream=' + (CFG.mode === 'tempmail' ? CFG.tmBase : CFG.upstream) + ' proxy=' + (CFG.proxy || '-') + ' api_key=' + (CFG.apiKey ? 'enabled' : 'disabled'));
});