/**
 * mock-flow.js -- 模拟「Google Flow 网页端」上游（供 flow-pool 池②联调，不联网、不出图）
 *
 *   node scripts/mock-flow.js            # 默认 127.0.0.1:9931
 *
 * 它复刻的是 flow2api 依赖的那几个上游行为：
 *   POST /internal/login     {st}                -> {at, expires}      （ST 换 AT）
 *   POST /internal/credits   {at}                -> {credits, userPaygateTier}
 *   POST /internal/generate  {at, prompt, kind}  -> 200 {url, remaining}
 *                                                   401 invalid_at / 402 insufficient_credits / 429 rate_limit_exceeded / 500
 *   GET  /internal/admin/state                    -> 查看/演示用
 *   POST /internal/admin/state                    -> 造场景（设额度、把某号打成 429 号）
 *
 * 环境变量：FLOW_AT_TTL_SECONDS（AT 有效期，默认 3600）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.FLOW_PORT || 9931);
const AT_TTL = Number(process.env.FLOW_AT_TTL_SECONDS || 3600) * 1000;
const ROOT = path.resolve(__dirname, '..');
const LOGF = path.join(ROOT, 'runtime', 'logs', 'mock-flow.log');

/* st -> 账号状态 */
const accounts = new Map();
function acct(st) {
  if (!accounts.has(st)) accounts.set(st, { st, email: st + '@mock', credits: 2, tier: 'PAYGATE_TIER_ONE', rate_limit: false, calls: 0, ats: new Map() });
  return accounts.get(st);
}

let bomDone = false;
function log(s) {
  const line = '[' + new Date().toISOString() + '] ' + s;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOGF), { recursive: true });
    if (!bomDone && !fs.existsSync(LOGF)) fs.writeFileSync(LOGF, '\uFEFF', 'utf8');
    bomDone = true; fs.appendFileSync(LOGF, line + '\n', 'utf8'); } catch (e) {}
}

const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { res({}); } }); });
const send = (res, code, obj) => { const s = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) }); res.end(s); };

function findAt(at) {
  for (const a of accounts.values()) for (const [tok, exp] of a.ats) if (tok === at) return { acct: a, exp };
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const body = await readBody(req);

  if (p === '/internal/login' && req.method === 'POST') {
    const a = acct(String(body.st || ''));
    const at = 'at_' + crypto.randomBytes(16).toString('hex');
    const expires = Date.now() + AT_TTL;
    a.ats.set(at, expires);
    log('login st=' + a.email + ' -> at=' + at.slice(0, 12) + '… ttl=' + (AT_TTL / 1000) + 's');
    return send(res, 200, { at, expires: new Date(expires).toISOString() });
  }

  if (p === '/internal/credits' && req.method === 'POST') {
    const f = findAt(String(body.at || ''));
    if (!f || f.exp <= Date.now()) return send(res, 401, { error: 'invalid_at' });
    log('credits ' + f.acct.email + ' = ' + f.acct.credits);
    return send(res, 200, { credits: f.acct.credits, userPaygateTier: f.acct.tier });
  }

  if (p === '/internal/generate' && req.method === 'POST') {
    const f = findAt(String(body.at || ''));
    if (!f) return send(res, 401, { error: 'invalid_at' });
    if (f.exp <= Date.now()) return send(res, 401, { error: 'invalid_at', note: 'AT 已过期' });
    const a = f.acct;
    a.calls++;
    if (a.rate_limit) { log('generate ' + a.email + ' -> 429 (被标记为限流号)'); return send(res, 429, { error: 'rate_limit_exceeded' }); }
    if (a.credits <= 0) { log('generate ' + a.email + ' -> 402 (额度耗尽)'); return send(res, 402, { error: 'insufficient_credits' }); }
    a.credits -= 1;
    const url2 = 'https://mock-cdn.local/' + crypto.randomBytes(8).toString('hex') + '.png';
    log('generate ' + a.email + ' -> 200  剩余 credits=' + a.credits + '  (' + (body.kind || 'image') + ')');
    return send(res, 200, { url: url2, remaining: a.credits, account: a.email });
  }

  if (p === '/internal/admin/state' && req.method === 'GET') {
    const out = {};
    for (const a of accounts.values()) out[a.st] = { email: a.email, credits: a.credits, rate_limit: a.rate_limit, calls: a.calls, ats: a.ats.size };
    return send(res, 200, out);
  }

  if (p === '/internal/admin/state' && req.method === 'POST') {
    const a = acct(String(body.st || ''));
    if (typeof body.credits === 'number') a.credits = body.credits;
    if (typeof body.rate_limit === 'boolean') a.rate_limit = body.rate_limit;
    log('admin set ' + a.email + ' credits=' + a.credits + ' rate_limit=' + a.rate_limit);
    return send(res, 200, { ok: true, email: a.email, credits: a.credits, rate_limit: a.rate_limit });
  }

  send(res, 404, { error: 'not_found', path: p });
});

server.listen(PORT, '127.0.0.1', () => log('mock-flow 启动: http://127.0.0.1:' + PORT + '  AT_TTL=' + (AT_TTL / 1000) + 's'));