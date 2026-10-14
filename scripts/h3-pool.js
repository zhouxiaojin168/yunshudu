/**
 * h3-pool.js -- 海外海螺(Minimax Hub / hailuoai.video) 「号池批量补号」并发器
 *
 * 用法:
 *   node scripts/h3-pool.js --n 100 --concurrency 8 --retries 3
 *
 * 参数:
 *   --n            目标注册数量 (默认 1)
 *   --concurrency  并发数 (默认 6)
 *   --retries      每个号的失败重试次数 (默认 3)
 *   --stagger      任务启动间隔 ms (默认 600)
 *   --code-timeout 等验证码秒数 (默认 120)
 *   --backoff      退避基数 ms (默认 3000, 指数: base*2^(attempt-1), 上限 30000)
 *   --cooldown     全局冷却 ms (命中风控/限速时暂停所有 worker, 默认 60000)
 *   --out          成功号池 jsonl (默认 h3-accounts.jsonl)
 *   --failed       失败明细 jsonl (默认 <out>.failed.jsonl)
 *   --prefix       信箱前缀 (默认 hlh3)
 *   --domain       信箱域名 (默认 MF_DOMAIN 或 qingzhou.autos)
 * 环境变量:
 *   MF_BASE (默认 http://114.66.16.225:8099) / MF_KEY (必填) / MF_DOMAIN
 *   H3_HOST (默认 hailuoai.video) / H3_LANG (默认 en) / OUT
 *
 * 产物:
 *   <out>            每行一个号: {email, code, ts, token, userID, username, isRegister, host, uuid, device_id, equity}
 *   <out>.failed     每行一次失败: {email, attempt, stage, code, message, ts}
 *   runtime/evidence/h3-pool-run-<ts>.json  本轮统计
 */
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const md5 = s => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
const uuid4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const C = {
  n: Number(argOf('n', '1')),
  concurrency: Number(argOf('concurrency', '6')),
  retries: Number(argOf('retries', '3')),
  stagger: Number(argOf('stagger', '600')),
  codeTimeout: Number(argOf('code-timeout', '120')),
  backoff: Number(argOf('backoff', '3000')),
  cooldown: Number(argOf('cooldown', '60000')),
  out: argOf('out', process.env.OUT || 'h3-accounts.jsonl'),
  failed: argOf('failed', ''),
  prefix: argOf('prefix', 'hlh3'),
  domain: process.env.MF_DOMAIN || 'qingzhou.autos',
  mfBase: process.env.MF_BASE || 'http://114.66.16.225:8099',
  mfKey: process.env.MF_KEY || '',
  host: process.env.H3_HOST || 'hailuoai.video',
  lang: process.env.H3_LANG || 'en',
};
if (!C.failed) C.failed = C.out + '.failed';
const EVID = path.resolve(__dirname, '..', 'runtime', 'evidence');
fs.mkdirSync(EVID, { recursive: true });

/* ---------------- H3 签名 + 请求 ---------------- */
function signedUrl(pathname, body, method, acct) {
  const t = Date.now();
  const q = {
    device_platform: 'web', app_id: '3001', version_code: '22203', biz_id: '0',
    unix: String(t), lang: C.lang, uuid: acct.uuid,
    os_name: 'Windows', browser_name: 'Chrome',
    browser_language: C.lang === 'en' ? 'en-US' : 'zh-CN',
    browser_platform: 'Win32', screen_width: '1920', screen_height: '1080',
    device_id: acct.device_id,
  };
  const qs = Object.keys(q).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
  const full = pathname + (pathname.includes('?') ? '&' : '?') + qs;
  const bs = (method === 'POST' || method === 'DELETE') ? JSON.stringify(body == null ? {} : body) : '{}';
  return { full, bs, yy: md5(encodeURIComponent(full) + '_' + bs + md5(String(t)) + 'ooui') };
}
function h3(method, pathname, body, acct) {
  const s = signedUrl(pathname, body, method, acct);
  return new Promise(res => {
    const d = (method === 'POST' || method === 'DELETE') ? Buffer.from(s.bs, 'utf8') : null;
    const r = https.request({
      host: C.host, port: 443, path: s.full, method,
      headers: {
        'content-type': 'application/json', origin: 'https://' + C.host,
        referer: 'https://' + C.host + '/login',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        token: acct.token || '', yy: s.yy,
      },
    }, rsp => {
      let b = ''; rsp.on('data', x => b += x);
      rsp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ http: rsp.statusCode, j, raw: b.slice(0, 400) }); });
    });
    r.on('error', e => res({ http: 0, j: null, raw: 'ERR ' + (e.code || e.message) }));
    if (d) r.write(d);
    r.end();
  });
}
const codeOf = r => (r.j && r.j.statusInfo ? Number(r.j.statusInfo.code) : NaN);
const msgOf = r => (r.j && r.j.statusInfo ? String(r.j.statusInfo.message || '') : String(r.raw || '').slice(0, 200));

/* 判定是否风控/限速（触发全局冷却） */
const RATE_PAT = /(频繁|限流|限速|稍后|过快|too\s*many|rate\s*limit|frequent|busy|try\s*again|操作太|captcha|验证)/i;
function looksRateLimited(r) {
  if (r.http === 429) return true;
  const m = msgOf(r);
  return RATE_PAT.test(m);
}

/* ---------------- mailfarm ---------------- */
function mf(method, p, body) {
  const u = new URL(C.mfBase);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise(res => {
    const d = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = mod.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: p, method,
      headers: Object.assign({ 'x-api-key': C.mfKey, 'accept': 'application/json' },
        d ? { 'content-type': 'application/json', 'content-length': d.length } : {}),
    }, rsp => { let b = ''; rsp.on('data', x => b += x); rsp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ http: rsp.statusCode, j, raw: b.slice(0, 300) }); }); });
    r.on('error', e => res({ http: 0, j: null, raw: 'ERR ' + (e.code || e.message) }));
    if (d) r.write(d);
    r.end();
  });
}
/* 信箱池：批量预取，供 worker 抢用 */
const mbQueue = [];
let mbLock = Promise.resolve();
function nextMailbox() {
  const job = mbLock.then(async () => {
    if (!mbQueue.length) {
      const want = Math.min(50, Math.max(5, C.concurrency * 3));
      const r = await mf('POST', '/v1/mailboxes/acquire_batch', { n: want, prefix: C.prefix });
      const boxes = (r.j && r.j.mailboxes) || [];
      boxes.forEach(b => mbQueue.push(b.address));
      if (!boxes.length) throw new Error('acquire_batch failed: ' + JSON.stringify(r.j || r.raw));
    }
    return mbQueue.shift();
  });
  mbLock = job.then(() => {}, () => {});
  return job;
}
async function readCode(address, timeoutS) {
  const t = Math.max(1, Math.min(120, timeoutS));
  const r = await mf('GET', '/v1/mailboxes/' + encodeURIComponent(address) + '/code?timeout=' + t);
  return (r.j && r.j.code) || null;
}

/* ---------------- 单号注册 ---------------- */
function newAcct() { return { token: '', uuid: uuid4(), device_id: String(Math.floor(Math.random() * 1e18)) }; }

async function sendCode(email, acct) {
  return h3('POST', '/v1/api/user/login/sms/send', { phone: '', email, ticket: '', randStr: '' }, acct);
}
async function loginByCode(email, code, acct) {
  return h3('POST', '/v1/api/user/login/email', { email, code }, acct);
}
async function fetchEquity(acct) {
  const r = await h3('GET', '/v1/api/user/equity', null, acct);
  const d = r.j && r.j.data;
  if (!d) return null;
  return {
    totalCredits: d.totalCredits, videoCost: d.videoCost, isNewUser: d.isNewUser,
    trialExpireTime: d.trialExpireTime, memberName: d.memberName, privilegeType: d.privilegeType,
  };
}

/* 一次完整注册尝试：发码 -> 等码 -> 换token -> 取额度 */
async function signupWithBox(box, acct) {
  const send = await sendCode(box, acct);
  if (codeOf(send) !== 0) {
    return { ok: false, stage: 'send', http: send.http, code: codeOf(send), message: msgOf(send), rate: looksRateLimited(send), raw: send.raw };
  }
  const code = await readCode(box, C.codeTimeout);
  if (!code) return { ok: false, stage: 'code-timeout', rate: false, message: 'no code in ' + C.codeTimeout + 's' };
  return finishLogin(box, code, acct, send);
}
async function resumeWithBox(box, acct) {
  const code = await readCode(box, 90);
  if (!code) return { ok: false, stage: 'code-timeout-2', rate: false, message: 'still no code' };
  return finishLogin(box, code, acct, { http: 0, j: { statusInfo: { code: 0 } } });
}
async function finishLogin(box, code, acct, sendResp) {
  const login = await loginByCode(box, code, acct);
  const si = login.j && login.j.statusInfo;
  if (!si || Number(si.code) !== 0 || !login.j.data) {
    return { ok: false, stage: 'login', http: login.http, code: codeOf(login), message: msgOf(login), rate: looksRateLimited(login), raw: login.raw, codeVal: code };
  }
  const d = login.j.data;
  acct.token = d.token;
  const equity = await fetchEquity(acct);
  return {
    ok: true, code, rec: {
      email: box, code, ts: Math.round(Date.now() / 1000), token: d.token, userID: d.userID,
      username: d.username, isRegister: d.isRegister, createTime: d.createTime,
      host: C.host, uuid: acct.uuid, device_id: acct.device_id, equity,
      sendHttp: sendResp && sendResp.http,
    },
  };
}

/* ---------------- 调度（并发 + 退避 + 重试 + 全局冷却） ---------------- */
const STATS = { started: new Date().toISOString(), ok: 0, fail: 0, attempts: 0, stages: {}, latencies: [], costMs: 0 };
function bump(stage) { STATS.stages[stage] = (STATS.stages[stage] || 0) + 1; }
let cooldownUntil = 0;
let rateStreak = 0;
function tripCooldown(ms, why) {
  const until = Date.now() + ms;
  if (until > cooldownUntil) {
    cooldownUntil = until;
    console.log('  [COOLDOWN] ' + Math.round(ms / 1000) + 's 因: ' + why);
  }
}
async function waitCooldown() {
  while (Date.now() < cooldownUntil) await sleep(Math.min(3000, cooldownUntil - Date.now()));
}
const backoffMs = a => Math.min(30000, C.backoff * Math.pow(2, a - 1)) + Math.floor(Math.random() * 1000);

let cursor = 0;
async function worker(id) {
  for (;;) {
    const idx = cursor++;
    if (idx >= C.n) return;
    const wait = idx * C.stagger - (Date.now() - STATS.t0);
    if (wait > 0) await sleep(wait);
    await waitCooldown();
    const t0 = Date.now();
    let done = false;
    for (let attempt = 1; attempt <= C.retries + 1 && !done; attempt++) {
      let box = null;
      try { box = await nextMailbox(); } catch (e) {
        bump('no-mailbox');
        console.log('[w' + id + '] 取信箱失败: ' + e.message);
        await sleep(backoffMs(attempt));
        continue;
      }
      const acct = newAcct();
      STATS.attempts++;
      let r = await signupWithBox(box, acct);
      /* 验证码慢：同一信箱再等一轮（不浪费号） */
      if (!r.ok && r.stage === 'code-timeout') { bump('code-timeout'); r = await resumeWithBox(box, acct); }
      if (r.ok) {
        fs.appendFileSync(C.out, JSON.stringify(r.rec) + '\n');
        STATS.ok++;
        done = true;
        const lat = Date.now() - t0;
        STATS.latencies.push(lat);
        rateStreak = 0;
        console.log('[w' + id + '] OK   ' + box + ' userID=' + r.rec.userID + ' isRegister=' + r.rec.isRegister +
          ' credit=' + (r.rec.equity ? r.rec.equity.totalCredits : '?') + ' videoCost=' + (r.rec.equity ? r.rec.equity.videoCost : '?') +
          ' 用时=' + (lat / 1000).toFixed(1) + 's (' + STATS.ok + '/' + C.n + ')');
        break;
      }
      bump(r.stage);
      fs.appendFileSync(C.failed, JSON.stringify({
        email: box, attempt, stage: r.stage, http: r.http, code: r.code, message: r.message, ts: Math.round(Date.now() / 1000),
      }) + '\n');
      console.log('[w' + id + '] FAIL ' + box + ' attempt=' + attempt + ' stage=' + r.stage +
        ' code=' + r.code + ' msg=' + String(r.message).slice(0, 120));
      if (r.rate) { rateStreak++; tripCooldown(C.cooldown, 'stage=' + r.stage + ' code=' + r.code + ' streak=' + rateStreak); }
      else rateStreak = 0;
      if (r.stage === 'login') { /* 邮箱/验证码被拒 —— 换信箱重试 */ }
      if (attempt <= C.retries) await sleep(backoffMs(attempt));
    }
    if (!done) { STATS.fail++; }
  }
}

(async () => {
  if (!C.mfKey) { console.error('MF_KEY required (或设置环境变量)'); process.exit(2); }
  STATS.t0 = Date.now();
  const h = await mf('GET', '/healthz');
  console.log('[' + new Date().toISOString() + '] h3-pool start');
  console.log('  目标=' + C.n + ' 并发=' + C.concurrency + ' 重试=' + C.retries + ' 步进=' + C.stagger + 'ms');
  console.log('  mailfarm=' + C.mfBase + ' ver=' + ((h.j && h.j.version) || '?') + ' domains=' + JSON.stringify((h.j && h.j.domains) || []));
  console.log('  h3=' + C.host + ' lang=' + C.lang + ' → ' + C.out);
  const ws = [];
  for (let i = 0; i < Math.max(1, C.concurrency); i++) ws.push(worker(i));
  await Promise.all(ws);
  STATS.costMs = Date.now() - STATS.t0;
  const lat = STATS.latencies.slice().sort((a, b) => a - b);
  STATS.latency = { p50: lat[Math.floor(lat.length * 0.5)] || 0, p90: lat[Math.floor(lat.length * 0.9)] || 0, max: lat[lat.length - 1] || 0 };
  STATS.finished = new Date().toISOString();
  const f = path.join(EVID, 'h3-pool-run-' + Date.now() + '.json');
  fs.writeFileSync(f, JSON.stringify(STATS, null, 1));
  console.log('\n==== 完成 ====');
  console.log('成功 ' + STATS.ok + ' / 目标 ' + C.n + '   失败 ' + STATS.fail + '   总尝试 ' + STATS.attempts);
  console.log('阶段分布 ' + JSON.stringify(STATS.stages));
  console.log('单号耗时 p50=' + (STATS.latency.p50 / 1000).toFixed(1) + 's p90=' + (STATS.latency.p90 / 1000).toFixed(1) + 's max=' + (STATS.latency.max / 1000).toFixed(1) + 's');
  console.log('总耗时 ' + (STATS.costMs / 1000).toFixed(1) + 's  → ' + C.out + ' / ' + C.failed);
  console.log('统计 ' + f);
  process.exit(STATS.ok > 0 ? 0 : 1);
})();