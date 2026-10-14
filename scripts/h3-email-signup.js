/*
 * h3-email-signup.js —— 海外海螺(MiniMax Hub / Hailuo H3) 邮箱验证码注册·补号脚本
 *
 *  流程: 取信箱 -> 触发发码(login/sms/send 带 email) -> mailfarm 读码 -> login/email 换 token
 *
 *  用法:
 *    node scripts/h3-email-signup.js --n 1
 *  环境变量:
 *    MF_BASE   mailfarm 地址, 默认 http://127.0.0.1:8099
 *    MF_KEY    mailfarm api key (必填)
 *    MF_DOMAIN 信箱域名, 默认 qingzhou.autos
 *    H3_HOST   目标站, 默认 hailuoai.video
 *    H3_LANG   语言, 默认 en
 *    OUT       结果文件, 默认 h3-accounts.jsonl
 */
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const md5 = s => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
const uuid4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const CFG = {
  n: Number(argOf('n', '1')),
  prefix: argOf('prefix', 'hlh3'),
  mfBase: process.env.MF_BASE || 'http://114.66.16.225:8099',
  mfKey: process.env.MF_KEY || '',
  domain: process.env.MF_DOMAIN || 'qingzhou.autos',
  host: process.env.H3_HOST || 'hailuoai.video',
  lang: process.env.H3_LANG || 'en',
  out: process.env.OUT || 'h3-accounts.jsonl',
};

/* ---------- H3 签名 ---------- */
function signedUrl(path, body) {
  const t = Date.now();
  const q = {
    device_platform: 'web', app_id: '3001', version_code: '22203', biz_id: '0',
    unix: String(t), lang: CFG.lang, uuid: uuid4(),
    os_name: 'Windows', browser_name: 'Chrome', browser_language: CFG.lang === 'en' ? 'en-US' : 'zh-CN',
    browser_platform: 'Win32', screen_width: '1920', screen_height: '1080',
    device_id: String(Math.floor(Math.random() * 1e18)),
  };
  const qs = Object.keys(q).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
  const full = path + (path.includes('?') ? '&' : '?') + qs;
  const bs = (body && Object.keys(body).length) ? JSON.stringify(body) : '{}';
  return { full, bs, yy: md5(encodeURIComponent(full) + '_' + bs + md5(String(t)) + 'ooui') };
}
function h3post(path, body, token) {
  const { full, bs, yy } = signedUrl(path, body);
  return new Promise(res => {
    const d = Buffer.from(bs, 'utf8');
    const r = https.request({
      host: CFG.host, port: 443, path: full, method: 'POST',
      headers: {
        'content-type': 'application/json', 'origin': 'https://' + CFG.host,
        'referer': 'https://' + CFG.host + '/login',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'token': token || '', 'yy': yy,
      },
    }, rsp => { let b = ''; rsp.on('data', x => b += x); rsp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ s: rsp.statusCode, json: j, raw: b.slice(0, 300) }); }); });
    r.on('error', e => res({ s: 0, json: null, raw: 'ERR ' + e.code }));
    r.write(d); r.end();
  });
}

/* ---------- mailfarm ---------- */
function mf(method, path, body) {
  const u = new URL(CFG.mfBase);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise(res => {
    const d = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = mod.request({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path, method,
      headers: Object.assign({ 'x-api-key': CFG.mfKey }, d ? { 'content-type': 'application/json', 'content-length': d.length } : {}) },
      rsp => { let b = ''; rsp.on('data', x => b += x); rsp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ s: rsp.statusCode, json: j }); }); });
    r.on('error', e => res({ s: 0, json: null, err: e.code }));
    if (d) r.write(d); r.end();
  });
}
async function acquireMailbox() {
  const r = await mf('POST', '/v1/mailboxes/acquire', { prefix: CFG.prefix, domain: CFG.domain });
  if (!r.json || !r.json.address) throw new Error('acquire failed: ' + JSON.stringify(r.json || r.err));
  return r.json.address;
}
async function waitCode(address, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 120000);
  while (Date.now() < deadline) {
    const r = await mf('GET', '/v1/mailboxes/' + encodeURIComponent(address) + '/code');
    if (r.json && r.json.code) return r.json.code;
    await sleep(2000);
  }
  return null;
}

/* ---------- 主流程 ---------- */
async function signupOne() {
  const email = await acquireMailbox();
  const t0 = Date.now();
  const send = await h3post('/v1/api/user/login/sms/send', { phone: '', email: email, ticket: '', randStr: '' });
  if (!send.json || (send.json.statusInfo && send.json.statusInfo.code !== 0)) {
    return { email, ok: false, stage: 'send', resp: send };
  }
  const code = await waitCode(email, 150000);
  if (!code) return { email, ok: false, stage: 'code-timeout', sentAt: t0 };
  const login = await h3post('/v1/api/user/login/email', { email: email, code: code });
  const si = login.json && login.json.statusInfo;
  if (!login.json || !si || si.code !== 0 || !login.json.data) {
    return { email, code, ok: false, stage: 'login', resp: login };
  }
  const d = login.json.data;
  const rec = {
    email, code, ts: Math.round(Date.now() / 1000),
    token: d.token, userID: d.userID, username: d.username,
    isRegister: d.isRegister, createTime: d.createTime, host: CFG.host,
  };
  fs.appendFileSync(CFG.out, JSON.stringify(rec) + '\n');
  return { email, code, ok: true, token: d.token, userID: d.userID, isRegister: d.isRegister, createTime: d.createTime };
}

(async () => {
  if (!CFG.mfKey) { console.error('MF_KEY required'); process.exit(2); }
  console.log('[' + new Date().toISOString() + '] h3-email-signup host=' + CFG.host + ' domain=' + CFG.domain + ' n=' + CFG.n);
  const h = await mf('GET', '/healthz');
  console.log('mailfarm healthz:', JSON.stringify(h.json));
  let okN = 0;
  for (let i = 0; i < CFG.n; i++) {
    const r = await signupOne();
    console.log((r.ok ? 'OK   ' : 'FAIL ') + r.email + (r.code ? ' code=' + r.code : '') + (r.ok ? ' userID=' + r.userID + ' isRegister=' + r.isRegister + ' token=' + String(r.token).slice(0, 24) + '...' : ' stage=' + r.stage + ' ' + JSON.stringify(r.resp || '').slice(0, 200)));
    if (r.ok) okN++;
    if (i < CFG.n - 1) await sleep(3000);
  }
  console.log('done: ' + okN + '/' + CFG.n + ' -> ' + CFG.out);
})();