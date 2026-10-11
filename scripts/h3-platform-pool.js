/**
 * h3-platform-pool.js -- 「平台池」式算力池（海螺 H3 形态）Node 语义复刻
 *   node scripts/h3-platform-pool.js                 # 默认 9940
 *
 * 与池①(new-api 渠道多 Key 轮询) / 池②(Google OAuth 账号池) 的关键区别：
 *   池①②: 池在**客户端/网关侧**，客户自己拼 key 或自己养号
 *   平台池: 池在**服务端**，平台侧维护账号资源，客户只买 credit（H3 文档原文如此）
 *
 * 逐条对齐 H3 公开文档：
 *   1) 「平台池：平台侧维护的账号资源。任务由调度系统挑一个余额足够的账号去打官方接口」
 *      -> pickAccount(): 健康 && 未冷却 && (credits-held) >= need，按 (credits-held) 降序 = 最肥优先
 *   2) 「账号每天自动签到补分」 -> checkinTick(): 每 CHECKIN_MS 调上游 /official/v2/checkin 并把钱包同步回来
 *      演示值 20s（生产 86400s = 1 天）
 *   3) 「上游要求账号余额 > 0，否则整单回 code 402 plan balance has run out
 *       —— 我们会在平台池里换号重试最多 3 次，仍不行就按 503 返回」
 *      -> runPoolTask(): 402 -> 换号，最多 MAX_ACCOUNT_RETRIES 次 -> 503 upstream_balance
 *   4) 「401/403 -> 账号失效，换号重试」 -> ACCOUNT_EXPIRED -> disableAccount()
 *   5) 「429 -> 退避重试」 -> cooldownAccount(retry_after)
 *   6) 「503 pool_empty：平台池里没有可用账号」+ 队列文案
 *      「waiting for credits (need X; fattest account holds Y)」 -> 池空/不够时的排队态
 *   7) 「单 Key 无 QPS 硬限，但受平台池吞吐与 Key 额度约束」
 *      「429 concurrency_exceeded：并发已满（在飞 20/20）-> Retry-After: 5」
 *      -> inflight 闸门 MAX_INFLIGHT
 *   8) 「Key(sk-hl-..)：客户凭证，由兑换码兑换时自动创建，额度用完自动失效（销号）」
 *      -> /v1/redeem + keys 表
 *   9) 「上游要求账号余额 >= 任务成本 x 2（提交预占 + 结算实扣）」
 *      -> held 预占列 + 结算后按上游 wallet.after 同步
 *  10) 「GET /v1/public/stats -> codes_total/codes_unused/codes_used/credits_pool/accounts/
 *      accounts_healthy/clips_available(1000 credit/条)/videos_24h/success_rate」
 *
 * 环境变量：
 *   H3P_PORT=9940  H3P_UPSTREAM=http://127.0.0.1:9941  H3P_ADMIN_KEY=sk-hl-admin
 *   H3P_CHECKIN_MS=20000  H3P_DAILY_CREDITS=300  H3P_ACCOUNT_CAP=1200
 *   H3P_RESERVE_FACTOR=2  H3P_MAX_RETRIES=3  H3P_MAX_INFLIGHT=20  H3P_CREDIT_PER_CLIP=1000
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.H3P_PORT || 9940);
const UPSTREAM = (process.env.H3P_UPSTREAM || 'http://127.0.0.1:9941').replace(/\/+$/, '');
const ADMIN_KEY = process.env.H3P_ADMIN_KEY || 'sk-hl-admin';
const CHECKIN_MS = Number(process.env.H3P_CHECKIN_MS || 20000);
const DAILY_CREDITS = Number(process.env.H3P_DAILY_CREDITS || 300);
const ACCOUNT_CAP = Number(process.env.H3P_ACCOUNT_CAP || 1200);
const RESERVE_FACTOR = Number(process.env.H3P_RESERVE_FACTOR || 2);
const MAX_RETRIES = Number(process.env.H3P_MAX_RETRIES || 3);
const MAX_INFLIGHT = Number(process.env.H3P_MAX_INFLIGHT || 20);
const CREDIT_PER_CLIP = Number(process.env.H3P_CREDIT_PER_CLIP || 1000);
const LOGF = path.join(ROOT, 'runtime', 'logs', 'h3-platform-pool.log');

/* 规格表：unit_credits 对齐文档口径（1000 credit/条视频；M3 只计次数不扣 credit；6 个工具一口价 0.002） */
const SPECS = [
  { model: 'MiniMax-H3', kind: 'video', unit_credits: CREDIT_PER_CLIP, spec: '768P-6s' },
  { model: 'H3-Max', kind: 'video', unit_credits: CREDIT_PER_CLIP, spec: '1080P-6s' },
  { model: 'Hailuo-2.3', kind: 'video', unit_credits: CREDIT_PER_CLIP, spec: '768P-6s' },
  { model: 'MiniMax-Image', kind: 'image', unit_credits: 4, spec: '1K-1张' },
  { model: 'MiniMax-Speech', kind: 'audio', unit_credits: 0.1, spec: 'per-char' },
  { model: 'MiniMax-Music', kind: 'music', unit_credits: 150, spec: 'per-song' },
  { model: 'MiniMax-M3', kind: 'chat', unit_credits: 0, spec: 'per-call' },
  { model: 'describe_images', kind: 'tool', unit_credits: 0.002, spec: 'per-call' },
  { model: 'search_images', kind: 'tool', unit_credits: 0.002, spec: 'per-call' },
  { model: 'reverse_image_search', kind: 'tool', unit_credits: 0.002, spec: 'per-call' },
  { model: 'listen_audio', kind: 'tool', unit_credits: 0.002, spec: 'per-call' },
  { model: 'videos_understand', kind: 'tool', unit_credits: 0.002, spec: 'per-call' },
  { model: 'audios_understand', kind: 'tool', unit_credits: 0.002, spec: 'per-call' }
];
const specOf = (m) => SPECS.find((s) => s.model === m) || { model: m, kind: 'video', unit_credits: CREDIT_PER_CLIP, spec: '768P-6s' };

let bomDone = false;
function log(s) {
  const line = '[' + new Date().toISOString() + '] ' + s;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOGF), { recursive: true });
    if (!bomDone && !fs.existsSync(LOGF)) fs.writeFileSync(LOGF, '\uFEFF', 'utf8');
    bomDone = true; fs.appendFileSync(LOGF, line + '\n', 'utf8');
  } catch (e) {}
}

/* ------------------------- 存储层 ------------------------- */
fs.mkdirSync(path.join(ROOT, 'runtime', 'data'), { recursive: true });
const db = new DatabaseSync(process.env.H3P_DB || path.join(ROOT, 'runtime', 'data', 'h3platformpool.db'));
db.exec('CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, token TEXT UNIQUE, credits REAL DEFAULT 0, held REAL DEFAULT 0, cap REAL, last_checkin_at INTEGER DEFAULT 0, healthy INTEGER DEFAULT 1, cooldown_until INTEGER DEFAULT 0, fail_reason TEXT, checkin_count INTEGER DEFAULT 0, inflight INTEGER DEFAULT 0, success_count INTEGER DEFAULT 0, created_at INTEGER);');
db.exec('CREATE TABLE IF NOT EXISTS api_keys (key TEXT PRIMARY KEY, label TEXT, credits REAL DEFAULT 0, unlimited INTEGER DEFAULT 0, revoked INTEGER DEFAULT 0, calls INTEGER DEFAULT 0, created_at INTEGER);');
db.exec('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, credits REAL, used_at INTEGER, used_by_key TEXT, created_at INTEGER);');
db.exec('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, api_key TEXT, model TEXT, spec_json TEXT, status TEXT, credits_cost REAL, account_id INTEGER, attempts INTEGER DEFAULT 0, upstream_task_id TEXT, result_url TEXT, error TEXT, created_at INTEGER, updated_at INTEGER);');
db.exec('CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, account_id INTEGER, api_key TEXT, action TEXT, credits_before REAL, credits_after REAL, delta REAL, detail TEXT);');

const now = () => Date.now();
function audit(account_id, api_key, action, before, after, detail) {
  db.prepare('INSERT INTO audit (ts,account_id,api_key,action,credits_before,credits_after,delta,detail) VALUES (?,?,?,?,?,?,?,?)')
    .run(now(), account_id || null, api_key || null, action, before === undefined ? null : before, after === undefined ? null : after,
      (before === undefined || after === undefined) ? null : after - before, detail || null);
}
const listAccounts = () => db.prepare('SELECT * FROM accounts ORDER BY id').all();
const getAccount = (id) => db.prepare('SELECT * FROM accounts WHERE id=?').get(id);

/* ------------------------- 上游调用 ------------------------- */
async function upstream(pathname, payload) {
  const r = await fetch(UPSTREAM + pathname, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {})
  });
  let j = null; try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, json: j || {}, retry_after: Number(r.headers.get('retry-after') || (j && j.retry_after) || 0) };
}
async function syncWallet(acct) {
  try {
    const w = await upstream('/official/v2/wallet', { token: acct.token });
    if (w.status === 200 && w.json && typeof w.json.balance === 'number') {
      db.prepare('UPDATE accounts SET credits=? WHERE id=?').run(w.json.balance, acct.id);
      return w.json.balance;
    }
  } catch (e) {}
  return null;
}

/* ------------------------- 平台池调度 ------------------------- */
function pickAccount(need, triedIds) {
  const rows = db.prepare('SELECT * FROM accounts WHERE healthy=1').all();
  const cands = rows
    .filter((a) => !triedIds.includes(a.id))
    .filter((a) => Number(a.cooldown_until || 0) <= now())
    .filter((a) => (a.credits - a.held) >= need)
    .sort((x, y) => (y.credits - y.held) - (x.credits - x.held));  // 最肥优先
  return cands[0] || null;
}
function fattestAvailable() {
  const rows = db.prepare('SELECT * FROM accounts WHERE healthy=1').all();
  let best = 0;
  for (const a of rows) { const v = a.credits - a.held; if (v > best) best = v; }
  return best;
}
const hold = (acct, need) => db.prepare('UPDATE accounts SET held=held+?, inflight=inflight+1 WHERE id=?').run(need, acct.id);
const release = (acct, need) => db.prepare('UPDATE accounts SET held=MAX(held-?,0), inflight=MAX(inflight-1,0) WHERE id=?').run(need, acct.id);
function disableAccount(acct, reason) {
  db.prepare('UPDATE accounts SET healthy=0, fail_reason=? WHERE id=?').run(reason, acct.id);
  audit(acct.id, null, 'account_disabled', undefined, undefined, reason);
  log('账号 #' + acct.id + ' ' + acct.label + ' -> ' + reason);
}
function cooldownAccount(acct, sec) {
  const until = now() + Math.max(1, sec) * 1000;
  db.prepare('UPDATE accounts SET cooldown_until=?, fail_reason=? WHERE id=?').run(until, '429_backoff', acct.id);
  audit(acct.id, null, 'account_cooldown', undefined, undefined, 'until=' + until);
}

/* 「换号重试最多 3 次」的核心：一次请求 -> 最多 3 个不同账号 */
async function runPoolTask(opts) {
  const tried = [];
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const need = opts.cost * RESERVE_FACTOR;      // 提交预占 + 结算实扣
    const acct = pickAccount(need, tried);
    if (!acct) {
      const fat = fattestAvailable();
      if (tried.length > 0) {
        return { ok: false, status: 503, code: 'upstream_balance',
          message: 'upstream account balance exhausted (已换号重试 ' + tried.length + ' 次仍失败)',
          detail: { attempts: tried.length, last_error: lastErr } };
      }
      return { ok: false, status: 503, code: 'pool_empty', queued: true,
        message: 'waiting for credits (need ' + need + '; fattest account holds ' + fat + ')',
        detail: { need, fattest_holds: fat, accounts_healthy: listAccounts().filter((a) => a.healthy).length } };
    }
    tried.push(acct.id);
    hold(acct, need);
    let up;
    try {
      up = await upstream('/official/v2/task', { token: acct.token, model: opts.model, spec: opts.spec, cost: opts.cost });
    } catch (e) {
      release(acct, need);
      return { ok: false, status: 502, code: 'upstream_error', message: String(e && e.message || e) };
    }
    if (up.status === 200) {
      const w = up.json.wallet || {};
      if (typeof w.after === 'number') db.prepare('UPDATE accounts SET credits=? WHERE id=?').run(w.after, acct.id);
      release(acct, need);
      db.prepare('UPDATE accounts SET success_count=success_count+1 WHERE id=?').run(acct.id);
      audit(acct.id, opts.apiKey, 'task_settled', w.before, w.after, 'model=' + opts.model + ' cost=' + opts.cost + ' attempts=' + attempt);
      return { ok: true, status: 200, account_id: acct.id, account_label: acct.label, attempts: attempt,
        wallet: { before: w.before, after: w.after, delta: w.delta },
        upstream_task_id: up.json.task_id, result_url: up.json.video_url || up.json.url };
    }
    const msg = String(up.json.message || up.json.error || '');
    if (up.status === 402 || /plan balance has run out/.test(msg)) {
      /* 额度耗尽 -> 换号；同时把钱包同步成真实值 */
      release(acct, need);
      const bal = await syncWallet(acct);
      audit(acct.id, opts.apiKey, 'switch_account', undefined, undefined, '402 plan balance has run out; wallet_sync=' + bal);
      log('402 换号：账号 #' + acct.id + ' 余额耗尽(wallet=' + bal + ')，试下一个');
      lastErr = '402 plan balance has run out';
      continue;
    }
    if (up.status === 401 || up.status === 403) { release(acct, need); disableAccount(acct, 'ACCOUNT_EXPIRED'); lastErr = 'ACCOUNT_EXPIRED'; continue; }
    if (up.status === 429) { release(acct, need); cooldownAccount(acct, up.retry_after || 5); lastErr = 'upstream_rate_limit'; continue; }
    if (up.status === 400) {
      release(acct, need);
      return { ok: false, status: 400, code: 'upstream_rejected', message: msg || 'upstream rejected', detail: '换号也没用，直接回客户' };
    }
    release(acct, need);
    return { ok: false, status: 502, code: 'upstream_error', message: msg || ('upstream http ' + up.status) };
  }
  return { ok: false, status: 503, code: 'upstream_balance',
    message: 'upstream account balance exhausted (已换号重试 ' + MAX_RETRIES + ' 次仍失败)', detail: { attempts: tried.length, last_error: lastErr } };
}

/* ------------------------- 签到补分 ------------------------- */
async function checkinTick(force) {
  for (const a of listAccounts()) {
    if (!a.healthy) continue;
    if (!force && now() - Number(a.last_checkin_at || 0) < CHECKIN_MS) continue;
    try {
      const r = await upstream('/official/v2/checkin', { token: a.token });
      if (r.status === 200) {
        db.prepare('UPDATE accounts SET credits=?, last_checkin_at=?, checkin_count=checkin_count+1 WHERE id=?')
          .run(Number(r.json.after || 0), now(), a.id);
        audit(a.id, null, 'daily_checkin', Number(r.json.before || 0), Number(r.json.after || 0), 'delta=' + (r.json.delta || 0));
        log('签到补分：账号 #' + a.id + ' ' + a.label + ' ' + r.json.before + ' -> ' + r.json.after);
      }
    } catch (e) { log('签到失败 账号#' + a.id + ': ' + e.message); }
  }
}

/* ------------------------- HTTP 层 ------------------------- */
let inflight = 0;
const send = (res, code, obj, extra) => {
  const h = Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extra || {});
  res.writeHead(code, h); res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { let j = {}; try { j = b ? JSON.parse(b) : {}; } catch (e) { j = {}; } resolve(j); });
});
function authKey(req, body) {
  const h = req.headers['authorization'] || '';
  let k = h.replace(/^Bearer\s+/i, '').trim();
  if (!k) k = String(req.headers['x-api-key'] || body.api_key || '').trim();
  if (!k) return { err: { status: 401, code: 'missing_api_key', message: 'Authorization: Bearer sk-hl-... required' } };
  const row = db.prepare('SELECT * FROM api_keys WHERE key=?').get(k);
  if (!row) return { err: { status: 401, code: 'invalid_api_key', message: 'API key not found' } };
  if (row.revoked) return { err: { status: 401, code: 'key_revoked', message: '额度用完已销号，续量请用新兑换码换新 Key' } };
  return { key: row };
}
function chargeKey(k, cost) {
  if (k.unlimited) return { ok: true };
  if (k.credits < cost) return { ok: false, err: { status: 402, code: 'insufficient_quota', message: 'insufficient quota: need ' + cost + ', left ' + k.credits } };
  db.prepare('UPDATE api_keys SET credits=MAX(credits-?,0), calls=calls+1 WHERE key=?').run(cost, k.key);
  return { ok: true };
}
const refundKey = (k, cost) => { if (!k.unlimited) db.prepare('UPDATE api_keys SET credits=credits+?, calls=MAX(calls-1,0) WHERE key=?').run(cost, k.key); };
function autoRevoke() {
  const rows = db.prepare('SELECT * FROM api_keys WHERE unlimited=0 AND revoked=0 AND credits<=0').all();
  for (const r of rows) { db.prepare('UPDATE api_keys SET revoked=1 WHERE key=?').run(r.key); log('销号：' + r.label + ' 额度用完自动失效'); }
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const body = await readBody(req);
  const isAdmin = String(req.headers['x-admin-key'] || body.admin_key || '') === ADMIN_KEY;

  if (req.method === 'GET' && url === '/healthz') return send(res, 200, { ok: true, pool: 'platform', inflight, max_inflight: MAX_INFLIGHT });
  if (req.method === 'GET' && url === '/v1/models') return send(res, 200, { object: 'list', data: SPECS.map((s) => ({ id: s.model, object: 'model', owned_by: 'hlpool' })) });
  if (req.method === 'GET' && url.startsWith('/v1/models/')) {
    const id = decodeURIComponent(url.slice('/v1/models/'.length));
    const s = SPECS.find((x) => x.model === id);
    return s ? send(res, 200, { id: s.model, object: 'model', owned_by: 'hlpool', unit_credits: s.unit_credits, spec: s.spec })
             : send(res, 404, { code: 'model_not_found', message: id });
  }

  /* 公开池子统计（H3 文档：无需 Key，IP 限流） */
  if (req.method === 'GET' && url === '/v1/public/stats') {
    const accts = listAccounts();
    const healthy = accts.filter((a) => a.healthy && Number(a.cooldown_until || 0) <= now());
    const creditsPool = healthy.reduce((s, a) => s + Math.max(0, a.credits - a.held), 0);
    const codes = db.prepare('SELECT COUNT(*) c, SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) u FROM codes').get();
    const day = now() - 24 * 3600 * 1000;
    const t24 = db.prepare('SELECT COUNT(*) c FROM tasks WHERE created_at>=?').get(day);
    const t24ok = db.prepare("SELECT COUNT(*) c FROM tasks WHERE created_at>=? AND status='succeeded'").get(day);
    return send(res, 200, {
      object: 'pool_stats',
      codes_total: Number(codes.c || 0), codes_unused: Number(codes.u || 0), codes_used: Number(codes.c || 0) - Number(codes.u || 0),
      credits_pool: Math.round(creditsPool * 1000) / 1000,
      accounts: accts.length, accounts_healthy: healthy.length,
      clips_available: Math.floor(creditsPool / CREDIT_PER_CLIP),
      seconds_available: Math.floor(creditsPool / CREDIT_PER_CLIP) * 6,
      videos_24h: Number(t24.c || 0), videos_24h_ok: Number(t24ok.c || 0),
      success_rate: Number(t24.c || 0) ? Math.round((Number(t24ok.c || 0) / Number(t24.c || 0)) * 1000) / 10 : null,
      in_flight: inflight, max_inflight: MAX_INFLIGHT, generated_at: now()
    });
  }
  if (req.method === 'GET' && url === '/v1/public/models') return send(res, 200, { object: 'list', data: SPECS.map((s) => ({ id: s.model, unit_credits: s.unit_credits, spec: s.spec })) });
  if (req.method === 'POST' && url === '/v1/public/query') {
    const code = String(body.code || ''); const key = String(body.key || '');
    if (code) { const c = db.prepare('SELECT * FROM codes WHERE code=?').get(code); return c ? send(res, 200, { code, credits: c.credits, used: !!c.used_at }) : send(res, 404, { code: 'code_not_found' }); }
    if (key) { const k = db.prepare('SELECT * FROM api_keys WHERE key=?').get(key); return k ? send(res, 200, { key, credits: k.credits, unlimited: !!k.unlimited, revoked: !!k.revoked }) : send(res, 404, { code: 'key_not_found' }); }
    return send(res, 400, { code: 'bad_request', message: 'code 或 key 二选一' });
  }

  /* 兑换码 -> sk-hl- Key */
  if (req.method === 'POST' && url === '/v1/redeem') {
    const code = String(body.code || '').trim();
    const c = db.prepare('SELECT * FROM codes WHERE code=?').get(code);
    if (!c) return send(res, 404, { code: 'code_not_found' });
    if (c.used_at) return send(res, 409, { code: 'code_used', message: '兑换码已使用' });
    const key = 'sk-hl-' + crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE codes SET used_at=?, used_by_key=? WHERE code=?').run(now(), key, code);
    db.prepare('INSERT INTO api_keys (key,label,credits,unlimited,revoked,calls,created_at) VALUES (?,?,?,0,0,0,?)').run(key, 'redeem:' + code, Number(c.credits || 0), now());
    log('兑换：' + code + ' -> ' + key.slice(0, 14) + '... credits=' + c.credits);
    return send(res, 200, { object: 'redeem', key, credits: Number(c.credits || 0), message: '额度不可追加/转移，续量请用新兑换码换新 Key' });
  }
  if (req.method === 'POST' && url === '/v1/redeem-codes/mint') {
    if (!isAdmin) return send(res, 401, { code: 'admin_required' });
    const n = Math.min(200, Number(body.count || 1));
    const credits = Number(body.credits || CREDIT_PER_CLIP);
    const out = [];
    for (let i = 0; i < n; i++) {
      const code = 'HL-' + crypto.randomBytes(3).toString('hex').toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      db.prepare('INSERT INTO codes (code,credits,created_at) VALUES (?,?,?)').run(code, credits, now());
      out.push(code);
    }
    return send(res, 200, { object: 'list', data: out, credits });
  }

  /* 产能/额度自助查询 */
  if (req.method === 'GET' && url === '/v1/credits') {
    const a = authKey(req, body); if (a.err) return send(res, a.err.status, a.err);
    return send(res, 200, { object: 'credits', credits: a.key.credits, unlimited: !!a.key.unlimited, revoked: !!a.key.revoked });
  }
  if (req.method === 'GET' && url === '/v1/quota') {
    const a = authKey(req, body); if (a.err) return send(res, a.err.status, a.err);
    const left = a.key.unlimited ? Infinity : a.key.credits;
    return send(res, 200, {
      object: 'quota', credits: a.key.unlimited ? -1 : a.key.credits, remaining_quota: a.key.unlimited ? -1 : a.key.credits,
      affordable: SPECS.filter((s) => s.kind === 'video').map((s) => ({ model: s.model, spec: s.spec, unit_credits: s.unit_credits, count: left === Infinity ? -1 : Math.floor(left / s.unit_credits), limited_by: 'credits' })),
      daily: { calls: { unlimited: true }, videos: { limit: null, used: 0, left: -1 }, credits_used_today: 0, reset_text: '每日 00:00' },
      limits: { max_batch: 20, daily_calls: -1, daily_videos: -1, calls_quota: -1, perm_premium: 1, perm_redeem: 1 }
    });
  }

  /* 出片（统一生成入口） */
  if (req.method === 'POST' && (url === '/v1/video/generations' || url === '/v1/images/generations' || url === '/v1/audio/speech' || url === '/v1/chat/completions')) {
    const a = authKey(req, body); if (a.err) return send(res, a.err.status, a.err);
    /* 平台池吞吐闸门：429 concurrency_exceeded（文档：在飞 20/20 -> Retry-After: 5） */
    if (inflight >= MAX_INFLIGHT) {
      return send(res, 429, { code: 'concurrency_exceeded', message: '并发已满（在飞 ' + inflight + '/' + MAX_INFLIGHT + '）', in_flight: inflight, max_inflight: MAX_INFLIGHT }, { 'retry-after': '5' });
    }
    const model = String(body.model || (url === '/v1/chat/completions' ? 'MiniMax-M3' : 'MiniMax-H3'));
    const s = specOf(model);
    let cost = s.unit_credits;
    if (s.kind === 'chat') cost = 0;
    if (url === '/v1/audio/speech' && body.input) cost = Math.max(0.1, String(body.input).length * 0.1);
    const ch = chargeKey(a.key, cost);
    if (!ch.ok) return send(res, ch.err.status, ch.err);

    inflight += 1;
    let r;
    try {
      if (s.kind === 'chat') {
        r = { ok: true, status: 200, account_id: null, account_label: '(M3 不扣 credit)', attempts: 0, upstream_task_id: null, result_url: null, text: 'mock: 这是平台池的 M3 文本回答（计入调用次数，不扣 credit）' };
      } else {
        r = await runPoolTask({ model, spec: Object.assign({}, body), cost, apiKey: a.key.key });
      }
    } finally { inflight -= 1; }

    if (!r.ok) {
      refundKey(a.key, cost);
      return send(res, r.status, { code: r.code, message: r.message, detail: r.detail || null, queued: !!r.queued }, r.status === 429 ? { 'retry-after': '5' } : undefined);
    }
    const taskId = 'task_' + crypto.randomBytes(6).toString('hex');
    db.prepare('INSERT INTO tasks (id,api_key,model,spec_json,status,credits_cost,account_id,attempts,upstream_task_id,result_url,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(taskId, a.key.key, model, JSON.stringify({ prompt: body.prompt || null }), 'succeeded', cost, r.account_id, r.attempts, r.upstream_task_id, r.result_url, null, now(), now());
    if (r.account_id) audit(r.account_id, a.key.key, 'task_ok', r.wallet.before, r.wallet.after, 'task=' + taskId + ' attempts=' + r.attempts);
    autoRevoke();
    if (s.kind === 'chat') return send(res, 200, { id: 'chatcmpl_' + taskId, object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: r.text } }], usage: { total_tokens: 1 } });
    return send(res, 200, {
      task_id: taskId, id: taskId, object: 'video.generation', model, status: 'succeeded',
      account: { id: r.account_id, label: r.account_label, attempts: r.attempts },
      credits_charged: cost, wallet: r.wallet, video_url: r.result_url, url: r.result_url, data: [{ url: r.result_url }]
    });
  }
  if (req.method === 'GET' && url.startsWith('/v1/video/generations/')) {
    const id = url.slice('/v1/video/generations/'.length);
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!t) return send(res, 404, { code: 'task_not_found' });
    return send(res, 200, { task_id: t.id, id: t.id, status: t.status, model: t.model, account_id: t.account_id, attempts: t.attempts, credits_charged: t.credits_cost, video_url: t.result_url, error: t.error, updated_at: t.updated_at });
  }
  if (req.method === 'POST' && url === '/v1/videos/query') {
    const ids = Array.isArray(body.task_ids) ? body.task_ids : [];
    return send(res, 200, { object: 'list', data: ids.map((id) => { const t = db.prepare('SELECT id,status,model,result_url FROM tasks WHERE id=?').get(id); return t ? { task_id: t.id, status: t.status, model: t.model, video_url: t.result_url } : { task_id: id, status: 'not_found' }; }) });
  }

  /* ---------------- 平台池管理口 ---------------- */
  if (url.startsWith('/pool/')) {
    if (!isAdmin) return send(res, 401, { code: 'admin_required', message: '带上 x-admin-key' });
    if (req.method === 'GET' && url === '/pool/stats') {
      return send(res, 200, { accounts: listAccounts(), inflight, max_inflight: MAX_INFLIGHT,
        config: { checkin_interval_ms: CHECKIN_MS, daily_credits: DAILY_CREDITS, reserve_factor: RESERVE_FACTOR, max_retries: MAX_RETRIES, credit_per_clip: CREDIT_PER_CLIP },
        audit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 50').all() });
    }
    if (req.method === 'POST' && url === '/pool/reset') {
      db.exec('DELETE FROM accounts; DELETE FROM api_keys; DELETE FROM codes; DELETE FROM tasks; DELETE FROM audit;');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/pool/accounts') {
      const label = String(body.label || 'acct');
      const token = String(body.token || ('tk_' + crypto.randomBytes(4).toString('hex')));
      const credits = Number(body.credits || 0);
      db.prepare('INSERT OR REPLACE INTO accounts (label,token,credits,held,cap,last_checkin_at,healthy,cooldown_until,fail_reason,checkin_count,inflight,success_count,created_at) VALUES (?,?,?,0,?,?,1,0,NULL,0,0,0,?)')
        .run(label, token, credits, ACCOUNT_CAP, now(), now());
      return send(res, 200, { ok: true, token, label, credits });
    }
    if (req.method === 'POST' && url === '/pool/checkin') { await checkinTick(true); return send(res, 200, { ok: true, accounts: listAccounts() }); }
    if (req.method === 'POST' && url === '/pool/keys') {
      const key = String(body.key || ('sk-hl-' + crypto.randomBytes(16).toString('hex')));
      db.prepare('INSERT OR REPLACE INTO api_keys (key,label,credits,unlimited,revoked,calls,created_at) VALUES (?,?,?,?,0,0,?)')
        .run(key, String(body.label || 'admin'), Number(body.credits || 0), body.unlimited ? 1 : 0, now());
      return send(res, 200, { ok: true, key });
    }
    return send(res, 404, { code: 'not_found', path: url });
  }

  return send(res, 404, { code: 'not_found', path: url });
});

let checkinBusy = false;
setInterval(async () => { if (checkinBusy) return; checkinBusy = true; try { await checkinTick(); } finally { checkinBusy = false; } }, Math.min(CHECKIN_MS, 5000));

server.listen(PORT, '127.0.0.1', () => log('[h3-platform-pool] listening on 127.0.0.1:' + PORT + ' upstream=' + UPSTREAM +
  ' checkin=' + CHECKIN_MS + 'ms daily=' + DAILY_CREDITS + ' reserve_x' + RESERVE_FACTOR + ' retries=' + MAX_RETRIES + ' inflight=' + MAX_INFLIGHT));