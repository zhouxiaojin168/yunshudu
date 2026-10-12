/**
 * align-t3000-pricing.js -- 把 45.207.214.163:3000（幻镜AI）的定价原样搬进本地 new-api
 *   依据：work\artifacts\ip45163-probe2.json 的 pricing 原始数据
 *   要点：13 个模型全部 quota_type=1（按次固定价）model_price=0.047945205479，model_ratio=0
 *        分组 default + vip（ratio 都 1），usable_group default=「MiniMax H3 全模型」
 *   用法：node scripts\align-t3000-pricing.js
 */
const fs2 = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.NEWAPI_BASE || 'http://127.0.0.1:3000';
const cred = fs2.readFileSync(path.join(ROOT, 'runtime', 'credentials.txt'), 'utf8');
const tok = (cred.match(/^access_token:\s*(.+)$/m) || [])[1];
if (!tok) throw new Error('runtime/credentials.txt 无 access_token');
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok, 'New-Api-User': '1' };
const api = async (m, u, b) => { const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { s: r.status, j }; };

const PRICE = 0.047945205479;
// :3000 pricing.data 的 13 个模型（原样）
const MODELS = ['MiniMax-H3-Max','MiniMax-Image','listen_audio','describe_images','search_images','MiniMax-M3','MiniMax-Hailuo-2.3','MiniMax-Speech','MiniMax-Music','videos_understand','audios_understand','reverse_image_search','MiniMax-H3'];

(async () => {
  const cur = await api('GET', '/api/option/');
  const map = {}; for (const o of (cur.j.data || [])) map[o.key] = o.value;
  const jp = (k) => { try { return JSON.parse(map[k] || '{}'); } catch (e) { return {}; } };

  const mp = jp('ModelPrice'), mr = jp('ModelRatio'), cr = jp('CompletionRatio');
  for (const m of MODELS) { mp[m] = PRICE; mr[m] = 0; cr[m] = 0; }

  const gr = { default: 1, vip: 1 };                       // :3000 group_ratio
  const uug = { default: 'MiniMax H3 全模型', vip: 'vip分组' }; // :3000 usable_group
  const ag = ['default'];

  const puts = [
    ['ModelPrice', mp],
    ['ModelRatio', mr],
    ['CompletionRatio', cr],
    ['GroupRatio', gr],
    ['UserUsableGroups', uug],
    ['AutoGroups', ag],
  ];
  for (const [k, v] of puts) {
    const r = await api('PUT', '/api/option/', { key: k, value: JSON.stringify(v) });
    console.log((r.j && r.j.success ? 'OK  ' : 'FAIL') + '  ' + k + '  [' + r.s + ']');
  }

  // 渠道 #13 的模型清单 -> 13 个
  const list = await api('GET', '/api/channel/?p=0&page_size=100');
  const items = (list.j.data && (list.j.data.items || list.j.data)) || [];
  const ch = items.find((c) => /平台池/.test(c.name));
  if (ch) {
    const del = await api('DELETE', '/api/channel/' + ch.id);
    const body = { mode: 'single', channel: { name: ch.name, type: 1, key: ch.key || '', base_url: ch.base_url, models: MODELS.join(','), group: 'default', status: 1, priority: 110, weight: 10, auto_ban: 0, setting: '{}' } };
    console.log('note: 渠道重建请在 start-stack-t3000 后跑 setup-h3pool-channel.js 或手工填 key；此处仅打印目标模型清单');
  }
  console.log('渠道 models 目标 = ' + MODELS.join(','));
  const st = await api('GET', '/api/pricing');
  console.log('\n/api/pricing -> ' + st.s + ' 模型数=' + ((st.j.data||st.j||[]).length));
})();
