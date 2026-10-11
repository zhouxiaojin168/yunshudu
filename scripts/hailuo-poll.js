/** hailuo-poll.js -- 通用签名请求器（GET/POST 任意路径，用来抓结果字段名） */
'use strict';
const HS = require('./hailuo-sign.js');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const MUL = args.filter((a) => a === '--call').length;
const RAW = arg('token', '');
const BASE = arg('base', 'https://hailuoai.video');
const calls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--call') {
    const spec = args[i + 1];
    if (spec) {
      const m = spec.slice(0, spec.indexOf(' ')).toUpperCase();
      const rest = spec.slice(spec.indexOf(' ') + 1).trim();
      const sp = rest.indexOf(' ');
      calls.push({ m: m, u: sp >= 0 ? rest.slice(0, sp) : rest, b: sp >= 0 ? rest.slice(sp + 1).trim() : '' });
    }
    i++;
  }
}
async function call(c) {
  let body = null;
  if (c.m === 'POST') { try { body = c.b ? JSON.parse(c.b) : {}; } catch (e) { body = {}; } }
  const req = HS.buildSignedRequest({ url: c.u, method: c.m, body: body, raw: RAW, time: Date.now() });
  const init = { method: c.m, headers: req.headers };
  if (c.m !== 'GET') init.body = req.bodyString;
  let r, txt = '';
  try { r = await fetch(BASE + req.url, Object.assign(init, { signal: AbortSignal.timeout(30000) })); txt = await r.text(); }
  catch (e) { console.log('### ' + c.m + ' ' + c.u + ' 网络错误 ' + e.message); return; }
  console.log('### ' + c.m + ' ' + c.u + '  HTTP ' + r.status);
  console.log('    ' + txt.slice(0, 2000));
}
(async () => {
  if (!RAW || !calls.length) { console.log('用法: node scripts/hailuo-poll.js --token "<...>" --call "GET /v1/api/billing/credit" --call "POST /api/feed/creation/my/processing {}"'); process.exit(1); }
  for (const c of calls) { await call(c); await new Promise((r) => setTimeout(r, 800)); }
})();
