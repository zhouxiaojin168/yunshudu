/**
 * hailuo-video-probe.js -- 找「海螺网页端 H3 视频」的真实接口与参数面（只读）
 *   node scripts/hailuo-video-probe.js --token "<_token>|<uuid>|<device>" [--base https://hailuoai.video]
 * 产出：runtime/evidence/ 下的原始 JSON + 终端摘要（模型 ID / 时长档 / 分辨率档 / 单价）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const HS = require('./hailuo-sign.js');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const RAW = arg('token', '');
const BASE = arg('base', 'https://hailuoai.video');
const OUTDIR = path.resolve(__dirname, '..', 'runtime', 'evidence');
fs.mkdirSync(OUTDIR, { recursive: true });

async function call(method, url, body, label, save) {
  const req = HS.buildSignedRequest({ url, method, body, raw: RAW, time: Date.now() });
  let r, txt = '', j = null;
  try {
    r = await fetch(BASE + req.url, { method, headers: req.headers, body: method === 'GET' ? undefined : req.bodyString, signal: AbortSignal.timeout(25000) });
    txt = await r.text();
    try { j = JSON.parse(txt); } catch (e) {}
  } catch (e) { console.log('### ' + label + ' 网络错误 ' + e.message); return null; }
  const cls = HS.classifyResponse(r.status, j);
  console.log('### ' + label + '  HTTP ' + r.status + ' code=' + (j && j.statusInfo ? j.statusInfo.code : 'n/a') + ' 判定=' + (cls.ok ? 'OK' : cls.kind) + (cls.message ? ' msg=' + cls.message : ''));
  if (save && txt) { fs.writeFileSync(path.join(OUTDIR, save), txt, 'utf8'); console.log('    saved runtime/evidence/' + save + ' (' + txt.length + 'B)'); }
  return j;
}

function summarizeEquity(j) {
  const mc = j && j.data && j.data.modelControl;
  if (!Array.isArray(mc)) { console.log('   (equity 里没有 modelControl)'); return; }
  console.log('   modelControl 条目数=' + mc.length);
  const keep = ['hailuo3.0-t2v', 'hailuo3.0-i2v', 'MiniMax-H3-Max', 'MiniMax-Hailuo-03', 'nano-banana2', 'seedream-4.5'];
  for (const m of mc) {
    const id = m.modelID || m.modelId || m.id || '';
    if (!keep.some((k) => String(id).toLowerCase().includes(k.toLowerCase()))) continue;
    const out = { modelID: id, name: m.name || m.title || '', isMember: m.isMember, videoCosts: m.videoCosts, costs: m.costs, creditCosts: m.creditCosts };
    console.log('   * ' + JSON.stringify(out).slice(0, 900));
  }
}

(async () => {
  if (!RAW) { console.log('用法: node scripts/hailuo-video-probe.js --token "<token|uuid|device>" [--base https://hailuoai.video]'); process.exit(1); }
  console.log('base=' + BASE);
  const eq = await call('GET', '/v1/api/user/equity', null, 'equity(权益/单价表)', 'equity-intl.json');
  summarizeEquity(eq);
  await call('GET', '/v1/api/multimodal/tool/list', null, 'tool/list(工具与模型清单)', 'tool-list-intl.json');
  await call('GET', '/v1/api/multimodal/tool/fields', null, 'tool/fields(参数面/枚举)', 'tool-fields-intl.json');
  await call('POST', '/api/feed/creation/search/my', { cursor: '', limit: 5 }, 'feed/search/my(最近产物类型)', 'feed-search-my-intl.json');
  console.log('完成：原始 JSON 在 runtime/evidence/。');
})();
