/**
 * pool2-e2e.js -- 池② 全链路端到端（客户端 -> new-api(3000) -> flow-pool(9930) -> mock-flow(9931)）
 *   node scripts/pool2-e2e.js
 * 中途会把一个账号打成 429，验证「账号被熔断但客户端仍然拿到 200」。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const GW = 'http://127.0.0.1:3000';
const POOL = 'http://127.0.0.1:9930';
const MOCK = 'http://127.0.0.1:9931';
const POOL_KEY = process.env.POOL_KEY || 'sk-pool-google-demo';
const MODEL = 'gemini-nano-banana-2.1-image';
const N = 8;

const key = fs.readFileSync(path.join(ROOT, 'runtime', 'test-token.txt'), 'utf8').replace(/^\uFEFF/, '').trim();
const poolStats = async () => (await fetch(POOL + '/pool/stats', { headers: { 'x-pool-admin': POOL_KEY } })).json();
const setMock = (st, o) => fetch(MOCK + '/internal/admin/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ st }, o)) });

(async () => {
  console.log('== 池② 全链路 E2E ==');
  const before = await poolStats();
  console.log('起始账号: ' + before.accounts.map((a) => a.email + '(credits=' + a.credits + ')').join('  '));

  const hits = [];
  let ok = 0;
  for (let i = 1; i <= N; i++) {
    if (i === 5) {
      await setMock('ST-g2', { credits: 3, rate_limit: true });
      console.log('  >>> 第 5 发前把 g2@gmail.mock 打成 429 限流号');
    }
    const r = await fetch(GW + '/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: MODEL, prompt: '漫剧分镜图 #' + i })
    });
    let j = {}; try { j = await r.json(); } catch (e) {}
    const acc = j.data && j.data[0] && j.data[0]._account;
    if (r.status === 200) { ok++; hits.push(acc); }
    console.log('  #' + i + '  HTTP ' + r.status + '  计费账号=' + (acc || '-') + (j.error ? '  err=' + JSON.stringify(j.error).slice(0, 90) : ''));
  }

  const after = await poolStats();
  console.log('');
  console.log('落点统计: ' + JSON.stringify(hits.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {})));
  for (const a of after.accounts) console.log('  ' + a.email + ' credits=' + a.credits + ' is_active=' + a.is_active + ' ban=' + a.ban_reason + ' 用过=' + a.use_count + ' 连续错误=' + a.consecutive_error_count);
  console.log('');
  const pass = [];
  pass.push(['全部 ' + N + ' 发都返回 200', ok === N, 'ok=' + ok + '/' + N]);
  pass.push(['请求被分摊到多个账号（池生效）', new Set(hits).size >= 2, '账号数=' + new Set(hits).size]);
  const g2 = after.accounts.find((a) => a.email === 'g2@gmail.mock');
  pass.push(['429 的号被熔断', g2 && g2.is_active === false, 'g2.is_active=' + (g2 && g2.is_active) + ' ban=' + (g2 && g2.ban_reason)]);
  pass.push(['熔断后客户端不受影响（仍 200）', ok === N, '客户端成功率=' + ok + '/' + N]);
  let allOk = true;
  for (const p of pass) { if (!p[1]) allOk = false; console.log((p[1] ? '  [PASS] ' : '  [FAIL] ') + p[0] + '  ' + p[2]); }
  console.log(allOk ? '\n===== E2E 全部通过 =====' : '\n===== E2E 有失败 =====');
  process.exit(allOk ? 0 : 1);
})();
