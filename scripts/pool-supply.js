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
 *     SUPP_INTERVAL_MS     守护循环间隔（默认 60000）
 *     SUPP_CHECKIN_EVERY   每 N 轮做一次全池签到（默认 10）
 *     SUPP_REFILL_BATCH    每次补号数量（默认 3）
 *
 *   用法：node scripts/pool-supply.js [--once]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const PORT = Number(process.env.SUPP_PORT || 9950);
const POOL = String(process.env.SUPP_POOL_API || 'http://127.0.0.1:9940').replace(/\/+$/, '');
const POOL_KEY = process.env.SUPP_POOL_ADMIN_KEY || 'sk-hl-admin';
const POOL_MIN = Number(process.env.SUPP_POOL_MIN || 5);
const POOL_MAX = Number(process.env.SUPP_POOL_MAX || 200);
const FARM_FILE = process.env.SUPP_FARM_FILE || path.join(ROOT, 'state', 'farm-accounts.jsonl');
const REG_FILE = process.env.SUPP_REGISTER_FILE || path.join(ROOT, 'config', 'pool-register.json');
const SMS_GET = process.env.SUPP_SMS_GET || '';
const SMS_POLL = process.env.SUPP_SMS_POLL || '';
const SMS_KEY = process.env.SUPP_SMS_KEY || '';
const SMS_WAIT_MS = Number(process.env.SUPP_SMS_WAIT_MS || 60000);
const INTERVAL = Number(process.env.SUPP_INTERVAL_MS || 60000);
const CHECKIN_EVERY = Number(process.env.SUPP_CHECKIN_EVERY || 10);
const REFILL_BATCH = Number(process.env.SUPP_REFILL_BATCH || 3);
const LOGD = path.join(ROOT, 'logs');
const LOGF = path.join(LOGD, 'pool-supply.log');
const STATE = path.join(ROOT, 'state', 'pool-supply.json');
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
const poolCheckin = () => poolReq('POST', '/pool/checkin', {});

function healthyCount(st) {
  const arr = (st && st.json && st.json.accounts) || [];
  const live = arr.filter((a) => Number(a.healthy) === 1);
  const credits = live.reduce((s, a) => s + Number(a.credits || 0), 0);
  return { total: arr.length, healthy: live.length, credits: credits, accounts: arr };
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
  let added = 0;
  for (const a of fresh.slice(0, n)) {
    const r = await poolAdd({ label: a.label || ('farm-' + (added + 1)), token: a.token, credits: Number(a.credits || 0) });
    if (r.status === 200) added++;
  }
  return added;
}

/* ------------------------- 补号源②：接码平台 ------------------------- */
function tpl(url, vars) {
  let out = String(url);
  Object.keys(vars || {}).forEach((k) => { out = out.split('{' + k + '}').join(encodeURIComponent(String(vars[k]))); });
  if (SMS_KEY) out += (out.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(SMS_KEY);
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function smsGetPhone(project) {
  if (!SMS_GET) throw new Error('未配置 SUPP_SMS_GET（接码取号接口）');
  const r = await fetch(tpl(SMS_GET, { project: project || '' }));
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) {}
  const phone = (j && (j.phone || (j.data && j.data.phone))) || (t.match(/1[3-9][0-9]{9}/) || [])[0];
  const id = (j && (j.id || j.phone_id || (j.data && j.data.id))) || phone;
  if (!phone || !id) throw new Error('取号失败: ' + t.slice(0, 200));
  return { phone: String(phone), id: String(id) };
}

async function smsWaitCode(id) {
  if (!SMS_POLL) throw new Error('未配置 SUPP_SMS_POLL（接码查码接口）');
  const deadline = Date.now() + SMS_WAIT_MS;
  while (Date.now() < deadline) {
    const r = await fetch(tpl(SMS_POLL, { id: id }));
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (e) {}
    const code = (j && (j.code || (j.data && j.data.code))) || (t.match(/\b[0-9]{4,6}\b/) || [])[0];
    if (code && String(code) !== '0') return String(code);
    await sleep(3000);
  }
  throw new Error('等验证码超时 id=' + id);
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
    if (type === 'emit') {
      const out = {};
      Object.keys(step.as || {}).forEach((k) => { out[k] = fillDeep(step.as[k], vars); });
      vars.account = Object.assign(vars.account || {}, out);
      continue;
    }
    // http 步骤
    const method = String(step.method || 'POST').toUpperCase();
    const headers = Object.assign({ 'content-type': 'application/json' }, fillDeep(step.headers || {}, vars));
    const init = { method: method, headers: headers };
    if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(fillDeep(step.body || {}, vars));
    let url = fill(String(step.path || ''), vars);
    if (!/^https?:/.test(url)) url = base + (url.charAt(0) === '/' ? url : '/' + url);
    if (method === 'GET' && step.query) {
      const q = new URLSearchParams(fillDeep(step.query, vars)).toString();
      url += (url.indexOf('?') >= 0 ? '&' : '?') + q;
    }
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
  try {
    const st = await poolStats();
    const h = healthyCount(st);
    report.pool = { total: h.total, healthy: h.healthy, credits: Math.round(h.credits * 100) / 100 };
    state.loops++;

    if (h.healthy < POOL_MIN || force) {
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
    if (req.method === 'POST' && u === '/supply/guard') { const body = await readBody(req); return send(res, 200, { ok: true, report: await guardRound(!!body.force) }); }
    if (req.method === 'POST' && u === '/supply/checkin') { const r = await poolCheckin(); return send(res, r.status === 200 ? 200 : 502, r.json); }
    if (req.method === 'POST' && u === '/supply/import') {
      const body = await readBody(req);
      const list = Array.isArray(body.accounts) ? body.accounts : [];
      let ok = 0;
      for (const a of list) { const r = await poolAdd(a); if (r.status === 200) ok++; }
      state.imported += ok; saveState();
      return send(res, 200, { ok: true, imported: ok, total: list.length });
    }
    if (req.method === 'POST' && u === '/supply/register') {
      const body = await readBody(req);
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
  if (!SMS_GET) log('提示：未配置 SUPP_SMS_GET -> 只能从农场文件补号（register 工作流会失败）');
  if (ONCE) { const r = await guardRound(true); log('--once: ' + JSON.stringify(r)); process.exit(0); }
  server.listen(PORT, '127.0.0.1', () => log('pool-supply listening on 127.0.0.1:' + PORT));
  await guardRound(true);
  setInterval(() => { guardRound(false).catch((e) => log('round error ' + e.message)); }, INTERVAL);
}

process.on('SIGTERM', () => { log('SIGTERM -> exit'); saveState(); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT -> exit'); saveState(); process.exit(0); });

main().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
