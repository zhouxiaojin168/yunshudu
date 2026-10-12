/** hailuo-project-probe.js -- 试 project/create 再出视频（只读+最多一次成功计费） */
'use strict';
const HS = require('./hailuo-sign.js');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const RAW = arg('token', ''), BASE = arg('base', 'https://hailuoai.video');
async function call(method, url, body) {
  const req = HS.buildSignedRequest({ url, method, body, raw: RAW, time: Date.now() });
  try { const r = await fetch(BASE + req.url, { method, headers: req.headers, body: method === 'GET' ? undefined : req.bodyString, signal: AbortSignal.timeout(30000) });
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) {}
    return { status: r.status, j, txt };
  } catch (e) { return { status: 0, j: null, txt: e.message }; }
}
(async () => {
  const p = await call('POST', '/api/feed/creation/project/create', { name: 'test' });
  console.log('project/create -> HTTP ' + p.status + ' ' + p.txt.slice(0, 300));
  const pid = p.j && p.j.data ? (p.j.data.id || p.j.data.projectID || p.j.data.projectId) : null;
  console.log('projectID = ' + pid);
  const tries = [
    { name: 'pid+23021', body: { quantity: 1, parameter: { modelID: '23021', desc: 'a cat walking on a wooden table', fileList: [], useOriginPrompt: true, resolution: '1', duration: 1 }, projectID: String(pid == null ? '0' : pid) } },
    { name: 'pid+t2v+ar16:9', body: { quantity: 1, parameter: { modelID: 'hailuo3.0-t2v', desc: 'a cat walking on a wooden table', fileList: [], useOriginPrompt: true, resolution: '720P', duration: 1, aspectRatio: '16:9' }, projectID: String(pid == null ? '0' : pid) } },
    { name: 'videoExtra空对象', body: { quantity: 1, parameter: { modelID: '23021', desc: 'a cat walking on a wooden table', fileList: [], useOriginPrompt: true, resolution: '720P', duration: 1 }, videoExtra: {}, projectID: String(pid == null ? '0' : pid) } }
  ];
  for (const t of tries) {
    const r = await call('POST', '/v2/api/multimodal/generate/video', t.body);
    const st = r.j && r.j.statusInfo, id = r.j && r.j.data && r.j.data.id;
    console.log('[' + t.name + '] HTTP ' + r.status + ' code=' + (st ? st.code : 'n/a') + ' msg=' + (st ? st.message : r.txt.slice(0, 160)) + (id ? '  ==> TASK ' + id : ''));
    if (id) { console.log('命中 body=' + JSON.stringify(t.body)); return; }
    await new Promise((x) => setTimeout(x, 1000));
  }
})();
