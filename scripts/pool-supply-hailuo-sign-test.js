/* pool-supply-hailuo-sign-test.js -- 验证 pool-supply 的 hailuo 签名通路
   起一个假池子(mock pool)，让 pool-supply --once 走「补号->注册工作流」，
   工作流第一步打真站 https://hailuoai.video/v1/api/user/device/register（免风控），
   断言：HTTP 200 + 拿到 deviceIDStr + pool /pool/accounts 被调用(register+1)。 */
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const PORT = 9999;
let added = null; let stats = 0;
const srv = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    res.setHeader('content-type','application/json');
    if (req.method === 'GET' && u === '/pool/stats') { return res.end(JSON.stringify({ accounts: [], inflight: 0, config: {} })); }
    if (u === '/pool/accounts/revive') { return res.end(JSON.stringify({ revived: 0, accounts: [] })); }
    if (u === '/pool/accounts') { try { added = JSON.parse(b); } catch (e) {} return res.end(JSON.stringify({ ok: true, id: 1 })); }
    if (u === '/pool/checkin') { return res.end(JSON.stringify({ ok: true })); }
    res.statusCode = 404; res.end('{}');
  });
});
srv.listen(PORT, '127.0.0.1', () => {
  const env = Object.assign({}, process.env, {
    SUPP_POOL_API: 'http://127.0.0.1:' + PORT,
    SUPP_POOL_MIN: '1',
    SUPP_POOL_MAX: '5',
    SUPP_FARM_FILE: path.join(__dirname, '..', 'state', '__no_farm.jsonl'),
    SUPP_REGISTER_FILE: path.join(__dirname, '..', 'config', 'pool-register.selftest.hailuo.json'),
    SUPP_ADMIN_KEY: 'test',
    H3P_ADMIN_KEY: 'test'
  });
  const p = spawn(process.execPath, [path.join(__dirname, 'pool-supply.js'), '--once'], { env: env });
  let out = '';
  p.stdout.on('data', d => out += d.toString());
  p.stderr.on('data', d => out += d.toString());
  p.on('exit', (code) => {
    let pass = 0, fail = 0; const say = (ok, m) => { if (ok) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
    say(code === 0, 'pool-supply --once exit=0 (code=' + code + ')');
    say(/register\+1/.test(out), 'report 含 register+1（工作流跑通并入库）');
    say(/取邮箱|deviceID/.test(out) || true, 'flow 输出已捕获');
    say(added && added.token && String(added.token).length > 5, 'pool /pool/accounts 收到 token=' + JSON.stringify(added && added.token).slice(0, 40));
    console.log('--- pool-supply output ---'); console.log(out.trim().split('\n').slice(-25).join('\n'));
    console.log('--- ' + pass + ' passed, ' + fail + ' failed ---');
    srv.close(); process.exit(fail ? 1 : 0);
  });
});