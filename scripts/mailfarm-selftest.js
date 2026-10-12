'use strict';
/**
 * mailfarm-selftest.js -- Node 版 mailfarm 端到端自测（零依赖）
 * 起一个临时实例（HTTP 18099 / SMTP 10025），走真实 SMTP 发码 + HTTP 取码 + ingest。
 * 用法：node scripts/mailfarm-selftest.js
 */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

const HTTP_PORT = 18099, SMTP_PORT = 10025;
const API_KEY = 'smoke-key-123';
const AK = { 'x-api-key': API_KEY };
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:' + HTTP_PORT;
let ok = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { ok++; console.log('[PASS] ' + name + (extra === undefined ? '' : ' ' + JSON.stringify(extra))); }
  else { fail++; console.log('[FAIL] ' + name + ' ' + JSON.stringify(extra)); }
}
function req(method, p, body, headers) {
  return new Promise(function (res) {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = Object.assign({}, headers || {});
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port: HTTP_PORT, path: p, method: method, headers: h, timeout: 20000 }, function (rr) {
      let bufs = [];
      rr.on('data', function (d) { bufs.push(d); });
      rr.on('end', function () {
        const txt = Buffer.concat(bufs).toString('utf8');
        let j = null; try { j = JSON.parse(txt); } catch (e) {}
        res({ status: rr.statusCode, json: j, text: txt });
      });
    });
    r.on('timeout', function () { r.destroy(); res({ status: 'TIMEOUT' }); });
    r.on('error', function (e) { res({ status: 'ERR:' + e.code }); });
    if (data) r.write(data);
    r.end();
  });
}
function smtpSend(to, subject, body, from) {
  return new Promise(function (res) {
    const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
    const s = net.connect(SMTP_PORT, "127.0.0.1");
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
function waitHealth(n) {
  return req('GET', '/healthz').then(function (r) {
    if (r.status === 200) return r.json;
    if (n <= 0) return null;
    return new Promise(function (z) { setTimeout(z, 400); }).then(function () { return waitHealth(n - 1); });
  });
}

(async function main() {
  const env = Object.assign({}, process.env, {
    MF_DOMAINS: 'allen23.online,ytu.baby',
    MF_API_KEY: API_KEY,
    MF_INGEST_KEY: 'ingest-key-123',
    MF_HTTP_HOST: '127.0.0.1', MF_HTTP_PORT: String(HTTP_PORT),
    MF_SMTP_HOST: '127.0.0.1', MF_SMTP_PORT: String(SMTP_PORT),
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mailfarm-server.js')], { env: env, cwd: ROOT });
  let srvLog = '';
  child.stdout.on('data', function (d) { srvLog += String(d); });
  child.stderr.on('data', function (d) { srvLog += String(d); });
  let rc = 1;
  try {
    const h = await waitHealth(25);
    check('启动 /healthz', !!h, h);
    if (h) {
      check('healthz domains', JSON.stringify(h.domains) === JSON.stringify(['allen23.online', 'ytu.baby']), h.domains);
      check('healthz store=memory', h.store === 'memory', h.store);

      const aq = await req('POST', '/v1/mailboxes/acquire', { prefix: 'zz' });
      check('acquire 返回地址', !!(aq.json && aq.json.address), aq.json);
      const addr = aq.json.address;
      check('acquire 前缀生效', String(addr).indexOf('zz') === 0, addr);

      const bq = await req('POST', '/v1/mailboxes/acquire_batch', { n: 3 });
      check('acquire_batch n=3', bq.json && bq.json.count === 3, bq.json && bq.json.count);

      check('SMTP 投递成功', await smtpSend(addr, 'Your verification code', 'Your code is 483920. Do not share.', 'noreply@example.com'));
      await new Promise(function (z) { setTimeout(z, 300); });

      const cd = await req('GET', '/v1/mailboxes/' + encodeURIComponent(addr) + '/code', undefined, AK);
      check('取到验证码 483920', cd.json && cd.json.code === '483920', cd.json);

      const ms = await req('GET', '/v1/mailboxes/' + encodeURIComponent(addr) + '/messages', undefined, AK);
      check('messages 可读且带 codes', ms.json && ms.json.count === 1 && ms.json.messages[0].codes[0] === '483920', ms.json);

      const s1 = await req('GET', '/v1/stats');
      check('stats 无 key -> 401', s1.status === 401 && s1.json.detail === 'bad api key', s1.status);
      const s2 = await req('GET', '/v1/stats', undefined, { 'x-api-key': API_KEY });
      check('stats 带 key -> 200', s2.status === 200 && s2.json.service === 'mailfarm', s2.status);

      const t0 = Date.now();
      const nq = await req('POST', '/v1/mailboxes/acquire', { prefix: 'no' });
      const nc = await req('GET', '/v1/mailboxes/' + encodeURIComponent(nq.json.address) + '/code?timeout=2', undefined, AK);
      const dt = (Date.now() - t0) / 1000;
      check('无码时按 timeout 返回 found=false', nc.json && nc.json.found === false && dt >= 1.8, dt.toFixed(2));

      const en = await req('POST', '/v1/mailboxes/acquire', { prefix: 'otp' });
      await smtpSend(en.json.address, 'Login code', 'Your one-time password is A7K9Q2', 'no-reply@x.com');
      await new Promise(function (z) { setTimeout(z, 300); });
      const ec = await req('GET', '/v1/mailboxes/' + encodeURIComponent(en.json.address) + '/code', undefined, AK);
      check('英文 one-time password 抽取 A7K9Q2', ec.json && ec.json.code === 'A7K9Q2', ec.json && ec.json.code);

      const nf = await req('GET', '/v1/mailboxes/nobody%40nowhere.tld/messages', undefined, AK);
      check('未知邮箱 -> 404', nf.status === 404, nf.status);

      const ig = await req('POST', '/v1/ingest', { to: 'cfbox@ytu.baby', from: 'noreply@upstream.io', subject: 'Verify', text: 'verification code: 550123' }, { 'x-ingest-key': 'ingest-key-123' });
      check('ingest(CF Worker 通道) 收信成功', ig.status === 200 && ig.json.codes[0] === '550123', ig.json);
      const ic = await req('GET', '/v1/mailboxes/cfbox%40ytu.baby/code', undefined, { 'x-api-key': API_KEY });
      check('ingest 后能取到码', ic.json && ic.json.code === '550123', ic.json);
      const igRaw = await req('POST', '/v1/ingest', { to: 'rawbox@ytu.baby', from: 'noreply@x.com', raw: 'Subject: Verify' + String.fromCharCode(10) + 'From: a@b.com' + String.fromCharCode(10) + String.fromCharCode(10) + 'Your login code is 334455' }, { 'x-ingest-key': 'ingest-key-123' });
      check('ingest 整封原文(raw) 能解析出码', igRaw.status === 200 && igRaw.json.codes[0] === '334455', igRaw.json);
      const igBad = await req('POST', '/v1/ingest', { to: 'cfbox@ytu.baby', text: 'x' }, { 'x-ingest-key': 'wrong' });
      check('ingest 错 key -> 401', igBad.status === 401, igBad.status);

      /* /v1/domains：与上游实测契约对齐 */
      const d0 = await req('GET', '/v1/domains', undefined, { 'x-api-key': API_KEY });
      check('domains 列表带 key -> 200 含 ytu.baby', d0.status === 200 && d0.json.domains.indexOf('ytu.baby') >= 0, d0.json);
      const d1 = await req('GET', '/v1/domains');
      check('domains 无 key -> 401', d1.status === 401, d1.status);
      const d2 = await req('POST', '/v1/domains', { domains: ['newdom.test'] }, { 'x-api-key': API_KEY });
      check('domains POST 追加成功', d2.status === 200 && d2.json.domains.indexOf('newdom.test') >= 0, d2.json);
      const d3 = await req('POST', '/v1/ingest', { to: 'x@newdom.test', text: 'verification code: 112233' }, { 'x-ingest-key': 'ingest-key-123' });
      check('新增域立即可收信', d3.status === 200 && d3.json.codes[0] === '112233', d3.json);

      const und = await req('POST', '/v1/ingest', { to: 'x@not-mine.com', text: 'x' }, { 'x-ingest-key': 'ingest-key-123' });
      check('ingest 非收信域 -> 400', und.status === 400, und.status);
    }
    rc = fail === 0 ? 0 : 1;
  } catch (e) {
    console.log('[FAIL] 异常: ' + e.message);
    fail++; rc = 1;
  } finally {
    try { child.kill(); } catch (e) {}
    await new Promise(function (z) { setTimeout(z, 400); });
    const tail = srvLog.split(String.fromCharCode(10)).filter(Boolean).slice(-8).join(String.fromCharCode(10));
    console.log('---- server log tail ----');
    console.log(tail);
    console.log('----');
    console.log('PASS=' + ok + '  FAIL=' + fail);
  }
  process.exit(rc);
})();
