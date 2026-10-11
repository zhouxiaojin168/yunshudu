/**
 * setup-channels.js -- 幂等创建"多 Key 渠道池"演示环境
 *   A 渠道: 2 个 key，polling 轮询，402->401 映射  (上游 9921 健康)
 *   B 渠道: 1 个 key，额度为 0                      (上游 9922 欠费)
 * 再创建一个本地测试令牌，用于跑通 /v1 调用。
 */
const fs = require('fs');
const path = require('path');
const BASE = 'http://127.0.0.1:3300';
const ROOT = path.resolve(__dirname, '..');
const cred = fs.readFileSync(path.join(ROOT, 'runtime', 'credentials.txt'), 'utf8');
const token = (cred.match(/^access_token:\s*(.+)$/m) || [])[1];
if (!token) throw new Error('runtime/credentials.txt 里没有 access_token，先跑 bootstrap-local.js');

const H = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'New-Api-User': '1' };
const api = async (m, u, b) => {
  const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  return { s: r.status, j };
};

const CHANNELS = [
  {
    name: '本地演示-A组(健康池)',
    key: ['sk-a1','sk-a2'].join('\n'),
    base_url: 'http://127.0.0.1:9921',
  },
  {
    name: '本地演示-B组(欠费池)',
    key: ['sk-b1'].join('\n'),
    base_url: 'http://127.0.0.1:9922',
  },
];

(async () => {
  const cur = await api('GET', '/api/channel/?p=0&page_size=100');
  const pick = (j) => { const d = j && j.data; return Array.isArray(d) ? d : ((d && d.items) || []); };
  const exist = pick(cur.j);

  for (const c of CHANNELS) {
    const dup = exist.find(x => x.name === c.name);
    if (dup) {
      await api('DELETE', '/api/channel/' + dup.id);
      console.log('  已删除同名旧渠道 id=' + dup.id);
    }
    const body = {
      mode: 'multi_to_single',
      multi_key_mode: 'polling',            // 池① 的调度模式：轮询（另一档是 random）
      channel: {
        name: c.name, type: 1, key: c.key, base_url: c.base_url,
        models: 'MiniMax-H3,MiniMax-M3', group: 'default',
        status: 1, priority: 5, weight: 10, auto_ban: 1,
        status_code_mapping: JSON.stringify({ '402': '401' }),   // 额度耗尽 => 认证失败 => 只踢这一把 key
        setting: '{}'
      }
    };
    const r = await api('POST', '/api/channel/', body);
    console.log('  + 渠道', c.name, '->', r.s, JSON.stringify(r.j).slice(0, 120));
  }

  const list = await api('GET', '/api/channel/?p=0&page_size=100');
  pick(list.j).forEach(ch => console.log('    [渠道]', ch.id, ch.name, '| multi_key=', ch.channel_info && ch.channel_info.is_multi_key, '| mode=', ch.channel_info && ch.channel_info.multi_key_mode, '| base=', ch.base_url));

  // 测试令牌
  const tl = await api('GET', '/api/token/?p=0&page_size=100');
  let key = null;
  const tExist = pick(tl.j).find(t => t.name === 'local-test-token');
  if (!tExist) {
    const r = await api('POST', '/api/token/', { name: 'local-test-token', remain_quota: 5000000, expired_time: -1, unlimited_quota: false, model_limits_enabled: false, allow_ips: '' });
    console.log('  + 令牌创建 ->', r.s, JSON.stringify(r.j).slice(0, 120));
  }
  const tl2 = await api('GET', '/api/token/?p=0&page_size=100');
  const t2 = pick(tl2.j).find(t => t.name === 'local-test-token');
  if (t2) { key = 'sk-' + t2.key; console.log('  [测试令牌]', key); fs.writeFileSync(path.join(ROOT, 'runtime', 'test-token.txt'), key, 'utf8'); }
  else console.log('  !! 没拿到令牌');
})();


