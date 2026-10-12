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
 *   H3P_CHECKIN_MS=20000  H3P_CHECKIN_BACKOFF_MAX_MS=86400000  H3P_DAILY_CREDITS=300  H3P_ACCOUNT_CAP=1200
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
const CHECKIN_BACKOFF_MAX_MS = Number(process.env.H3P_CHECKIN_BACKOFF_MAX_MS || 86400000); /* 无收益/失败时退避上限，默认 24h */
const DAILY_CREDITS = Number(process.env.H3P_DAILY_CREDITS || 300);
const ACCOUNT_CAP = Number(process.env.H3P_ACCOUNT_CAP || 1200);
const RESERVE_FACTOR = Number(process.env.H3P_RESERVE_FACTOR || 2);
const MAX_RETRIES = Number(process.env.H3P_MAX_RETRIES || 3);
const MAX_INFLIGHT = Number(process.env.H3P_MAX_INFLIGHT || 20);
const CREDIT_PER_CLIP = Number(process.env.H3P_CREDIT_PER_CLIP || 1000);
const PENDING_TIMEOUT_MS = Number(process.env.H3P_PENDING_TIMEOUT_MS || 300000);   // R114：异步任务超时判失败+退额（默认 5 分钟）
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
/* R139：新人礼额度有到期时间（海螺 sub_credits[].end_time），加列以便「到期自动换号」 */
try { db.exec('ALTER TABLE accounts ADD COLUMN expires_at INTEGER DEFAULT 0'); } catch (e) {}

const now = () => Date.now();
function audit(account_id, api_key, action, before, after, detail) {
  db.prepare('INSERT INTO audit (ts,account_id,api_key,action,credits_before,credits_after,delta,detail) VALUES (?,?,?,?,?,?,?,?)')
    .run(now(), account_id || null, api_key || null, action, before === undefined ? null : before, after === undefined ? null : after,
      (before === undefined || after === undefined) ? null : after - before, detail || null);
}
const listAccounts = () => db.prepare('SELECT * FROM accounts ORDER BY id').all();

/* R139「到期自动换号」：新人礼额度时效到点 -> 直接删号，池子少号后由 pool-supply 自动补新号。
   H3P_AUTO_PRUNE_EXPIRED=0 可关；H3P_AUTO_PRUNE_ZERO=1 时连「0 额度」号一起清。 */
const AUTO_PRUNE_EXPIRED = String(process.env.H3P_AUTO_PRUNE_EXPIRED || '1') !== '0';
const AUTO_PRUNE_ZERO = String(process.env.H3P_AUTO_PRUNE_ZERO || '0') === '1';
function expireSweep() {
  const out = { expired: 0, zero: 0 };
  if (!AUTO_PRUNE_EXPIRED && !AUTO_PRUNE_ZERO) return out;
  for (const a of listAccounts()) {
    if (Number(a.inflight || 0) > 0 || Number(a.held || 0) > 0) continue;
    const exp = Number(a.expires_at || 0);
    if (AUTO_PRUNE_EXPIRED && exp > 0 && now() > exp) {
      audit(a.id, null, 'credits_expired', a.credits, 0, 'expires_at=' + exp);
      log('新人礼到期弃号：账号 #' + a.id + ' ' + a.label + ' exp=' + new Date(exp).toISOString());
      db.prepare('DELETE FROM accounts WHERE id=?').run(a.id);
      out.expired++;
      continue;
    }
    if (AUTO_PRUNE_ZERO && Number(a.credits || 0) <= 0) {
      audit(a.id, null, 'prune_zero_credit', a.credits, 0, 'auto_prune_zero');
      log('0 额度弃号：账号 #' + a.id + ' ' + a.label);
      db.prepare('DELETE FROM accounts WHERE id=?').run(a.id);
      out.zero++;
    }
  }
  return out;
}
const getAccount = (id) => db.prepare('SELECT * FROM accounts WHERE id=?').get(id);

/* ------------------------- 上游适配器（config/pool-adapter.json） ------------------------- */
/* 3 个接口：wallet / checkin / task；method+path+auth+字段映射全部可配置，换上游只改 JSON */
const ADAPTER_FILE = process.env.H3P_ADAPTER_FILE || path.join(ROOT, 'config', 'pool-adapter.json');
let ADAPTER = null;
try { ADAPTER = JSON.parse(fs.readFileSync(ADAPTER_FILE, 'utf8')); log('adapter: ' + ADAPTER.name + ' base=' + ADAPTER.base + ' <- ' + ADAPTER_FILE); }
catch (e) { log('adapter: 读不到 ' + ADAPTER_FILE + '，退回内置 mock 形态（' + e.message + '）'); }
const EP = (ADAPTER && ADAPTER.endpoints) || {};
/* 优先级：H3P_UPSTREAM 环境变量（显式指定） > 适配器 JSON 的 base > 内置默认 */
const ADAPTER_BASE = String(process.env.H3P_UPSTREAM || (ADAPTER && ADAPTER.base) || UPSTREAM).replace(/\/+$/, '');
const ADAPTER_BASE_SRC = process.env.H3P_UPSTREAM ? 'env:H3P_UPSTREAM' : ((ADAPTER && ADAPTER.base) ? 'json:' + ADAPTER_FILE : 'builtin');

/* R140 去水印：上游每张图都预渲染 3 个变体（见 feed.metaInfo.imageMetaInfo.mediaInfo.downloadURL）：
     watermarkURL      = 底部大横幅 'Hailuo AI x MINIMAX' + 右下 'AI生成' 角标
     aiWatermarkURL    = 只有右下 'AI生成' 角标（无品牌横幅）<- 默认用这个
     hailuoWatermarkURL= 只有右下 'Hailuo AI x MINIMAX' 小标
   适配器 url_path 改成数组即「按序取第一个非空」。角标可选本地抹除见 dewatermark()。 */
const cp = require('child_process');
const MEDIA_DIR = process.env.H3P_MEDIA_DIR || path.join(ROOT, 'runtime', 'media');
const DEWATERMARK = String(process.env.H3P_DEWATERMARK == null ? '1' : process.env.H3P_DEWATERMARK) !== '0';
const MEDIA_BASE = String(process.env.H3P_MEDIA_BASE || ('http://127.0.0.1:' + PORT + '/media')).replace(/\/+$/, '');
/* R140 到期预警：还剩多少小时弃号（新人礼 80 贝壳 ~3.8 天寿命） */
const EXPIRY_WARN_H = Number(process.env.H3P_EXPIRY_WARN_H || 12);
/* R140 监听地址：默认只本机；要让「去水印成品图」对外可访问时才用 H3P_BIND=0.0.0.0 */
const BIND = String(process.env.H3P_BIND || '127.0.0.1');
function expiryReport() {
  const t = now();
  const warn = [];
  for (const a of listAccounts()) {
    const exp = Number(a.expires_at || 0);
    if (!(exp > 0)) continue;
    const hours = Math.round(((exp - t) / 3600000) * 100) / 100;
    if (hours <= EXPIRY_WARN_H) warn.push({ id: a.id, label: a.label, credits: a.credits, expires_at: exp, hours_left: hours });
  }
  return { warn_hours: EXPIRY_WARN_H, expiring_soon: warn, soon_count: warn.length };
}
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) {}

/* 把 aiWatermarkURL 下载下来 -> 用 System.Drawing 抹掉右下角标 -> 落到 runtime/media 由本服务托管 */
async function dewatermark(srcUrl, taskId) {
  const rawPath = path.join(MEDIA_DIR, 'raw-' + taskId + '.jpg');
  const outPath = path.join(MEDIA_DIR, taskId + '.jpg');
  const r = await fetch(srcUrl, { signal: AbortSignal.timeout(60000) });
  if (r.status !== 200) throw new Error('download HTTP ' + r.status);
  fs.writeFileSync(rawPath, Buffer.from(await r.arrayBuffer()));
  const ps = path.join(ROOT, 'scripts', 'dewatermark.ps1');
  await new Promise(function (resolve, reject) {
    const c = cp.spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-In', rawPath, '-Out', outPath], { windowsHide: true });
    let e = '';
    c.stderr.on('data', function (d) { e += d.toString(); });
    c.on('error', reject);
    c.on('close', function (code) { if (code === 0 && fs.existsSync(outPath)) resolve(); else reject(new Error('dewatermark.ps1 exit=' + code + ' ' + String(e).slice(0, 200))); });
  });
  try { fs.unlinkSync(rawPath); } catch (e) {}
  return MEDIA_BASE + '/' + taskId + '.jpg';
}
const ADAPTER_AUTH = (ADAPTER && ADAPTER.auth) || { type: 'body', field: 'token' };

/* ---- R114：多站支持（一个池子里国内号/海外号并存）--------------------------------
   适配器可选字段：
     "sites": { "<标签>": { "base": "https://...", "models": { "<pool模型名>": {...} } } }
     "default_site": "<标签>"     // token 第 4 段没写站标签时的缺省站
   账号 token 形如 "token|uuid|device_id|site"；site 缺省=default_site。
   客户端只认 pool 级模型名（MiniMax-Image 等），每站各自映射到真实 modelID。 */
const SITES = (ADAPTER && ADAPTER.sites && typeof ADAPTER.sites === 'object') ? ADAPTER.sites : null;
const DEFAULT_SITE = String((ADAPTER && ADAPTER.default_site) || (SITES ? (Object.keys(SITES)[0] || '') : ''));
function siteOfToken(raw) {
  const parts = String(raw == null ? '' : raw).split('|');
  const tag = String(parts[3] || '').trim();
  if (tag && SITES && SITES[tag]) return tag;
  return DEFAULT_SITE;
}
function baseOfSite(site) {
  const sc = SITES && SITES[site];
  return String((sc && sc.base) || ADAPTER_BASE).replace(/\/+$/, '');
}
function modelsOf(site) {
  const sc = SITES && SITES[site];
  return (sc && sc.models) || (EP.task && EP.task.models) || null;
}

function dig(obj, p) {
  if (!p) return undefined;
  return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/* 适配器 body 模板渲染：{{key}} 当字符串插值，{{n:key}} 当数字插值（引号一起去掉）
   例：{"parameter":{"resolution":"{{resolution}}"},"quantity":"{{n:quantity}}"} */
function renderTpl(tpl, vars) {
  let out = JSON.stringify(tpl);
  out = out.replace(/"\{\{n:([A-Za-z0-9_]+)\}\}"/g, function (m, k) {
    const v = vars[k];
    return (v === undefined || v === null || v === '') ? '0' : String(Number(v) || 0);
  });
  out = out.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, function (m, k) {
    const v = vars[k];
    if (v === undefined || v === null) return '';
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
  });
  try { return JSON.parse(out); } catch (e) { return null; }
}

async function upstream(name, fallbackPath, payload) {
  const e = EP[name] || {};
  const pathname = e.path || fallbackPath;
  const method = String(e.method || 'POST').toUpperCase();
  const auth = e.auth || ADAPTER_AUTH;
  const headers = { 'content-type': 'application/json' };
  const body = Object.assign({}, payload || {});
  const token = body.token;
  delete body.token;
  /* 适配器可给 body 模板（海螺式：{quantity,parameter:{...},projectID}）——模板里用 {{key}} 取 payload 里的字段 */
  /* 模板优先级：本次调用从 models 映射带下来的 __tpl > 适配器 endpoints.task.body */
  const tpl = body.__tpl || e.body;
  delete body.__tpl;
  if (tpl) {
    const rendered = renderTpl(tpl, body);
    if (rendered) { for (const k of Object.keys(body)) delete body[k]; Object.assign(body, rendered); }
  }
  /* auth.type='hailuo_web'：海螺网页端协议（header token + header yy 签名 + 公共参数拼进 query）
     见 scripts/hailuo-sign.js。账号 token 支持 'token|uuid|device_id' 三段。*/
  const isHailuo = String(auth.type) === 'hailuo_web';
  let signedReq = null;
  if (isHailuo) {
    const HS = require('./hailuo-sign.js');
    signedReq = HS.buildSignedRequest({ url: pathname, method: method,
      body: (method === 'GET' || method === 'HEAD') ? undefined : body,
      raw: String(token == null ? '' : token), time: Date.now() });
  } else if (token != null && token !== '') {
    if (auth.type === 'bearer') headers['authorization'] = 'Bearer ' + token;
    else if (auth.type === 'header') headers[String(auth.header || 'x-token').toLowerCase()] = String(token);
    else body[auth.field || 'token'] = token;
  }
  const init = { method: method, headers: signedReq ? signedReq.headers : headers };
  if (method !== 'GET' && method !== 'HEAD') init.body = signedReq ? signedReq.bodyString : JSON.stringify(body);
  let r;
  try {
    const _base = baseOfSite(siteOfToken(token));
    if (signedReq) { try { const _o = new URL(_base).origin; signedReq.headers.origin = _o; signedReq.headers.referer = _o + '/'; } catch (e2) {} }
    r = await fetch(_base + (signedReq ? signedReq.url : pathname), init);
  }
  catch (err) {
    /* 上游不可达/地址没配好：返回 status 0，让调用方按 upstream_error 处理，绝不让进程崩 */
    return { status: 0, json: { error: 'upstream_unreachable', message: String(err && err.message || err) }, retry_after: 0,
      g: { credits: undefined, credits_before: undefined, credits_after: undefined, delta: undefined, task_id: undefined, result_url: undefined, wallet_before: undefined, wallet_after: undefined } };
  }
  let j = null;
  try { j = await r.json(); } catch (err) { j = null; }
  const flat = j || {};
  /* 海螺响应信封 {statusInfo:{code,...}, data}：把业务码翻译成池子既有的 HTTP 语义，换号逻辑全复用
     1000048 -> 401（token 失效 -> 换号/下线）  22 -> 403（封禁）  2400026/2400040 -> 402（贝壳不足 -> 换号）*/
  let httpLike = r.status;
  if (isHailuo) {
    const HS = require('./hailuo-sign.js');
    const cls = HS.classifyResponse(r.status, j);
    httpLike = cls.ok ? 200
      : (cls.kind === 'AUTH_EXPIRED' ? 401
        : cls.kind === 'NO_CREDITS' ? 402
          : cls.kind === 'ACCOUNT_BANNED' ? 403
            : (r.status >= 400 ? r.status : 400));
  }
  const map = e.map || {};
  const pick = function (k, dflt) {
    const v = dig(flat, map[k]);
    return (v === undefined || v === null) ? dig(flat, dflt) : v;
  };
  return {
    status: httpLike,
    json: flat,
    retry_after: Number(r.headers.get('retry-after') || flat.retry_after || 0),
    g: {
      credits: pick('credits', 'balance'),
      credits_before: pick('credits_before', 'before'),
      credits_after: pick('credits_after', 'after'),
      delta: pick('delta', 'delta'),
      task_id: pick('task_id', 'task_id'),
      result_url: pick('result_url', 'video_url'),
      wallet_before: pick('wallet_before', 'wallet.before'),
      wallet_after: pick('wallet_after', 'wallet.after')
    }
  };
}

async function syncWallet(acct) {
  try {
    const w = await upstream('wallet', '/official/v2/wallet', { token: acct.token });
    const bal = Number(w.g.credits);
    if (w.status === 200 && isFinite(bal)) {
      db.prepare('UPDATE accounts SET credits=? WHERE id=?').run(bal, acct.id);
      return bal;
    }
  } catch (e) {}
  return null;
}

/* 导入时探余额：200 -> 回写真实余额；401/403 -> 判该号无效；其它 -> 保持原样等下一轮 */
/* 从上游钱包响应里抽「额度到期时间」：适配器返回的 sub_credits[].end_time 取最大 */
function walletExpiry(w) {
  try {
    const subs = (w && w.json && w.json.data && w.json.data.sub_credits) || [];
    let max = 0;
    for (const s of subs) { const e = Number(s && s.end_time); if (isFinite(e) && e > max) max = e; }
    return max;
  } catch (e) { return 0; }
}

async function probeWallet(acct) {
  try {
    const w = await upstream('wallet', '/official/v2/wallet', { token: acct.token });
    const bal = Number(w.g.credits);
    if (w.status === 200 && isFinite(bal)) {
      const exp = walletExpiry(w);
      if (exp > 0) db.prepare('UPDATE accounts SET credits=?, expires_at=?, fail_reason=NULL WHERE id=?').run(bal, exp, acct.id);
      else db.prepare('UPDATE accounts SET credits=?, fail_reason=NULL WHERE id=?').run(bal, acct.id);
      return { ok: true, credits: bal, expires_at: exp };
    }
    if (w.status === 401 || w.status === 403) { disableAccount(acct, 'PROBE_AUTH_FAILED'); return { ok: false, status: w.status }; }
    return { ok: false, status: w.status };
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
}

/* 复活：把所有「不健康」的号重新探一次余额；上游说 OK 就恢复健康位（上游恢复/误判时不用手工加号） */
async function reviveDead() {
  const rows = db.prepare('SELECT * FROM accounts WHERE healthy=0').all();
  let revived = 0;
  for (const a of rows) {
    const pr = await probeWallet(a);
    if (pr.ok) {
      db.prepare('UPDATE accounts SET healthy=1, fail_reason=NULL, cooldown_until=0 WHERE id=?').run(a.id);
      audit(a.id, null, 'account_revived', undefined, Number(pr.credits), 'by=revive wallet_ok');
      log('复活账号 #' + a.id + ' ' + a.label + ' credits=' + pr.credits);
      revived++;
    }
  }
  return { checked: rows.length, revived, accounts: listAccounts() };
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

/* 供给层共用：插入/更新一个上游账号（token 必填；credits<=0 时标记 probed 交给调用方探余额） */
function insertAccount(inp, requireToken) {
  const o = inp || {};
  const label = String(o.label || 'acct');
  let token = String(o.token || '').trim();
  if (!token) {
    if (requireToken) return { skipped: true, reason: 'token_required' };
    token = 'tk_' + crypto.randomBytes(4).toString('hex');
  }
  const exists = db.prepare('SELECT id FROM accounts WHERE token=?').get(token);
  if (exists && !o.overwrite) return { skipped: true, reason: 'exists' };
  const noCredits = (o.credits === undefined || o.credits === null);
  const credits = Number(o.credits || 0);
  const cap = Number(o.cap || ACCOUNT_CAP) || ACCOUNT_CAP;
  db.prepare('INSERT OR REPLACE INTO accounts (label,token,credits,held,cap,last_checkin_at,healthy,cooldown_until,fail_reason,checkin_count,inflight,success_count,created_at) VALUES (?,?,?,0,?,?,1,0,NULL,0,0,0,?)')
    .run(label, token, credits, cap, now(), now());
  const row = db.prepare('SELECT * FROM accounts WHERE token=?').get(token);
  return { id: row ? row.id : null, token: token, label: label, credits: credits, cap: cap, probed: noCredits };
}
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
    const need = (Number(opts.maxCost) || opts.cost) * RESERVE_FACTOR;   // 提交预占 + 结算实扣（多站取最贵，防预占不足）
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
    /* R114：按账号所在站解析上游模型；该站没有这个模型 -> 跳过该号换下一个（不要整个请求打死） */
    const site = siteOfToken(acct.token);
    const rp = opts.resolveParams ? opts.resolveParams(site) : { cost: opts.cost, params: opts.params || {} };
    if (!rp) {
      tried.push(acct.id);
      lastErr = 'model_unsupported_on_site:' + site;
      log('跳过账号 #' + acct.id + '：站 ' + site + ' 无模型 ' + opts.model);
      continue;
    }
    const taskCost = Number(rp.cost) || opts.cost;
    tried.push(acct.id);
    hold(acct, need);
    let up;
    try {
      up = await upstream('task', '/official/v2/task', Object.assign({ token: acct.token, model: opts.model, spec: opts.spec, cost: taskCost }, rp.params || {}));
    } catch (e) {
      release(acct, need);
      return { ok: false, status: 502, code: 'upstream_error', message: String(e && e.message || e) };
    }
    if (up.status === 200) {
      const wb = Number(up.g.wallet_before);
      const wa = Number(up.g.wallet_after);
      if (isFinite(wa)) db.prepare('UPDATE accounts SET credits=? WHERE id=?').run(wa, acct.id);
      release(acct, need);
      db.prepare('UPDATE accounts SET success_count=success_count+1 WHERE id=?').run(acct.id);
      audit(acct.id, opts.apiKey, 'task_settled', (isFinite(wb) ? wb : undefined), (isFinite(wa) ? wa : undefined), 'model=' + opts.model + ' cost=' + opts.cost + ' attempts=' + attempt + ' adapter=' + ((ADAPTER && ADAPTER.name) || 'builtin'));
      const isAsync = !!(EP.task && EP.task.async);
      return { ok: true, status: 200, account_id: acct.id, account_label: acct.label, attempts: attempt,
        wallet: { before: (isFinite(wb) ? wb : null), after: (isFinite(wa) ? wa : null), delta: Number(up.g.delta) || null },
        pending: isAsync, upstream_task_id: up.g.task_id, result_url: up.g.result_url }; 
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
    if (up.status === 0) {
      return { ok: false, status: 502, code: 'upstream_unreachable',
        message: '上游不可达（检查 config/pool-adapter.json 的 base 或 H3P_UPSTREAM）：' + String(up.json.message || ''),
        detail: { base: ADAPTER_BASE, source: ADAPTER_BASE_SRC } };
    }
    return { ok: false, status: 502, code: 'upstream_error', message: msg || ('upstream http ' + up.status) };
  }
  return { ok: false, status: 503, code: 'upstream_balance',
    message: 'upstream account balance exhausted (已换号重试 ' + MAX_RETRIES + ' 次仍失败)', detail: { attempts: tried.length, last_error: lastErr } };
}

/* ------------------------- 签到补分（带退避） ------------------------- */
/* 为什么要有退避：闸门原来只看 last_checkin_at，而它**只在 200 且 credits_after 有限时才更新**。
   于是上游一旦返回非 200（429/500/风控），闸门永远放行 -> 按扫描周期(5s)疯狂重试，比 60s 严重 12 倍。
   现在：无论成败都记「本次尝试时间」；收益>0 归零，收益=0 或失败则退避翻倍（CHECKIN_MS * 2^n，封顶 H3P_CHECKIN_BACKOFF_MAX_MS 默认 24h）。*/
const checkinState = new Map(); /* id -> { lastAttemptAt, noGain } */
function checkinWaitMs(id) {
  const s = checkinState.get(id);
  if (!s || !s.noGain) return CHECKIN_MS;
  return Math.min(CHECKIN_MS * Math.pow(2, s.noGain), CHECKIN_BACKOFF_MAX_MS);
}
function checkinDue(a, force) {
  if (force) return true;
  const s = checkinState.get(a.id);
  const last = Math.max(Number(a.last_checkin_at || 0), (s && s.lastAttemptAt) || 0);
  return now() - last >= checkinWaitMs(a.id);
}
function checkinMark(id, gained) {
  const s = checkinState.get(id) || { lastAttemptAt: 0, noGain: 0 };
  s.lastAttemptAt = now();
  s.noGain = (gained > 0) ? 0 : (s.noGain + 1);
  checkinState.set(id, s);
  return s;
}

async function checkinTick(force) {
  for (const a of listAccounts()) {
    if (!a.healthy) continue;
    if (!checkinDue(a, force)) continue;
    try {
      const r = await upstream('checkin', '/official/v2/checkin', { token: a.token });
      if (r.status === 200) {
        const after = Number(r.g.credits_after);
        const before = Number(r.g.credits_before);
        if (isFinite(after)) {
          const gained = isFinite(before) ? (after - before) : (after - Number(a.credits || 0));
          const _exp = walletExpiry(r);
          if (_exp > 0) db.prepare('UPDATE accounts SET credits=?, expires_at=?, last_checkin_at=?, checkin_count=checkin_count+1, fail_reason=NULL WHERE id=?')
            .run(after, _exp, now(), a.id);
          else db.prepare('UPDATE accounts SET credits=?, last_checkin_at=?, checkin_count=checkin_count+1, fail_reason=NULL WHERE id=?')
            .run(after, now(), a.id);
          audit(a.id, null, 'daily_checkin', (isFinite(before) ? before : undefined), after, 'delta=' + (r.g.delta || 0));
          const s = checkinMark(a.id, gained);
          log('签到补分：账号 #' + a.id + ' ' + a.label + ' ' + (isFinite(before) ? before : '?') + ' -> ' + after
            + (gained > 0 ? (' (+' + gained + ')') : (' [无新增 -> 退避 x' + s.noGain + '，下次 ' + Math.round(checkinWaitMs(a.id) / 1000) + 's 后]')));
        } else {
          const s = checkinMark(a.id, 0);
          log('签到 200 但拿不到 credits_after 账号#' + a.id + ' [退避 x' + s.noGain + ']');
        }
      } else if (r.status === 401 || r.status === 403) {
        checkinMark(a.id, 0);
        disableAccount(a, 'CHECKIN_AUTH_FAILED');
      } else {
        const s = checkinMark(a.id, 0);
        log('签到返回 http ' + r.status + ' 账号#' + a.id + ' [退避 x' + s.noGain + '，下次 ' + Math.round(checkinWaitMs(a.id) / 1000) + 's 后] :: ' + JSON.stringify(r.json).slice(0, 120));
      }
    } catch (e) { const s = checkinMark(a.id, 0); log('签到失败 账号#' + a.id + ': ' + e.message + ' [退避 x' + s.noGain + ']'); }
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
  try { return await handle(req, res); } catch (e) { log('handler 异常: ' + (e && e.message || e)); try { send(res, 500, { code: 'internal_error', message: String(e && e.message || e) }); } catch (e2) {} }
});

async function handle(req, res) {
  const url = req.url.split('?')[0];
  const body = await readBody(req);
  const isAdmin = String(req.headers['x-admin-key'] || body.admin_key || '') === ADMIN_KEY;

  if (req.method === 'GET' && url === '/healthz') return send(res, 200, { ok: true, pool: 'platform', inflight, max_inflight: MAX_INFLIGHT });
  /* R140 去水印后的成品图托管 */
  if (req.method === 'GET' && url.startsWith('/media/')) {
    const _name = decodeURIComponent(url.slice('/media/'.length));
    if (!/^[A-Za-z0-9._-]+$/.test(_name)) return send(res, 400, { code: 'bad_name' });
    const _f = path.join(MEDIA_DIR, _name);
    if (!fs.existsSync(_f)) return send(res, 404, { code: 'not_found' });
    const _buf = fs.readFileSync(_f);
    res.writeHead(200, { 'content-type': /\.png$/i.test(_name) ? 'image/png' : 'image/jpeg', 'content-length': _buf.length, 'cache-control': 'public, max-age=86400' });
    return res.end(_buf);
  }
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
    /* 适配器给了 models 映射 -> 用上游真实单价与参数（海螺：modelID + resolution/aspectRatio/quality 的 valueStr）
       R114：改为「按账号所在站」解析；每个站可以有不同 modelID（国内 all-in-one-image-pro / 海外 nano-banana2）。 */
    const promptStr = String(body.prompt || body.desc || '');
    const quantity = Number(body.n || body.quantity || 1);
    const resolveParams = (site) => {
      const mmap = modelsOf(site);
      const mp = mmap && mmap[model] ? mmap[model] : null;
      if (!mp) return null;
      return { cost: Number(mp.cost) || cost, params: Object.assign({ prompt: promptStr, quantity: quantity, limit: 20, __tpl: mp.body }, mp) };
    };
    const siteCosts = (SITES ? Object.keys(SITES) : ['']).map((st) => { const rp = resolveParams(st); return rp ? rp.cost : 0; });
    const maxCost = Math.max(cost, siteCosts.length ? Math.max.apply(null, siteCosts) : 0);
    const eager = resolveParams(DEFAULT_SITE);
    if (eager) cost = eager.cost;
    if (url === '/v1/audio/speech' && body.input) cost = Math.max(0.1, String(body.input).length * 0.1);
    const ch = chargeKey(a.key, cost);
    if (!ch.ok) return send(res, ch.err.status, ch.err);

    inflight += 1;
    let r;
    try {
      if (s.kind === 'chat') {
        r = { ok: true, status: 200, account_id: null, account_label: '(M3 不扣 credit)', attempts: 0, upstream_task_id: null, result_url: null, text: 'mock: 这是平台池的 M3 文本回答（计入调用次数，不扣 credit）' };
      } else {
        r = await runPoolTask({ model, spec: Object.assign({}, body), cost, maxCost, apiKey: a.key.key, resolveParams });
      }
    } finally { inflight -= 1; }

    if (!r.ok) {
      refundKey(a.key, cost);
      return send(res, r.status, { code: r.code, message: r.message, detail: r.detail || null, queued: !!r.queued }, r.status === 429 ? { 'retry-after': '5' } : undefined);
    }
    const taskId = 'task_' + crypto.randomBytes(6).toString('hex');
    /* node:sqlite 不认 undefined -> 一律转 null（异步任务 result_url 起初就是空的） */
    const nn = (v) => (v === undefined || v === null) ? null : v;
    db.prepare('INSERT INTO tasks (id,api_key,model,spec_json,status,credits_cost,account_id,attempts,upstream_task_id,result_url,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(taskId, a.key.key, model, JSON.stringify({ prompt: body.prompt || null }), (r.pending ? 'pending' : 'succeeded'), cost, nn(r.account_id), nn(r.attempts), nn(r.upstream_task_id), nn(r.result_url), null, now(), now());
    if (r.account_id) audit(r.account_id, a.key.key, 'task_ok', r.wallet.before, r.wallet.after, 'task=' + taskId + ' attempts=' + r.attempts);
    autoRevoke();
    if (s.kind === 'chat') return send(res, 200, { id: 'chatcmpl_' + taskId, object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: r.text } }], usage: { total_tokens: 1 } });
    return send(res, 200, {
      task_id: taskId, id: taskId, object: 'video.generation', model, status: (r.pending ? 'processing' : 'succeeded'),
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
      return send(res, 200, { accounts: listAccounts().map(function (a) { return Object.assign({}, a, { hours_left: Number(a.expires_at || 0) > 0 ? Math.round(((Number(a.expires_at) - now()) / 3600000) * 100) / 100 : null }); }), expiry: expiryReport(), inflight, max_inflight: MAX_INFLIGHT, auto_prune: { expired: AUTO_PRUNE_EXPIRED, zero: AUTO_PRUNE_ZERO },
        config: { checkin_interval_ms: CHECKIN_MS, checkin_backoff_max_ms: CHECKIN_BACKOFF_MAX_MS, daily_credits: DAILY_CREDITS, reserve_factor: RESERVE_FACTOR, max_retries: MAX_RETRIES, credit_per_clip: CREDIT_PER_CLIP },
        checkin_state: Array.from(checkinState.entries()).map(([id, s]) => ({ id: id, no_gain: s.noGain, wait_ms: checkinWaitMs(id), last_attempt_at: s.lastAttemptAt })),
        audit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 50').all() });
    }
    if (req.method === 'POST' && url === '/pool/reset') {
      db.exec('DELETE FROM accounts; DELETE FROM api_keys; DELETE FROM codes; DELETE FROM tasks; DELETE FROM audit;');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/pool/accounts') {
      const r = insertAccount(body, false);
      if (r.skipped) return send(res, 400, { ok: false, code: 'bad_account', reason: r.reason });
      if (r.probed) { const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(r.id); const pr = await probeWallet(row); if (pr.ok) r.credits = pr.credits; }
      return send(res, 200, { ok: true, id: r.id, token: r.token, label: r.label, credits: r.credits, probed: r.probed });
    }
    if (req.method === 'POST' && url === '/pool/accounts/revive') { return send(res, 200, Object.assign({ ok: true }, await reviveDead())); }
    if (req.method === 'POST' && url === '/pool/accounts/delete') {
      const id = Number(body.id);
      if (!id) return send(res, 400, { ok: false, code: 'bad_id' });
      const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
      if (!row) return send(res, 404, { ok: false, code: 'not_found', id: id });
      db.prepare('DELETE FROM accounts WHERE id=?').run(id);
      log('删除账号 #' + id + ' ' + row.label);
      return send(res, 200, { ok: true, removed: { id: id, label: row.label }, accounts: listAccounts() });
    }
    if (req.method === 'POST' && url === '/pool/accounts/prune') {
      /* 清掉「0 额度」的死号：d1jiema 回收号没有新人礼、探出来就是 0，留着只会撑爆 total、占 POOL_MAX 名额。
         默认只删「健康且 0 额度」的（body.all=true 连不健康的一起删）。 */
      const before = Number(db.prepare('SELECT COUNT(*) c FROM accounts').get().c || 0);
      db.prepare(body.all ? 'DELETE FROM accounts WHERE credits<=0' : 'DELETE FROM accounts WHERE credits<=0 AND healthy=1').run();
      const after = Number(db.prepare('SELECT COUNT(*) c FROM accounts').get().c || 0);
      log('prune: 删除 ' + (before - after) + ' 个 0 额度号，剩 ' + after);
      return send(res, 200, { ok: true, removed: before - after, remaining: after, accounts: listAccounts() });
    }
    if (req.method === 'POST' && url === '/pool/accounts/bulk') {
      const arr = Array.isArray(body.accounts) ? body.accounts : [];
      if (!arr.length) return send(res, 400, { ok: false, code: 'no_accounts' });
      let imported = 0, skipped = 0, probed = 0; const newIds = [];
      for (const a0 of arr) {
        const r = insertAccount(a0, true);
        if (r.skipped) { skipped++; continue; }
        imported++; probed += r.probed ? 1 : 0; newIds.push(r.id);
      }
      for (const id of newIds) {
        const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
        if (row) await probeWallet(row);
      }
      return send(res, 200, { ok: true, total: arr.length, imported, skipped, probed, accounts: listAccounts() });
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
}

/* ---------------- 异步任务轮询（海螺是异步：先拿 data.id，几秒后结果出现在 feed 列表） ---------------- */
let pollBusy = false;
async function pollPending() {
  if (!EP.query) return;
  const qcfg = EP.query.map || {};
  const rows = db.prepare("SELECT * FROM tasks WHERE status='pending' AND upstream_task_id IS NOT NULL ORDER BY updated_at DESC LIMIT 50").all();
  for (const t of rows) {
    /* R114：超时兜底。上游若最终不产出 feed 项（生成彻底失败），任务会永远 pending -> 客户白等、key 被白扣。
       超过 H3P_PENDING_TIMEOUT_MS 仍 pending：判 failed + 原路退回客户 key 的额度 + 取消自动销号。 */
    if (now() - Number(t.created_at || 0) > PENDING_TIMEOUT_MS) {
      db.prepare("UPDATE tasks SET status='failed', error='poll_timeout', updated_at=? WHERE id=?").run(now(), t.id);
      const krow = db.prepare('SELECT * FROM api_keys WHERE key=?').get(t.api_key);
      if (krow && !krow.unlimited) {
        db.prepare('UPDATE api_keys SET credits=credits+?, calls=MAX(calls-1,0), revoked=0 WHERE key=?').run(Number(t.credits_cost || 0), krow.key);
      }
      audit(t.account_id, t.api_key, 'task_timeout', undefined, undefined, 'task=' + t.id + ' refunded=' + Number(t.credits_cost || 0));
      log('任务超时判失败：' + t.id + '（> ' + PENDING_TIMEOUT_MS + 'ms），已退回 key 额度 ' + Number(t.credits_cost || 0));
      continue;
    }
    const acct = t.account_id ? getAccount(t.account_id) : null;
    if (!acct) { db.prepare("UPDATE tasks SET status='failed', error='account_missing', updated_at=? WHERE id=?").run(now(), t.id); continue; }
    const q = await upstream('query', '/api/feed/creation/search/my', { token: acct.token, limit: 20 });
    if (q.status !== 200) { if (process.env.H3P_DEBUG_POLL) log('poll ' + t.id + ' 上游 http ' + q.status + ' :: ' + JSON.stringify(q.json).slice(0, 140)); continue; }
    const feeds = dig(q.json, qcfg.list_path || 'data.feeds');
    if (!Array.isArray(feeds)) { if (process.env.H3P_DEBUG_POLL) log('poll ' + t.id + ' feeds 不是数组'); continue; }
    const hit = feeds.find((f) => String(dig(f, qcfg.id_path || 'commonInfo.id')) === String(t.upstream_task_id));
    if (!hit) { if (process.env.H3P_DEBUG_POLL) log('poll ' + t.id + ' 未命中(upid=' + t.upstream_task_id + ' feeds=' + feeds.length + ')'); continue; }
    const st = Number(dig(hit, qcfg.status_path || 'commonInfo.status'));
    /* R140: url_path 支持数组（按序取第一个非空），默认优先「无品牌横幅」的 aiWatermarkURL */
    const _cands = [].concat(qcfg.url_path || 'metaInfo.imageMetaInfo.mediaInfo.url');
    let url = '';
    for (const _c of _cands) { const _v = dig(hit, _c); if (_v) { url = _v; break; } }
    if (st === 2 && url) {
      let finalUrl = String(url);
      if (DEWATERMARK) {
        try { const local = await dewatermark(String(url), t.id); if (local) finalUrl = local; }
        catch (e) { log('去水印失败（回退上游原图）: ' + e.message); }
      }
      db.prepare("UPDATE tasks SET status='succeeded', result_url=?, updated_at=? WHERE id=?").run(finalUrl, now(), t.id);
      audit(acct.id, t.api_key, 'task_polled', undefined, undefined, 'task=' + t.id + ' url_ok');
    } else if (st === 6) {
      db.prepare("UPDATE tasks SET status='failed', error='upstream_failed', updated_at=? WHERE id=?").run(now(), t.id);
    }
  }
}
let checkinBusy = false;
setInterval(async () => { if (checkinBusy) return; checkinBusy = true; try { await checkinTick(); const sw = expireSweep(); if (sw.expired || sw.zero) log('到期清扫: 过期弃号 ' + sw.expired + ' / 零额度弃号 ' + sw.zero); } finally { checkinBusy = false; } }, Math.min(CHECKIN_MS, 5000));

setInterval(async () => { if (pollBusy) return; pollBusy = true; try { await pollPending(); } catch (e) {} finally { pollBusy = false; } }, Math.max(3000, Number(process.env.H3P_POLL_MS || 5000)));

server.listen(PORT, BIND, () => log('[h3-platform-pool] listening on ' + BIND + ':' + PORT + ' upstream=' + ADAPTER_BASE + ' (from ' + ADAPTER_BASE_SRC + ')' +
  ' checkin=' + CHECKIN_MS + 'ms daily=' + DAILY_CREDITS + ' reserve_x' + RESERVE_FACTOR + ' retries=' + MAX_RETRIES + ' inflight=' + MAX_INFLIGHT));