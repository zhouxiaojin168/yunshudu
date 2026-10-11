/**
 * build-site-json.js -- 把本地网关的实时信息抓成静态快照 web/data/site.json
 *   node scripts/build-site-json.js
 * 静态站点即使离线打开也能显示内容；在线时网页会自动尝试刷新。
 *
 * ★ 幂等保证（2026-10-11 修）：
 *   网关 /api/pricing 的 models 数组顺序来自 Go map 迭代，定价缓存重建时会变一次，
 *   直接 JSON 比较会「每次都不同」→ auto-sync 形成无限提交循环。
 *   这里统一做 canonical 化：数组按稳定键排序 + 对象键排序 + 忽略 generatedAt，
 *   内容不变就绝不碰文件。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.SITE_API || 'http://127.0.0.1:3300';
const OUT = path.join(ROOT, 'web', 'data', 'site.json');
const IDX = path.join(ROOT, 'web', 'index.html');

const get = async (u) => {
  const r = await fetch(BASE + u);
  if (!r.ok) throw new Error(u + ' -> HTTP ' + r.status);
  return r.json();
};

/* ---------- canonical 化工具 ---------- */
const asStr = (v) => (v === undefined || v === null ? '' : String(v));
// 递归给对象键排序；数组保持原顺序（数组顺序由下面显式排序负责）
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}
const canon = (o) => JSON.stringify(sortKeys(o));
// 忽略时间戳后的规范串，用于「有没有真变化」判定
const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.generatedAt; return canon(c); };
const sortArr = (a) => (Array.isArray(a) ? a.slice().sort() : a);

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
  })).sort((a, b) => asStr(a.model_name).localeCompare(asStr(b.model_name), 'en'));   // ★ 消除顺序抖动

  let channels = [];
  try {
    const db = new DatabaseSync(path.join(ROOT, 'runtime', 'data', 'one-api.db'), { readOnly: true });
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

  // ★ 幂等写入：内容和上次一样（忽略 generatedAt，且已 canonical 化）就不动文件
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
  if (prev && strip(prev) === strip(snap)) {
    console.log('snapshot unchanged -> skip write (' + OUT + ')');
    return;
  }

  const body = JSON.stringify(snap, null, 2);
  if (!(prev && fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === body)) {
    fs.writeFileSync(OUT, body, 'utf8');
    console.log('written -> ' + OUT);
  }
  console.log('  site       = ' + snap.site.name + '  version=' + snap.site.version);
  console.log('  models     = ' + compact.length);
  console.log('  channels   = ' + channels.length + '  (multi-key: ' + channels.filter(c => c.is_multi_key).length + ')');

  // 顺手把快照内嵌进 index.html —— 这样直接双击打开网页也能看到数据（同样幂等）
  if (fs.existsSync(IDX)) {
    const html = fs.readFileSync(IDX, 'utf8');
    const re = /(<script id="snapshot" type="application\/json">)[\s\S]*?(<\/script>)/;
    if (re.test(html)) {
      const out = html.replace(re, '$1\n' + JSON.stringify(snap) + '\n$2');
      if (out !== html) { fs.writeFileSync(IDX, out, 'utf8'); console.log('snapshot injected -> web/index.html'); }
      else console.log('index.html unchanged');
    } else {
      console.log('[warn] web/index.html 里没找到 #snapshot 占位');
    }
  }
})();