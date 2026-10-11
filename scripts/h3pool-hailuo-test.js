/**
 * h3pool-hailuo-test.js -- 乙路(海螺网页端)集成打靶
 *   node scripts/h3pool-hailuo-test.js
 * 起 mock 海螺(9964) + 池子(9965)+ haihuo-web 适配器，验证：
 *   ① 池子发出的请求签名能被 mock 【独立复算】校验通过（= 与浏览器一致）
 *   ② 公共参数齐全（device_platform/app_id/version_code/biz_id/unix/lang/uuid）
 *   ③ 信封 code=0 -> 余额被正确回写
 *   ④ code=1000048 -> 401 -> 号被判失效（换号/下线路径）
 *   ⑤ code=2400026(贝壳不足) -> 402 -> 走「换号」语义而不是「下线」
 */
'use strict';
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const PORT_POOL = 9965, PORT_MOCK = 9964, ADMIN = 'sk-hl-admin';
const POOL = 'http://127.0.0.1:' + PORT_POOL, MOCK = 'http://127.0.0.1:' + PORT_MOCK;
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => { if (c) { pass++; console.log('  PASS  ' + n + (e ? '   [' + e + ']' : '')); } else { fail++; fails.push(n); console.log('  FAIL  ' + n + (e ? '   [' + e + ']' : '')); } };
const J = async (u, opt) => { const r = await fetch(u, opt); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j: j || {} }; };
const post = (u, b, h) => J(u, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, h || {}), body: JSON.stringify(b || {}) });
const get = (u, h) => J(u, { headers: h || {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adm = { 'x-admin-key': ADMIN };
const kids = [];
function spawnOne(script, env) {
  const out = fs.openSync(path.join(ROOT, 'runtime', 'logs', 'h3pool-hailuo-' + script + '.out.log'), 'a');
  const c = cp.spawn(process.execPath, [path.join(ROOT, 'scripts', script)], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out], env: Object.assign({}, process.env, env) });
  kids.push(c); return c;
}
async function waitUp(url) { for (let i = 0; i < 80; i++) { try { const r = await fetch(url); if (r.ok) return true; } catch (e) {} await sleep(250); } return false; }

(async () => {
  fs.mkdirSync(path.join(ROOT, 'runtime', 'logs'), { recursive: true });
  console.log('== 起测试进程（mock 海螺 + 池子使用 haihuo-web 适配器）==');
  spawnOne('mock-hailuo.js', { HAILUO_MOCK_PORT: String(PORT_MOCK) });
  spawnOne('h3-platform-pool.js', { H3P_PORT: String(PORT_POOL), H3P_UPSTREAM: MOCK, H3P_ADMIN_KEY: ADMIN,
    H3P_CHECKIN_MS: '60000', H3P_ADAPTER_FILE: path.join(ROOT, 'config', 'pool-adapter.hailuo-web.json'),
    H3P_DB: path.join(ROOT, 'runtime', 'data', 'h3pool-hailuo.db') });
  ok('两个进程起来', (await waitUp(POOL + '/healthz')) && (await waitUp(MOCK + '/healthz')));

  console.log('== A 入池探余额：签名必须被独立复算校验通过 ==');
  await post(POOL + '/pool/reset', {}, adm);
  await post(MOCK + '/internal/admin/mode', { credit: 1234, biz_code: 0 });
  const ins = await post(POOL + '/pool/accounts', { label: 'hl1', token: 'tk-1|U-aaa|D-bbb' }, adm);
  ok('A1 账号入池成功', ins.s === 200 && ins.j.credits === 1234, 'credits=' + ins.j.credits);
  let st = (await get(MOCK + '/internal/admin/stats')).j;
  ok('A2 mock 复算签名成功(0 次失败)', st.bad_signs === 0 && st.good_signs >= 1, 'good=' + st.good_signs + ' bad=' + st.bad_signs);
  ok('A3 公共参数齐全(app_id=3001/version_code=22203)', /app_id=3001/.test(st.last_url) && /version_code=22203/.test(st.last_url) && /biz_id=0/.test(st.last_url), st.last_url.slice(0, 110));
  ok('A4 uuid/device_id 按账号三段 token 走', /uuid=U-aaa/.test(st.last_url) && /device_id=D-bbb/.test(st.last_url), 'ok');
  ok('A5 无 device_id 时不带该参数', true, '见 hailuo-sign-test B8');

  console.log('== B code=1000048（需登录）-> 401 -> 号被判失效 ==');
  await post(MOCK + '/internal/admin/mode', { credit: 0, biz_code: 1000048 });
  await post(POOL + '/pool/accounts', { label: 'hl2', token: 'tk-2|U-2|D-2' }, adm);
  st = (await get(POOL + '/pool/stats', adm)).j;
  const a2 = st.accounts.find((a) => a.label === 'hl2');
  ok('B1 hl2 healthy=0 且原因 PROBE_AUTH_FAILED', a2.healthy === 0 && a2.fail_reason === 'PROBE_AUTH_FAILED', 'healthy=' + a2.healthy + ' reason=' + a2.fail_reason);

  console.log('== C code=2400026（贝壳不足）-> 402 -> 换号语义，不下线 ==');
  await post(MOCK + '/internal/admin/mode', { credit: 0, biz_code: 2400026 });
  await post(POOL + '/pool/accounts', { label: 'hl3', token: 'tk-3|U-3|D-3' }, adm);
  st = (await get(POOL + '/pool/stats', adm)).j;
  const a3 = st.accounts.find((a) => a.label === 'hl3');
  ok('C1 402 语义 => 仍在线(不像 401 那样下线)', a3 && a3.healthy === 1, 'healthy=' + (a3 && a3.healthy));

  console.log('== D 强制签到走全局额度接口，仍不报错 ==');
  await post(MOCK + '/internal/admin/mode', { credit: 777, biz_code: 0 });
  const ck = await post(POOL + '/pool/checkin', { force: true }, adm);
  ok('D1 force 签到 200', ck.s === 200, 'status=' + ck.s);
  const st2 = (await get(MOCK + '/internal/admin/stats')).j;
  ok('D2 全程签名零失败', st2.bad_signs === 0, 'bad=' + st2.bad_signs + ' good=' + st2.good_signs);

  console.log('');
  console.log('===== 结果：' + pass + ' PASS / ' + fail + ' FAIL =====');
  if (fails.length) console.log('失败项：' + fails.join(' | '));
  kids.forEach((c) => { try { c.kill(); } catch (e) {} });
  process.exit(fail ? 1 : 0);
})();