/**
 * mock-hailuo.js -- 模拟海螺网页端上游（9964），并【独立复算】校验签名
 *   node scripts/mock-hailuo.js
 * 关键：签名校验不引用 hailuo-sign.js，而是用 node:crypto 按前端公式就地重算：
 *     yy == md5( encodeURIComponent(实际收到的 req.url) + '_' + bodyStr + md5(unix) + 'ooui' )
 *     （GET/HEAD 的 bodyStr 固定 '{}'；POST 用原始请求体字符串）
 * => 校验通过即证明「我们发出的 URL + body + token/yy」与浏览器完全一致。
 * 管理口：POST /internal/admin/mode {credit, biz_code}
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

const PORT = Number(process.env.HAILUO_MOCK_PORT || 9964);
let credit = 1234;
let bizCode = 0;
let badSigns = 0, goodSigns = 0, lastUrl = '';

const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(b); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });

http.createServer(async (req, res) => {
  const rawBody = await readBody(req);
  const url = req.url;
  const path = url.split('?')[0];

  if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true, bad_signs: badSigns, good_signs: goodSigns });
  if (req.method === 'GET' && path === '/internal/admin/stats') return send(res, 200, { good_signs: goodSigns, bad_signs: badSigns, last_url: lastUrl, credit: credit, biz_code: bizCode });
  if (req.method === 'POST' && path === '/internal/admin/mode') {
    let b = {}; try { b = JSON.parse(rawBody); } catch (e) {}
    if (b.credit !== undefined) credit = Number(b.credit);
    if (b.biz_code !== undefined) bizCode = Number(b.biz_code);
    return send(res, 200, { ok: true, credit: credit, biz_code: bizCode });
  }

  /* --- 独立复算签名 --- */
  const token = String(req.headers.token || '');
  const yy = String(req.headers.yy || '');
  const q = new URLSearchParams(url.split('?')[1] || '');
  const unix = q.get('unix') || '';
  const need = ['device_platform', 'app_id', 'version_code', 'biz_id', 'unix', 'lang', 'uuid'];
  const missing = need.filter((k) => !q.get(k));
  const bodyStr = (req.method === 'POST' || req.method === 'DELETE') ? (rawBody || '{}') : '{}';
  const expect = md5(encodeURIComponent(url) + '_' + bodyStr + md5(unix) + 'ooui');
  const signOk = yy === expect;
  if (signOk) goodSigns++; else badSigns++;
  lastUrl = url;

  if (!token) return send(res, 200, { statusInfo: { code: 1000048, httpCode: 401, message: 'login required', serviceTime: Math.floor(Date.now() / 1000), requestID: 'mock-1', debugInfo: '', serverAlert: 0 } });
  if (!signOk || missing.length) {
    return send(res, 200, { statusInfo: { code: 1, httpCode: 400, message: 'bad sign' + (missing.length ? (' missing:' + missing.join(',')) : ''), debugInfo: 'expect=' + expect + ' got=' + yy, serviceTime: Math.floor(Date.now() / 1000), requestID: 'mock-2', serverAlert: 0 } });
  }
  if (bizCode) return send(res, 200, { statusInfo: { code: bizCode, httpCode: 0, message: '贝壳不足', serviceTime: Math.floor(Date.now() / 1000), requestID: 'mock-3', debugInfo: '', serverAlert: 0 } });

  /* R81: 按真上游形状返回 —— /v1/api/billing/credit 的真实结构是 {total_credit, sub_credits:[{credit_type, credit, record}]}
     （逆向自 cdn.hailuoai.com 前端包 js/3726-*.js 原文 `let{total_credit:e,sub_credits:a=[]}=await (0,r.c6)()`），
     旧的 {credit} 是臆造字段，会让 map 里的 data.total_credit 取不到值。equity 保持独立形状。 */
  const creditData = { total_credit: credit, sub_credits: credit > 0 ? [{ credit_type: 3, credit: credit, record: [] }] : [] };
  const equityData = { credit: credit };
  if (path === '/v1/api/billing/credit') return send(res, 200, { statusInfo: { code: 0, httpCode: 0, message: 'success', serviceTime: Math.floor(Date.now() / 1000), requestID: 'mock-4', debugInfo: '', serverAlert: 0 }, data: creditData });
  if (path === '/v1/api/user/equity') return send(res, 200, { statusInfo: { code: 0, httpCode: 0, message: 'success', serviceTime: Math.floor(Date.now() / 1000), requestID: 'mock-5', debugInfo: '', serverAlert: 0 }, data: equityData });
  if (path === '/v2/api/multimodal/generate/image') return send(res, 200, { statusInfo: { code: 0, httpCode: 0, message: 'success', serviceTime: Math.floor(Date.now() / 1000), requestID: 'mock-6', debugInfo: '', serverAlert: 0 }, data: { taskID: 'mock-task-1', fileURL: 'https://filecdn.minimax.chat/mock/1.png' } });
  return send(res, 404, { statusInfo: { code: 404, message: 'no such path' } });
}).listen(PORT, '127.0.0.1', () => console.log('[mock-hailuo] listening on 127.0.0.1:' + PORT));