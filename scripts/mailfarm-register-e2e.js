'use strict';
/**
 * mailfarm-register-e2e.js -- 端到端验证「邮箱型补号」全链路（零依赖）
 *
 *   mailfarm(18099/10025)  <-- 取邮箱/等验证码
 *        ^
 *        |  mock 上游(18800)：/api/account/send-code 会真的把验证码邮件投到 mailfarm
 *        |
 *   pool-supply --once  --> 跑 config 里 type=mail-acquire / mail-wait 的工作流
 *        |
 *        v
 *   mock 池(19940)：/pool/stats /pool/accounts/revive /pool/accounts
 *
 *  用法：node scripts/mailfarm-register-e2e.js
 */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
const MF_HTTP = 18099, MF_SMTP = 10025, UP = 18800, POOL = 19940, SUPP = 19950;
const MF_KEY = 'mf-key-123';
let ok = 0, fail = 0;
function check(n, c, e) { if (c) { ok++; console.log('[PASS] ' + n + (e === undefined ? '' : ' ' + JSON.stringify(e))); } else { fail++; console.log('[FAIL] ' + n + ' ' + JSON.stringify(e)); } }
function sleep(ms) { return new Promise(function (z) { setTimeout(z, ms); }); }
function jreply(res, code, obj) { const b = Buffer.from(JSON.stringify(obj), 'utf8'); res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b); }
function readBody(req, cb) { let c = []; req.on('data', function (d) { c.push(d); }); req.on('end', function () { let o = {}; try { o = JSON.parse(Buffer.concat(c).toString('utf8') || '{}'); } catch (e) {} cb(o); }); }
function get(url, headers) {
  return new Promise(function (res) {
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: headers || {}, timeout: 15000 }, function (rr) {
      let b = []; rr.on('data', function (d) { b.push(d); }); rr.on('end', function () { const txt = Buffer.concat(b).toString('utf8'); let j = null; try { j = JSON.parse(txt); } catch (e) {} res({ status: rr.statusCode, json: j, text: txt }); });
    });
    r.on('error', function (e) { res({ status: 'ERR:' + e.code }); });
    r.on('timeout', function () { r.destroy(); res({ status: 'TIMEOUT' }); });
    r.end();
  });
}
function smtpSend(to, subject, body, from) {
  return new Promise(function (res) {
    const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
    const s = net.connect(MF_SMTP, "127.0.0.1");
    let buf = "", phase = "greet", done = false;
    function finish(ok) {
      if (done) return; done = true;
      try { s.write("QUIT" + CRLF); } catch (e) {}
      setTimeout(function () { try { s.destroy(); } catch (e) {} res(ok); }, 60);
    }
    function onLine(line) {
      const code = line.slice(0, 3);
      if (line.length > 3 && line.charAt(3) === "-") return;
      if (/^[45]/.test(code)) { finish(false); return; }
      if (code === "220") { s.write("EHLO test" + CRLF); return; }
      if (code === "250" && phase === "greet") { phase = "mail"; s.write("MAIL FROM:<" + from + ">" + CRLF); return; }
      if (code === "250" && phase === "mail") { phase = "rcpt"; s.write("RCPT TO:<" + to + ">" + CRLF); return; }
      if (code === "250" && phase === "rcpt") { phase = "data"; s.write("DATA" + CRLF); return; }
      if (code === "354") { phase = "sent"; s.write("Subject: " + subject + CRLF + "From: " + from + CRLF + CRLF + body + CRLF + "." + CRLF); return; }
      if (code === "250" && phase === "sent") { finish(true); return; }
    }
    s.setTimeout(10000);
    s.on("data", function (chunk) {
      buf += String(chunk);
      for (;;) {
        const i = buf.indexOf(CRLF);
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    });
    s.on("error", function () { finish(false); });
    s.on("timeout", function () { finish(false); });
  });
}

const added = [];
function startMockPool() {
  return http.createServer(function (req, res) {
    const p = req.url.split('?')[0];
    if (p === '/pool/stats') return jreply(res, 200, { accounts: [] });
    if (p === '/pool/accounts/revive') return jreply(res, 200, { revived: 0, accounts: [] });
    if (p === '/pool/accounts' || p === '/pool/accounts/bulk') {
      return readBody(req, function (b) {
        const list = b.accounts || [b];
        for (let i = 0; i < list.length; i++) added.push(list[i]);
        jreply(res, 200, { ok: true, added: list.length });
      });
    }
    jreply(res, 404, { detail: 'no route' });
  }).listen(POOL, '127.0.0.1');
}
function startMockUpstream() {
  const codes = {};
  return http.createServer(function (req, res) {
    const p = req.url.split('?')[0];
    if (p === '/api/account/send-code') {
      return readBody(req, function (b) {
        const code = '778899';
        codes[b.email] = code;
        smtpSend(b.email, 'Your verification code', 'Your verification code is ' + code + ' .', 'noreply@mock-upstream.test')
          .then(function () { jreply(res, 200, { ok: true }); });
      });
    }
    if (p === '/api/account/register') {
      return readBody(req, function (b) {
        if (codes[b.email] && String(b.code) === codes[b.email]) {
          return jreply(res, 200, { data: { token: 'tok-' + Buffer.from(b.email).toString('hex').slice(0, 12), account_id: 'acc-' + b.email.split('@')[0] } });
        }
        jreply(res, 400, { error: 'bad code' });
      });
    }
    if (p === '/api/status') return jreply(res, 200, { ok: true });
    jreply(res, 404, { detail: 'no route' });
  }).listen(UP, '127.0.0.1');
}

(async function main() {
  const tmpFlow = path.join(os.tmpdir(), 'mf-reg-flow.json');
  fs.writeFileSync(tmpFlow, JSON.stringify({
    base: 'http://127.0.0.1:' + UP,
    mail_prefix: 'e2e',
    steps: [
      { name: '取邮箱', type: 'mail-acquire', save_email: 'email', save_id: 'email_id' },
      { name: '发验证码', type: 'http', method: 'POST', path: '/api/account/send-code', body: { email: '{{email}}' }, expect: 200 },
      { name: '等信', type: 'sleep', ms: 500 },
      { name: '收验证码', type: 'mail-wait', from: 'email_id', save: 'code' },
      { name: '提交注册', type: 'http', method: 'POST', path: '/api/account/register', body: { email: '{{email}}', code: '{{code}}' }, save: { token: 'data.token', label: 'data.account_id' }, expect: 200 },
      { name: '整理', type: 'emit', as: { token: '{{token}}', label: 'reg-{{email}}' } }
    ]
  }), 'utf8');

  const mfEnv = Object.assign({}, process.env, {
    MF_DOMAINS: 'farmdemo.io,allen23.online', MF_API_KEY: MF_KEY,
    MF_HTTP_HOST: '127.0.0.1', MF_HTTP_PORT: String(MF_HTTP),
    MF_SMTP_HOST: '127.0.0.1', MF_SMTP_PORT: String(MF_SMTP)
  });
  const mf = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mailfarm-server.js')], { env: mfEnv, cwd: ROOT });
  const pool = startMockPool();
  const up = startMockUpstream();
  let mfLog = '';
  mf.stdout.on('data', function (d) { mfLog += String(d); });
  mf.stderr.on('data', function (d) { mfLog += String(d); });

  try {
    // 等 mailfarm 就绪
    let ready = false;
    for (let i = 0; i < 25 && !ready; i++) { const r = await get('http://127.0.0.1:' + MF_HTTP + '/healthz'); ready = r.status === 200; if (!ready) await sleep(300); }
    check('mailfarm 就绪', ready);

    const suppEnv = Object.assign({}, process.env, {
      SUPP_PORT: String(SUPP),
      SUPP_POOL_API: 'http://127.0.0.1:' + POOL,
      SUPP_POOL_ADMIN_KEY: 'sk-test',
      SUPP_POOL_MIN: '1', SUPP_POOL_MAX: '10', SUPP_REFILL_BATCH: '1',
      SUPP_MAIL_API: 'http://127.0.0.1:' + MF_HTTP,
      SUPP_MAIL_KEY: MF_KEY,
      SUPP_CALLBACK: '',
      SUPP_REGISTER_FILE: tmpFlow,
      SUPP_FARM_FILE: path.join(os.tmpdir(), 'no-such-farm.jsonl'),
      SUPP_STATE_FILE: path.join(os.tmpdir(), 'mf-e2e-supply.json'),
      SUPP_LOG_FILE: path.join(os.tmpdir(), 'mf-e2e-supply.log'),
      SUPP_SMS_GET: '', SUPP_SMS_POLL: ''
    });
    const supp = spawn(process.execPath, [path.join(ROOT, 'scripts', 'pool-supply.js'), '--once'], { env: suppEnv, cwd: ROOT });
    let sLog = '';
    supp.stdout.on('data', function (d) { sLog += String(d); });
    supp.stderr.on('data', function (d) { sLog += String(d); });
    const rc = await new Promise(function (res) { supp.on('exit', function (c) { res(c); }); setTimeout(function () { try { supp.kill(); } catch (e) {} res('timeout'); }, 45000); });

    check('pool-supply --once 正常退出', rc === 0, rc);
    check('池子收到 1 个新号', added.length >= 1, added.length);
    const a = added[0] || {};
    check('新号带 token', !!a.token && String(a.token).indexOf('tok-') === 0, a.token);
    check('新号 label 是邮箱注册', String(a.label || '').indexOf('reg-') === 0, a.label);
    check('用的是 mailfarm 邮箱（非手机号）', /@(farmdemo\.io|allen23\.online)$/.test(String(a.label || '')), a.label);
    check('日志出现「取邮箱」', sLog.indexOf('取邮箱') >= 0);
    check('日志出现「收到邮箱验证码 778899」', sLog.indexOf('778899') >= 0);
    console.log('---- pool-supply log tail ----');
    console.log(sLog.split(NL).filter(Boolean).slice(-8).join(NL));
  } catch (e) {
    console.log('[FAIL] 异常: ' + e.message);
    fail++;
  } finally {
    try { mf.kill(); } catch (e) {}
    try { pool.close(); } catch (e) {}
    try { up.close(); } catch (e) {}
    console.log('----');
    console.log('PASS=' + ok + '  FAIL=' + fail);
  }
  process.exit(fail === 0 ? 0 : 1);
})();
