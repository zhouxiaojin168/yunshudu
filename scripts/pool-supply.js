/**
 * pool-supply.js -- 账号供给与守护：让池子「无限」的那一环
 *
 *   池引擎（h3-platform-pool.js）只负责「调度已有账号」；
 *   真正决定算力能不能「无限」的，是这个守护进程：
 *
 *     1) 保号    健康账号数 < SUPP_POOL_MIN  -> 自动补号
 *     2) 补号源  ① 农场文件（已养好的现成号）
 *                ② 注册工作流（config/pool-register.json：HTTP 步骤 + 接码平台取验证码）
 *                ③ 接码平台 API（可单独调用）
 *     3) 领额度  定时把全池账号签到（调池的 /pool/checkin），保证每天的免费额度都拿到手
 *     4) 清废    连续失效的号归档，避免池子虚胖
 *     5) 可观测  GET /supply/stats
 *
 *   环境变量：
 *     SUPP_PORT            本服务端口（默认 9950）
 *     SUPP_POOL_API        池地址（默认 http://127.0.0.1:9940）
 *     SUPP_POOL_ADMIN_KEY  池 admin key（默认 sk-hl-admin）
 *     SUPP_POOL_MIN        健康账号下限，低于就补（默认 5）
 *     SUPP_POOL_MAX        上限，到顶不再补（默认 200）
 *     SUPP_FARM_FILE       农场文件（每行一个 JSON: {"label":..,"token":..}）
 *     SUPP_REGISTER_FILE   注册工作流（默认 config/pool-register.json）
 *     SUPP_SMS_GET         接码「取号」URL 模板
 *     SUPP_SMS_POLL        接码「查码」URL 模板（含 {id}）
 *     SUPP_SMS_KEY         接码平台 key（会以 &key= 拼到上面的 URL）
 *     SUPP_SMS_WAIT_MS     查码最长等待（默认 60000）
 *     SUPP_SMS_HEADERS    额外请求头 JSON，如 {"Authorization":"Bearer xxx"}（5sim 这类必须）
 *     --- 邮箱型注册（不需要手机号/接码平台，走自建 mailfarm）---
 *     SUPP_MAIL_API        mailfarm 地址（默认 http://127.0.0.1:8099）
 *     SUPP_MAIL_KEY        mailfarm 的 x-api-key（配了 MF_API_KEY 就必填）
 *     SUPP_MAIL_PREFIX     邮箱前缀（默认 hl）
 *     SUPP_MAIL_WAIT_MS    等邮件验证码的最长等待（默认 90000）
 *     SUPP_INTERVAL_MS     守护循环间隔（默认 60000）
 *     SUPP_CHECKIN_EVERY   每 N 轮做一次全池签到（默认 10）
 *     SUPP_REFILL_BATCH    每次补号数量（默认 3）
 *
 *   用法：node scripts/pool-supply.js [--once]
 */
'use strict';
/* 海螺网页端请求签名器（工作流步骤 step.sign==='hailuo' 时使用）*/
let hailuoSign = null;
try { hailuoSign = require('./hailuo-sign.js'); } catch (e) { hailuoSign = null; }
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const PORT = Number(process.env.SUPP_PORT || 9950);
const POOL = String(process.env.SUPP_POOL_API || 'http://127.0.0.1:9940').replace(/\/+$/, '');
const POOL_KEY = process.env.SUPP_POOL_ADMIN_KEY || 'sk-hl-admin';
/* 本服务管理口的鉴权 key：写操作必须带 x-admin-key（服务器上从 secrets.txt 注入，密钥不入库） */
const ADMIN_KEY = process.env.SUPP_ADMIN_KEY || process.env.SUPP_POOL_ADMIN_KEY || 'sk-hl-admin';
const POOL_MIN = Number(process.env.SUPP_POOL_MIN || 5);
const POOL_MAX = Number(process.env.SUPP_POOL_MAX || 200);
const FARM_FILE = process.env.SUPP_FARM_FILE || path.join(ROOT, 'state', 'farm-accounts.jsonl');
const REG_FILE = process.env.SUPP_REGISTER_FILE || path.join(ROOT, 'config', 'pool-register.json');
const SMS_GET = process.env.SUPP_SMS_GET || '';
const SMS_POLL = process.env.SUPP_SMS_POLL || '';
const SMS_KEY = process.env.SUPP_SMS_KEY || '';
const SMS_WAIT_MS = Number(process.env.SUPP_SMS_WAIT_MS || 60000);
/* ---- 补号源①.5：mailfarm 邮箱农场（自有域名 catch-all 收信 + 自动取码，零短信成本）---- */
const MAIL_API = String(process.env.SUPP_MAIL_API || 'http://127.0.0.1:8099').replace(/\/+$/, '');
const MAIL_KEY = process.env.SUPP_MAIL_KEY || '';
const MAIL_PREFIX = process.env.SUPP_MAIL_PREFIX || 'hl';
const MAIL_WAIT_MS = Number(process.env.SUPP_MAIL_WAIT_MS || 90000);
const MAIL_ACQUIRE_PATH = process.env.SUPP_MAIL_ACQUIRE_PATH || '/v1/mailboxes/acquire';
function mailHeaders() { const h = { 'content-type': 'application/json' }; if (MAIL_KEY) h['x-api-key'] = MAIL_KEY; return h; }
async function mailAcquire(prefix) {
  const r = await fetch(MAIL_API + MAIL_ACQUIRE_PATH, { method: 'POST', headers: mailHeaders(), body: JSON.stringify({ prefix: prefix || MAIL_PREFIX }) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) {}
  if (r.status !== 200 || !j || !j.address) throw new Error('mailfarm 取邮箱失败 HTTP ' + r.status + ': ' + String(t).slice(0, 200));
  return { email: j.address, domain: j.domain || '', id: j.address };
}
async function mailWaitCode(address) {
  const url = MAIL_API + '/v1/mailboxes/' + encodeURIComponent(address) + '/code?timeout=' + Math.round(MAIL_WAIT_MS / 1000);
  const r = await fetch(url, { headers: mailHeaders() });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) {}
  if (r.status !== 200) throw new Error('mailfarm 取码失败 HTTP ' + r.status + ': ' + String(t).slice(0, 200));
  if (!j || !j.code) throw new Error('mailfarm 等验证码超时 ' + address);
  return j.code;
}
const INTERVAL = Number(process.env.SUPP_INTERVAL_MS || 60000);
const CHECKIN_EVERY = Number(process.env.SUPP_CHECKIN_EVERY || 10);
const REFILL_BATCH = Number(process.env.SUPP_REFILL_BATCH || 3);
const LOGD = path.join(ROOT, 'logs');
const LOGF = process.env.SUPP_LOG_FILE || path.join(LOGD, 'pool-supply.log');
const STATE = process.env.SUPP_STATE_FILE || path.join(ROOT, 'state', 'pool-supply.json');
const ONCE = process.argv.indexOf('--once') >= 0;

let bomDone = false;
function log(s) {
  const line = '[' + new Date().toISOString() + '] ' + s;
  console.log(line);
  try {
    fs.mkdirSync(LOGD, { recursive: true });
    if (!bomDone && !fs.existsSync(LOGF)) fs.writeFileSync(LOGF, String.fromCharCode(0xFEFF), 'utf8');
    bomDone = true;
    fs.appendFileSync(LOGF, line + NL, 'utf8');
  } catch (e) {}
}

const state = {
  started_at: Date.now(), loops: 0, imported: 0, registered: 0, refills: 0,
  checkins: 0, last_error: null, last_refill_at: 0, source_used: null
};
try {
  const prev = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  Object.assign(state, prev, { started_at: Date.now(), loops: 0 });
} catch (e) {}
function saveState() { try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8'); } catch (e) {} }

/* ------------------------- 池管理接口 ------------------------- */
async function poolReq(method, p, body) {
  const init = { method: method, headers: { 'content-type': 'application/json', 'x-admin-key': POOL_KEY } };
  if (body) init.body = JSON.stringify(body);
  const r = await fetch(POOL + p, init);
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, json: j || {} };
}
const poolStats = () => poolReq('GET', '/pool/stats');
const poolAdd = (acct) => poolReq('POST', '/pool/accounts', acct);
const poolBulk = (accounts) => poolReq('POST', '/pool/accounts/bulk', { accounts: accounts });
const poolCheckin = () => poolReq('POST', '/pool/checkin', {});
const poolRevive = () => poolReq('POST', '/pool/accounts/revive', {});

function healthyCount(st) {
  const arr = (st && st.json && st.json.accounts) || [];
  const live = arr.filter((a) => Number(a.healthy) === 1);
  /* 「可用」= 健康 且 余额>0。d1jiema 卡池里有回收号（R113 实测命中率约 50% 拿不到新人礼 80 credit），
     只按 healthy 计会让 0 额度号把池子「撑满」、补号提前停止 -> 对外看是「无限算力」其实没额度可用。 */
  const usable = live.filter((a) => Number(a.credits || 0) > 0);
  const credits = usable.reduce((s, a) => s + Number(a.credits || 0), 0);
  return { total: arr.length, healthy: usable.length, healthy_live: live.length, credits: credits, accounts: arr };
}

/* ------------------------- 补号源①：农场文件 ------------------------- */
function readFarm() {
  const out = [];
  try {
    const txt = fs.readFileSync(FARM_FILE, 'utf8').replace(/^\uFEFF/, '');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.charAt(0) === '#') continue;
      try { out.push(JSON.parse(line)); } catch (e) { out.push({ label: 'farm-line', token: line }); }
    }
  } catch (e) {}
  return out;
}
async function refillFromFarm(n) {
  const all = readFarm();
  if (!all.length) return 0;
  const st = await poolStats();
  const have = new Set((st.json.accounts || []).map((a) => String(a.token)));
  const fresh = all.filter((a) => a && a.token && !have.has(String(a.token)));
  if (!fresh.length) return 0;
  const batch = fresh.slice(0, n).map((a, i) => ({ label: a.label || ('farm-' + (i + 1)), token: a.token, credits: Number(a.credits || 0) }));
  const bulk = await poolBulk(batch);
  if (bulk.status === 200) return Number(bulk.json.imported || 0);
  let added = 0;  // 池子太老没有 /pool/accounts/bulk -> 退回单条
  for (const a of batch) {
    const r = await poolAdd(a);
    if (r.status === 200) added++;
  }
  return added;
}

/* ------------------------- 补号源②：接码平台 ------------------------- */
const smsAdapter = require('./sms-adapter');

/* 额外请求头：SUPP_SMS_HEADERS='{"Authorization":"Bearer xxx"}'（5sim 这类要 Bearer 的平台用得上） */
let SMS_HEADERS = {};
try {
  if (process.env.SUPP_SMS_HEADERS) SMS_HEADERS = JSON.parse(process.env.SUPP_SMS_HEADERS) || {};
} catch (e) { SMS_HEADERS = {}; }

function tpl(url, vars) {
  let out = String(url);
  const usedKeySlot = out.indexOf('{key}') >= 0;
  const all = Object.assign({}, vars || {});
  if (SMS_KEY) all.key = SMS_KEY;   // 模板里写 {key} 可把 key 放到任意位置（api_key=/token=/apikey=）
  Object.keys(all).forEach((k) => { out = out.split('{' + k + '}').join(encodeURIComponent(String(all[k]))); });
  if (SMS_KEY && !usedKeySlot) out += (out.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(SMS_KEY);
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function smsGetPhone(project) {
  if (!SMS_GET) throw new Error('未配置 SUPP_SMS_GET（接码取号接口）');
  const url = tpl(SMS_GET, { project: project || '' });
  const r = await fetch(url, { headers: SMS_HEADERS });
  const t = await r.text();
  const got = smsAdapter.parsePhone(t);
  if (r.status !== 200) throw new Error('取号 HTTP ' + r.status + ': ' + t.slice(0, 200));
  if (!got.phone) throw new Error('取号失败: ' + (got.error || t.slice(0, 200)));
  return { phone: got.phone, id: got.id || got.phone };
}

async function smsWaitCode(id) {
  if (!SMS_POLL) throw new Error('未配置 SUPP_SMS_POLL（接码查码接口）');
  const deadline = Date.now() + SMS_WAIT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const r = await fetch(tpl(SMS_POLL, { id: id }), { headers: SMS_HEADERS });
    const t = await r.text();
    last = t;
    const p = smsAdapter.parseCode(t);
    if (p.code) return p.code;
    if (p.terminal) throw new Error('接码失败: ' + (p.error || t.slice(0, 120)));
    await sleep(3000);
  }
  throw new Error('等验证码超时 id=' + id + ' 最后响应: ' + String(last).slice(0, 120));
}

/* ------------------------- 补号源②：注册工作流引擎 ------------------------- */
function loadFlow() {
  try { return JSON.parse(fs.readFileSync(REG_FILE, 'utf8')); } catch (e) { return null; }
}
function dig(o, p) { return String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o); }
function fill(v, vars) {
  if (typeof v !== 'string') return v;
  return v.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, k) => (vars[k] === undefined ? '' : String(vars[k])));
}
function fillDeep(o, vars) {
  if (o == null) return o;
  if (typeof o === 'string') return fill(o, vars);
  if (Array.isArray(o)) return o.map((x) => fillDeep(x, vars));
  if (typeof o === 'object') { const r = {}; Object.keys(o).forEach((k) => { r[k] = fillDeep(o[k], vars); }); return r; }
  return o;
}

async function runRegisterFlow() {
  const flow = loadFlow();
  if (!flow || !Array.isArray(flow.steps)) throw new Error('注册工作流不可用: ' + REG_FILE);
  const base = String(flow.base || '').replace(/\/+$/, '');
  const vars = {};
  const shots = [];
  for (const step of flow.steps) {
    const type = step.type || 'http';
    if (type === 'sleep') { await sleep(Number(step.ms || 1000)); continue; }
    if (type === 'sms-get') {
      const got = await smsGetPhone(step.project || flow.project);
      vars[step.save_phone || 'phone'] = got.phone;
      vars[step.save_id || 'phone_id'] = got.id;
      log('取号 ' + got.phone + ' (id=' + got.id + ')');
      continue;
    }
    if (type === 'sms-wait') {
      const code = await smsWaitCode(vars[step.from || 'phone_id']);
      vars[step.save || 'code'] = code;
      log('收到验证码 ' + code);
      continue;
    }
    if (type === 'mail-acquire') {
      const got = await mailAcquire(step.prefix || flow.mail_prefix);
      vars[step.save_email || 'email'] = got.email;
      vars[step.save_id || 'email_id'] = got.id;
      log('取邮箱 ' + got.email);
      continue;
    }
    if (type === 'mail-wait') {
      const code = await mailWaitCode(vars[step.from || 'email_id']);
      vars[step.save || 'code'] = code;
      log('收到邮箱验证码 ' + code);
      continue;
    }
    if (type === 'emit') {
      const out = {};
      Object.keys(step.as || {}).forEach((k) => { out[k] = fillDeep(step.as[k], vars); });
      vars.account = Object.assign(vars.account || {}, out);
      continue;
    }
    // http 步骤（step.sign === 'hailuo' 时走海螺网页端签名：query 公共参数 + header.yy）
    const method = String(step.method || 'POST').toUpperCase();
    let url = fill(String(step.path || ''), vars);
    const bodyObj = fillDeep(step.body || {}, vars);
    let headers = Object.assign({ 'content-type': 'application/json' }, fillDeep(step.headers || {}, vars));
    let bodyStr = null;
    if (step.sign === 'hailuo') {
      if (!hailuoSign) throw new Error("step 需要 hailuo 签名，但 scripts/hailuo-sign.js 加载失败");
      const built = hailuoSign.buildSignedRequest({ url: url, method: method, body: bodyObj, raw: String(vars.token || ''), lang: step.lang, time: Date.now() });
      headers = Object.assign(headers, built.headers, fillDeep(step.headers || {}, vars));
      try { const o = new URL(base).origin; headers.origin = o; headers.referer = o + '/'; } catch (e) {}
      bodyStr = built.bodyString;
      url = base + built.url;
    } else {
      if (!/^https?:/.test(url)) url = base + (url.charAt(0) === '/' ? url : '/' + url);
      if (method !== 'GET' && method !== 'HEAD') bodyStr = JSON.stringify(bodyObj);
      if (method === 'GET' && step.query) {
        const q = new URLSearchParams(fillDeep(step.query, vars)).toString();
        url += (url.indexOf('?') >= 0 ? '&' : '?') + q;
      }
    }
    const init = { method: method, headers: headers };
    if (bodyStr != null && method !== 'GET' && method !== 'HEAD') init.body = bodyStr;
    const r = await fetch(url, init);
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    shots.push({ step: step.name || type, http: r.status });
    if (step.save) {
      Object.keys(step.save).forEach((k) => {
        const v = dig(j || {}, step.save[k]);
        vars[k] = (v === undefined ? '' : v);
      });
    }
    const want = step.expect === undefined ? 200 : Number(step.expect);
    if (want >= 0 && r.status !== want) {
      throw new Error('步骤 ' + (step.name || type) + ' 返回 ' + r.status + ' :: ' + txt.slice(0, 200));
    }
    /* 业务码校验：海螺 HTTP 200 也可能带 statusInfo.code!=0（22=封号 / 32=限流 / 2400026=贝壳不足）。
       不校验就会把「短信没真发成功」当成功、白等验证码白烧一个号。step.expect_code 显式要求时生效。 */
    if (step.expect_code !== undefined) {
      const gotCode = Number(dig(j || {}, step.expect_code_path || 'statusInfo.code'));
      const wantCode = Number(step.expect_code);
      if (gotCode !== wantCode) {
        throw new Error('步骤 ' + (step.name || type) + ' 业务码 ' + (isFinite(gotCode) ? gotCode : 'n/a') + ' != ' + wantCode + ' :: ' + txt.slice(0, 200));
      }
    }
  }
  const acc = vars.account || {};
  if (!acc.token) throw new Error('工作流跑完但没拿到 token（检查最后一步的 save/emit）');
  return { account: acc, steps: shots, vars: vars };
}

/* ------------------------- 守护循环 ------------------------- */
let busy = false;
async function guardRound(force) {
  if (busy) return { skipped: 'busy' };
  busy = true;
  const report = { at: new Date().toISOString(), pool: null, actions: [] };
  state.last_error = null;  // 新一轮开始就清掉上一轮的旧错，避免状态页骗人
  try {
    const st = await poolStats();
    const h = healthyCount(st);
    report.pool = { total: h.total, healthy: h.healthy, healthy_live: h.healthy_live, credits: Math.round(h.credits * 100) / 100 };
    state.loops++;

    if (h.healthy < POOL_MIN || force) {
      /* 先试着把「被判死的号」复活（上游恢复/误判很常见），不行再补新号 */
      try {
        const rv = await poolRevive();
        const n = Number((rv.json && rv.json.revived) || 0);
        if (n > 0) { report.actions.push('revive+' + n); h.healthy += n; h.total = (rv.json.accounts || []).length; }
      } catch (e) { log('复活检查失败: ' + e.message); }
      const need = Math.max(REFILL_BATCH, POOL_MIN - h.healthy);
      const room = Math.max(0, POOL_MAX - h.total);
      const want = Math.min(need, room);
      if (want > 0) {
        let added = 0;
        try {
          added = await refillFromFarm(want);
          if (added > 0) { state.source_used = 'farm'; state.imported += added; report.actions.push('farm+' + added); }
        } catch (e) { log('农场补号失败: ' + e.message); }
        if (added < want) {
          try {
            const res = await runRegisterFlow();
            const a = res.account;
            const r = await poolAdd({ label: a.label || a.token.slice(0, 12), token: a.token, credits: Number(a.credits || 0) });
            if (r.status === 200) { state.registered++; state.source_used = 'register'; report.actions.push('register+1'); }
          } catch (e) {
            state.last_error = 'register: ' + e.message;
            log('注册补号失败: ' + e.message);
          }
        }
        state.refills++;
        state.last_refill_at = Date.now();
      } else {
        report.actions.push('pool_full');
      }
    }

    if (state.loops % CHECKIN_EVERY === 0) {
      const c = await poolCheckin();
      if (c.status === 200) { state.checkins++; report.actions.push('checkin_all'); }
      else { report.actions.push('checkin_http_' + c.status); }
    }

    saveState();
  } catch (e) {
    state.last_error = String(e && e.message || e);
    report.error = state.last_error;
    log('守护循环异常: ' + state.last_error);
  } finally { busy = false; }
  return report;
}

/* ------------------------- HTTP 管理面 ------------------------- */
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { let j = {}; try { j = b ? JSON.parse(b) : {}; } catch (e) {} resolve(j); }); });

/* 写操作鉴权：x-admin-key 头 或 ?key= 查询参数；读接口(healthz/stats)保持开放便于排障 */
function isAdmin(req, body) {
  const h = String(req.headers['x-admin-key'] || '').trim();
  const q = String((req.url.split('?')[1] || '')).split('&').find(function (x) { return x.indexOf('key=') === 0; });
  const k = h || (q ? decodeURIComponent(q.slice(4)) : '') || String((body && body.admin_key) || '');
  return k && k === ADMIN_KEY;
}

const server = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && u === '/supply/healthz') return send(res, 200, { ok: true, port: PORT });
    if (req.method === 'GET' && u === '/supply/stats') {
      const st = await poolStats();
      const h = healthyCount(st);
      return send(res, 200, {
        supply: state,
        config: { pool: POOL, pool_min: POOL_MIN, pool_max: POOL_MAX, interval_ms: INTERVAL, farm_file: FARM_FILE, register_file: REG_FILE, sms_configured: !!SMS_GET },
        pool: { total: h.total, healthy: h.healthy, credits: Math.round(h.credits * 100) / 100 },
        accounts: h.accounts.map((a) => ({ id: a.id, label: a.label, credits: a.credits, held: a.held, healthy: a.healthy, fail_reason: a.fail_reason, checkin_count: a.checkin_count, success_count: a.success_count }))
      });
    }
    if (req.method === 'POST' && u === '/supply/guard') { const body = await readBody(req); if (!isAdmin(req, body)) return send(res, 401, { code: 'admin_required', message: 'need x-admin-key' }); return send(res, 200, { ok: true, report: await guardRound(!!body.force) }); }
    if (req.method === 'POST' && u === '/supply/checkin') { const body = await readBody(req); if (!isAdmin(req, body)) return send(res, 401, { code: 'admin_required', message: 'need x-admin-key' }); const r = await poolCheckin(); return send(res, r.status === 200 ? 200 : 502, r.json); }
    if (req.method === 'POST' && u === '/supply/import') {
      const _probe = await readBody(req);
      if (!isAdmin(req, _probe)) return send(res, 401, { code: 'admin_required', message: 'need x-admin-key' });
      const body = _probe;
      const list = Array.isArray(body.accounts) ? body.accounts : [];
      let ok = 0;
      const bulk = list.length ? await poolBulk(list) : { status: 0, json: {} };
      if (bulk.status === 200) ok = Number(bulk.json.imported || 0);
      else for (const a of list) { const r = await poolAdd(a); if (r.status === 200) ok++; }
      state.imported += ok; saveState();
      return send(res, 200, { ok: true, imported: ok, total: list.length });
    }
    if (req.method === 'POST' && u === '/supply/register') {
      const _probe = await readBody(req);
      if (!isAdmin(req, _probe)) return send(res, 401, { code: 'admin_required', message: 'need x-admin-key' });
      const body = _probe;   // 不能二次 readBody：请求流已结束，第二次会永久挂起（2026-10-12 修）
      const times = Math.max(1, Number(body.n || 1));
      const done = [];
      for (let i = 0; i < times; i++) {
        try {
          const res2 = await runRegisterFlow();
          const a = res2.account;
          const r = await poolAdd({ label: a.label || a.token.slice(0, 12), token: a.token, credits: Number(a.credits || 0) });
          done.push({ ok: r.status === 200, steps: res2.steps, label: a.label });
          if (r.status === 200) state.registered++;
        } catch (e) { done.push({ ok: false, error: String(e && e.message || e) }); }
      }
      saveState();
      return send(res, 200, { ok: true, results: done });
    }
    return send(res, 404, { code: 'not_found', path: u });
  } catch (e) { return send(res, 500, { code: 'error', message: String(e && e.message || e) }); }
});

async function main() {
  log('pool-supply start pool=' + POOL + ' min=' + POOL_MIN + ' max=' + POOL_MAX + ' interval=' + INTERVAL + 'ms farm=' + FARM_FILE);
  if (!SMS_GET && !MAIL_API) log('提示：未配置 SUPP_SMS_GET 也没有 mailfarm -> 只能从农场文件补号（register 工作流会失败）');
  if (MAIL_API) log('邮箱补号已就绪 mailfarm=' + MAIL_API + ' prefix=' + MAIL_PREFIX);
  if (ONCE) { const r = await guardRound(true); log('--once: ' + JSON.stringify(r)); process.exit(0); }
  server.listen(PORT, '127.0.0.1', () => log('pool-supply listening on 127.0.0.1:' + PORT));
  await guardRound(true);
  setInterval(() => { guardRound(false).catch((e) => log('round error ' + e.message)); }, INTERVAL);
}

process.on('SIGTERM', () => { log('SIGTERM -> exit'); saveState(); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT -> exit'); saveState(); process.exit(0); });

main().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
