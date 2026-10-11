/**
 * flow-pool.js -- 「池②：Google/Flow 账号池」的 Node 1:1 复刻（照抄 TheSmallHanCat/flow2api，MIT）
 *
 *   node scripts/flow-pool.js
 *
 * 抄的是 flow2api 的**账号池状态机**，逐条对应源码：
 *   1) 凭据模型   src/core/models.py  Token:
 *        st(__Secure-next-auth.session-token) / at / at_expires / credits / user_paygate_tier
 *        image_enabled / video_enabled / image_concurrency / video_concurrency
 *        proxy_url(一号一代理) / ban_reason / banned_at
 *   2) AT 自动刷新  token_manager.py _should_refresh_at():
 *        AT 不存在，或 at_expires - now < 3600s  -> 刷新
 *   3) 429 熔断    token_manager.py ban_token_for_429():
 *        is_active=0, ban_reason='429_rate_limit', banned_at=now
 *   4) 自动解禁    token_manager.py auto_unban_429_tokens():
 *        now - banned_at >= 12*3600s 且 AT 未过期 -> is_active=1 && 清空 ban && 清零错误计数
 *   5) 连续错误熔断 record_error():
 *        consecutive_error_count >= error_ban_threshold -> disable；record_success 清零
 *   6) 瞬时错误白名单 _is_transient_network_failure():
 *        timed out / timeout / connection / curl: ( / proxy / network / 504 -> 不算账号故障
 *   7) 调度排序    load_balancer.py:
 *        sort key = (needs_refresh?1:0, inflight, remaining is None?0:1, -remaining, random)
 *        然后 ready_candidates + refresh_candidates（需刷新的排最后）
 *   8) DB 兜底     database.py: SELECT * FROM tokens WHERE is_active=1
 *
 * 环境变量：
 *   FLOW_POOL_PORT=9930  POOL_KEY=sk-pool-google-demo  FLOW_UPSTREAM=http://127.0.0.1:9931
 *   FLOW_BAN_SECONDS=43200(12h)  FLOW_AT_REFRESH_SECONDS=3600  FLOW_ERROR_BAN_THRESHOLD=5
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.FLOW_POOL_PORT || 9930);
const POOL_KEY = process.env.POOL_KEY || 'sk-pool-google-demo';
const UPSTREAM = (process.env.FLOW_UPSTREAM || 'http://127.0.0.1:9931').replace(/\/+$/, '');
const BAN_MS = Number(process.env.FLOW_BAN_SECONDS || 43200) * 1000;          // 照抄 12*3600
const AT_REFRESH_MS = Number(process.env.FLOW_AT_REFRESH_SECONDS || 3600) * 1000;  // 照抄 <3600s
const ERROR_BAN_THRESHOLD = Number(process.env.FLOW_ERROR_BAN_THRESHOLD || 5);
const LOGF = path.join(ROOT, 'runtime', 'logs', 'flow-pool.log');

const TRANSIENT = ['timed out', 'timeout', 'connection', 'curl: (', 'proxy', 'network', '502', '503', '504', 'fetch failed', 'econnrefused', 'econnreset', 'socket hang up'];

let bomDone = false;
function log(s) {
  const line = '[' + new Date().toISOString() + '] ' + s;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOGF), { recursive: true });
    if (!bomDone && !fs.existsSync(LOGF)) fs.writeFileSync(LOGF, '\uFEFF', 'utf8');
    bomDone = true; fs.appendFileSync(LOGF, line + '\n', 'utf8'); } catch (e) {}
}

/* ---------------- 存储层（对应 flow2api 的 tokens 表） ---------------- */
fs.mkdirSync(path.join(ROOT, 'runtime', 'data'), { recursive: true });
const db = new DatabaseSync(path.join(ROOT, 'runtime', 'data', 'flowpool.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  st TEXT UNIQUE NOT NULL,
  at TEXT,
  at_expires INTEGER,
  email TEXT,
  credits INTEGER DEFAULT 0,
  user_paygate_tier TEXT,
  image_enabled INTEGER DEFAULT 1,
  video_enabled INTEGER DEFAULT 1,
  image_concurrency INTEGER DEFAULT -1,
  video_concurrency INTEGER DEFAULT -1,
  proxy_url TEXT DEFAULT '',
  is_active INTEGER DEFAULT 1,
  ban_reason TEXT,
  banned_at INTEGER,
  consecutive_error_count INTEGER DEFAULT 0,
  use_count INTEGER DEFAULT 0,
  last_used_at INTEGER,
  inflight_image INTEGER DEFAULT 0,
  inflight_video INTEGER DEFAULT 0,
  created_at INTEGER
)`);
const allTokens = () => db.prepare('SELECT * FROM tokens ORDER BY id').all();
const getToken = (id) => db.prepare('SELECT * FROM tokens WHERE id = ?').get(id);

/* ---------------- 上游调用（对应 flow_client.py / token_manager.py） ---------------- */
async function up(pathname, body) {
  try {
    const r = await fetch(UPSTREAM + pathname, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000)
    });
    let j = {};
    try { j = await r.json(); } catch (e) {}
    return { status: r.status, json: j };
  } catch (e) {
    return { status: 0, json: {}, error: String(e && e.message || e) };
  }
}

const isTransient = (msg) => {
  const t = String(msg || '').toLowerCase();
  if (!t) return false;
  return TRANSIENT.some(k => t.includes(k));
};

/* ---------------- 2) AT 自动刷新（照抄 _should_refresh_at） ---------------- */
function needsRefresh(t) {
  if (!t.at) return true;
  if (!t.at_expires) return true;
  return (t.at_expires - Date.now()) < AT_REFRESH_MS;   // 源码: total_seconds() < 3600
}
async function ensureValidToken(t) {
  if (!needsRefresh(t)) return t;
  const r = await up('/internal/login', { st: t.st });
  if (r.status !== 200 || !r.json.at) { log('  [AT] token#' + t.id + ' 刷新失败 status=' + r.status); return null; }
  const exp = Date.parse(r.json.expires);
  db.prepare('UPDATE tokens SET at=?, at_expires=? WHERE id=?').run(r.json.at, exp, t.id);
  log('  [AT] token#' + t.id + ' AT 已刷新（剩余不足 ' + (AT_REFRESH_MS / 1000) + 's）');
  return getToken(t.id);
}

/* ---------------- 3/4) 429 熔断 + 自动解禁（照抄） ---------------- */
function banFor429(t) {
  db.prepare("UPDATE tokens SET is_active=0, ban_reason='429_rate_limit', banned_at=? WHERE id=?").run(Date.now(), t.id);
  log("  [429_BAN] 禁用账号 #" + t.id + " " + t.email + "（原因: 429 Rate Limit，冷却 " + (BAN_MS / 3600000) + "h）");
}
function autoUnban() {
  const now = Date.now();
  for (const t of allTokens()) {
    if (t.ban_reason !== '429_rate_limit' || t.is_active) continue;
    if (!t.banned_at) continue;
    if (t.at_expires && t.at_expires <= now) continue;          // 源码: 已过期跳过
    if (now - t.banned_at >= BAN_MS) {                          // 源码: >= 12*3600
      db.prepare('UPDATE tokens SET is_active=1, ban_reason=NULL, banned_at=NULL, consecutive_error_count=0 WHERE id=?').run(t.id);
      log('  [AUTO_UNBAN] 解禁账号 #' + t.id + ' ' + t.email + '（已过 ' + ((now - t.banned_at) / 1000).toFixed(0) + 's）');
    }
  }
}
function recordError(t, why) {
  db.prepare('UPDATE tokens SET consecutive_error_count = consecutive_error_count + 1 WHERE id=?').run(t.id);
  const cur = getToken(t.id);
  if (cur.consecutive_error_count >= ERROR_BAN_THRESHOLD) {
    db.prepare('UPDATE tokens SET is_active=0, ban_reason=? WHERE id=?').run('error_threshold', t.id);
    log('  [TOKEN_BAN] #' + t.id + ' 连续错误 ' + cur.consecutive_error_count + ' 达阈值 ' + ERROR_BAN_THRESHOLD + ' -> 自动禁用');
  } else log('  [ERR] #' + t.id + ' 连续错误=' + cur.consecutive_error_count + ' (' + why + ')');
}
function recordSuccess(t) {
  db.prepare('UPDATE tokens SET consecutive_error_count=0, use_count=use_count+1, last_used_at=? WHERE id=?').run(Date.now(), t.id);
}

/* ---------------- 7) 调度排序（照抄 load_balancer.py） ---------------- */
function candidates(kind) {
  const now = Date.now();
  const list = allTokens().filter(t => t.is_active === 1 && (kind === 'video' ? t.video_enabled : t.image_enabled));
  const rows = list.map(t => {
    const inflight = kind === 'video' ? t.inflight_video : t.inflight_image;
    const cap = kind === 'video' ? t.video_concurrency : t.image_concurrency;
    return { t, inflight, cap, remaining: cap < 0 ? null : (cap - inflight), needs_refresh: needsRefresh(t) ? 1 : 0, random: Math.random(), now };
  });
  rows.sort((a, b) => (
    (a.needs_refresh - b.needs_refresh) ||
    (a.inflight - b.inflight) ||
    ((a.remaining === null ? 0 : 1) - (b.remaining === null ? 0 : 1)) ||
    (-(a.remaining || 0) - -(b.remaining || 0)) ||
    (a.random - b.random)
  ));
  const ready = rows.filter(r => !r.needs_refresh);
  const refresh = rows.filter(r => r.needs_refresh);
  return ready.concat(refresh);
}

function reserve(t, kind) {
  const col = kind === 'video' ? 'inflight_video' : 'inflight_image';
  db.prepare('UPDATE tokens SET ' + col + ' = ' + col + ' + 1 WHERE id=?').run(t.id);
}
function release(t, kind) {
  const col = kind === 'video' ? 'inflight_video' : 'inflight_image';
  db.prepare('UPDATE tokens SET ' + col + ' = MAX(0, ' + col + ' - 1) WHERE id=?').run(t.id);
}

/* ---------------- 主流程：取号 -> 生成（失败换号，最多 N 轮） ---------------- */
/* ---------------- 主流程：按候选序逐个下走（照抄 flow2api 的 ordered candidates 语义） ---------------- */
/* 修复点：每个 token 在同一请求里最多试一次；失败的号记进 tried 集合，不会再被随机挑回来。*/
async function generate(kind, prompt) {
  const trace = [];
  const order = candidates(kind);
  if (!order.length) return { ok: false, code: 503, error: 'no_available_account', trace };

  const tried = new Set();
  for (const c of order) {
    if (tried.has(c.t.id)) continue;
    tried.add(c.t.id);

    const t0 = getToken(c.t.id);
    if (!t0 || t0.is_active !== 1) { trace.push('#' + c.t.id + ' 已不可用 -> 跳过'); continue; }

    const inflight = kind === 'video' ? t0.inflight_video : t0.inflight_image;
    const cap = kind === 'video' ? t0.video_concurrency : t0.image_concurrency;
    if (cap >= 0 && inflight >= cap) { trace.push('#' + t0.id + ' 并发槽满 ' + inflight + '/' + cap + ' -> 跳过'); continue; }

    const t = await ensureValidToken(t0);
    if (!t) { trace.push('#' + t0.id + ' AT 刷新失败 -> 跳过'); continue; }

    reserve(t, kind);
    const pickOrder = candidates(kind).map((x) => x.t.id).join('>');
    log('  [PICK] ' + kind + ' 选中 #' + t.id + ' ' + t.email + '  候选序=' + pickOrder);
    const r = await up('/internal/generate', { at: t.at, prompt, kind });
    release(t, kind);

    if (r.status === 200) {
      recordSuccess(t);
      db.prepare('UPDATE tokens SET credits=? WHERE id=?').run(Number(r.json.remaining !== undefined ? r.json.remaining : t.credits), t.id);
      trace.push('#' + t.id + ' 200 OK');
      return { ok: true, code: 200, account: t.email, url: r.json.url, credits: r.json.remaining, trace };
    }
    if (r.status === 429) { banFor429(t); trace.push('#' + t.id + ' 429 -> 熔断换号'); continue; }
    if (r.status === 402) { db.prepare('UPDATE tokens SET credits=0 WHERE id=?').run(t.id); trace.push('#' + t.id + ' 402 额度耗尽 -> 换号'); continue; }
    if (r.status === 401) { db.prepare('UPDATE tokens SET at=NULL, at_expires=NULL WHERE id=?').run(t.id); trace.push('#' + t.id + ' 401 AT 失效 -> 清 AT 后换号'); continue; }
    const msg = r.error || ('HTTP ' + r.status);
    if (r.status === 0 || isTransient(msg)) { trace.push('#' + t.id + ' 瞬时错误(' + msg + ') -> 不算故障，换号'); continue; }
    recordError(t, msg);
    trace.push('#' + t.id + ' 错误(' + msg + ')');
  }
  return { ok: false, code: 503, error: 'all_accounts_failed', trace };
}

/* ---------------- HTTP ---------------- */
const readBody = (req) => new Promise(res => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { res({}); } }); });
const send = (res, code, obj) => { const s = JSON.stringify(obj, null, 2); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) }); res.end(s); };

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const body = await readBody(req);
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const isAdmin = req.headers['x-pool-admin'] === POOL_KEY;

  if (p === '/v1/models') return send(res, 200, { object: 'list', data: [{ id: 'gemini-nano-banana-2.1-image', object: 'model', owned_by: 'flow-pool' }] });

  if (p === '/pool/stats') {
    if (!isAdmin) return send(res, 401, { error: 'admin only (header x-pool-admin)' });
    const rows = allTokens().map(t => ({
      id: t.id, email: t.email, credits: t.credits, is_active: !!t.is_active, ban_reason: t.ban_reason,
      banned_ago_s: t.banned_at ? Math.floor((Date.now() - t.banned_at) / 1000) : null,
      will_unban_in_s: (t.ban_reason === '429_rate_limit' && t.banned_at) ? Math.max(0, Math.floor((t.banned_at + BAN_MS - Date.now()) / 1000)) : null,
      at_left_s: t.at_expires ? Math.floor((t.at_expires - Date.now()) / 1000) : null,
      needs_refresh: needsRefresh(t), inflight_image: t.inflight_image, inflight_video: t.inflight_video,
      image_concurrency: t.image_concurrency, consecutive_error_count: t.consecutive_error_count, use_count: t.use_count
    }));
    return send(res, 200, { ban_seconds: BAN_MS / 1000, at_refresh_seconds: AT_REFRESH_MS / 1000, error_ban_threshold: ERROR_BAN_THRESHOLD, accounts: rows });
  }

  if (p === '/pool/accounts' && req.method === 'POST') {
    if (!isAdmin) return send(res, 401, { error: 'admin only' });
    const st = String(body.st || ''); if (!st) return send(res, 400, { error: 'st required' });
    const exists = db.prepare('SELECT id FROM tokens WHERE st=?').get(st);
    if (exists) db.prepare('UPDATE tokens SET credits=?, is_active=1, ban_reason=NULL, banned_at=NULL WHERE id=?').run(Number(body.credits ?? 2), exists.id);
    else db.prepare('INSERT INTO tokens (st,email,credits,image_concurrency,video_concurrency,proxy_url,is_active,created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(st, body.email || (st + '@mock'), Number(body.credits ?? 2), Number(body.image_concurrency ?? -1), Number(body.video_concurrency ?? -1), body.proxy_url || '', Date.now());
    const t = db.prepare('SELECT * FROM tokens WHERE st=?').get(st);
    return send(res, 200, { ok: true, token: { id: t.id, email: t.email, credits: t.credits } });
  }

  if (p === '/pool/reset' && req.method === 'POST') {
    if (!isAdmin) return send(res, 401, { error: 'admin only' });
    db.exec('DELETE FROM tokens');
    log('池已清空');
    return send(res, 200, { ok: true });
  }

  if (p === '/pool/unban' && req.method === 'POST') {
    if (!isAdmin) return send(res, 401, { error: 'admin only' });
    db.prepare("UPDATE tokens SET is_active=1, ban_reason=NULL, banned_at=NULL WHERE ban_reason='429_rate_limit'").run();
    return send(res, 200, { ok: true, note: '强制解禁（测试用）' });
  }

  if ((p === '/v1/chat/completions' || p === '/v1/images/generations') && req.method === 'POST') {
    if (bearer !== POOL_KEY) return send(res, 401, { error: { message: 'invalid pool key', type: 'invalid_request_error' } });
    const kind = p.includes('images') ? 'image' : 'image';
    const prompt = String(body.prompt || (body.messages && body.messages[0] && body.messages[0].content) || '');
    const out = await generate(kind, prompt);
    log('[REQ] ' + p + ' -> ' + out.code + (out.ok ? (' 由 ' + out.account) : ' ' + out.error) + '  trace=' + JSON.stringify(out.trace));
    if (!out.ok) return send(res, out.code, { error: { message: out.error, type: 'upstream_error', trace: out.trace } });
    if (p.includes('images')) return send(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ url: out.url, revised_prompt: prompt, _account: out.account }] });
    return send(res, 200, { id: 'chatcmpl-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model || 'gemini-nano-banana-2.1-image', choices: [{ index: 0, message: { role: 'assistant', content: '![](' + out.url + ')' }, finish_reason: 'stop' }], _account: out.account });
  }

  send(res, 404, { error: 'not_found', path: p });
});

setInterval(autoUnban, 5000).unref();
server.listen(PORT, '127.0.0.1', () => {
  log('flow-pool(池②) 启动: http://127.0.0.1:' + PORT + '  上游=' + UPSTREAM);
  log('  抄自 flow2api: AT刷新阈值<=' + (AT_REFRESH_MS / 1000) + 's ｜ 429 冷却=' + (BAN_MS / 3600000) + 'h ｜ 连续错误阈值=' + ERROR_BAN_THRESHOLD);
  log('  pool key=' + POOL_KEY + '  (管理员头 x-pool-admin)');
});