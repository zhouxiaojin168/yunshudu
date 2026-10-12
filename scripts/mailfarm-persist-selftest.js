#!/usr/bin/env node
/* eslint-disable */
/*
 * mailfarm-persist-selftest.js - 持久化(重启不丢)自测
 *
 * 目的：证明「服务重启后，已发出的邮箱 + 已收到的验证码都还在」。
 * 做法：起服务(MF_STORE=file) -> 取邮箱 -> 投一封带码的邮件 -> 取码
 *       -> **杀掉进程(SIGKILL)** -> 用同一个 state 文件重启 -> 再取码，必须还在。
 * 用法：node scripts/mailfarm-persist-selftest.js
 */

'use strict';

var http = require('http');
var path = require('path');
var fs = require('fs');
var cp = require('child_process');

var HTTP_PORT = Number(process.env.PERSIST_HTTP_PORT || 18109);
var API_KEY = 'persist-key-123';
var INGEST_KEY = 'persist-ingest-123';
var STATE_DIR = path.join(__dirname, '..', 'state', '_selftest');
var STATE_FILE = path.join(STATE_DIR, 'mailfarm.jsonl');

var ok = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { ok++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  <= ' + JSON.stringify(extra))); }
}
function req(method, p, body, headers) {
  return new Promise(function (res) {
    var data = body === undefined || body === null ? null : JSON.stringify(body);
    var h = Object.assign({}, headers || {});
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    var r = http.request({ host: '127.0.0.1', port: HTTP_PORT, path: p, method: method, headers: h, timeout: 20000 }, function (rr) {
      var bufs = [];
      rr.on('data', function (d) { bufs.push(d); });
      rr.on('end', function () {
        var t = Buffer.concat(bufs).toString('utf8');
        var j = null; try { j = JSON.parse(t); } catch (e) {}
        res({ status: rr.statusCode, json: j, text: t });
      });
    });
    r.on('timeout', function () { r.destroy(); res({ status: 'TIMEOUT' }); });
    r.on('error', function (e) { res({ status: 'ERR:' + e.code }); });
    if (data) r.write(data);
    r.end();
  });
}
function sleep(ms) { return new Promise(function (z) { setTimeout(z, ms); }); }

function startServer() {
  var env = Object.assign({}, process.env, {
    MF_SERVICE_NAME: 'mailfarm',
    MF_DOMAINS: 'allen23.online,ytu.baby',
    MF_HTTP_HOST: '127.0.0.1',
    MF_HTTP_PORT: String(HTTP_PORT),
    MF_SMTP_ENABLE: '0',
    MF_API_KEY: API_KEY,
    MF_INGEST_KEY: INGEST_KEY,
    MF_STORE: 'file',
    MF_STATE_FILE: STATE_FILE,
    MF_SNAPSHOT_EVERY: '3',
    NODE_SKIP_PLATFORM_CHECK: '1'
  });
  var c = cp.spawn(process.execPath, [path.join(__dirname, 'mailfarm-server.js')], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  var log = '';
  c.stdout.on('data', function (d) { log += String(d); });
  c.stderr.on('data', function (d) { log += String(d); });
  c.getLog = function () { return log; };
  return c;
}
function waitHealth(n) {
  return req('GET', '/healthz').then(function (r) {
    if (r.status === 200) return r;
    if (n <= 0) return r;
    return sleep(300).then(function () { return waitHealth(n - 1); });
  });
}
function fileLines() {
  try { return fs.readFileSync(STATE_FILE, 'utf8').split(String.fromCharCode(10)).filter(function (x) { return x.trim(); }).length; }
  catch (e) { return -1; }
}

(async function main() {
  var srv = null;
  var rc = 1;
  try {
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (e) {}
    fs.mkdirSync(STATE_DIR, { recursive: true });

    srv = startServer();
    var h0 = await waitHealth(30);
    check('启动(第1次) /healthz 200', h0.status === 200, h0.status + ' ' + h0.text);
    check('healthz.store = file', h0.json && h0.json.store === 'file', h0.json && h0.json.store);

    var ac = await req('POST', '/v1/mailboxes/acquire', { prefix: 'ps' }, { 'x-api-key': API_KEY });
    check('acquire 返回地址', ac.status === 200 && !!ac.json.address, ac.json);
    var addr = ac.json.address;

    var ig = await req('POST', '/v1/ingest', { to: addr, from: 'no-reply@hailuoai.com', subject: 'Verify', text: '您的验证码是 909090，5分钟内有效' }, { 'x-ingest-key': INGEST_KEY });
    check('ingest 投递成功且提到码', ig.status === 200 && ig.json.codes[0] === '909090', ig.json);

    var c1 = await req('GET', '/v1/mailboxes/' + encodeURIComponent(addr) + '/code', undefined, { 'x-api-key': API_KEY });
    check('重启前取码 = 909090', c1.json && c1.json.code === '909090', c1.json);

    var lines1 = fileLines();
    check('状态文件已写入(>=2 行)', lines1 >= 2, lines1);

    console.log('  -- 杀掉进程(SIGKILL)后重启 --');
    try { srv.kill('SIGKILL'); } catch (e) {}
    await sleep(600);

    var srv2 = startServer();
    var h1 = await waitHealth(30);
    check('启动(第2次) /healthz 200', h1.status === 200, h1.status + ' ' + h1.text);
    check('重启后 healthz.store = file', h1.json && h1.json.store === 'file', h1.json && h1.json.store);

    var c2 = await req('GET', '/v1/mailboxes/' + encodeURIComponent(addr) + '/code', undefined, { 'x-api-key': API_KEY });
    check('*** 重启后取码仍是 909090(持久化生效) ***', c2.json && c2.json.code === '909090', c2.json);

    var ms = await req('GET', '/v1/mailboxes/' + encodeURIComponent(addr) + '/messages', undefined, { 'x-api-key': API_KEY });
    check('重启后 messages 仍有该封', ms.status === 200 && ms.json.count >= 1, ms.json);

    var st = await req('GET', '/v1/stats', undefined, { 'x-api-key': API_KEY });
    check('stats.store = file 且 persist_loaded>0', st.json && st.json.store === 'file' && st.json.persist_loaded >= 2, st.json && { store: st.json.store, loaded: st.json.persist_loaded });

    for (var i = 0; i < 3; i++) {
      await req('POST', '/v1/mailboxes/acquire', { prefix: 'cx' + i }, { 'x-api-key': API_KEY });
    }
    var c3 = await req('GET', '/v1/mailboxes/' + encodeURIComponent(addr) + '/code', undefined, { 'x-api-key': API_KEY });
    check('触发 compact 后取码仍正常', c3.json && c3.json.code === '909090', c3.json);
    var head = '';
    try { head = fs.readFileSync(STATE_FILE, 'utf8').split(String.fromCharCode(10))[0]; } catch (e) {}
    check('compact 后文件首行是快照(box)', head.indexOf('"t":"box"') >= 0, head.slice(0, 80));

    try { srv2.kill('SIGKILL'); } catch (e) {}
    await sleep(300);
    rc = fail === 0 ? 0 : 1;
  } catch (e) {
    console.log('[FAIL] 异常: ' + (e && e.stack ? e.stack : e));
    fail++; rc = 1;
  } finally {
    if (srv) { try { srv.kill('SIGKILL'); } catch (e) {} }
  }
  console.log('----');
  console.log('PASS=' + ok + '  FAIL=' + fail);
  process.exit(rc);
})();
