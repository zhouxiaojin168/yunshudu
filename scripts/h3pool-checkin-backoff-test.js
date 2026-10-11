/**
 * h3pool-checkin-backoff-test.js -- 签到退避打靶（修掉「上游报错时按 5s 疯狂重试」）
 *   node scripts/h3pool-checkin-backoff-test.js
 * 起 mock 官方上游(9963) + 池子(9962)，H3P_CHECKIN_MS=1000 放大观测。
 */
'use strict';
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const PORT_POOL = 9962, PORT_MOCK = 9963, ADMIN = 'sk-hl-admin';
const POOL = 'http://127.0.0.1:' + PORT_POOL, MOCK = 'http://127.0.0.1:' + PORT_MOCK;
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   [' + extra + ']' : '')); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (extra ? '   [' + extra + ']' : '')); }
}
const J = async (u, opt) => { const r = await fetch(u, opt); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j: j || {} }; };
const post = (u, b, h) => J(u, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, h || {}), body: JSON.stringify(b || {}) });
const get = (u, h) => J(u, { headers: h || {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adm = { 'x-admin-key': ADMIN };
const kids = [];
function spawnOne(script, env) {
  const out = fs.openSync(path.join(ROOT, 'runtime', 'logs', 'h3pool-backoff-' + script + '.out.log'), 'a');
  const c = cp.spawn(process.execPath, [path.join(ROOT, 'scripts', script)], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out], env: Object.assign({}, process.env, env) });
  kids.push(c); return c;
}
async function waitUp(url) { for (let i = 0; i < 80; i++) { try { const r = await fetch(url); if (r.ok) return true; } catch (e) {} await sleep(250); } return false; }

(async () => {
  fs.mkdirSync(path.join(ROOT, 'runtime', 'logs'), { recursive: true });
  console.log('== 起测试进程 ==');
  spawnOne('mock-official.js', { OFFICIAL_PORT: String(PORT_MOCK), OFFICIAL_DAILY_CREDITS: '300' });
  spawnOne('h3-platform-pool.js', { H3P_PORT: String(PORT_POOL), H3P_UPSTREAM: MOCK, H3P_ADMIN_KEY: ADMIN,
    H3P_CHECKIN_MS: '1000', H3P_CHECKIN_BACKOFF_MAX_MS: '60000', H3P_DAILY_CREDITS: '300',
    H3P_DB: path.join(ROOT, 'runtime', 'data', 'h3pool-backoff.db') });
  ok('两个进程起来', (await waitUp(POOL + '/healthz')) && (await waitUp(MOCK + '/healthz')));

  /* 场景：账号存在但上游风控(429)。旧代码会以扫描周期(1s)狂敲；新代码应指数退避。 */
  console.log('== A 上游 429：退避闸门必须拦住疯狂重试 ==');
  await post(POOL + '/pool/reset', {}, adm);
  await post(MOCK + '/internal/admin/reset', {});
  await post(POOL + '/pool/accounts', { label: 'x1', token: 'tk_x1', credits: 0 }, adm);
  await post(MOCK + '/internal/admin/account', { token: 'tk_x1', credits: 0, rate_limited: true });
  await sleep(5000);
  const mst = (await get(MOCK + '/internal/admin/stats')).j;
  ok('A1 5 秒内签到调用 <= 4 次（旧代码约 5+ 次）', mst.checkin_calls <= 4, 'checkin_calls=' + mst.checkin_calls);
  const pst = (await get(POOL + '/pool/stats', adm)).j;
  const cs = (pst.checkin_state || []).find((x) => x.id === pst.accounts[0].id);
  ok('A2 退回次数已累计 (no_gain>=1)', cs && cs.no_gain >= 1, 'checkin_state=' + JSON.stringify(cs));
  ok('A3 下次等待被拉长 (wait_ms>1000)', cs && cs.wait_ms > 1000, 'wait_ms=' + (cs && cs.wait_ms));
  ok('A4 config 暴露退避上限', pst.config && pst.config.checkin_backoff_max_ms === 60000, 'backoff_max=' + (pst.config && pst.config.checkin_backoff_max_ms));

  console.log('== B 风控解除：签到拿到额度 -> 退避归零 ==');
  await post(MOCK + '/internal/admin/account', { token: 'tk_x1', rate_limited: false });
  await post(POOL + '/pool/checkin', { force: true }, adm);
  const pst2 = (await get(POOL + '/pool/stats', adm)).j;
  ok('B1 账号余额变 300', pst2.accounts[0].credits === 300, 'credits=' + pst2.accounts[0].credits);
  const cs2 = (pst2.checkin_state || []).find((x) => x.id === pst2.accounts[0].id);
  ok('B2 退避归零 (no_gain=0)', cs2 && cs2.no_gain === 0, JSON.stringify(cs2));
  ok('B3 等待回到基准 (wait_ms=1000)', cs2 && cs2.wait_ms === 1000, 'wait_ms=' + (cs2 && cs2.wait_ms));

  console.log('== C force 签到不受退避影响 ==');
  await post(MOCK + '/internal/admin/account', { token: 'tk_x1', rate_limited: true });
  await post(POOL + '/pool/checkin', { force: true }, adm);
  await sleep(300);
  const pst3 = (await get(POOL + '/pool/stats', adm)).j;
  const cs3 = (pst3.checkin_state || []).find((x) => x.id === pst3.accounts[0].id);
  ok('C1 force 立刻生效并记账退避', cs3 && cs3.no_gain >= 1, JSON.stringify(cs3));

  console.log('');
  console.log('===== 结果：' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (fails.length) console.log('失败项：' + fails.join(' | '));
  kids.forEach((c) => { try { c.kill(); } catch (e) {} });
  process.exit(fail ? 1 : 0);
})();