/**
 * mock-official.js -- 模拟「官方」上游（海螺/MiniMax 侧那本账）
 *   node scripts/mock-official.js              # 默认 9941
 *
 * 复刻 H3 文档里描述的上游行为（逐条对齐原文）：
 *   1) 账号钱包余额；硬门槛 = 余额必须 >= 本单成本，否则整单回
 *      code 402 "plan balance has run out"（文档：上游要求账号余额 > 0，否则整单回 plan balance has run out）
 *   2) 账号可被置为 失效(401/403) / 限流(429 + Retry-After)
 *   3) 沙箱读不了公网 URL：素材必须是 md-* id，否则 400
 *      "could not be read or decoded ... call upload_temp_url"
 *   4) 每日签到可补分（文档：账号每天自动签到补分）
 *   5) 成功时按成本实扣钱包（用于校验「预占 + 结算实扣」的 delta）
 *
 * 管理口（本地演示用）：
 *   POST /internal/admin/reset                     清空账号表
 *   POST /internal/admin/account {token,credits,valid,rate_limited}
 *   POST /internal/admin/delay   {ms}              给所有任务加固定延迟（用于压并发）
 *   GET  /internal/admin/accounts
 */
'use strict';
const http = require('http');

const PORT = Number(process.env.OFFICIAL_PORT || 9941);
const DAY_CREDITS = Number(process.env.OFFICIAL_DAILY_CREDITS || 300);

const accts = new Map();
let delayMs = 0;
let seq = 0;

function acct(t) {
  if (!accts.has(t)) accts.set(t, { token: t, credits: 0, valid: true, rate_limited: false, calls: 0 });
  return accts.get(t);
}
function send(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const h = Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extraHeaders || {});
  res.writeHead(code, h); res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { let j = {}; try { j = b ? JSON.parse(b) : {}; } catch (e) { j = {}; } resolve(j); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const body = await readBody(req);

  if (req.method === 'GET' && url === '/healthz') return send(res, 200, { ok: true, accounts: accts.size, delay_ms: delayMs });
  if (req.method === 'GET' && url === '/internal/admin/accounts') return send(res, 200, { accounts: [...accts.values()] });
  if (req.method === 'POST' && url === '/internal/admin/reset') { accts.clear(); delayMs = 0; return send(res, 200, { ok: true }); }
  if (req.method === 'POST' && url === '/internal/admin/delay') { delayMs = Number(body.ms || 0); return send(res, 200, { ok: true, delay_ms: delayMs }); }
  if (req.method === 'POST' && url === '/internal/admin/account') {
    const a = acct(String(body.token || ''));
    if (body.credits !== undefined) a.credits = Number(body.credits);
    if (body.valid !== undefined) a.valid = !!body.valid;
    if (body.rate_limited !== undefined) a.rate_limited = !!body.rate_limited;
    return send(res, 200, { ok: true, account: a });
  }

  if (req.method === 'POST' && url === '/official/v2/wallet') {
    const a = accts.get(String(body.token || ''));
    if (!a) return send(res, 401, { code: 401, message: 'invalid account token' });
    return send(res, 200, { token: a.token, balance: a.credits });
  }
  if (req.method === 'POST' && url === '/official/v2/checkin') {
    const a = accts.get(String(body.token || ''));
    if (!a) return send(res, 401, { code: 401, message: 'invalid account token' });
    const before = a.credits;
    a.credits = Math.min(a.cap === undefined ? 1e9 : a.cap, a.credits + DAY_CREDITS);
    return send(res, 200, { token: a.token, before, after: a.credits, delta: a.credits - before });
  }
  if (req.method === 'POST' && url === '/official/v2/upload') {
    seq += 1;
    return send(res, 200, { object: 'file', id: 'md-' + String(seq).padStart(4, '0'), bytes: (body.data || '').length });
  }

  /* 出片/出图/出音/工具：统一入口 */
  if (req.method === 'POST' && (url === '/official/v2/task' || url === '/official/v2/tool')) {
    if (delayMs > 0) await sleep(delayMs);
    const t = String(body.token || '');
    const a = accts.get(t);
    if (!a) return send(res, 401, { code: 401, message: 'invalid account token' });
    if (!a.valid) return send(res, 403, { code: 403, message: 'account expired or forbidden' });
    if (a.rate_limited) return send(res, 429, { code: 429, message: 'too many requests', retry_after: 5 }, { 'retry-after': '5' });

    const cost = Number(body.cost || 0);
    /* 沙箱读不了公网 URL */
    const spec = body.spec || {};
    const refs = [];
    if (spec.input_image) refs.push(String(spec.input_image));
    if (Array.isArray(spec.reference_images)) for (const x of spec.reference_images) refs.push(String(x));
    for (const r of refs) {
      if (/^https?:\/\//i.test(r) && !/^https?:\/\/[^/]*\/v1\/media\//i.test(r)) {
        return send(res, 400, { code: 400, message: 'could not be read or decoded; call upload_temp_url first' });
      }
    }
    /* 硬门槛：余额必须 >= 本单成本，否则 code 402 plan balance has run out */
    if (!(a.credits >= cost)) return send(res, 402, { code: 402, message: 'plan balance has run out' });

    const before = a.credits;
    a.credits = a.credits - cost;
    a.calls += 1;
    seq += 1;
    return send(res, 200, {
      task_id: 'off_' + String(seq).padStart(6, '0'),
      status: 'succeeded',
      model: body.model || 'unknown',
      wallet: { before, after: a.credits, delta: a.credits - before },
      video_url: 'https://official.cdn.mock/clip_' + seq + '.mp4',
      url: 'https://official.cdn.mock/clip_' + seq + '.mp4'
    });
  }

  return send(res, 404, { code: 404, message: 'not found', path: url });
});

server.listen(PORT, '127.0.0.1', () => console.log('[mock-official] listening on 127.0.0.1:' + PORT + ' daily_credits=' + DAY_CREDITS));