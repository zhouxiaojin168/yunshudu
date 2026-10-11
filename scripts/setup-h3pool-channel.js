/**
 * setup-h3pool-channel.js -- 把「平台池(H3 式)」接进 new-api 当一条渠道 + 种账号/发码/建 Key
 *   node scripts/setup-h3pool-channel.js
 * 关键点：平台池是**服务端池**，渠道里只放 1 把「平台签发的 sk-hl- Key」，
 *         真正的账号池在 9940 进程内部（和池①的多 Key 轮询是两种不同做法）。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:3300';
const POOL = 'http://127.0.0.1:9940';
const MOCK = 'http://127.0.0.1:9941';
const ADMIN = 'sk-hl-admin';
const CH_NAME = '平台池-海螺H3式(platform-pool)';
const MODELS = 'MiniMax-H3,MiniMax-Image';

const cred = fs.readFileSync(path.join(ROOT, 'runtime', 'credentials.txt'), 'utf8');
const adm = (cred.match(/^access_token:\s*(.+)$/m) || [])[1];
if (!adm) throw new Error('runtime/credentials.txt 里没有 access_token');
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm, 'New-Api-User': '1' };
const api = async (m, u, b) => { const r = await fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { s: r.status, j }; };
const pick = (j) => { const dd = j && j.data; return Array.isArray(dd) ? dd : ((dd && dd.items) || []); };
const poolPost = (p, b) => fetch(POOL + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN }, body: JSON.stringify(b || {}) }).then((r) => r.json());

(async () => {
  console.log('== 1) 定价：MiniMax-H3 = 1 元/条、MiniMax-Image = 0.05 元/张（演示价）==');
  const cur = await api('GET', '/api/option/');
  const map = {}; for (const o of (cur.j.data || [])) map[o.key] = o.value;
  const jp = (k) => { try { return JSON.parse(map[k] || '{}'); } catch (e) { return {}; } };
  const mp = jp('ModelPrice'); const mr = jp('ModelRatio'); const cr = jp('CompletionRatio');
  mp['MiniMax-H3'] = 1.0; mp['MiniMax-Image'] = 0.05;
  mr['MiniMax-H3'] = 1; mr['MiniMax-Image'] = 1; cr['MiniMax-H3'] = 1; cr['MiniMax-Image'] = 1;
  for (const kv of [['ModelPrice', mp], ['ModelRatio', mr], ['CompletionRatio', cr]]) {
    const r = await api('PUT', '/api/option/', { key: kv[0], value: JSON.stringify(kv[1]) });
    console.log('   PUT ' + kv[0] + ' -> ' + r.s);
  }

  console.log('== 2) 建渠道 ==');
  const curCh = await api('GET', '/api/channel/?p=0&page_size=100');
  const dup = pick(curCh.j).find((x) => x.name === CH_NAME);
  if (dup) { await api('DELETE', '/api/channel/' + dup.id); console.log('   已删同名旧渠道 id=' + dup.id); }

  /* 平台签发的 Key：渠道里只放这一把；它对应池内部的"客户凭证" */
  await poolPost('/pool/reset', {});
  const chKeyR = await poolPost('/pool/keys', { label: 'new-api-channel', credits: 0, unlimited: 1 });
  const chKey = chKeyR.key;
  console.log('   平台签发渠道 Key: ' + chKey.slice(0, 14) + '... (unlimited)');

  const body = { mode: 'single', channel: { name: CH_NAME, type: 1, key: chKey, base_url: POOL, models: MODELS, group: 'default', status: 1, priority: 110, weight: 10, auto_ban: 0, setting: '{}' } };
  const r = await api('POST', '/api/channel/', body);
  console.log('   + 渠道 -> ' + r.s + ' ' + JSON.stringify(r.j).slice(0, 120));

  console.log('== 3) 种平台池账号（本地记账 vs 上游真实钱包可故意错开，用来演示 402 换号）==');
  const seed = [
    { label: 'h1-瘦号', token: 'tk_h1', credits: 12, up: 12 },
    { label: 'h2-肥号', token: 'tk_h2', credits: 100, up: 100 },
    { label: 'h3-空号', token: 'tk_h3', credits: 0, up: 0 }
  ];
  for (const s of seed) {
    await poolPost('/pool/accounts', { label: s.label, token: s.token, credits: s.credits });
    await fetch(MOCK + '/internal/admin/account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: s.token, credits: s.up, valid: true }) });
    console.log('   + ' + s.label + ' credits=' + s.credits);
  }

  console.log('== 4) 发兑换码（演示：兑换码 -> sk-hl- Key，额度用完自动销号）==');
  const minted = await poolPost('/v1/redeem-codes/mint', { count: 3, credits: 2000 });
  console.log('   兑换码: ' + minted.data.join('  '));
  const red = await fetch(POOL + '/v1/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: minted.data[0] }) }).then((x) => x.json());
  fs.writeFileSync(path.join(ROOT, 'runtime', 'h3pool-redeem-demo.txt'), 'code=' + minted.data[0] + '\nkey=' + red.key + '\ncredits=' + red.credits + '\n', 'utf8');
  console.log('   已兑换 Key: ' + String(red.key).slice(0, 14) + '... credits=' + red.credits + '  -> runtime/h3pool-redeem-demo.txt');

  console.log('== 5) 复核 ==');
  const list = await api('GET', '/api/channel/?p=0&page_size=100');
  for (const c of pick(list.j)) console.log('   [ch] #' + c.id + ' ' + c.name + '  status=' + c.status + '  base=' + c.base_url + '  models=' + c.models);
  const ps = await fetch(POOL + '/v1/public/stats').then((x) => x.json());
  console.log('   [池] accounts=' + ps.accounts + ' healthy=' + ps.accounts_healthy + ' credits_pool=' + ps.credits_pool + ' clips_available=' + ps.clips_available + ' codes_unused=' + ps.codes_unused);
})();