/**
 * probe-hailuo.js -- 海螺乙路探针：拿一个真号，把字段名和额度一次问清楚
 *   node scripts/probe-hailuo.js --token "<_token>|<uuid>|<device_id>"
 *   node scripts/probe-hailuo.js --token "..." --gen     # 额外试一次生图（会花额度，默认不跑）
 * 输出：每个接口的 HTTP 码 + statusInfo + data 的字段路径清单
 *   -> 把 data.<字段> 抄进 config/pool-adapter.hailuo-web.json 的 map 即可。
 */
'use strict';
const HS = require('./hailuo-sign.js');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const RAW = arg('token', '');
const DO_GEN = args.includes('--gen');
const BASE = arg('base', 'https://hailuoai.com');

function paths(o, pre) {
  const out = [];
  if (o === null || typeof o !== 'object') return [pre + ' = ' + JSON.stringify(o)];
  for (const k of Object.keys(o)) {
    const v = o[k], p = pre ? pre + '.' + k : k;
    if (v !== null && typeof v === 'object') out.push.apply(out, paths(v, p));
    else out.push(p + ' = ' + JSON.stringify(v));
  }
  return out;
}

async function call(method, url, body, label) {
  const req = HS.buildSignedRequest({ url: url, method: method, body: body, raw: RAW, time: Date.now() });
  let r, txt = '', j = null;
  try {
    r = await fetch(BASE + req.url, { method: method, headers: req.headers, body: method === 'GET' ? undefined : req.bodyString, signal: AbortSignal.timeout(20000) });
    txt = await r.text();
    try { j = JSON.parse(txt); } catch (e) { j = null; }
  } catch (e) { console.log('\n### ' + label + ' -> 网络错误 ' + e.message); return null; }
  const cls = HS.classifyResponse(r.status, j);
  console.log('\n### ' + label + '  ' + method + ' ' + url);
  console.log('    HTTP ' + r.status + ' | statusInfo.code=' + (j && j.statusInfo ? j.statusInfo.code : 'n/a') + ' | 判定=' + (cls.ok ? 'OK' : cls.kind));
  if (j && j.statusInfo && j.statusInfo.message) console.log('    message: ' + j.statusInfo.message);
  if (j) console.log('    字段路径：\n      ' + paths(j, '').slice(0, 40).join('\n      '));
  else console.log('    原始响应(前 300)：' + txt.slice(0, 300));
  return j;
}

(async () => {
  if (!RAW) { console.log('用法: node scripts/probe-hailuo.js --token "<_token>|<uuid>|<device_id>" [--gen]'); process.exit(1); }
  const t = HS.parseToken(RAW);
  console.log('token 长度=' + t.token.length + '  uuid=' + (t.uuid || '(未给，将按 token 派生)') + '  device_id=' + (t.device_id || '(未给)'));
  await call('GET', '/v1/api/user/info', null, '① 账号信息');
  await call('GET', '/v1/api/billing/credit', null, '② 额度（wallet 候选）');
  await call('GET', '/v1/api/user/equity', null, '③ 权益/免费额度（checkin 候选）');
  await call('GET', '/v1/api/user/subscription', null, '④ 订阅/会员');
  if (DO_GEN) await call('POST', '/v2/api/multimodal/generate/image', { prompt: '一只猫', model: 'image-01', n: 1 }, '⑤ 生图（会花额度）');
  else console.log('\n（跳过生图；加 --gen 才试）');
  console.log('\n完成：把上面 data.* 的字段名抄进 config/pool-adapter.hailuo-web.json 的 map。');
})();