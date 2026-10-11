/**
 * build-site-json.js -- 把本地网关的实时信息抓成静态快照 web/data/site.json
 *   node scripts/build-site-json.js
 * 静态站点即使离线打开也能显示内容；在线时网页会自动尝试刷新。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.SITE_API || 'http://127.0.0.1:3300';
const OUT = path.join(ROOT, 'web', 'data', 'site.json');

const get = async (u) => {
  const r = await fetch(BASE + u);
  if (!r.ok) throw new Error(u + ' -> HTTP ' + r.status);
  return r.json();
};

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
    groups: m.enable_groups || [],
    endpoints: m.supported_endpoint_types || []
  }));

  let channels = [];
  try {
    const db = new DatabaseSync(path.join(ROOT, 'runtime', 'data', 'one-api.db'), { readOnly: true });
    const rows = db.prepare('SELECT id, name, type, base_url, models, status, priority, weight, auto_ban, key FROM channels ORDER BY id').all();
    channels = rows.map(c => ({
      id: c.id,
      name: c.name,
      base_url: c.base_url,
      models: String(c.models || '').split(',').filter(Boolean),
      status: c.status,
      priority: c.priority,
      weight: c.weight,
      auto_ban: c.auto_ban,
      is_multi_key: String(c.key || '').includes('\n'),
      key_count: String(c.key || '').split('\n').filter(Boolean).length
    }));
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
    auto_groups: (pricingRaw && pricingRaw.auto_groups) || [],
    vendors: (pricingRaw && pricingRaw.vendors) || [],
    usable_group: (pricingRaw && pricingRaw.usable_group) || {},
    models: compact,
    channels
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snap, null, 2), 'utf8');
  console.log('written -> ' + OUT);
  console.log('  site       = ' + snap.site.name + '  version=' + snap.site.version);
  console.log('  models     = ' + compact.length);
  console.log('  channels   = ' + channels.length + '  (multi-key: ' + channels.filter(c => c.is_multi_key).length + ')');
  console.log('  groups     = ' + JSON.stringify(snap.auto_groups));

  // 顺手把快照内嵌进 index.html —— 这样直接双击打开网页也能看到数据
  const IDX = path.join(ROOT, 'web', 'index.html');
  if (fs.existsSync(IDX)) {
    const html = fs.readFileSync(IDX, 'utf8');
    const re = /(<script id="snapshot" type="application\/json">)[\s\S]*?(<\/script>)/;
    if (re.test(html)) {
      fs.writeFileSync(IDX, html.replace(re, '$1\n' + JSON.stringify(snap) + '\n$2'), 'utf8');
      console.log('snapshot injected -> web/index.html');
    } else {
      console.log('[warn] web/index.html 里没找到 #snapshot 占位');
    }
  }
})();
