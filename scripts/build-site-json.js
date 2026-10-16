/**
 * build-site-json.js -- 鎶婃湰鍦扮綉鍏崇殑瀹炴椂淇℃伅鎶撴垚闈欐€佸揩鐓?web/data/site.json
 *   node scripts/build-site-json.js
 * 闈欐€佺珯鐐瑰嵆浣跨绾挎墦寮€涔熻兘鏄剧ず鍐呭锛涘湪绾挎椂缃戦〉浼氳嚜鍔ㄥ皾璇曞埛鏂般€? *
 * 鈽?骞傜瓑淇濊瘉锛?026-10-11 绗?2杞慨锛夛細
 *   缃戝叧 /api/pricing 鐨?models 椤哄簭鏉ヨ嚜 Go map 杩唬锛屽畾浠风紦瀛橀噸寤烘椂浼氱炕涓€娆★紱
 *   鐩存帴姣旇緝 JSON 浼氥€屾瘡娆￠兘涓嶅悓銆嶁啋 auto-sync 鏃犻檺鎻愪氦寰幆銆? *   鍋氭硶锛歝ompare 涓?write 閮借蛋 normSnap()锛堝璞￠敭鎺掑簭 + 鏁扮粍鎸夌ǔ瀹氶敭鎺掑簭 + 蹇界暐 generatedAt锛夈€? *   鍐呭璇箟涓嶅彉 鈫?缁濅笉纰版枃浠?鈫?涓嶄骇鐢熸彁浜ゃ€? */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.SITE_API || 'http://127.0.0.1:3000';
const OUT = path.join(ROOT, 'web', 'data', 'site.json');
const IDX = path.join(ROOT, 'web', 'index.html');

const get = async (u) => {
  const r = await fetch(BASE + u);
  if (!r.ok) throw new Error(u + ' -> HTTP ' + r.status);
  return r.json();
};

/* ---------- canonical 鍖栧伐鍏?---------- */
const asStr = (v) => (v === undefined || v === null ? '' : String(v));
function sortKeys(v) {                       // 閫掑綊閿帓搴忥紙鏁扮粍椤哄簭涓嶅姩锛?  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}
const sortArr = (a) => (Array.isArray(a) ? a.map(x => (x && typeof x === 'object' ? (x.name || x.id || JSON.stringify(x)) : x)).sort() : a);

/** 瑙勮寖鍖栧揩鐓э細鏁扮粍鎸夌ǔ瀹氶敭鎺掑簭 + 瀵硅薄閿帓搴?+ 鍘绘帀 generatedAt锛岀敤浜?璇箟鏄惁鍙樺寲"鍒ゅ畾 */
function normSnap(o) {
  const c = JSON.parse(JSON.stringify(o));
  delete c.generatedAt;
  if (Array.isArray(c.models)) {
    for (const m of c.models) { m.groups = sortArr(m.groups || []); m.endpoints = sortArr(m.endpoints || []); }
    c.models.sort((a, b) => asStr(a.model_name).localeCompare(asStr(b.model_name), 'en'));
  }
  if (Array.isArray(c.channels)) {
    for (const ch of c.channels) { if (Array.isArray(ch.models)) ch.models = sortArr(ch.models); }
    c.channels.sort((a, b) => Number(a.id) - Number(b.id));
  }
  if (Array.isArray(c.auto_groups)) c.auto_groups = sortArr(c.auto_groups);
  if (Array.isArray(c.vendors)) c.vendors = sortArr(c.vendors);
  return JSON.stringify(sortKeys(c));
}

(async () => {
  const status = (await get('/api/status')).data || {};
  let pricingRaw = null;
  try { pricingRaw = await get('/api/pricing'); } catch (e) { console.log('[warn] pricing:', e.message); }

  const models = (pricingRaw && (Array.isArray(pricingRaw.data) ? pricingRaw.data : (pricingRaw.models || []))) || [];
  const compact = models.map(m => ({
    model_name: m.model_name,
    quota_type: m.quota_type,
    model_price: m.model_price,
    model_ratio: m.model_ratio,
    completion_ratio: m.completion_ratio,
    groups: sortArr(m.enable_groups || []),
    endpoints: sortArr(m.supported_endpoint_types || [])
  })).sort((a, b) => asStr(a.model_name).localeCompare(asStr(b.model_name), 'en'));   // 鈽?娑堥櫎椤哄簭鎶栧姩

  let channels = [];
  try {
    const DB_CANDIDATES = [
      process.env.SITE_DB,
      path.join(ROOT, 'data', 'one-api.db'),
      path.join(ROOT, 'runtime', 'data', 'one-api.db'),
      path.join(ROOT, '..', 'data', 'one-api.db'),
      'C:\\yunshudu\\data\\one-api.db'
    ].filter(Boolean);
    const dbPath = DB_CANDIDATES.find((x) => { try { return fs.existsSync(x); } catch (e) { return false; } }) || DB_CANDIDATES[1];
    const db = new DatabaseSync(dbPath, { readOnly: true });
    console.log('[db] ' + dbPath);
    const rows = db.prepare('SELECT id, name, type, base_url, models, status, priority, weight, auto_ban, key FROM channels ORDER BY id').all();
    channels = rows.map(c => ({
      id: c.id,
      name: c.name,
      base_url: c.base_url,
      models: String(c.models || '').split(',').filter(Boolean).sort(),
      status: c.status,
      priority: c.priority,
      weight: c.weight,
      auto_ban: c.auto_ban,
      is_multi_key: String(c.key || '').includes('\n'),
      key_count: String(c.key || '').split('\n').filter(Boolean).length
    })).sort((a, b) => Number(a.id) - Number(b.id));
  } catch (e) { console.log('[warn] channels:', e.message); }

  const snap = {
    generatedAt: new Date().toISOString(),
    source: BASE,
    site: {
      name: status.system_name || 'yunshudu',
      version: status.version || '',
      register_enabled: !!status.register_enabled,
      password_register_enabled: !!status.password_register_enabled,
      quota_per_unit: status.quota_per_unit,
      usd_exchange_rate: status.usd_exchange_rate,
      price: status.price,
      currency_symbol: status.custom_currency_symbol,
      currency_rate: status.custom_currency_exchange_rate,
      server_address: status.server_address,
      checkin_enabled: !!status.checkin_enabled,
      pricing_version: (pricingRaw && pricingRaw.pricing_version) || (models[0] && models[0].pricing_version) || ''
    },
    auto_groups: sortArr((pricingRaw && pricingRaw.auto_groups) || []),
    vendors: ((pricingRaw && pricingRaw.vendors) || []).slice().sort((a, b) =>
      asStr(typeof a === 'object' ? (a.name || a.id) : a).localeCompare(asStr(typeof b === 'object' ? (b.name || b.id) : b), 'en')),
    usable_group: (pricingRaw && pricingRaw.usable_group) || {},
    models: compact,
    channels
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // 鈽?骞傜瓑鍐欏叆锛氳涔変笉鍙橈紙蹇界暐 generatedAt銆佸拷鐣ユ暟缁勯『搴忥級灏辩粷涓嶇鏂囦欢
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
  if (prev && normSnap(prev) === normSnap(snap)) {
    console.log('snapshot unchanged -> skip write (' + OUT + ')');
    return;
  }

  const body = JSON.stringify(snap, null, 2);
  fs.writeFileSync(OUT, body, 'utf8');
  console.log('written -> ' + OUT);
  console.log('  site       = ' + snap.site.name + '  version=' + snap.site.version);
  console.log('  models     = ' + compact.length);
  console.log('  channels   = ' + channels.length + '  (multi-key: ' + channels.filter(c => c.is_multi_key).length + ')');

  // 椤烘墜鎶婂揩鐓у唴宓岃繘 index.html锛堝悓鏍峰箓绛夛細鍐呭祵鍖哄鐨勫唴瀹逛竴寰嬩笉鍔級
  if (fs.existsSync(IDX)) {
    const html = fs.readFileSync(IDX, 'utf8');
    const re = /(<script id="snapshot" type="application\/json">)[\s\S]*?(<\/script>)/;
    if (re.test(html)) {
      const cur = (html.match(re) || [])[0] || '';
      const next = html.replace(re, '$1\n' + JSON.stringify(snap) + '\n$2');
      const curJson = cur.replace(/^<script id="snapshot" type="application\/json">/, '').replace(/<\/script>$/, '').trim();
      let same = false;
      try { same = normSnap(JSON.parse(curJson)) === normSnap(snap); } catch (e) {}
      if (same) console.log('index.html unchanged');
      else { fs.writeFileSync(IDX, next, 'utf8'); console.log('snapshot injected -> web/index.html'); }
    } else {
      console.log('[warn] web/index.html 閲屾病鎵惧埌 #snapshot 鍗犱綅');
    }
  }
})();
