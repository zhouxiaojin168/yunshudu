/**
 * h3pool-e2e.js -- 平台池全链路 E2E（客户端 -> new-api(3000) -> 平台池(9940) -> 官方模拟(9941)）
 *   node scripts/h3pool-e2e.js
 * 验证：① 客户端只管买 credit，池内换号它对无感；② 402 换号；③ 池空 -> 5xx；④ 签到补分自动恢复
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const GW = 'http://127.0.0.1:3000';
const POOL = 'http://127.0.0.1:9940';
const MOCK = 'http://127.0.0.1:9941';
const ADMIN = 'sk-hl-admin';
const MODEL = 'MiniMax-Image';

const client = fs.readFileSync(path.join(ROOT, 'runtime', 'test-token.txt'), 'utf8').replace(/^\uFEFF/, '').trim();
const poolGet = (p) => fetch(POOL + p, { headers: { 'x-admin-key': ADMIN } }).then((r) => r.json());
const poolPost = (p, b) => fetch(POOL + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN }, body: JSON.stringify(b || {}) }).then((r) => r.json());
const mockPost = (p, b) => fetch(MOCK + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());
const gen = async () => {
  const r = await fetch(GW + '/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + client }, body: JSON.stringify({ model: MODEL, prompt: '漫剧分镜 #1' }) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { s: r.status, j };
};
const results = [];
const ok = (n, c, e) => { results.push([n, !!c, e || '']); console.log((c ? '  [PASS] ' : '  [FAIL] ') + n + (e ? '   ' + e : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('== 平台池全链路 E2E ==');
  const base = await poolGet('/pool/stats');
  console.log('起始池子: ' + base.accounts.map((a) => a.label + '(credits=' + a.credits + ')').join('  '));

  console.log('-- ① 客户端出 5 张图（网关 -> 渠道 -> 平台池）--');
  let okc = 0;
  for (let i = 1; i <= 5; i++) { const r = await gen(); if (r.s === 200) okc++; console.log('   #' + i + ' HTTP ' + r.s + (r.s !== 200 ? '  ' + JSON.stringify(r.j).slice(0, 120) : '')); }
  ok('① 5 发全 200', okc === 5, 'ok=' + okc + '/5');
  const fat = (await poolGet('/pool/stats')).accounts.slice().sort((a, b) => b.credits - a.credits)[0];
  ok('① 肥号被优先消耗（最肥优先）', fat.label.startsWith('h2'), '最肥号=' + fat.label + ' credits=' + fat.credits);

  console.log('-- ② 把最肥号的上游钱包打成 0（本地记账还有钱）-> 触发 402 换号 --');
  const before = await poolGet('/pool/stats');
  const swBefore = before.audit.filter((x) => x.action === 'switch_account').length;
  await mockPost('/internal/admin/account', { token: 'tk_h2', credits: 0 });
  const r2 = await gen();
  ok('② 客户端仍拿到 200（对换号无感）', r2.s === 200, 'status=' + r2.s);
  await sleep(300);
  const after2 = await poolGet('/pool/stats');
  const swAfter = after2.audit.filter((x) => x.action === 'switch_account').length;
  ok('② 池内确实发生了 402 换号', swAfter > swBefore, 'switch_account ' + swBefore + ' -> ' + swAfter);
  ok('② 换号原因 = plan balance has run out', after2.audit.some((x) => x.action === 'switch_account' && /plan balance has run out/.test(x.detail || '')), '');
  ok('② 那个号钱包已被同步成 0', after2.accounts.find((a) => a.label.startsWith('h2')).credits === 0, 'h2.credits=' + after2.accounts.find((a) => a.label.startsWith('h2')).credits);

  console.log('-- ③ 把池子清空 -> 客户端收到 5xx（pool_empty 对客户是"稍后重试"）--');
  for (const t of ['tk_h1', 'tk_h2', 'tk_h3']) { await poolPost('/pool/accounts', { label: 'empty-' + t, token: t, credits: 0 }); await mockPost('/internal/admin/account', { token: t, credits: 0 }); }
  const r3 = await gen();
  ok('③ 池空 -> 客户端 5xx', r3.s >= 500, 'status=' + r3.s + '  ' + JSON.stringify(r3.j).slice(0, 140));
  const ps3 = await fetch(POOL + '/v1/public/stats').then((x) => x.json());
  ok('③ 公开 stats 显示 clips_available=0', ps3.clips_available === 0, 'clips=' + ps3.clips_available + ' credits_pool=' + ps3.credits_pool);

  console.log('-- ④ 每日签到补分 -> 池子自动恢复 --');
  await poolPost('/pool/checkin', { force: true });
  const afterCheckin = await poolGet('/pool/stats');
  ok('④ 三个号都补了分', afterCheckin.accounts.every((a) => a.credits >= 300), afterCheckin.accounts.map((a) => a.credits).join(','));
  const r4 = await gen();
  ok('④ 客户端恢复 200', r4.s === 200, 'status=' + r4.s);

  console.log('');
  const ps = await fetch(POOL + '/v1/public/stats').then((x) => x.json());
  console.log('最终公开池子：accounts=' + ps.accounts + ' healthy=' + ps.accounts_healthy + ' credits_pool=' + ps.credits_pool +
    ' clips_available=' + ps.clips_available + ' videos_24h=' + ps.videos_24h + ' success_rate=' + ps.success_rate);
  const bad = results.filter((x) => !x[1]);
  console.log(bad.length ? '\n===== E2E 有 ' + bad.length + ' 项失败 =====' : '\n===== E2E 全部通过 (' + results.length + '/' + results.length + ') =====');
  process.exit(bad.length ? 1 : 0);
})();