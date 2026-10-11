/**
 * flow-pool-test.js -- 池② 账号池状态机验收（照抄 flow2api 的四条规则，逐条打靶）
 *   node scripts/flow-pool-test.js
 * 前提：node scripts/start-flow-pool.js start --ban 20 --at-ttl 60 --at-refresh 30
 */
const POOL = process.env.FLOW_POOL || 'http://127.0.0.1:9930';
const MOCK = process.env.FLOW_MOCK || 'http://127.0.0.1:9931';
const KEY = process.env.POOL_KEY || 'sk-pool-google-demo';
const H = { 'content-type': 'application/json', 'x-pool-admin': KEY, authorization: 'Bearer ' + KEY };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function j(url, body) {
  const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
  let o = {};
  try { o = await r.json(); } catch (e) {}
  return { status: r.status, json: o };
}
async function g(url) {
  const r = await fetch(url, { headers: H });
  let o = {};
  try { o = await r.json(); } catch (e) {}
  return { status: r.status, json: o };
}
const gen = () => j(POOL + '/v1/images/generations', { prompt: '漫剧分镜图', model: 'gemini-nano-banana-2.1-image' });
const stats = async () => (await g(POOL + '/pool/stats')).json;
const acct = (s, email) => (s.accounts || []).find((a) => a.email === email);
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + name + '  ' + detail);
}

(async () => {
  console.log('== 池②(flow-pool) 状态机验收 ==');
  console.log('');

  console.log('[场景A] 402 额度耗尽 -> 自动换号');
  await j(POOL + '/pool/reset');
  const seed = [['a1', 2], ['a2', 2], ['a3', 10]];
  for (const pair of seed) {
    await j(POOL + '/pool/accounts', { st: 'ST-' + pair[0], email: pair[0] + '@mock', credits: pair[1] });
    await j(MOCK + '/internal/admin/state', { st: 'ST-' + pair[0], credits: pair[1], rate_limit: false });
  }
  let okA = 0;
  const usedA = [];
  for (let i = 0; i < 6; i++) {
    const r = await gen();
    if (r.status === 200) { okA++; usedA.push(r.json.data[0]._account); }
  }
  const sA = await stats();
  check('A1 六连发全部 200', okA === 6, 'ok=' + okA + '/6  落点=' + usedA.join(','));
  const sumA = (sA.accounts || []).reduce((n, a) => n + a.credits, 0);
  check('A2 额度真实扣减（6 次 = 6 credit）', sumA === 8, '剩余合计=' + sumA + '（初值 14，用掉 6）');
  check('A3 前面的号用尽后切到 a3 继续', usedA.includes('a3@mock'), 'a3 使用次数=' + usedA.filter((x) => x === 'a3@mock').length);

  console.log('');
  console.log('[场景B] 429 熔断 -> 换号；冷却到期 -> 自动解禁');
  await j(MOCK + '/internal/admin/state', { st: 'ST-a1', credits: 5, rate_limit: true });
  const rB = await gen();
  const sB = await stats();
  const a1 = acct(sB, 'a1@mock');
  check('B1 撞 429 的号被熔断，整请求仍成功', rB.status === 200 && a1 && a1.is_active === false,
    'HTTP=' + rB.status + '  落点=' + (rB.json.data && rB.json.data[0]._account));
  check('B2 ban_reason=429_rate_limit（照抄源码常量）', a1 && a1.ban_reason === '429_rate_limit', 'ban_reason=' + (a1 && a1.ban_reason));
  check('B3 冷却倒计时可见', a1 && a1.will_unban_in_s !== null, 'will_unban_in_s=' + (a1 && a1.will_unban_in_s) + 's（生产值 43200s=12h）');
  const banS = sB.ban_seconds;
  console.log('  ... 等 ' + (banS + 7) + 's 观察冷却到期自动解禁 ...');
  await sleep((banS + 7) * 1000);
  const sB2 = await stats();
  const a1b = acct(sB2, 'a1@mock');
  check('B4 冷却到期自动解禁（12h 逻辑，测试压缩为 ' + banS + 's）', a1b && a1b.is_active === true && !a1b.ban_reason,
    'is_active=' + (a1b && a1b.is_active) + '  ban_reason=' + (a1b && a1b.ban_reason));

  console.log('');
  console.log('[场景C] AT 剩余 < 阈值 -> 自动刷新（照抄 <3600s）');
  await j(POOL + '/pool/reset');
  await j(POOL + '/pool/accounts', { st: 'ST-b1', email: 'b1@mock', credits: 9 });
  await j(MOCK + '/internal/admin/state', { st: 'ST-b1', credits: 9, rate_limit: false });
  await gen();
  const sC1 = await stats();
  const b1 = acct(sC1, 'b1@mock');
  check('C1 首次调用换到 AT，且剩余 > 阈值（不刷新）', b1.at_left_s > sC1.at_refresh_seconds,
    'AT剩余=' + b1.at_left_s + 's  阈值=' + sC1.at_refresh_seconds + 's  needs_refresh=' + b1.needs_refresh);
  await sleep(35000);
  const sC2 = await stats();
  const b1b = acct(sC2, 'b1@mock');
  check('C2 等 35s 后 AT 剩余已低于阈值', b1b.at_left_s < sC2.at_refresh_seconds, 'AT剩余=' + b1b.at_left_s + 's < 阈值=' + sC2.at_refresh_seconds + 's');
  await gen();
  const sC3 = await stats();
  const b1c = acct(sC3, 'b1@mock');
  check('C3 刷新后 AT 剩余被拉长回 TTL', b1c.at_left_s > sC3.at_refresh_seconds, '刷新后 AT剩余=' + b1c.at_left_s + 's');

  const pass = results.filter((r) => r.ok).length;
  console.log('');
  console.log('===== 汇总: ' + pass + '/' + results.length + ' PASS =====');
  results.filter((r) => !r.ok).forEach((r) => console.log('  FAIL: ' + r.name + ' -> ' + r.detail));
  process.exit(pass === results.length ? 0 : 1);
})();
