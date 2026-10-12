/**
 * pool-ledger.js -- 号池台账（R140 第 5 项）
 *   把池子里每个号摊开：额度 / 健康 / 到期时间 / 还剩几小时 / 能出几张图，并汇总。
 *   只读接口，不动池子。
 *   用法:
 *     node scripts/pool-ledger.js
 *     node scripts/pool-ledger.js --pool http://114.66.16.225:9940 --key <admin-key>
 *     node scripts/pool-ledger.js --json
 * 环境变量: H3P_POOL / H3P_ADMIN_KEY / SMS_UNIT_PRICE(默认0.4元/取号) / CREDIT_PER_IMAGE(默认6)
 */
'use strict';
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const POOL = String(arg('pool', process.env.H3P_POOL || 'http://127.0.0.1:9940')).replace(/\/+$/, '');
const KEY = String(arg('key', process.env.H3P_ADMIN_KEY || 'sk-hl-admin'));
const SMS_UNIT = Number(arg('sms-unit', process.env.SMS_UNIT_PRICE || 0.4));
const CREDIT_PER_IMAGE = Number(arg('credit-per-image', process.env.CREDIT_PER_IMAGE || 6));
const AS_JSON = args.indexOf('--json') >= 0;

(async () => {
  let st;
  try {
    const r = await fetch(POOL + '/pool/stats', { headers: { 'x-admin-key': KEY }, signal: AbortSignal.timeout(20000) });
    st = await r.json();
    if (!r.ok) { console.log('pool HTTP ' + r.status + ' :: ' + JSON.stringify(st).slice(0, 200)); process.exit(1); }
  } catch (e) { console.log('连不上池子 ' + POOL + ' :: ' + e.message); process.exit(1); }

  const accts = (st.accounts || []).map((a) => {
    const cr = Number(a.credits || 0);
    const hl = a.hours_left == null ? null : Number(a.hours_left);
    return {
      id: a.id, label: a.label, credits: cr, healthy: Number(a.healthy) === 1 ? 1 : 0,
      held: Number(a.held || 0), inflight: Number(a.inflight || 0),
      fails: Number(a.success_count || 0), fail_reason: a.fail_reason || '',
      expires_at: Number(a.expires_at || 0) || null,
      expires_iso: Number(a.expires_at || 0) ? new Date(Number(a.expires_at)).toISOString() : null,
      hours_left: hl,
      images_left: Math.floor(cr / CREDIT_PER_IMAGE)
    };
  }).sort((x, y) => y.credits - x.credits);

  const usable = accts.filter((a) => a.credits > 0 && a.healthy === 1);
  const totalCredits = usable.reduce((s, a) => s + a.credits, 0);
  const totalImages = Math.floor(totalCredits / CREDIT_PER_IMAGE);
  const soon = typeof st.expiry === 'object' && st.expiry ? st.expiry.expiring_soon || [] : accts.filter((a) => a.hours_left != null && a.hours_left <= 12);

  if (AS_JSON) {
    console.log(JSON.stringify({ pool: POOL, accounts: accts, summary: { accounts: accts.length, usable: usable.length, credits: totalCredits, images: totalImages, expiring_soon: soon } }, null, 2));
    return;
  }

  console.log('=== 号池台账 ===  ' + POOL + '   ' + new Date().toISOString());
  console.log('id   label                          credits  imgs  health  held  inflight  expires(UTC)          hours_left');
  for (const a of accts) {
    console.log(
      String(a.id).padEnd(5) +
      String(a.label).slice(0, 30).padEnd(31) +
      String(a.credits).padStart(7) +
      String(a.images_left).padStart(6) +
      String(a.healthy).padStart(8) +
      String(a.held).padStart(6) +
      String(a.inflight).padStart(10) +
      '  ' + String(a.expires_iso || '-').padEnd(26) +
      (a.hours_left == null ? '-' : String(a.hours_left))
    );
  }
  const dead = accts.length - usable.length;
  console.log('');
  console.log('总数=' + accts.length + '  可用(有额度且健康)=' + usable.length + '  不可用=' + dead);
  console.log('可用额度合计=' + totalCredits + ' credit  => 可出图 ' + totalImages + ' 张 (按 ' + CREDIT_PER_IMAGE + ' credit/张)');
  console.log('每张图上游成本 ≈ ' + (totalImages > 0 ? (SMS_UNIT / (totalCredits / CREDIT_PER_IMAGE)).toFixed(4) : 'n/a') + ' 元  (按接码 ' + SMS_UNIT + ' 元/号 且 100% 命中计)');
  if (soon.length) {
    console.log('');
    console.log('⚠ 到期预警（<=' + (st.expiry ? st.expiry.warn_hours : 12) + 'h）：');
    for (const a of soon) console.log('   #' + a.id + ' ' + a.label + ' credits=' + a.credits + ' 还剩 ' + a.hours_left + 'h (' + (a.expires_iso || '') + ')');
  } else {
    console.log('');
    console.log('✔ 暂无 12 小时内到期的号');
  }
})();
