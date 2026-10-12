/**
 * hailuo-video-gen.js -- 海螺网页端「真出视频」(H3 / hailuo3.0) 端到端
 *   node scripts/hailuo-video-gen.js --token "<token|uuid|device>" [--model 23021] [--dur 1] [--res 1] [--prompt "..."] [--base https://hailuoai.video]
 * 流程：余额 -> POST /v2/api/multimodal/generate/video -> 轮询 /api/feed/creation/search/my -> 打印视频直链
 */
'use strict';
const fs = require('fs');
const path = require('path');
const HS = require('./hailuo-sign.js');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const RAW = arg('token', '');
const BASE = arg('base', 'https://hailuoai.video');
const MODEL = arg('model', '23021');
const DUR = Number(arg('dur', '1'));
const RES = Number(arg('res', '1'));
const PROMPT = arg('prompt', 'A cute orange cat walking slowly on a wooden table, cinematic light');
const OUT = path.resolve(__dirname, '..', 'runtime', 'evidence', 'video-gen-result.json');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

async function call(method, url, body) {
  const req = HS.buildSignedRequest({ url, method, body, raw: RAW, time: Date.now() });
  try {
    const r = await fetch(BASE + req.url, { method, headers: req.headers, body: method === 'GET' ? undefined : req.bodyString, signal: AbortSignal.timeout(30000) });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    return { status: r.status, j, txt };
  } catch (e) { return { status: 0, j: null, txt: e.message }; }
}
const credits = async () => { const r = await call('GET', '/v1/api/billing/credit', null); return r.j && r.j.data ? r.j.data.total_credit : null; };

(async () => {
  if (!RAW) { console.log('用法: node scripts/hailuo-video-gen.js --token "<token|uuid|device>" [--model 23021]'); process.exit(1); }
  console.log('base=' + BASE + ' model=' + MODEL + ' dur=' + DUR + ' res=' + RES);
  const before = await credits();
  console.log('扣费前额度 = ' + before);
  const body = { quantity: 1, parameter: { modelID: MODEL, desc: PROMPT, fileList: [], useOriginPrompt: true, resolution: String(RES), duration: DUR }, projectID: '0' };
  console.log('POST /v2/api/multimodal/generate/video body=' + JSON.stringify(body));
  const g = await call('POST', '/v2/api/multimodal/generate/video', body);
  console.log('HTTP ' + g.status + ' code=' + (g.j && g.j.statusInfo ? g.j.statusInfo.code : 'n/a') + ' msg=' + (g.j && g.j.statusInfo ? g.j.statusInfo.message : g.txt.slice(0, 200)));
  const taskId = g.j && g.j.data ? (g.j.data.id || g.j.data.taskID || g.j.data.taskId) : null;
  console.log('task_id = ' + taskId + '  |  data = ' + JSON.stringify(g.j && g.j.data).slice(0, 300));
  if (!taskId) { fs.writeFileSync(OUT, JSON.stringify(g, null, 1), 'utf8'); console.log('已保存原始响应 -> ' + OUT); return; }
  let found = null;
  for (let i = 1; i <= 40; i++) {
    await new Promise((x) => setTimeout(x, 8000));
    const q = await call('POST', '/api/feed/creation/search/my', { cursor: '', limit: 10 });
    const feeds = (q.j && q.j.data && q.j.data.feeds) || [];
    const hit = feeds.find((f) => String((f.commonInfo || {}).id) === String(taskId));
    if (hit) {
      const st = (hit.commonInfo || {}).status;
      console.log('[' + i + '] status=' + st + '  ' + JSON.stringify(hit).slice(0, 220));
      if (Number(st) === 2 || Number(st) === 6 || Number(st) === 3) { found = hit; break; }
    } else { console.log('[' + i + '] 还没出现在 feed 里'); }
  }
  const after = await credits();
  console.log('扣费后额度 = ' + after + '  (花费 ' + (before != null && after != null ? before - after : '?') + ')');
  fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, taskId, feed: found, creditsBefore: before, creditsAfter: after, generatedAt: new Date().toISOString() }, null, 1), 'utf8');
  if (found) {
    const s = JSON.stringify(found);
    const urls = [...new Set((s.match(/https:\/\/[^"]+?\.(mp4|mov|webm)/g) || []))];
    console.log('视频直链: ' + (urls.join('  ') || '(未在 feed 里找到 mp4，见 ' + OUT + ')'));
  }
})();


