#!/usr/bin/env node
/* eslint-disable */
/*
 * imap-mail-bridge-selftest.js - 本地自测（不需要任何真实邮箱）
 *
 * 做法：起一个「假 IMAP 服务器」(明文 TCP, 默认 18143)，喂两封带验证码的邮件；
 *       把 imap-mail-bridge 指向它，然后按 mailfarm 同款契约打 HTTP 断言。
 * 用法：node scripts/imap-mail-bridge-selftest.js
 */

'use strict';

var net = require('net');
var http = require('http');

var IMAP_PORT = Number(process.env.IMAP_MOCK_PORT || 18143);
var HTTP_PORT = Number(process.env.IMAP_BRIDGE_PORT || 18098);
var API_KEY = 'test-key-123';

var CRLF = String.fromCharCode(13) + String.fromCharCode(10);
var NL = String.fromCharCode(10);

var alias1 = 'hlalpha@example.com';
var alias2 = 'hlbeta@example.com';

var code1 = '483920';
var code2 = '7788';

function msgA() {
  var body = Buffer.from('您的验证码是 ' + code1 + '，5 分钟内有效。', 'utf8').toString('base64');
  return [
    'From: Hailuo AI <no-reply@hailuoai.com>',
    'To: <' + alias1 + '>',
    'Subject: =?UTF-8?B?' + Buffer.from('登录验证码', 'utf8').toString('base64') + '?=',
    'Date: Wed, 08 Oct 2026 10:00:00 +0800',
    'Message-ID: <m1@example.com>',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    body
  ].join(CRLF);
}

function msgB() {
  return [
    'From: "MiniMax" <no-reply@minimax.io>',
    'Delivered-To: ' + alias2,
    'Subject: Verify your email',
    'Date: Wed, 08 Oct 2026 10:01:00 +0800',
    'Message-ID: <m2@example.com>',
    'Content-Type: multipart/alternative; boundary="BND"',
    '',
    '--BND',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Your verification code is ' + code2 + '=2E It expires in 10 minutes.',
    '--BND--',
    ''
  ].join(CRLF);
}

var MAILBOX = { 1: msgA(), 2: msgB() };

/* --------------------------- 假 IMAP 服务器 --------------------------- */
function startMockImap(done) {
  var srv = net.createServer(function (sock) {
    var buf = '';
    sock.write('* OK [CAPABILITY IMAP4rev1] mock imap ready' + CRLF);
    sock.on('data', function (c) {
      buf += c.toString('utf8');
      for (;;) {
        var i = buf.indexOf(NL);
        if (i < 0) break;
        var line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line) continue;
        var sp = line.indexOf(' ');
        var tag = sp < 0 ? line : line.slice(0, sp);
        var rest = sp < 0 ? '' : line.slice(sp + 1);
        var up = rest.toUpperCase();
        if (/^CAPABILITY/.test(up)) {
          sock.write('* CAPABILITY IMAP4rev1' + CRLF + tag + ' OK done' + CRLF);
        } else if (/^LOGIN/.test(up)) {
          sock.write(tag + ' OK LOGIN completed' + CRLF);
        } else if (/^SELECT/.test(up)) {
          sock.write('* 2 EXISTS' + CRLF + '* OK [UIDVALIDITY 1] ok' + CRLF + tag + ' OK [READ-WRITE] SELECT completed' + CRLF);
        } else if (/^UID SEARCH/.test(up)) {
          var uids = Object.keys(MAILBOX).join(' ');
          sock.write('* SEARCH ' + uids + CRLF + tag + ' OK SEARCH completed' + CRLF);
        } else if (/^UID FETCH/.test(up)) {
          var mm = rest.match(/UID FETCH (\d+)/i);
          var uid = mm ? mm[1] : '';
          var raw = MAILBOX[uid];
          if (!raw) {
            sock.write(tag + ' OK FETCH completed' + CRLF);
          } else {
            var b = Buffer.from(raw, 'utf8');
            sock.write('* 1 FETCH (UID ' + uid + ' BODY[] {' + b.length + '}' + CRLF);
            sock.write(b);
            sock.write(')' + CRLF + tag + ' OK FETCH completed' + CRLF);
          }
        } else if (/^LOGOUT/.test(up)) {
          sock.write('* BYE mock logging out' + CRLF + tag + ' OK LOGOUT completed' + CRLF);
          sock.end();
        } else {
          sock.write(tag + ' OK done' + CRLF);
        }
      }
    });
    sock.on('error', function () {});
  });
  srv.listen(IMAP_PORT, '127.0.0.1', function () { done(null, srv); });
  srv.on('error', done);
}

/* --------------------------- 断言工具 --------------------------- */
var PASS = 0, FAIL = 0;
function ok(name, cond, extra) {
  if (cond) { PASS++; console.log('  PASS  ' + name); }
  else { FAIL++; console.log('  FAIL  ' + name + (extra ? '  <= ' + extra : '')); }
}
function get(path, key) {
  var headers = {};
  if (key) headers['x-api-key'] = key;
  return fetch('http://127.0.0.1:' + HTTP_PORT + path, { headers: headers }).then(function (r) {
    return r.text().then(function (t) { var j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, json: j, text: t }; });
  });
}
function post(path, body, key) {
  var headers = { 'content-type': 'application/json' };
  if (key) headers['x-api-key'] = key;
  return fetch('http://127.0.0.1:' + HTTP_PORT + path, { method: 'POST', headers: headers, body: JSON.stringify(body || {}) })
    .then(function (r) { return r.text().then(function (t) { var j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, json: j, text: t }; }); });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* --------------------------- 主流程 --------------------------- */
async function main() {
  process.env.IMB_HOST = '127.0.0.1';
  process.env.IMB_PORT = String(IMAP_PORT);
  process.env.IMB_TLS = '0';
  process.env.IMB_USER = 'yipian@example.com';
  process.env.IMB_PASS = 'mock-pass';
  process.env.IMB_DOMAIN = 'example.com';
  process.env.IMB_HTTP_PORT = String(HTTP_PORT);
  process.env.IMB_HTTP_HOST = '127.0.0.1';
  process.env.IMB_API_KEY = API_KEY;
  process.env.IMB_POLL_MS = '150';
  process.env.IMB_MAX_SCAN = '10';

  var mock = null;
  await new Promise(function (res, rej) { startMockImap(function (e, s) { if (e) rej(e); else { mock = s; res(); } }); });
  console.log('mock IMAP on 127.0.0.1:' + IMAP_PORT);

  var bridge = require('./imap-mail-bridge.js');
  bridge.startServer();
  await sleep(300);
  console.log('bridge HTTP on 127.0.0.1:' + HTTP_PORT);

  console.log(NL + '--- 1) 健康检查 & 鉴权 ---');
  var h = await get('/healthz');
  ok('healthz 200', h.status === 200, h.text);
  ok('healthz.mode=imap-bridge', h.json && h.json.mode === 'imap-bridge');
  ok('healthz.mailbox 正确', h.json && h.json.mailbox === 'yipian@example.com');
  ok('healthz.domain 正确', h.json && h.json.domain === 'example.com');
  var h2 = await get('/v1/stats', 'wrong');
  ok('错误 x-api-key -> 401', h2.status === 401, h2.status + ' ' + h2.text);
  var h3 = await get('/v1/stats', API_KEY);
  ok('正确 x-api-key -> 200', h3.status === 200, h3.status + ' ' + h3.text);
  var h4 = await get('/v1/stats');
  ok('缺 x-api-key -> 401', h4.status === 401, h4.status);

  console.log(NL + '--- 2) acquire（契约与 mailfarm 一致）---');
  var ac = await post('/v1/mailboxes/acquire', { prefix: 'hl' }, API_KEY);
  ok('acquire 200', ac.status === 200, ac.text);
  ok('acquire.address 带 example.com', ac.json && /@example\.com$/.test(String(ac.json.address)), JSON.stringify(ac.json));
  ok('acquire.domain=example.com', ac.json && ac.json.domain === 'example.com');

  console.log(NL + '--- 3) 取码：单段 base64 正文 ---');
  var c1 = await get('/v1/mailboxes/' + encodeURIComponent(alias1) + '/code?timeout=8', API_KEY);
  ok('alias1 取码 200', c1.status === 200, c1.text);
  ok('alias1 code=' + code1, c1.json && c1.json.code === code1, JSON.stringify(c1.json));
  ok('alias1 found=true', c1.json && c1.json.found === true);
  ok('alias1 subject 已解 MIME 编码', c1.json && c1.json.subject === '登录验证码', c1.json && c1.json.subject);

  console.log(NL + '--- 4) 取码：multipart + quoted-printable ---');
  var c2 = await get('/v1/mailboxes/' + encodeURIComponent(alias2) + '/code?timeout=8', API_KEY);
  ok('alias2 code=' + code2, c2.json && c2.json.code === code2, JSON.stringify(c2.json));

  console.log(NL + '--- 5) 不存在的收件人 -> found=false（不误命中）---');
  var c3 = await get('/v1/mailboxes/' + encodeURIComponent('nobody@example.com') + '/code?timeout=1', API_KEY);
  ok('未命中 found=false', c3.json && c3.json.found === false, JSON.stringify(c3.json));

  console.log(NL + '--- 6) messages 列表 ---');
  var ms = await get('/v1/mailboxes/' + encodeURIComponent(alias1) + '/messages?limit=5', API_KEY);
  ok('messages 200', ms.status === 200, ms.text);
  ok('messages.count>=1', ms.json && ms.json.count >= 1, JSON.stringify(ms.json));
  ok('messages[0].codes 含 ' + code1, ms.json && ms.json.messages && ms.json.messages[0] && ms.json.messages[0].codes.indexOf(code1) >= 0, JSON.stringify(ms.json && ms.json.messages));

  console.log(NL + '--- 7) 单元：IMAP 日期格式 ---');
  var dt = bridge.imapDate(24);
  ok('imapDate 形如 07-Oct-2026', /^\d{2}-[A-Z][a-z]{2}-\d{4}$/.test(dt), dt);

  console.log(NL + '--- 8) 单元：验证码提取边界 ---');
  ok('关键词+数字', bridge.extractCodes('x', '验证码：998877', 5)[0] === '998877');
  ok('英文 keyword', bridge.extractCodes('Your verification code: 1234', '', 5)[0] === '1234');
  ok('小写单词不当码', bridge.extractCodes('x', 'hello world', 5).length === 0, JSON.stringify(bridge.extractCodes('x', 'hello world', 5)));
  ok('大写字母码可识别(与 mailfarm 一致)', bridge.extractCodes('x', 'ABCDEF', 5)[0] === 'ABCDEF');
  ok('优先取关键词后的码', bridge.extractCodes('', '尊敬的用户，您的验证码为 556677，请勿泄露', 5)[0] === '556677');

  console.log(NL + '=== PASS=' + PASS + '  FAIL=' + FAIL + ' ===');
  try { mock.close(); } catch (e) {}
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.log('FATAL ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
