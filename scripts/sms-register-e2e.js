/**
 * sms-register-e2e.js -- 端到端验证「接码取号 -> 注册 -> 入池」整条链
 *   全本地、无网络：mock 接码平台 + mock 上游注册接口 + mock 池子，
 *   然后启动真的 pool-supply.js，打 POST /supply/register，断言账号被写进池子。
 *
 *   跑法：node scripts/sms-register-e2e.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SMS_PORT = 9971, UP_PORT = 9972, POOL_PORT = 9973, SUPP_PORT = 9974;
const ADMIN_KEY = 'e2e-admin-key';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-e2e-'));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n); } };

const state = { pollCount: 0, poolCalls: [], registerHits: 0 };

function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json' }); res.end(b); }
function text(res, code, s) { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(s); }

/* ---------------- mock 接码平台（两个都做成真实平台的格式） ---------------- */
const smsSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/get') {
    // sms-man 风格 JSON + 国际号（考验适配层的国际号分支）
    return json(res, 200, { success: true, number: '+12025550143', request_id: 4242 });
  }
  if (u.pathname === '/poll') {
    state.pollCount++;
    if (state.pollCount < 2) return text(res, 200, 'STATUS_WAIT_CODE');   // sms-activate 风格文本
    return text(res, 200, 'STATUS_OK:778899');
  }
  return text(res, 404, 'nope');
});

/* ---------------- mock 上游注册接口 ---------------- */
const upSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/api/account/send-code') return json(res, 200, { ok: true });
    if (req.url === '/api/account/register') {
      state.registerHits++;
      const b = (() => { try { return JSON.parse(body); } catch (e) { return {}; } })();
      if (b.phone && b.code === '778899') return json(res, 200, { data: { token: 'tok-e2e-1', account_id: 'acc-e2e-1' } });
      return json(res, 400, { error: 'bad code', got: b });
    }
    return json(res, 404, {});
  });
});

/* ---------------- mock 池子 ---------------- */
const poolSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    state.poolCalls.push({ url: req.url, method: req.method, body: body.slice(0, 300) });
    if (req.url.startsWith('/pool/stats')) return json(res, 200, { accounts: [], inflight: 0 });
    if (req.url.startsWith('/pool/accounts/bulk')) return json(res, 200, { imported: 0 });
    if (req.url.startsWith('/pool/accounts')) return json(res, 200, { ok: true });
    if (req.url.startsWith('/pool/checkin')) return json(res, 200, { credited: 0 });
    if (req.url.startsWith('/pool/accounts/revive')) return json(res, 200, { revived: 0, accounts: [] });
    return json(res, 404, {});
  });
});

const flow = {
  base: 'http://127.0.0.1:' + UP_PORT,
  project: 'go',
  steps: [
    { name: '取号', type: 'sms-get', project: 'go', save_phone: 'phone', save_id: 'phone_id' },
    { name: '发验证码', type: 'http', method: 'POST', path: '/api/account/send-code', body: { phone: '{{phone}}' }, expect: 200 },
    { name: '收验证码', type: 'sms-wait', from: 'phone_id', save: 'code' },
    { name: '提交注册', type: 'http', method: 'POST', path: '/api/account/register', body: { phone: '{{phone}}', code: '{{code}}' }, save: { token: 'data.token', label: 'data.account_id' }, expect: 200 },
    { name: '整理', type: 'emit', as: { token: '{{token}}', label: 'reg-{{phone}}' } }
  ]
};
const flowFile = path.join(TMP, 'reg-flow.json');
fs.writeFileSync(flowFile, JSON.stringify(flow, null, 2));

function listen(srv, port) { return new Promise((r) => srv.listen(port, '127.0.0.1', () => r())); }
function get(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers: headers || {} }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject); req.end();
  });
}
function post(url, obj, headers) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(obj || {});
    const req = http.request(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('error', reject); req.end(b);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
async function main() {
  await listen(smsSrv, SMS_PORT);
  await listen(upSrv, UP_PORT);
  await listen(poolSrv, POOL_PORT);
  console.log('mock servers up: sms=' + SMS_PORT + ' upstream=' + UP_PORT + ' pool=' + POOL_PORT);

  const env = Object.assign({}, process.env, {
    SUPP_PORT: String(SUPP_PORT),
    SUPP_POOL_API: 'http://127.0.0.1:' + POOL_PORT,
    SUPP_POOL_ADMIN_KEY: 'pool-key',
    SUPP_ADMIN_KEY: ADMIN_KEY,
    SUPP_POOL_MIN: '5',
    SUPP_POOL_MAX: '20',
    SUPP_INTERVAL_MS: '600000',
    SUPP_FARM_FILE: path.join(TMP, 'no-farm.jsonl'),
    SUPP_REGISTER_FILE: flowFile,
    SUPP_STATE_FILE: path.join(TMP, 'state.json'),
    SUPP_LOG_FILE: path.join(TMP, 'supply.log'),
    // 关键：接码地址（取号 JSON 国际号 + 查码文本协议）
    SUPP_SMS_GET: 'http://127.0.0.1:' + SMS_PORT + '/get?project={project}&service={project}&key={key}',
    SUPP_SMS_POLL: 'http://127.0.0.1:' + SMS_PORT + '/poll?id={id}',
    SUPP_SMS_KEY: 'E2E-SMS-KEY',
    SUPP_SMS_WAIT_MS: '15000'
  });
  child = spawn(process.execPath, [path.join(__dirname, 'pool-supply.js')], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await get('http://127.0.0.1:' + SUPP_PORT + '/supply/healthz'); if (r.status === 200) { up = true; break; } } catch (e) {}
    await sleep(250);
  }
  ok(up, 'pool-supply 起来了 (:' + SUPP_PORT + ')');
  if (!up) throw new Error('service did not start');

  const r = await post('http://127.0.0.1:' + SUPP_PORT + '/supply/register', {}, { 'x-admin-key': ADMIN_KEY });
  ok(r.status === 200, 'POST /supply/register -> 200 (got ' + r.status + ')');

  await sleep(600);
  ok(state.pollCount >= 2, '查码轮询发生了（前 2 次 WAIT，第 3 次 STATUS_OK）实测 ' + state.pollCount + ' 次');
  ok(state.registerHits === 1, '上游注册接口被调 1 次');
  const addCall = state.poolCalls.filter((c) => c.url.startsWith('/pool/accounts') && !c.url.includes('bulk') && !c.url.includes('revive'));
  ok(addCall.length >= 1, '账号被写入池子 (POST /pool/accounts)');
  ok(addCall.some((c) => c.body.indexOf('tok-e2e-1') >= 0), '写入的 token = tok-e2e-1（整链打通）');

  const st = await get('http://127.0.0.1:' + SUPP_PORT + '/supply/stats');
  let sj = null; try { sj = JSON.parse(st.body); } catch (e) {}
  ok(sj && sj.supply && sj.supply.registered === 1, 'stats.registered = 1（实测 ' + (sj && sj.supply && sj.supply.registered) + '）');
  ok(sj && sj.config && sj.config.sms_configured === true, 'stats.config.sms_configured = true');

  console.log('\n' + pass + ' PASS / ' + fail + ' FAIL');
}

function cleanup() {
  try { if (child) child.kill(); } catch (e) {}
  try { smsSrv.close(); } catch (e) {}
  try { upSrv.close(); } catch (e) {}
  try { poolSrv.close(); } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

main().then(() => { cleanup(); process.exit(fail ? 1 : 0); }).catch((e) => { console.log('  ERROR ' + e.message); cleanup(); process.exit(1); });
