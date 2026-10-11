/**
 * setup-pool2-channel.js -- 把「池②：Google/Flow 账号池」接进 new-api 当一条渠道
 *   node scripts/setup-pool2-channel.js
 *
 * 与池①(多Key渠道池)的区别：
 *   池① = 一条渠道里塞 N 把 key，靠 new-api 自己轮询（multi_to_single + multi_key_mode）
 *   池② = 一条渠道只有 1 个 key，真正的账号池在 flow-pool 里面（AT 刷新 / 429 冷却 / 负载调度）
 * 所以这里建渠道时 **不** 用 multi_to_single，只用普通单 key 渠道。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:3300';
const POOL_BASE = 'http://127.0.0.1:9930';
const POOL_KEY = process.env.POOL_KEY || 'sk-pool-google-demo';
const MODEL = 'gemini-nano-banana-2.1-image';
const CH_NAME = '池②-Google账号池(flow-pool)';

const cred = fs.readFileSync(path.join(ROOT, 'runtime', 'credentials.txt'), 'utf8');
const adm = (cred.match(/^access_token:\s*(.+)$/m) || [])[1];
if (!adm) throw new Error('runtime/credentials.txt 里没有 access_token');
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm, 'New-Api-User': '1' };
const api = async (m, u, b) => {
  const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  return { s: r.status, j };
};
const pick = (j) => { const d = j && j.data; return Array.isArray(d) ? d : ((d && d.items) || []); };

(async () => {
  /* 1) 给这个模型配价（否则 new-api 会报 model_price_error） */
  const cur = await api('GET', '/api/option/');
  const map = {};
  for (const o of (cur.j.data || [])) map[o.key] = o.value;
  let mp = {}; try { mp = JSON.parse(map.ModelPrice || '{}'); } catch (e) {}
  mp[MODEL] = 0.05;   // 每张 0.05 元（演示价）
  let mr = {}; try { mr = JSON.parse(map.ModelRatio || '{}'); } catch (e) {}
  mr[MODEL] = 1;
  let cr = {}; try { cr = JSON.parse(map.CompletionRatio || '{}'); } catch (e) {}
  cr[MODEL] = 1;
  for (const kv of [['ModelPrice', mp], ['ModelRatio', mr], ['CompletionRatio', cr]]) {
    const r = await api('PUT', '/api/option/', { key: kv[0], value: JSON.stringify(kv[1]) });
    console.log('PUT ' + kv[0] + ' -> ' + r.s);
  }

  /* 2) 建/换 池② 渠道 */
  const curCh = await api('GET', '/api/channel/?p=0&page_size=100');
  const exist = pick(curCh.j);
  const dup = exist.find((x) => x.name === CH_NAME);
  if (dup) { await api('DELETE', '/api/channel/' + dup.id); console.log('已删除同名旧渠道 id=' + dup.id); }
  const body = {
    mode: 'single',
    channel: {
      name: CH_NAME, type: 1, key: POOL_KEY, base_url: POOL_BASE,
      models: MODEL, group: 'default', status: 1, priority: 100, weight: 10,
      auto_ban: 0,               // 池② 内部自己管熔断，不让 new-api 因为单次 401/429 把整条渠道停掉
      setting: '{}'
    }
  };
  const r = await api('POST', '/api/channel/', body);
  console.log('+ 池②渠道 -> ' + r.s + ' ' + JSON.stringify(r.j).slice(0, 140));

  /* 3) 往池里种 3 个模拟 Google 账号 */
  const seed = [['ST-g1', 'g1@gmail.mock', 3, -1], ['ST-g2', 'g2@gmail.mock', 3, -1], ['ST-g3', 'g3@gmail.mock', 10, -1]];
  await fetch(POOL_BASE + '/pool/reset', { method: 'POST', headers: { 'x-pool-admin': POOL_KEY } });
  for (const s of seed) {
    await fetch(POOL_BASE + '/pool/accounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pool-admin': POOL_KEY },
      body: JSON.stringify({ st: s[0], email: s[1], credits: s[2], image_concurrency: s[3] })
    });
    await fetch('http://127.0.0.1:9931/internal/admin/state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ st: s[0], credits: s[2], rate_limit: false })
    });
    console.log('  + 种号 ' + s[1] + ' credits=' + s[2]);
  }

  /* 4) 复核 */
  const list = await api('GET', '/api/channel/?p=0&page_size=100');
  for (const c of pick(list.j)) console.log('  [ch] #' + c.id + ' ' + c.name + '  status=' + c.status + '  base=' + c.base_url + '  models=' + c.models);
  const st = await (await fetch(POOL_BASE + '/pool/stats', { headers: { 'x-pool-admin': POOL_KEY } })).json();
  console.log('  池②账号数=' + st.accounts.length + '  ban=' + st.ban_seconds + 's  AT刷新阈值=' + st.at_refresh_seconds + 's');
})();
