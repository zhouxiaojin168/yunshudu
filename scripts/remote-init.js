/**
 * remote-init.js -- 对【远端 new-api】做初始化：建 root 用户 + 写站点参数
 *   用法: node scripts/remote-init.js [BASE_URL]
 *   环境: BASE / RUSER / RPW / SITE
 */
const BASE  = process.env.BASE  || process.argv[2] || 'http://114.66.16.225:3000';
const USER  = process.env.RUSER || 'root';
const PW    = process.env.RPW   || 'Yunshudu#225';
const SITE  = process.env.SITE  || 'yunshudu';

async function call(url, opt) {
  const r = await fetch(url, opt);
  const t = await r.text();
  let d = null; try { d = JSON.parse(t); } catch (e) {}
  return { status: r.status, body: d, text: t };
}

(async () => {
  console.log('BASE = ' + BASE);
  const s = await call(BASE + '/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PW, confirmPassword: PW, SelfUseModeEnabled: false, DemoSiteEnabled: false })
  });
  console.log('setup -> ' + s.status + '  ' + (s.text || '').slice(0, 220));

  const l = await call(BASE + '/api/user/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PW })
  });
  console.log('login -> ' + l.status + '  ' + (l.text || '').slice(0, 160));
  if (!l.body || !l.body.success) { console.log('INIT_FAIL'); process.exit(1); }
  const tok = l.body.data.access_token, uid = l.body.data.id;
  const H = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok, 'New-Api-User': String(uid) };

  const put = async (k, v) => {
    const r = await call(BASE + '/api/option/', { method: 'PUT', headers: H, body: JSON.stringify({ key: k, value: v }) });
    const ok = r.body && r.body.success;
    console.log('  PUT ' + k + ' = ' + v + ' -> ' + r.status + ' ' + (ok ? 'ok' : (r.text || '').slice(0, 120)));
  };
  await put('SystemName', SITE);
  await put('ServerAddress', BASE);
  await put('RegisterEnabled', 'true');
  await put('PasswordRegisterEnabled', 'true');
  await put('QuotaPerUnit', '500000');
  await put('USDExchangeRate', '7.3');
  await put('DisplayInCurrencyEnabled', 'true');
  await put('SessionCookieSecure', 'false');

  const st = await call(BASE + '/api/status');
  if (st.body && st.body.data) {
    console.log('status -> ' + JSON.stringify({
      system_name: st.body.data.system_name,
      server_address: st.body.data.server_address,
      register: st.body.data.register_enabled,
      qpu: st.body.data.quota_per_unit,
      setup: st.body.data.setup,
      version: st.body.data.version
    }));
  } else { console.log('status raw -> ' + st.text.slice(0, 200)); }
  console.log('TOKEN=' + tok);
  console.log('UID=' + uid);
  console.log('PW=' + PW);
  console.log('INIT_DONE');
})();
