/**
 * hailuo-video-matrix.js -- H3 视频接口参数矩阵试错（每次失败的尝试不计费）
 *   node scripts/hailuo-video-matrix.js --token "<token|uuid|device>" [--base https://hailuoai.video]
 * 命中 data.id 立即停止（避免重复计费）。
 */
'use strict';
const HS = require('./hailuo-sign.js');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const RAW = arg('token', '');
const BASE = arg('base', 'https://hailuoai.video');
const PROMPT = arg('prompt', 'A cute orange cat walking slowly on a wooden table, cinematic light');

const variants = [
  { name: 'A t2v-name+res1', body: { quantity: 1, parameter: { modelID: 'hailuo3.0-t2v', desc: PROMPT, fileList: [], useOriginPrompt: true, resolution: '1', duration: 1 }, projectID: '0' } },
  { name: 'B t2v-name+720P', body: { quantity: 1, parameter: { modelID: 'hailuo3.0-t2v', desc: PROMPT, fileList: [], useOriginPrompt: true, resolution: '720P', duration: 1 }, projectID: '0' } },
  { name: 'C 23021+720P', body: { quantity: 1, parameter: { modelID: '23021', desc: PROMPT, fileList: [], useOriginPrompt: true, resolution: '720P', duration: 1 }, projectID: '0' } },
  { name: 'D 23021+res1+ar', body: { quantity: 1, parameter: { modelID: '23021', desc: PROMPT, fileList: [], useOriginPrompt: true, resolution: '1', duration: 1, aspectRatio: '16:9', referenceMode: '' }, projectID: '0' } },
  { name: 'E MiniMax-Hailuo-03', body: { quantity: 1, parameter: { modelID: 'MiniMax-Hailuo-03', desc: PROMPT, fileList: [], useOriginPrompt: true, resolution: '1', duration: 1 }, projectID: '0' } },
  { name: 'F 23000+res1', body: { quantity: 1, parameter: { modelID: '23000', desc: PROMPT, fileList: [], useOriginPrompt: true, resolution: '1', duration: 1 }, projectID: '0' } },
  { name: 'G 23210+res4', body: { quantity: 1, parameter: { modelID: '23210', desc: PROMPT, fileList: [], useOriginPrompt: true, resolution: '4', duration: 1 }, projectID: '0' } }
];

async function call(method, url, body) {
  const req = HS.buildSignedRequest({ url, method, body, raw: RAW, time: Date.now() });
  try {
    const r = await fetch(BASE + req.url, { method, headers: req.headers, body: method === 'GET' ? undefined : req.bodyString, signal: AbortSignal.timeout(30000) });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    return { status: r.status, j, txt };
  } catch (e) { return { status: 0, j: null, txt: e.message }; }
}

(async () => {
  if (!RAW) { console.log('用法: node scripts/hailuo-video-matrix.js --token "<token|uuid|device>"'); process.exit(1); }
  const c0 = await call('GET', '/v1/api/billing/credit', null);
  console.log('起始额度 = ' + (c0.j && c0.j.data ? c0.j.data.total_credit : '?'));
  for (const v of variants) {
    const r = await call('POST', '/v2/api/multimodal/generate/video', v.body);
    const st = r.j && r.j.statusInfo;
    const id = r.j && r.j.data && r.j.data.id;
    console.log('[' + v.name + '] HTTP ' + r.status + ' code=' + (st ? st.code : 'n/a') + ' msg=' + (st ? st.message : r.txt.slice(0, 160)) + (id ? '  ==> TASK ' + id : ''));
    if (id) {
      console.log('命中！body=' + JSON.stringify(v.body));
      const c1 = await call('GET', '/v1/api/billing/credit', null);
      console.log('当前额度 = ' + (c1.j && c1.j.data ? c1.j.data.total_credit : '?'));
      return;
    }
    await new Promise((x) => setTimeout(x, 1200));
  }
  console.log('全部变体都没拿到 task id');
})();
