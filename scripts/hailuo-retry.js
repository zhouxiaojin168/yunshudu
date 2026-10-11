/** hailuo-retry.js -- 同一请求重试 N 次（看是否边缘节点canary导致 200/404 抖动） */
'use strict';
const HS = require('./hailuo-sign.js');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const RAW = arg('token', '');
const BASE = arg('base', 'https://hailuoai.video');
const URLX = arg('url', '/api/feed/creation/my/processing');
const METHOD = arg('method', 'POST');
const BODY = arg('body', '{}');
const N = Number(arg('n', '6'));
async function call() {
  let body = null;
  if (METHOD === 'POST') { try { body = JSON.parse(BODY); } catch (e) { body = {}; } }
  const req = HS.buildSignedRequest({ url: URLX, method: METHOD, body: body, raw: RAW, time: Date.now() });
  const init = { method: METHOD, headers: req.headers };
  if (METHOD !== 'GET') init.body = req.bodyString;
  let r, txt = '';
  try { r = await fetch(BASE + req.url, Object.assign(init, { signal: AbortSignal.timeout(20000) })); txt = await r.text(); }
  catch (e) { return 'ERR ' + e.message; }
  return 'HTTP ' + r.status + ' :: ' + txt.slice(0, 300);
}
(async () => {
  if (!RAW) { console.log('用法: --token <...> [--base ...] [--url ...] [--method POST] [--body {}] [--n 6]'); process.exit(1); }
  for (let i = 0; i < N; i++) { console.log('[' + (i + 1) + '] ' + await call()); await new Promise((r) => setTimeout(r, 1500)); }
})();
