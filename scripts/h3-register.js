#!/usr/bin/env node
/**
 * h3-register.js —— 海外海螺 H3 号厂（注册器骨架）
 *
 * 依据（全部实证，见 docs/豆啦啦浏览器-登录原理逆向(R142).md 与 docs/海螺H3-号厂(R142).md）：
 *   · H3 前端（hailuoai.video, prod-en-0.1.881）请求签名 yy（mod 3340 + mod 99766=blueimp-md5）：
 *       yy = MD5( encodeURIComponent(path+query) + "_" + bodyJSON + MD5(String(unix_ms)) + "ooui" )
 *     GET 无 body 时 bodyJSON = "{}";  header: yy / token(localStorage)
 *   · 默认 params: device_platform=web, app_id=3001, version_code=22203, biz_id=0, unix=<ms>
 *   · 人机校验: POST /v1/api/user/need_captcha -> {"needCaptcha":false}（实测）
 *   · 发码:     POST /v1/api/user/login/email/code   （实测存在；空 body 时 debugInfo=email verification timing metadata unavailable）
 *   · 登录/注册: POST /v1/api/user/login/email  {email, code}
 *               实测 {"email":..,"code":"123456"} -> code=1200059 "邮箱验证码错误"（=> 会校验我们提交的码）
 *   · Firebase（备用路）: projectId=hailuoai-fd23b, apiKey=AIzaSyBPpXM2acsCQqclRxSoGTtK5NYtyeX4uZY
 *
 * 零依赖（node 内置）。支持 HTTP(S) 代理（CONNECT 隧道）。
 *
 * 用法：
 *   node h3-register.js --probe                 # 只探测发码接口该传什么参数（不改任何状态）
 *   node h3-register.js --once                  # 跑一个完整号：取号->发码->读码->登录->入库
 *   node h3-register.js --count 5               # 连跑 5 个
 *   node h3-register.js --address a@b.c --code 123456    # 有码在手时直接验证登录
 *   node h3-register.js --send-only --address a@b.c      # 只发码不读
 *
 * 环境变量（都可被 config/h3-register.json 覆盖）：
 *   H3_BASE=https://hailuoai.video      H3_APP_ID=3001   H3_VERSION_CODE=22203   H3_BIZ_ID=0
 *   H3_SEND_PATH=/v1/api/user/login/email/code
 *   H3_LOGIN_PATH=/v1/api/user/login/email
 *   H3_SEND_BODY={"email":"{EMAIL}"}     # 发码 body 模板（{EMAIL} 占位），--probe 会用多种形状试探
 *   H3_SEND_EXTRA={}                    # 发码时额外合并的字段（例如 {"type":1}）
 *   H3_CODE_FIELD=code                  # 读码时取哪个字段
 *   H3_CODE_RE=                        # 自定义取码正则（不填=用内置多策略）
 *   H3_MAIL_BASE=http://127.0.0.1:8100  H3_MAIL_KEY=   H3_PREFIX=hl   H3_DOMAIN=
 *   H3_PROXY=http://127.0.0.1:10090
 *   H3_TIMEOUT_MS=120000  H3_POLL_MS=3000  H3_MAX_FAIL=5
 *   H3_STATE=state/h3-accounts.jsonl
 */
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function env(k, d) { const v = process.env[k]; return (v === undefined || v === null || String(v) === '') ? (d === undefined ? '' : d) : String(v); }
function log(m) { console.log('[' + new Date().toISOString() + '] h3 ' + m); }

let FILE_CFG = {};
(function loadFileCfg() {
  const f = env('H3_CONFIG', path.join(__dirname, '..', 'config', 'h3-register.json'));
  try { if (fs.existsSync(f)) FILE_CFG = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { log('config load fail: ' + e.message); }
})();
function cfg(k, d) { if (Object.prototype.hasOwnProperty.call(FILE_CFG, k)) return FILE_CFG[k]; return env(k, d); }

const C = {
  base: String(cfg('H3_BASE', 'https://hailuoai.video')).replace(/\/+$/, ''),
  appId: String(cfg('H3_APP_ID', '3001')),
  versionCode: String(cfg('H3_VERSION_CODE', '22203')),
  bizId: String(cfg('H3_BIZ_ID', '0')),
  sendPath: String(cfg('H3_SEND_PATH', '/v1/api/user/login/email/code')),
  loginPath: String(cfg('H3_LOGIN_PATH', '/v1/api/user/login/email')),
  sendBody: String(cfg('H3_SEND_BODY', '{"email":"{EMAIL}"}')),
  sendExtra: cfg('H3_SEND_EXTRA', '{}'),
  codeField: String(cfg('H3_CODE_FIELD', 'code')),
  queryEmail: String(cfg('H3_QUERY_EMAIL', '1')) !== '0',
  fullParams: String(cfg('H3_FULL_PARAMS', '0')) !== '0',
  verify: String(cfg('H3_VERIFY', '1')) !== '0',
  codeRe: String(cfg('H3_CODE_RE', '')),
  mailBase: String(cfg('H3_MAIL_BASE', 'http://127.0.0.1:8100')).replace(/\/+$/, ''),
  mailKey: String(cfg('H3_MAIL_KEY', '')),
  prefix: String(cfg('H3_PREFIX', 'hl')),
  domain: String(cfg('H3_DOMAIN', '')),
  proxy: String(cfg('H3_PROXY', '')),
  timeoutMs: parseInt(cfg('H3_TIMEOUT_MS', '120000'), 10),
  pollMs: parseInt(cfg('H3_POLL_MS', '3000'), 10),
  statePath: String(cfg('H3_STATE', path.join(__dirname, '..', 'state', 'h3-accounts.jsonl'))),
  ua: String(cfg('H3_UA', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'))
};

// ---------- 签名 ----------
function md5hex(s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); }
/** yy = MD5(encodeURIComponent(path+query) + "_" + body + MD5(String(unix_ms)) + "ooui") */
function sign(pathAndQuery, bodyString, unixMs) {
  const enc = encodeURIComponent(pathAndQuery);
  const inner = md5hex(String(unixMs));
  return md5hex(enc + '_' + bodyString + inner + 'ooui');
}
function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 3 | 8); return v.toString(16); }); }

// ---------- HTTP(S) + 代理（CONNECT 隧道） ----------
let DEVICE_ID = uuid();
function buildQuery(extra, fpOverride) {
  const unix = Date.now();
  const p = {
    device_platform: 'web', app_id: C.appId, version_code: C.versionCode, biz_id: C.bizId, unix: String(unix)
  };
  const useFull = (fpOverride === undefined) ? C.fullParams : !!fpOverride;
  const extra2 = (useFull ? { lang: 'en', uuid: DEVICE_ID, os_name: 'Windows', browser_name: 'Chrome',
    browser_language: 'en-US', browser_platform: 'Win32', screen_width: '1920', screen_height: '1080' } : {});
  const all = Object.assign({}, extra2, extra || {}, p);
  const qs = Object.keys(all).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(all[k]); }).join('&');
  return { unix: unix, qs: qs };
}
function rawRequest(fullUrl, method, headers, bodyBuf, proxyOverride) {
  const PROXY = (proxyOverride === undefined) ? C.proxy : proxyOverride;
  return new Promise(function (resolve, reject) {
    const u = new URL(fullUrl);
    const isHttps = u.protocol === 'https:';
    const targetPort = u.port || (isHttps ? 443 : 80);
    function doReq(socket, agentOverride) {
      const opt = {
        method: method, hostname: u.hostname, port: targetPort,
        path: u.pathname + u.search, headers: headers || {},
        agent: agentOverride === undefined ? undefined : agentOverride
      };
      if (socket) { opt.createConnection = function () { return socket; }; opt.agent = false; }
      const mod = isHttps ? https : http;
      const req = mod.request(opt, function (res) {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', function (c) { buf += c; });
        res.on('end', function () { resolve({ status: res.statusCode, text: buf, headers: res.headers }); });
      });
      req.on('error', reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    }
    if (!PROXY) return doReq(null);
    let pu;
    try { pu = new URL(PROXY); } catch (e) { return reject(new Error('bad proxy')); }
    const connectReq = http.request({ host: pu.hostname, port: pu.port || 8080, method: 'CONNECT', path: u.hostname + ':' + targetPort, headers: { host: u.hostname + ':' + targetPort } });
    connectReq.on('connect', function (res, socket) {
      if (res.statusCode !== 200) { reject(new Error('proxy CONNECT ' + res.statusCode)); return; }
      if (isHttps) {
        const tsock = tls.connect({ socket: socket, servername: u.hostname }, function () { doReq(tsock); });
        tsock.on('error', reject);
      } else { doReq(socket); }
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

/** 调用 H3 业务接口：自动拼 params + 签名 */
async function h3(method, apiPath, params, bodyObj, token, deviceId, useProxy, fpOverride) {
  const bq = buildQuery(params, fpOverride);
  /* apiPath 可能已带 ?email=...（发码实测形状）；此时用 & 续接，否则会出现两个 ??? 导致参数被判非法 */
  const full = (apiPath.indexOf('?') >= 0) ? (apiPath + '&' + bq.qs) : (apiPath + '?' + bq.qs);
  let bodyStr = '{}';
  let bodyBuf = null;
  if (method === 'POST' || method === 'DELETE') {
    bodyStr = JSON.stringify(bodyObj === undefined || bodyObj === null ? {} : bodyObj);
    bodyBuf = Buffer.from(bodyStr, 'utf8');
  }
  const yy = sign(full, bodyStr, bq.unix);
  const headers = {
    'yy': yy, 'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'origin': C.base, 'referer': C.base + '/',
    'user-agent': C.ua
  };
  if (token) headers['token'] = token;
  if (bodyBuf) headers['content-length'] = String(bodyBuf.length);
  /* 实测（R143）：发码直连(CN IP)才被接受；登录必须走代理，否则 400「请求异常」 */
  const px = (useProxy === false) ? '' : (useProxy === true ? C.proxy : undefined);
  const r = await rawRequest(C.base + full, method, headers, bodyBuf, px);
  let j = null;
  try { j = JSON.parse(r.text); } catch (e) { j = null; }
  return { status: r.status, json: j, text: r.text, headers: r.headers, yy: yy, full: full, body: bodyStr };
}

function ok(j) { return !!(j && j.statusInfo && (j.statusInfo.code === 0 || j.statusInfo.message === 'Success')); }
function info(j) { return (j && j.statusInfo) ? j.statusInfo : {}; }

// ---------- 邮箱侧 ----------
async function mail(method, p, bodyObj) {
  const headers = {};
  if (C.mailKey) headers['x-api-key'] = C.mailKey;
  const r = await rawRequest(C.mailBase + p, method, Object.assign(headers, bodyObj ? { 'content-type': 'application/json' } : {}), bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null);
  let j = null; try { j = JSON.parse(r.text); } catch (e) { j = null; }
  return { status: r.status, json: j, text: r.text };
}
async function acquireEmail(prefix) {
  // 优先「三件套」recipe，其次 acquire 透传，最后本地构造
  try {
    const r = await mail('GET', '/v1/recipe?prefix=' + encodeURIComponent(prefix || C.prefix) + (C.domain ? ('&domain=' + encodeURIComponent(C.domain)) : ''), null);
    if (r.status === 200 && r.json && r.json.address) return r.json.address;
  } catch (e) { /* ignore */ }
  try {
    const r2 = await mail('POST', '/v1/mailboxes/acquire', { prefix: prefix || C.prefix });
    if (r2.status === 200 && r2.json && r2.json.address) return r2.json.address;
  } catch (e) { /* ignore */ }
  return (prefix || C.prefix) + String(Date.now() % 1000).padStart(3, '0') + '@' + (C.domain || 'qingzhou.autos');
}

function extractCode(text, subject) {
  /* 先把 html 还原成纯文本（H3 的码是 6 个独立 span/td，展开后带空格）*/
  const plain = String(text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
  const blob = plain + ' ' + String(subject || '');
  /* ① 带空格的 6 位（H3 实测形状）：code...1 3 8 9 7 9 */
  const spaced = [/(?:code|Code|CODE)[^0-9]{0,60}((?:\d\s*){6})/, /(?:^|\s)((?:\d\s){5}\d)(?:\s|$)/];
  for (let i = 0; i < spaced.length; i++) { const m = blob.match(spaced[i]); if (m) { const c = String(m[1]).replace(/\s+/g, ''); if (/^\d{6}$/.test(c)) return c; } }
  if (C.codeRe) { const m = blob.match(new RegExp(C.codeRe, 'i')); if (m) return m[1] || m[0]; }
  const patterns = [
    /(?:code|Code|CODE|verification code|验证码|인증번호|コード)[^0-9]{0,24}(\d{4,8})/,
    /(\d{6})[^0-9]{0,24}(?:expire|expires|minutes|分钟|有效|有効)/i,
    /(?:^|[^0-9])(\d{6})(?:[^0-9]|$)/
  ];
  for (let i = 0; i < patterns.length; i++) { const m = blob.match(patterns[i]); if (m) return m[1]; }
  return null;
}
async function pollCode(address) {
  const deadline = Date.now() + C.timeoutMs;
  const seen = new Set();
  while (Date.now() < deadline) {
    try {
      const r = await mail('GET', '/api/mails?email=' + encodeURIComponent(address) + '&limit=5', null);
      const list = (r.json && r.json.mail_list) || [];
      for (const it of list) {
        const id = it.mail_id || it.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        let code = extractCode(it.subject, '');
        if (!code) {
          const det = await mail('GET', '/api/mails/' + encodeURIComponent(id) + '?email=' + encodeURIComponent(address), null);
          if (det.json) code = det.json[C.codeField] || extractCode(det.json.text, det.json.subject) || extractCode(JSON.stringify(det.json), '');
        }
        if (code) return code;
      }
    } catch (e) { /* keep polling */ }
    await new Promise(function (r2) { setTimeout(r2, C.pollMs); });
  }
  return null;
}

// ---------- 主流程 ----------
async function needCaptcha(email) {
  const r = await h3('POST', '/v1/api/user/need_captcha', null, { email: email }, null, null, false);
  return r;
}
async function sendCode(email) {
  const extra = (typeof C.sendExtra === 'string') ? (function () { try { return JSON.parse(C.sendExtra); } catch (e) { return {}; } })() : (C.sendExtra || {});
  /* 实测（R143）：email 必须放 query，body 里带 email 反而 400「请求异常，请检查请求参数」*/
  if (C.queryEmail) return h3('POST', C.sendPath + '?email=' + encodeURIComponent(email), null, extra, null, null, false);
  let body = C.sendBody.replace('{EMAIL}', email);
  let obj;
  try { obj = JSON.parse(body); } catch (e) { obj = { email: email }; }
  Object.assign(obj, extra);
  return h3('POST', C.sendPath, null, obj, null, null, false);
}
async function loginEmail(email, code) {
  return h3('POST', C.loginPath, null, { email: email, code: String(code) }, null, null, true, true);
}
function saveAccount(rec) {
  try {
    fs.mkdirSync(path.dirname(C.statePath), { recursive: true });
    fs.appendFileSync(C.statePath, JSON.stringify(rec) + '\n', 'utf8');
    return true;
  } catch (e) { log('save fail: ' + e.message); return false; }
}

async function probe() {
  const email = (await acquireEmail()).replace(/^/, '');
  log('probe address=' + email);
  const shapes = [
    { email: email },
    { email: email, type: 1 },
    { email: email, type: 2 },
    { email: email, type: 16 },
    { email: email, scene: 'login' },
    { email: email, loginType: 1 },
    { email: email, code_type: 1 },
    { email: email, needCaptcha: false },
    { email: email, aid: '', aidEncrypted: '' },
    { email: email, source: 1 }
  ];
  for (const s of shapes) {
    const r = await h3('POST', C.sendPath, null, s, null);
    const si = info(r.json);
    log('SEND ' + JSON.stringify(s) + ' -> HTTP ' + r.status + ' code=' + (si.code === undefined ? 'n/a' : si.code) + ' msg=' + JSON.stringify(si.debugInfo || si.message || r.text.slice(0, 80)));
    await new Promise(function (x) { setTimeout(x, 1200); });
  }
  const lr = await h3('POST', C.loginPath, null, { email: email, code: '000000' }, null);
  const li = info(lr.json);
  log('LOGIN probe -> HTTP ' + lr.status + ' code=' + li.code + ' msg=' + JSON.stringify(li.debugInfo || li.message));
}

async function runOne() {
  const email = await acquireEmail();
  log('1/5 取号 ' + email);
  log('2/5 人机校验 need_captcha ...');
  try { const nc = await needCaptcha(email); log('     needCaptcha=' + JSON.stringify(info(nc.json).message || '') + ' data=' + JSON.stringify((nc.json || {}).data)); } catch (e) { log('     need_captcha err ' + e.message); }
  log('3/5 发码 ' + C.sendPath);
  const s = await sendCode(email);
  const si = info(s.json);
  log('     HTTP ' + s.status + ' code=' + si.code + ' debug=' + JSON.stringify(si.debugInfo || si.message || s.text.slice(0, 120)));
  if (!ok(s.json) && s.status >= 400) { log('     发码未通过，停止（参数待定，先跑 --probe）'); return null; }
  log('4/5 读码（最多 ' + Math.round(C.timeoutMs / 1000) + 's）...');
  const code = await pollCode(email);
  if (!code) { log('     超时没读到码'); return null; }
  log('     code=' + code);
  log('5/5 登录 ' + C.loginPath);
  const l = await loginEmail(email, code);
  const li = info(l.json);
  log('     HTTP ' + l.status + ' code=' + li.code + ' msg=' + JSON.stringify(li.debugInfo || li.message));
  const data = (l.json && l.json.data) || {};
  const token = data.token || data.authToken || data.accessToken || '';
  let credit = null;
  if (token && C.verify) {
    try {
      const eq = await h3('GET', '/v1/api/user/equity', null, null, token, null, true, true);
      const ed = (eq.json && eq.json.data) || {};
      credit = { totalCredits: ed.totalCredits, isNewUser: ed.isNewUser, trialText: ed.trialText, trialExpireTime: ed.trialExpireTime, videoCost: ed.videoCost, memberName: ed.memberName };
      log('     equity: ' + JSON.stringify(credit));
    } catch (e) { log('     equity 查询失败 ' + e.message); }
  }
  const rec = { email: email, code: code, token: token, cookieSet: (l.headers && l.headers['set-cookie']) || null, user: data, credit: credit, at: new Date().toISOString(), base: C.base };
  if (saveAccount(rec)) log('     已入库 ' + C.statePath + (token ? ' (token len=' + token.length + ')' : ' (无 token)'));
  return rec;
}

(async function main() {
  const argv = process.argv.slice(2);
  const has = function (f) { return argv.indexOf(f) >= 0; };
  const val = function (f, d) { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  log('base=' + C.base + ' send=' + C.sendPath + ' login=' + C.loginPath + ' mail=' + C.mailBase + ' proxy=' + (C.proxy || '(none)'));

  if (has('--probe')) { await probe(); return; }
  const addr = val('--address', '');
  const codeIn = val('--code', '');
  if (addr && codeIn) { const r = await loginEmail(addr, codeIn); log('login -> HTTP ' + r.status + ' ' + JSON.stringify((r.json || {}).statusInfo || r.text.slice(0, 200))); if (r.json && r.json.data && r.json.data.token) saveAccount({ email: addr, code: codeIn, token: r.json.data.token, user: r.json.data, at: new Date().toISOString(), base: C.base }); return; }
  if (addr && has('--send-only')) { const r = await sendCode(addr); log('send -> HTTP ' + r.status + ' ' + JSON.stringify((r.json || {}).statusInfo || r.text.slice(0, 200))); return; }

  const n = has('--once') ? 1 : (parseInt(val('--count', '1'), 10) || 1);
  let okN = 0, failN = 0;
  for (let i = 0; i < n; i++) {
    log('===== 第 ' + (i + 1) + '/' + n + ' 个 =====');
    try { const r = await runOne(); if (r) okN++; else failN++; } catch (e) { failN++; log('异常: ' + e.message); }
    if (i < n - 1) await new Promise(function (x) { setTimeout(x, 4000); });
  }
  log('结束：成功 ' + okN + ' / 失败 ' + failN);
})();
