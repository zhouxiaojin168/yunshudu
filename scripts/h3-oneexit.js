#!/usr/bin/env node
/**
 * h3-oneexit.js -- 「一号一出口」编排器（H3 号池 × 机场节点池）
 *
 * 原理：mihomo 选择器组（猫猫云）一次只出一台落地，
 *       所以「一号一出口」= 每个账号登录前先切节点 → 再单号单跑登录引擎。
 *       出口 IP 用 exit-rotate 的探针实测落库，和账号一一对应。
 *
 * 用法：
 *   node scripts/h3-oneexit.js --in state/h3-accounts.in.jsonl --region 美国 --dry      # 只切节点+探针，不开浏览器
 *   node scripts/h3-oneexit.js --in state/h3-accounts.in.jsonl --region 美国 --port 17899
 *   node scripts/h3-oneexit.js --in state/h3-accounts.in.jsonl --nodes "0.5x 🇺🇸 美国直连 US - 11,…"
 *
 * 产物：state/oneexit-map.jsonl（account ↔ node ↔ 出口IP ↔ 登录结果）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OPS = path.resolve(ROOT, '..', '_ops');
const MAP = path.join(ROOT, 'state', 'oneexit-map.jsonl');

function argval(name, dflt) { const i = process.argv.indexOf('--' + name); if (i < 0) return dflt; const v = process.argv[i + 1]; return (v === undefined || String(v).indexOf('--') === 0) ? dflt : v; }
const has = (n) => process.argv.indexOf('--' + n) >= 0;
const run = (script, args) => spawnSync(process.execPath, [path.join(__dirname, script)].concat(args), { encoding: 'utf8' });

(async () => {
  const inFile = argval('in', path.join(ROOT, 'state', 'h3-accounts.in.jsonl'));
  const port = argval('port', '17899');
  const dry = has('dry');
  const accounts = fs.readFileSync(inFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  if (!accounts.length) { console.log('输入为空: ' + inFile); process.exit(1); }

  // 1) 取节点池
  let nodes = [];
  const fixed = argval('nodes', '');
  if (fixed) nodes = fixed.split(',').map((s) => s.trim()).filter(Boolean);
  else {
    const args = ['list'];
    const region = argval('region', ''); const rate = argval('rate', '');
    if (region) args.push('--region', region);
    if (rate) args.push('--rate', rate);
    const r = run('exit-rotate.js', args);
    // list 输出只是给人看的，这里直接用 API 取
  }
  if (!nodes.length) {
    const res = await fetch('http://127.0.0.1:9790/proxies'); const p = await res.json();
    const region = argval('region', '');
    nodes = Object.keys(p.proxies).filter((n) => !Array.isArray(p.proxies[n].all) && !/^(DIRECT|REJECT|GLOBAL|自动选择|故障转移|负载均衡|猫猫云)$/.test(n));
    if (region) nodes = nodes.filter((n) => n.indexOf(region) >= 0);
  }
  if (!nodes.length) { console.log('没有可用节点'); process.exit(1); }

  console.log('账号 ' + accounts.length + ' 个 / 候选节点 ' + nodes.length + ' 个  出口桥=127.0.0.1:' + port + (dry ? '  [DRY]' : '') + '\n');
  fs.mkdirSync(path.dirname(MAP), { recursive: true });
  const prev = (run('exit-rotate.js', ['current']).stdout || '').trim();

  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    const node = nodes[i % nodes.length];
    run('exit-rotate.js', ['switch', node]);
    let rec = { at: new Date().toISOString(), label: acct.label || acct.email || ('#' + i), node, exitIp: null, ok: null };
    const pr = run('exit-rotate.js', ['probe', '--via', 'http://127.0.0.1:' + port]);
    try { const j = JSON.parse(pr.stdout); rec.exitIp = j.ip; rec.geo = j.geo && (j.geo.country + ' ' + (j.geo.city || j.geo.regionName || '') + ' ' + (j.geo.isp || '')); } catch (e) { rec.probeErr = (pr.stdout || pr.stderr || '').slice(0, 200); }
    console.log(String(i + 1).padStart(2) + '. ' + String(rec.label).padEnd(28) + ' ← ' + node + '\n    出口=' + rec.exitIp + '  ' + (rec.geo || ''));

    if (!dry) {
      const tmp = path.join(OPS, 'oneexit-' + i + '.jsonl');
      fs.mkdirSync(OPS, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(acct) + '\n');
      const args = ['--in', tmp, '--concurrency', '1', '--proxy', 'http://127.0.0.1:' + port, '--login-proxy', 'http://127.0.0.1:' + port, '--keep'];
      const r = run('h3-batch-login.js', args);
      rec.ok = r.status === 0;
      rec.log = ((r.stdout || '') + (r.stderr || '')).slice(-400);
      console.log('    登录引擎退出码=' + r.status);
    }
    fs.appendFileSync(MAP, JSON.stringify(rec) + '\n');
  }
  if (prev) { run('exit-rotate.js', ['switch', prev.replace(/^当前出站节点\([^)]*\) = /, '')]); }
  console.log('\n映射表 -> ' + MAP);
})();