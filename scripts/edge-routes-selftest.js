'use strict';
/**
 * edge-routes-selftest.js -- 验证 edge-proxy 的 EDGE_ROUTES 前缀路由（零依赖）
 *   起 mailfarm(18099) + edge-proxy(18081, 上游故意指向死端口)，
 *   然后 POST /mailfarm/v1/ingest，必须被剥掉 /mailfarm 前缀转发到 mailfarm。
 *  用法：node scripts/edge-routes-selftest.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MF = 18099, EDGE = 18081;
const ING = 'edge-test-ingest-key';
let ok = 0, fail = 0;
function check(n, c, e) { if (c) { ok++; console.log('[PASS] ' + n + (e === undefined ? '' : ' ' + JSON.stringify(e))); } else { fail++; console.log('[FAIL] ' + n + ' ' + JSON.stringify(e)); } }
function sleep(ms) { return new Promise(function (z) { setTimeout(z, ms); }); }
function post(port, p, body, headers) {
  return new Promise(function (res) {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const h = Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, headers || {});
    const r = http.request({ host: '127.0.0.1', port: port, path: p, method: 'POST', headers: h, timeout: 10000 }, function (rr) {
      let b = []; rr.on('data', function (d) { b.push(d); }); rr.on('end', function () { const txt = Buffer.concat(b).toString('utf8'); let j = null; try { j = JSON.parse(txt); } catch (e) {} res({ status: rr.statusCode, json: j, text: txt }); });
    });
    r.on('error', function (e) { res({ status: 'ERR:' + e.code }); });
    r.on('timeout', function () { r.destroy(); res({ status: 'TIMEOUT' }); });
    r.write(data); r.end();
  });
}
function get(port, p) {
  return new Promise(function (res) {
    const r = http.request({ host: '127.0.0.1', port: port, path: p, method: 'GET', timeout: 10000 }, function (rr) {
      let b = []; rr.on('data', function (d) { b.push(d); }); rr.on('end', function () { res({ status: rr.statusCode, text: Buffer.concat(b).toString('utf8') }); });
    });
    r.on('error', function (e) { res({ status: 'ERR:' + e.code }); });
    r.on('timeout', function () { r.destroy(); res({ status: 'TIMEOUT' }); });
    r.end();
  });
}
(async function main() {
  const mf = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mailfarm-server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { MF_DOMAINS: 'edge.test', MF_INGEST_KEY: ING, MF_SMTP_ENABLE: '0', MF_HTTP_HOST: '127.0.0.1', MF_HTTP_PORT: String(MF) })
  });
  const ed = spawn(process.execPath, [path.join(ROOT, 'scripts', 'edge-proxy.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { EDGE_PORT: String(EDGE), EDGE_HOST: '127.0.0.1', EDGE_UPSTREAM: 'http://127.0.0.1:19999', EDGE_ROUTES: '/mailfarm=http://127.0.0.1:' + MF, EDGE_LOG_DIR: path.join(require('os').tmpdir(), 'edge-test-logs') })
  });
  let edlog = ''; ed.stdout.on('data', function (d) { edlog += String(d); }); ed.stderr.on('data', function (d) { edlog += String(d); });
  try {
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) { const r = await get(MF, '/healthz'); ready = r.status === 200; if (!ready) await sleep(300); }
    check('mailfarm 就绪', ready);
    let eok = false;
    for (let i = 0; i < 30 && !eok; i++) { const r = await get(EDGE, '/__edge/health'); eok = r.status === 200; if (!eok) await sleep(300); }
    check('edge-proxy 就绪', eok);

    const direct = await post(MF, '/v1/ingest', { to: 'a@edge.test', subject: 'V', text: 'verification code: 111222' }, { 'x-ingest-key': ING });
    check('直连 mailfarm /v1/ingest 正常', direct.status === 200 && direct.json.codes[0] === '111222', direct.json);

    const viaEdge = await post(EDGE, '/mailfarm/v1/ingest', { to: 'b@edge.test', subject: 'V', text: 'verification code: 654321' }, { 'x-ingest-key': ING });
    check('经 edge-proxy /mailfarm/v1/ingest 转发成功', viaEdge.status === 200 && viaEdge.json && viaEdge.json.codes[0] === '654321', viaEdge.json || viaEdge.text);

    const root = await get(EDGE, '/healthz');
    check('未命中前缀的路径仍走上游(死端口) -> 502', root.status === 502, root.status);

    const mfRoot = await get(MF, '/v1/mailboxes/b%40edge.test/code');
    check('转发过去的信真进了 mailfarm 的库', mfRoot.status === 200 && mfRoot.text.indexOf('654321') >= 0, mfRoot.text);
  } catch (e) {
    console.log('[FAIL] 异常: ' + e.message); fail++;
  } finally {
    try { mf.kill(); } catch (e) {}
    try { ed.kill(); } catch (e) {}
    await sleep(400);
    console.log('---- edge-proxy log tail ----');
    console.log(edlog.split(String.fromCharCode(10)).filter(Boolean).slice(-6).join(String.fromCharCode(10)));
    console.log('----');
    console.log('PASS=' + ok + '  FAIL=' + fail);
  }
  process.exit(fail === 0 ? 0 : 1);
})();
