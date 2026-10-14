#!/usr/bin/env node
/**
 * h3-fb-pool-run.js —— 甲 的「号池扩容」一步命令
 *
 * 作用：把 state/h3-fb-pool.jsonl（Facebook OAuth 换来的 Firebase refreshToken 清单）
 *       批量打进 H3 海外站（h3-batch-login kind=refresh），汇总 isRegister / credits，
 *       可选 --push 直接推进 pool-supply 池子。
 *
 * 用法：
 *   node scripts/h3-fb-pool-run.js                       # 用默认池文件、出口 17899
 *   node scripts/h3-fb-pool-run.js --proxy http://127.0.0.1:17898 --profiles state/h3-profiles/exit-17898
 *   node scripts/h3-fb-pool-run.js --push --pool http://127.0.0.1:9940 --admin-key sk-hl-admin
 *
 * 前置：FB OAuth 那条链（_ops/r169-fb-login-wait.js）已经往 state/h3-fb-pool.jsonl 里写了号。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
function arg(n, d) { const i = process.argv.indexOf('--' + n); if (i < 0) return d; const v = process.argv[i + 1]; return (v === undefined || String(v).indexOf('--') === 0) ? true : v; }
const has = (n) => process.argv.indexOf('--' + n) >= 0;

const inFile = path.resolve(String(arg('in', path.join(ROOT, 'state', 'h3-fb-pool.jsonl'))));
const proxy = String(arg('proxy', 'http://127.0.0.1:17899'));
const profiles = path.resolve(String(arg('profiles', path.join(ROOT, 'state', 'h3-profiles', 'exit-17899'))));
const outFile = path.resolve(String(arg('out', path.join(ROOT, 'state', 'h3-fb-pool.out.jsonl'))));
const conc = String(arg('concurrency', '2'));

if (!fs.existsSync(inFile)) { console.log('池文件不存在: ' + inFile + '\n（先跑 FB OAuth 链：node _ops/r169-fb-login-wait.js）'); process.exit(1); }
const lines = fs.readFileSync(inFile, 'utf8').split(/\r?\n/).filter(Boolean);
console.log('池内账号 ' + lines.length + ' 个 -> ' + inFile);
console.log('出口 ' + proxy + '  档案 ' + profiles + '  并发 ' + conc);

const args = [path.join(__dirname, 'h3-batch-login.js'), '--in', inFile, '--out', outFile, '--profiles', profiles,
  '--concurrency', conc, '--proxy', proxy, '--login-proxy', proxy];
if (has('push')) args.push('--push', '--pool', String(arg('pool', 'http://127.0.0.1:9940')), '--admin-key', String(arg('admin-key', process.env.SUPP_ADMIN_KEY || 'sk-hl-admin')));

const p = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
p.on('exit', (code) => {
  console.log('\n=== 汇总（' + outFile + '）');
  try {
    const recs = fs.readFileSync(outFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const ok = recs.filter((r) => r.ok);
    for (const r of recs) console.log('  ' + (r.ok ? 'OK  ' : 'FAIL') + ' ' + String(r.label).padEnd(18) + ' isRegister=' + (r.isRegister === undefined ? '-' : r.isRegister) + ' credits=' + (r.credits === undefined ? '-' : r.credits) + ' userID=' + (r.userID || '-') + ' exit=' + JSON.stringify((r.exitIp && r.exitIp.country) || '-') + (r.ok ? '' : ' err=' + String(r.error).slice(0, 90)));
    console.log('成功 ' + ok.length + '/' + recs.length + '  新号(isRegister=true) ' + ok.filter((r) => r.isRegister === true).length);
  } catch (e) { console.log('读汇总失败: ' + e.message); }
  process.exit(code || 0);
});