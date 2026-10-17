'use strict';
/**
 * selftest-wake-policy.js —— R1190 唤醒判定自测（不联网、不开机、不动真服务）
 *   验证：探活(GET /v1/models) 绝不叫醒机器；真实业务 POST + Bearer 才叫醒。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const RELAY = path.join(__dirname, 'h3-local-relay.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-pol-'));
const marker = path.join(dir, 'wake.marker');
const wakeJs = path.join(dir, 'wake.js');
fs.writeFileSync(wakeJs, "require('fs').appendFileSync(process.argv[2], 'x');", 'utf8');

const PORT = 9433;
const BASE = 'http://127.0.0.1:' + PORT;

function req(method, p, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const h = Object.assign({}, opts.headers || {});
    let body = opts.body || null;
    if (body && !h['content-type']) h['content-type'] = 'application/json';
    if (body) h['content-length'] = Buffer.byteLength(body);
    const r = http.request(BASE + p, { method, headers: h, timeout: 8000 }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b, json: safe(b) }));
    });
    r.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message, json: null }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'TIMEOUT', json: null }); });
    if (body) r.write(body);
    r.end();
  });
}
function safe(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function markCount() { try { return fs.readFileSync(marker, 'utf8').length; } catch (e) { return 0; } }

(async () => {
  const env = Object.assign({}, process.env, {
    H3R_PORT: String(PORT),
    H3R_STATE: path.join(dir, 'state.json'),
    H3R_UPSTREAM: 'http://127.0.0.1:1',
    H3R_WAKE_STATE: path.join(dir, 'wake.json'),
    H3R_WAKE_CMD: '"' + process.execPath + '" "' + wakeJs + '" "' + marker + '"',
    H3R_WAKE_MIN_INTERVAL: '30',
    H3R_LOG_REQ: '0',
  });
  const child = spawn(process.execPath, [RELAY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => out += d);
  child.stderr.on('data', (d) => out += d);

  // 等端口起来
  let up = false;
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 100));
    const h = await req('GET', '/healthz');
    if (h.status === 200) { up = true; break; }
  }

  const res = [];
  const rec = (k, v, extra) => { res.push((v ? 'PASS  ' : 'FAIL  ') + k + (extra ? '   [' + extra + ']' : '')); return v; };
  rec('0) relay 启动', up, 'status=' + (up ? 200 : 0));

  // a) 无 auth 的 GET 探活
  let r1 = await req('GET', '/v1/models');
  rec('a) GET /v1/models (无auth) 不唤醒', r1.status >= 500 && r1.json && r1.json.wake && r1.json.wake.fired === false, JSON.stringify(r1.json && r1.json.wake));
  rec('a2) 唤醒命令未执行', markCount() === 0, 'marker=' + markCount());

  // b) 带 auth 的 GET 探活（new-api 渠道测活就长这样）
  let r2 = await req('GET', '/v1/models', { headers: { authorization: 'Bearer sk-abcdef1234567890' } });
  rec('b) GET /v1/models (带Bearer) 仍不唤醒', r2.status >= 500 && r2.json && r2.json.wake && r2.json.wake.fired === false, JSON.stringify(r2.json && r2.json.wake));
  rec('b2) 唤醒命令仍未执行', markCount() === 0, 'marker=' + markCount());

  // c) POST 但没 auth
  let r3 = await req('POST', '/v1/chat/completions', { body: JSON.stringify({ model: 'x', messages: [] }) });
  rec('c) POST /v1/chat/completions (无auth) 不唤醒', r3.status >= 500 && r3.json && r3.json.wake && r3.json.wake.fired === false, JSON.stringify(r3.json && r3.json.wake));
  rec('c2) 唤醒命令仍未执行', markCount() === 0, 'marker=' + markCount());

  // d) 真实业务：POST + Bearer
  let r4 = await req('POST', '/v1/chat/completions', { headers: { authorization: 'Bearer sk-abcdef1234567890' }, body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }) });
  rec('d) POST + Bearer 触发唤醒', r4.status >= 500 && r4.json && r4.json.wake && r4.json.wake.fired === true, JSON.stringify(r4.json && r4.json.wake));
  await new Promise(r => setTimeout(r, 700));
  rec('d2) 唤醒命令真的执行了', markCount() > 0, 'marker=' + markCount());

  // e) healthz 业务指标
  const h = await req('GET', '/healthz');
  const j = h.json || {};
  rec('e) healthz 暴露 biz_idle_s/biz_count', j.biz_count === 1 && typeof j.biz_idle_s === 'number', 'biz_count=' + j.biz_count + ' biz_idle_s=' + j.biz_idle_s + ' idle_s=' + j.idle_s + ' req_count=' + j.req_count);

  // f) 二次业务请求被节流（不同请求，间隔 < 30s）
  const r5 = await req('POST', '/v1/videos', { headers: { authorization: 'Bearer sk-abcdef1234567890' }, body: '{}' });
  rec('f) 二次业务请求被节流(不重复开)', r5.json && r5.json.wake && r5.json.wake.fired === false && r5.json.wake.reason === 'throttled', JSON.stringify(r5.json && r5.json.wake));

  child.kill();
  await new Promise(r => setTimeout(r, 300));
  console.log('\n=== wake-policy selftest ===');
  res.forEach(x => console.log('  ' + x));
  const all = res.every(x => x.startsWith('PASS'));
  if (!all) console.log('\n--- relay 输出 ---\n' + out.slice(-1500));
  console.log(all ? '★ 全部符合预期' : '⚠ 有不符合项');
  process.exit(all ? 0 : 1);
})();
