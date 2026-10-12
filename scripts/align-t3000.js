/**
 * align-t3000.js -- 把本地 new-api 参数对齐到 45.207.214.163:3000（幻镜AI）的同款形态
 *   依据：work\artifacts\ip45163-probe2.json 实测快照
 *   差异项：币种「条」/ 汇率 20.857142857142858 / quota_display_type=CUSTOM / USDExchangeRate=7.3
 * 用法：node scripts\align-t3000.js [SystemName]
 *       不传 SystemName 则保持原名（只对齐计价/币种/注册/登录形态）
 */
const fs2 = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.NEWAPI_BASE || 'http://127.0.0.1:3000';
const cred = fs2.readFileSync(path.join(ROOT, 'runtime', 'credentials.txt'), 'utf8');
const token = (cred.match(/^access_token:\s*(.+)$/m) || [])[1];
if (!token) throw new Error('runtime/credentials.txt 无 access_token');

const H = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'New-Api-User': '1' };
const api = async (m, u, b) => {
  const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  return { s: r.status, j };
};

// :3000 同款参数（probe2 实测）
const MIRROR = [
  ['general_setting.custom_currency_symbol', '条'],
  ['general_setting.custom_currency_exchange_rate', '20.857142857142858'],
  ['general_setting.quota_display_type', 'CUSTOM'],
  ['QuotaPerUnit', '500000'],
  ['USDExchangeRate', '7.3'],
  ['Price', '7.3'],
  ['StripeUnitPrice', '8'],
  ['DisplayInCurrencyEnabled', 'true'],
  ['CheckInEnabled', 'false'],
  ['RegisterEnabled', 'true'],
  ['PasswordRegisterEnabled', 'true'],
  ['PasswordLoginEnabled', 'true'],
  ['EmailVerificationEnabled', 'false'],
  ['TurnstileCheckEnabled', 'false'],
  ['SelfUseModeEnabled', 'false'],
  ['DemoSiteEnabled', 'false'],
  // OAuth/Passkey 全关（:3000 = 账号密码登录）
  ['GitHubOAuthEnabled', 'false'],
  ['LinuxDOOAuthEnabled', 'false'],
  ['WeChatAuthEnabled', 'false'],
  ['TelegramOAuthEnabled', 'false'],
  ['passkey.enabled', 'false'],
  ['oidc.enabled', 'false'],
];

(async () => {
  const name = process.argv[2];
  const list = name ? [['SystemName', name], ...MIRROR] : MIRROR;
  for (const [k, v] of list) {
    const r = await api('PUT', '/api/option/', { key: k, value: v });
    console.log((r.j && r.j.success ? 'OK  ' : 'FAIL') + '  ' + k + ' = ' + (v.length > 40 ? v.slice(0, 40) + '..' : v) + '  [' + r.s + ']');
  }
  const st = await api('GET', '/api/status');
  const d = st.j.data;
  console.log('\n-- status --');
  for (const k of ['system_name','register_enabled','password_login_enabled','email_verification','turnstile_check','quota_per_unit','usd_exchange_rate','custom_currency_symbol','custom_currency_exchange_rate','quota_display_type','display_in_currency','checkin_enabled','price','stripe_unit_price']) {
    console.log('   ' + k + ' = ' + JSON.stringify(d[k]));
  }
})();
