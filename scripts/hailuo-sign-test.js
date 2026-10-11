/**  hailuo-sign-test.js -- 海螺签名器单测（独立复算，不信实现自己）
 *   node scripts/hailuo-sign-test.js
 */
'use strict';
const crypto = require('crypto');
const S = require('./hailuo-sign.js');
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, e) => { if (c) { pass++; console.log('  PASS  ' + n + (e ? '   [' + e + ']' : '')); } else { fail++; fails.push(n); console.log('  FAIL  ' + n + (e ? '   [' + e + ']' : '')); } };
const md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

console.log('== A token 解析 ==');
let t = S.parseToken('tk-abc');
ok('A1 单段 token', t.token === 'tk-abc' && t.uuid === '' && t.device_id === '', JSON.stringify(t));
t = S.parseToken('tk-abc|uuid-1|dev-1');
ok('A2 三段 token', t.token === 'tk-abc' && t.uuid === 'uuid-1' && t.device_id === 'dev-1', JSON.stringify(t));
ok('A3 派生 uuid 稳定', S.deriveUuid('x') === S.deriveUuid('x') && S.deriveUuid('x') !== S.deriveUuid('y'), S.deriveUuid('x'));
const u = S.deriveUuid('x');
ok('A4 派生 uuid 形如 uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u), u);

console.log('== B 公共参数 ==');
const pp = S.publicParams({ unix: 1700000000000, token: 'tk', uuid: 'U1', device_id: 'D1' });
ok('B1 device_platform=web', pp.device_platform === 'web', pp.device_platform);
ok('B2 app_id=3001', pp.app_id === '3001', pp.app_id);
ok('B3 version_code=22203', pp.version_code === '22203', pp.version_code);
ok('B4 biz_id=0', pp.biz_id === '0', pp.biz_id);
ok('B5 unix=毫秒字符串', pp.unix === '1700000000000', pp.unix);
ok('B6 lang=zh-Hans', pp.lang === 'zh-Hans', pp.lang);
ok('B7 uuid/device_id 带上', pp.uuid === 'U1' && pp.device_id === 'D1', pp.uuid + '/' + pp.device_id);
ok('B8 无 device_id 时不出现该键', !('device_id' in S.publicParams({ unix: 1, token: 't' })), 'ok');

console.log('== C 参与签名的 path ==');
let p = S.hasSearchParamsPath('/v1/api/billing/credit', { a: '1', b: '2' });
ok('C1 无 query -> 加 ?', p === '/v1/api/billing/credit?a=1&b=2', p);
p = S.hasSearchParamsPath('/x?y=1', { a: '2' });
ok('C2 已有 query -> 用 &', p === '/x?y=1&a=2', p);
p = S.hasSearchParamsPath('/x?client_scene=h5&y=1', { a: '2' });
ok('C3 client_scene 被剔除', p === '/x?y=1&a=2', p);
p = S.hasSearchParamsPath('/x', { a: null, b: '2' });
ok('C4 null 参数跳过', p === '/x?b=2', p);

console.log('== D 签名公式（独立复算） ==');
const time = 1700000000000;
const path = '/v1/api/billing/credit?a=1';
let r = S.computeSign({ time: time, method: 'GET', body: undefined, hasSearchParamsPath: path });
let expect = md5(encodeURIComponent(path) + '_' + '{}' + md5(String(time)) + 'ooui');
ok('D1 GET: body 记作 {}', r.yy === expect, r.yy.slice(0, 16) + ' vs ' + expect.slice(0, 16));
ok('D2 GET 发出体也是 {}', r.bodyString === '{}', r.bodyString);

const body = { prompt: '猫', model: 'image-01' };
r = S.computeSign({ time: time, method: 'POST', body: body, hasSearchParamsPath: path });
const bodyStr = JSON.stringify(body);
expect = md5(encodeURIComponent(path) + '_' + bodyStr + md5(String(time)) + 'ooui');
ok('D3 POST: body 进签名', r.yy === expect, r.yy.slice(0, 16));
ok('D4 POST 发出体=JSON 串', r.bodyString === bodyStr, r.bodyString);

r = S.computeSign({ time: time, method: 'POST', body: body, hasSearchParamsPath: path, bodyToYY: 'RAW-Y' });
expect = md5(encodeURIComponent(path) + '_RAW-Y' + md5(String(time)) + 'ooui');
ok('D5 bodyToYY 覆盖签名体（上传场景）', r.yy === expect, r.yy.slice(0, 16));

console.log('== E 整包组装 ==');
const req = S.buildSignedRequest({ url: '/v1/api/billing/credit', method: 'GET', token: 'tk-x|U9|D9', time: time });
ok('E1 header token 正确', req.headers.token === 'tk-x', req.headers.token);
ok('E2 header yy = 复算值', req.yy === md5(encodeURIComponent(req.url) + '_' + '{}' + md5(String(time)) + 'ooui'), req.yy.slice(0, 16));
ok('E3 url 带全公共参数', /app_id=3001/.test(req.url) && /version_code=22203/.test(req.url) && /uuid=U9/.test(req.url) && /device_id=D9/.test(req.url), req.url.slice(0, 120) + '...');
ok('E4 unix 进 query', req.url.includes('unix=' + time), 'ok');

console.log('== F 响应信封判定 ==');
ok('F1 code=0 -> ok', S.classifyResponse(200, { statusInfo: { code: 0 }, data: {} }).ok === true);
let c = S.classifyResponse(200, { statusInfo: { code: 1000048, message: 'login' } });
ok('F2 1000048 -> AUTH_EXPIRED 换号', c.kind === 'AUTH_EXPIRED' && c.switchAccount === true, JSON.stringify(c));
c = S.classifyResponse(200, { statusInfo: { code: 22 } });
ok('F3 22 -> ACCOUNT_BANNED 下线', c.kind === 'ACCOUNT_BANNED' && c.disableAccount === true, JSON.stringify(c));
c = S.classifyResponse(200, { statusInfo: { code: 2400026, message: '贝壳不足' } });
ok('F4 2400026 -> NO_CREDITS(等价402) 换号', c.kind === 'NO_CREDITS' && c.switchAccount === true, JSON.stringify(c));
c = S.classifyResponse(200, { statusInfo: { code: 2400040 } });
ok('F5 2400040 -> NO_CREDITS', c.kind === 'NO_CREDITS', c.kind);
c = S.classifyResponse(502, null);
ok('F6 502 -> 可重试', c.retryable === true, JSON.stringify(c));

console.log('');
console.log('===== 结果：' + pass + ' PASS / ' + fail + ' FAIL =====');
if (fails.length) console.log('失败项：' + fails.join(' | '));
process.exit(fail ? 1 : 0);