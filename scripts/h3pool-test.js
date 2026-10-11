/**
 * h3pool-test.js -- 「平台池」算力池打靶（10 个场景）
 *   node scripts/h3pool-test.js
 * 自己起两个进程（测试端口 9960/9961 + 独立 DB），跑完自动收摊。
 */
'use strict';
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const PORT_POOL = 9960, PORT_MOCK = 9961, ADMIN = 'sk-hl-admin';
const POOL = 'http://127.0.0.1:' + PORT_POOL, MOCK = 'http://127.0.0.1:' + PORT_MOCK;
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   [' + extra + ']' : '')); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (extra ? '   [' + extra + ']' : '')); }
}
const J = async (u, opt) => { const r = await fetch(u, opt); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j: j || {}, ra: r.headers.get('retry-after') }; };
const post = (u, b, h) => J(u, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, h || {}), body: JSON.stringify(b || {}) });
const get = (u, h) => J(u, { headers: h || {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adm = { 'x-admin-key': ADMIN };
const poolAdmin = (p, b) => post(POOL + p, b, adm);
const poolGet = (p) => get(POOL + p, adm);
const mockAdmin = (p, b) => post(MOCK + p, b);

const kids = [];
function spawnOne(script, env) {
  const out = fs.openSync(path.join(ROOT, 'runtime', 'logs', 'h3pool-test-' + script + '.out.log'), 'a');
  const c = cp.spawn(process.execPath, [path.join(ROOT, 'scripts', script)], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out], env: Object.assign({}, process.env, env) });
  kids.push(c); return c;
}
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { const r = await fetch(url); if (r.ok) return true; } catch (e) {} await sleep(250); } return false; }

async function seed(list) {
  await poolAdmin('/pool/reset'); await mockAdmin('/internal/admin/reset');
  const out = [];
  for (const a of list) {
    const r = await poolAdmin('/pool/accounts', { label: a.label, token: a.token, credits: a.credits });
    await mockAdmin('/internal/admin/account', { token: a.token, credits: a.upCredits === undefined ? a.credits : a.upCredits, valid: a.valid !== false });
    out.push(r.j.token);
  }
  return out;
}
async function mkKey(credits, unlimited) { const r = await poolAdmin('/pool/keys', { label: 'test', credits, unlimited }); return r.j.key; }
const H = (k) => ({ authorization: 'Bearer ' + k, 'content-type': 'application/json' });
const genVideo = (k, extra) => post(POOL + '/v1/video/generations', Object.assign({ model: 'MiniMax-H3', prompt: 'test' }, extra || {}), { authorization: 'Bearer ' + k });
const genImage = (k) => post(POOL + '/v1/images/generations', { model: 'MiniMax-Image', prompt: 'x' }, { authorization: 'Bearer ' + k });

(async () => {
  fs.mkdirSync(path.join(ROOT, 'runtime', 'logs'), { recursive: true });
  console.log('== 起测试进程 ==');
  spawnOne('mock-official.js', { OFFICIAL_PORT: String(PORT_MOCK), OFFICIAL_DAILY_CREDITS: '300' });
  spawnOne('h3-platform-pool.js', { H3P_PORT: String(PORT_POOL), H3P_UPSTREAM: MOCK, H3P_ADMIN_KEY: ADMIN,
    H3P_CHECKIN_MS: '8000', H3P_DAILY_CREDITS: '300', H3P_MAX_INFLIGHT: '20',
    H3P_DB: path.join(ROOT, 'runtime', 'data', 'h3pool-test.db') });
  ok('两个进程起来', (await waitUp(POOL + '/healthz')) && (await waitUp(MOCK + '/healthz')));

  /* A. 预占+结算：钱包 delta = -cost，Key 扣 cost */
  console.log('== A 预占 + 结算实扣 ==');
  await seed([{ label: 'a1', token: 'tk_a1', credits: 3000 }]);
  let k = await mkKey(5000);
  let r = await genVideo(k);
  ok('A1 出片 200', r.s === 200, 'status=' + r.s);
  ok('A2 上游钱包 delta = -1000', r.j.wallet && r.j.wallet.delta === -1000, JSON.stringify(r.j.wallet));
  const cred = await get(POOL + '/v1/credits', { authorization: 'Bearer ' + k });
  ok('A3 Key 扣 1000', cred.j.credits === 4000, 'left=' + cred.j.credits);
  ok('A4 预占已释放(held=0)', (await poolGet('/pool/stats')).j.accounts[0].held === 0);

  /* B. 402 换号成功：a1 本地记账有钱但上游没钱 -> 换 a2 */
  console.log('== B 402 plan balance has run out -> 换号成功 ==');
  await seed([{ label: 'b1', token: 'tk_b1', credits: 2500, upCredits: 0 }, { label: 'b2', token: 'tk_b2', credits: 2500, upCredits: 2500 }]);
  k = await mkKey(5000);
  r = await genVideo(k);
  ok('B1 最终 200', r.s === 200, 'status=' + r.s);
  ok('B2 换了 2 次(attempts=2)', r.j.account && r.j.account.attempts === 2, 'account=' + JSON.stringify(r.j.account));
  const st = (await poolGet('/pool/stats')).j;
  ok('B3 用过 b1、最终落 b2', r.j.account.label === 'b2', 'label=' + r.j.account.label);
  ok('B4 b1 钱包被同步成 0', st.accounts.find((a) => a.label === 'b1').credits === 0, 'b1.credits=' + st.accounts.find((a) => a.label === 'b1').credits);

  /* C. 3 个号都 402 -> 503 upstream_balance */
  console.log('== C 换号 3 次仍失败 -> 503 upstream_balance ==');
  await seed([{ label: 'c1', token: 'tk_c1', credits: 2500, upCredits: 0 }, { label: 'c2', token: 'tk_c2', credits: 2500, upCredits: 0 }, { label: 'c3', token: 'tk_c3', credits: 2500, upCredits: 0 }]);
  k = await mkKey(5000);
  r = await genVideo(k);
  ok('C1 503 upstream_balance', r.s === 503 && r.j.code === 'upstream_balance', 'status=' + r.s + ' code=' + r.j.code);
  ok('C2 尝试了 3 个号', r.j.detail && r.j.detail.attempts === 3, JSON.stringify(r.j.detail));
  const stC = (await poolGet('/pool/stats')).j;
  ok('C3 audit 里有 3 条 switch_account', stC.audit.filter((x) => x.action === 'switch_account').length === 3, 'count=' + stC.audit.filter((x) => x.action === 'switch_account').length);
  ok('C4 失败后 Key 额度已退回', (await get(POOL + '/v1/credits', { authorization: 'Bearer ' + k })).j.credits === 5000);

  /* D. 池里没有余额够的号 -> 503 pool_empty + 排队文案 */
  console.log('== D 池空 -> 503 pool_empty + waiting for credits 文案 ==');
  await seed([{ label: 'd1', token: 'tk_d1', credits: 100 }, { label: 'd2', token: 'tk_d2', credits: 50 }]);
  k = await mkKey(5000);
  r = await genVideo(k);
  ok('D1 503 pool_empty', r.s === 503 && r.j.code === 'pool_empty', 'status=' + r.s + ' code=' + r.j.code);
  ok('D2 queued=true', r.j.queued === true);
  ok('D3 文案含 fattest account holds', /waiting for credits \(need 2000; fattest account holds 100\)/.test(String(r.j.message)), String(r.j.message));

  /* E. 签到补分：0 余额 -> 池空；签到后能出图 */
  console.log('== E 每日签到补分 ==');
  await seed([{ label: 'e1', token: 'tk_e1', credits: 0, upCredits: 0 }]);
  k = await mkKey(100);
  r = await genImage(k);
  ok('E1 签到前池空 503', r.s === 503, 'status=' + r.s);
  await poolAdmin('/pool/checkin', { force: true });
  const stE = (await poolGet('/pool/stats')).j;
  ok('E2 签到后账号余额 300', stE.accounts[0].credits === 300, 'credits=' + stE.accounts[0].credits);
  ok('E3 签到被记账', stE.audit.some((x) => x.action === 'daily_checkin'), 'audit actions=' + [...new Set(stE.audit.map((x) => x.action))].join(','));
  r = await genImage(k);
  ok('E4 签到后出图 200', r.s === 200, 'status=' + r.s);

  /* F. 401/403 -> 账号失效换号 */
  console.log('== F ACCOUNT_EXPIRED -> 换号 ==');
  await seed([{ label: 'f1', token: 'tk_f1', credits: 2500, valid: false }, { label: 'f2', token: 'tk_f2', credits: 2500 }]);
  k = await mkKey(5000);
  r = await genVideo(k);
  ok('F1 最终 200', r.s === 200, 'status=' + r.s);
  const stF = (await poolGet('/pool/stats')).j;
  ok('F2 f1 被下线且原因 ACCOUNT_EXPIRED', stF.accounts[0].healthy === 0 && stF.accounts[0].fail_reason === 'ACCOUNT_EXPIRED', 'healthy=' + stF.accounts[0].healthy + ' reason=' + stF.accounts[0].fail_reason);

  /* G. 并发闸门 20/20 -> 429 + Retry-After: 5 */
  console.log('== G 平台池吞吐闸门：在飞 20/20 -> 429 concurrency_exceeded ==');
  await mockAdmin('/internal/admin/delay', { ms: 1200 });
  await seed([{ label: 'g1', token: 'tk_g1', credits: 100000 }]);
  k = await mkKey(0, 1);
  const burst = await Promise.all(Array.from({ length: 25 }, () => genImage(k)));
  const c429 = burst.filter((x) => x.s === 429).length;
  const c200 = burst.filter((x) => x.s === 200).length;
  ok('G1 恰好 20 个进、5 个被 429', c200 === 20 && c429 === 5, '200=' + c200 + ' 429=' + c429);
  const one = burst.find((x) => x.s === 429);
  ok('G2 429 带 Retry-After: 5', one && one.ra === '5', 'retry-after=' + (one && one.ra));
  ok('G3 429 文案 concurrency_exceeded', one && one.j.code === 'concurrency_exceeded', one && one.j.code);
  await mockAdmin('/internal/admin/delay', { ms: 0 });

  /* H. 兑换码 -> sk-hl- Key -> 额度用完自动销号 */
  console.log('== H 兑换码 / 销号 ==');
  await seed([{ label: 'h1', token: 'tk_h1', credits: 5000 }]);
  const minted = await post(POOL + '/v1/redeem-codes/mint', { count: 2, credits: 1000 }, adm);
  ok('H1 发码 2 张', minted.s === 200 && minted.j.data.length === 2, JSON.stringify(minted.j.data));
  const red = await post(POOL + '/v1/redeem', { code: minted.j.data[0] });
  ok('H2 兑换出 sk-hl- Key', red.s === 200 && /^sk-hl-[0-9a-f]{32}$/.test(red.j.key), red.j.key && red.j.key.slice(0, 12));
  const kk = red.j.key;

  r = await genVideo(kk);
  ok('H3 用兑换的 Key 出片 200', r.s === 200, 'status=' + r.s);
  const r2 = await genVideo(kk);
  ok('H4 额度用完 -> 401 key_revoked(销号)', r2.s === 401 && r2.j.code === 'key_revoked', 'status=' + r2.s + ' code=' + r2.j.code);
  const r3 = await post(POOL + '/v1/redeem', { code: mined_code_reuse_check(minted.j.data[0]) });
  ok('H5 兑换码不可复用', r3.s === 409, 'status=' + r3.s);
  const pq = await post(POOL + '/v1/public/query', { code: minted.j.data[1] });
  ok('H6 公开查码未使用', pq.s === 200 && pq.j.used === false, JSON.stringify(pq.j));

  /* I. 公开池子统计 */
  console.log('== I /v1/public/stats ==');
  await seed([{ label: 'i1', token: 'tk_i1', credits: 4000 }, { label: 'i2', token: 'tk_i2', credits: 0, upCredits: 0 }]);
  const ps = await get(POOL + '/v1/public/stats');
  const s = ps.j;
  const need = ['codes_total', 'codes_unused', 'codes_used', 'credits_pool', 'accounts', 'accounts_healthy', 'clips_available', 'videos_24h', 'videos_24h_ok', 'success_rate'];
  ok('I1 字段齐全', need.every((f) => f in s), need.filter((f) => !(f in s)).join(',') || 'all present');
  ok('I2 免 Key 可读(200)', ps.s === 200);
  ok('I3 accounts=2 / healthy=2', s.accounts === 2 && s.accounts_healthy === 2, JSON.stringify({ a: s.accounts, h: s.accounts_healthy }));
  ok('I4 credits_pool=4000', s.credits_pool === 4000, 'credits_pool=' + s.credits_pool);
  ok('I5 clips_available=floor(credits_pool/1000)=4', s.clips_available === 4, 'clips=' + s.clips_available);

  /* J. 沙箱限制：公网 URL 素材 -> 400 upstream_rejected 且额度退回 */
  console.log('== J 上游沙箱读不了公网 URL ==');
  await seed([{ label: 'j1', token: 'tk_j1', credits: 5000 }]);
  k = await mkKey(5000);
  r = await genVideo(k, { input_image: 'https://example.com/a.png' });
  ok('J1 400 upstream_rejected', r.s === 400 && r.j.code === 'upstream_rejected', 'status=' + r.s + ' code=' + r.j.code);
  ok('J2 额度已退回 5000', (await get(POOL + '/v1/credits', { authorization: 'Bearer ' + k })).j.credits === 5000);

  console.log('');
  console.log('===== 结果：' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (fails.length) console.log('失败项：' + fails.join(' | '));
  kids.forEach((c) => { try { c.kill(); } catch (e) {} });
  process.exit(fail ? 1 : 0);
})();

function mined_code_reuse_check(c) { return c; }