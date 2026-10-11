/** hailuo-dump.js -- 把一次签名请求的完整响应写到文件（便于逐字段分析） */
'use strict';
const HS = require('./hailuo-sign.js');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const RAW = arg('token', '');
const BASE = arg('base', 'https://hailuoai.video');
const URLX = arg('url', '/api/feed/creation/search/my');
const METHOD = arg('method', 'POST');
const BODY = arg('body', '{"cursor":"","limit":20}');
const OUT = arg('out', 'out.json');
const MAXTRY = Number(arg('retry', '5'));
async function call() {
  let body = null;
  if (METHOD === 'POST') { try { body = JSON.parse(BODY); } catch (e) { body = {}; } }
  const req = HS.buildSignedRequest({ url: URLX, method: METHOD, body: body, raw: RAW, time: Date.now() });
  const init = { method: METHOD, headers: req.headers };
  if (METHOD !== 'GET') init.body = req.bodyString;
  try { const r = await fetch(BASE + req.url, Object.assign(init, { signal: AbortSignal.timeout(20000) })); const txt = await r.text(); return { status: r.status, txt: txt }; }
  catch (e) { return { status: 0, txt: e.message }; }
}
(async () => {
  for (let i = 0; i < MAXTRY; i++) {
    const r = await call();
    if (r.status === 200 && r.txt.indexOf('404 page not found') < 0) { require('node:fs').writeFileSync(OUT, r.txt, 'utf8'); console.log('saved ' + OUT + ' (' + r.txt.length + ' bytes)'); return; }
    console.log('[' + (i + 1) + '] HTTP ' + r.status + ' retry...');
    await new Promise((x) => setTimeout(x, 1500));
  }
  console.log('全部失败');
})();
