/** hailuo-gen-matrix.js -- 生图 body 形状试探矩阵（逐个变体抢答案） */
'use strict';
const HS = require('./hailuo-sign.js');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const RAW = arg('token', '');
const BASE = arg('base', 'https://hailuoai.video');
const MODEL = arg('model', 'nano-banana2');
const DESC = arg('prompt', 'a cute orange cat sitting on a windowsill, soft morning light, photorealistic');
const ONLY = arg('only', '');

function mk(extra) {
  const parameter = Object.assign({ modelID: MODEL, desc: DESC, fileList: [], useOriginPrompt: true }, extra);
  return { quantity: 1, parameter: parameter, projectID: '0' };
}

const VARIANTS = [
  { n: 'A_numvalue_str', b: mk({ aspectRatio: '11', resolution: '1', quality: 'medium', referenceMode: 0 }) },
  { n: 'B_numtype_str',  b: mk({ aspectRatio: '11', resolution: '5', quality: 'medium', referenceMode: 0 }) },
  { n: 'D_minimal',      b: mk({}) },
  { n: 'F_A_extra',      b: Object.assign(mk({ aspectRatio: '11', resolution: '1', quality: 'medium', referenceMode: 0 }), { imageExtra: {} }) },
  { n: 'C_valueStr',     b: mk({ aspectRatio: 'Auto', resolution: '1K', quality: 'medium', referenceMode: '' }) },
  { n: 'E_allnum',       b: mk({ aspectRatio: 11, resolution: 1, quality: 'medium', referenceMode: 0 }) },
  { n: 'G_nores',        b: mk({ aspectRatio: '11', quality: 'medium', referenceMode: 0 }) },
  { n: 'I_src_home',     b: Object.assign(mk({ aspectRatio: '11', resolution: '1', quality: 'medium', referenceMode: 0 }), { modelSource: 'home' }) },
  { n: 'J_noproj',       b: (function(){ const o = mk({ aspectRatio: '11', resolution: '1', quality: 'medium', referenceMode: 0 }); delete o.projectID; return o; })() }
];

async function call(url, b) {
  const req = HS.buildSignedRequest({ url: url, method: 'POST', body: b, raw: RAW, time: Date.now() });
  let r, txt = '';
  try { r = await fetch(BASE + req.url, { method: 'POST', headers: req.headers, body: req.bodyString, signal: AbortSignal.timeout(30000) }); txt = await r.text(); }
  catch (e) { return { status: 0, text: e.message }; }
  return { status: r.status, text: txt };
}

(async () => {
  if (!RAW) { console.log('用法: node scripts/hailuo-gen-matrix.js --token "<...>" [--only A] [--model ...]'); process.exit(1); }
  console.log('base=' + BASE + '  model=' + MODEL);
  for (const v of VARIANTS) {
    if (ONLY && v.n.indexOf(ONLY) < 0) continue;
    const r = await call('/v2/api/multimodal/generate/image', v.b);
    console.log('[' + v.n + '] HTTP ' + r.status + ' :: ' + r.text.slice(0, 400));
    if (r.status === 200 && /"code":0/.test(r.text)) { console.log('  >>> 命中形状: ' + v.n); console.log('  >>> body=' + JSON.stringify(v.b)); break; }
    await new Promise((x) => setTimeout(x, 1200));
  }
})();
