/**
 * hailuo-gen.js -- 海螺乙路「真出图」端到端（默认海外站 hailuoai.video）
 *   node scripts/hailuo-gen.js --token "<token|uuid|device>" [--base https://hailuoai.video]
 *        [--model nano-banana2] [--prompt "..."] [--res 5] [--ratio 11] [--qty 1]
 *        [--quality medium] [--refmode ""] [--project 0] [--dry] [--nodry-run]
 *   --dry  只打印将要发送的 body（默认行为，不花钱）；真发要显式加 --live
 * 关键：resolution / aspectRatio / quality 都必须是 **字符串**（后端 Go 绑定要求）。
 *   resolutions: 5=1K / 6=2K / 7=4K   （type 值当字符串发）
 *   aspectRatios: 11=Auto / 1..10      （type 值当字符串发）
 *   quality: 无 qualities 的模型用 "medium"
 * body 形状来自前端包 9563-*.js:
 *   POST /v2/api/multimodal/generate/image
 *   { quantity, parameter:{ modelID, desc, fileList, useOriginPrompt, aspectRatio, resolution, quality, referenceMode }, projectID }
 */
'use strict';
const HS = require('./hailuo-sign.js');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const RAW = arg('token', '');
const BASE = arg('base', 'https://hailuoai.video');
const MODEL = arg('model', 'nano-banana2');
const PROMPT = arg('prompt', 'a cute orange cat sitting on a windowsill, soft morning light, photorealistic');
const RES = arg('res', '5');        // 5=1K 6=2K 7=4K (字符串)
const RATIO = arg('ratio', '11');    // 11=Auto (字符串)
const QTY = Number(arg('qty', '1'));
const QUALITY = arg('quality', 'medium');
const REFMODE = arg('refmode', '');
const PROJECT = arg('project', '0');
const LIVE = args.includes('--live');

const body = {
  quantity: QTY,
  parameter: {
    modelID: MODEL,
    desc: PROMPT,
    fileList: [],
    useOriginPrompt: true,
    aspectRatio: String(RATIO),
    resolution: String(RES),
    quality: String(QUALITY),
    referenceMode: String(REFMODE)
  },
  projectID: String(PROJECT)
};

async function call(method, url, b, label) {
  const req = HS.buildSignedRequest({ url: url, method: method, body: b, raw: RAW, time: Date.now() });
  const init = { method: method, headers: req.headers };
  if (method !== 'GET') init.body = req.bodyString;
  let r, txt = '';
  try { r = await fetch(BASE + req.url, Object.assign(init, { signal: AbortSignal.timeout(30000) })); txt = await r.text(); }
  catch (e) { console.log('### ' + label + ' 网络错误 ' + e.message); return null; }
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  const cls = HS.classifyResponse(r.status, j);
  console.log('### ' + label + '  ' + method + ' ' + url);
  console.log('    HTTP ' + r.status + ' | code=' + (j && j.statusInfo ? j.statusInfo.code : 'n/a') + ' | ' + (cls.ok ? 'OK' : cls.kind) + (j && j.statusInfo && j.statusInfo.message ? ' | msg=' + j.statusInfo.message : ''));
  console.log('    set-cookie: ' + String(r.headers.get('set-cookie') || '').slice(0, 200));
  console.log('    body: ' + txt.slice(0, 1200));
  return { status: r.status, json: j, text: txt };
}

const pick = (x) => (x && x.json && x.json.data && x.json.data.total_credit !== undefined ? x.json.data.total_credit : undefined);

(async () => {
  if (!RAW) { console.log('用法: node scripts/hailuo-gen.js --token "<token|uuid|device>" [--base ...] [--model ...] [--live]'); process.exit(1); }
  console.log('base=' + BASE + '  model=' + MODEL + '  res=' + RES + '  ratio=' + RATIO + '  qty=' + QTY + '  quality=' + QUALITY);
  console.log('将要发送的 body: ' + JSON.stringify(body));
  if (!LIVE) { console.log('(--dry 默认：只演算不发送；真发请加 --live)'); return; }
  const before = await call('GET', '/v1/api/billing/credit', null, '扣费前额度');
  const g = await call('POST', '/v2/api/multimodal/generate/image', body, '发起生图');
  await new Promise((r) => setTimeout(r, 4000));
  const after = await call('GET', '/v1/api/billing/credit', null, '扣费后额度');
  console.log('');
  console.log('额度变化: ' + pick(before) + ' -> ' + pick(after) + '（差=' + (pick(after) - pick(before)) + '）');
  if (g && g.json && g.json.data) console.log('生成返回 data 顶层键: ' + Object.keys(g.json.data).join(','));
  const r1 = await call('POST', '/api/feed/creation/my/processing', {}, '结果查询(processing)');
  if (r1 && r1.json && r1.json.data) console.log('processing data 顶层键: ' + Object.keys(r1.json.data).join(','));
})();
