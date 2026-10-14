#!/usr/bin/env node
/**
 * exit-multi.js -- 「并发多出口」网关管理器（多上游 × 并发流）
 *
 * 背景（R165 实测结论）：
 *   mihomo 单进程无论选「故障转移 / 自动选择 / 负载均衡」，8 并发请求出口 **只有 1 个 IP**。
 *   ⇒ 真并发多出口必须「多上游进程/多物理出口」，本脚本把已有出口池编排成并发流。
 *
 * 出口来源：
 *   ① state/bridges.json 里所有有上游的桥（17896→机场JP、17897→CN隧道、17899→机场JP…）
 *   ② 静态 ISP / 海外 VPS 网关（接进来后自动出现）
 *
 * 用法：
 *   node scripts/exit-multi.js exits                                  # 列出口
 *   node scripts/exit-multi.js health                                 # 并发体检所有出口（IP/国家/延迟/H3可达）
 *   node scripts/exit-multi.js assign --in state/h3-accounts.in.jsonl # 账号↔出口 轮转分配 → state/exit-plan.json
 *   node scripts/exit-multi.js run --plan state/exit-plan.json [--dry] # 每出口一条并发流，各自跑自己那批号
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { proxyFetch } = require('./h3-proxy-fetch');

const ROOT = path.resolve(__dirname, '..');
const OPTS = path.resolve(ROOT, '..', '_ops');
const BRIDGES = path.join(ROOT, 'state', 'bridges.json');
const PLAN = path.join(ROOT, 'state', 'exit-plan.json');

function argval(name, dflt) { const i = process.argv.indexOf('--' + name); if (i < 0) return dflt; const v = process.argv[i + 1]; return (v === undefined || v.indexOf('--') === 0) ? dflt : v; }
const has = (n) => process.argv.indexOf('--' + n) >= 0;

function bridges() {
  try { return JSON.parse(fs.readFileSync(BRIDGES, 'utf8')); } catch (e) { return []; }
}
function exitList(filter) {
  let list = bridges().filter((b) => b.upstream).map((b) => ({ name: (b.note || '').split(/[（(]/)[0].trim() || ('桥 ' + b.port), port: b.port, upstream: b.upstream, url: 'http://127.0.0.1:' + b.port }));
  if (filter && filter.length) list = list.filter((e) => filter.indexOf(String(e.port)) >= 0);
  return list;
}
async function probe(e) {
  const t0 = Date.now();
  const out = { port: e.port, name: e.name, ip: null, country: null, isp: null, ms: 0, h3: 0 };
  try {
    /* 首选 ip-api(http)：一步拿到 IP+geo，且在国内出口上比 ipify 稳 */
    const g = await proxyFetch('http://ip-api.com/json/?fields=status,country,regionName,city,isp,as,query,hosting', { proxy: e.url, timeoutMs: 20000 });
    const gj = JSON.parse(g.body.toString('utf8'));
    out.ip = gj.query; out.country = gj.country; out.city = gj.city || gj.regionName; out.isp = gj.isp || gj.as; out.hosting = !!gj.hosting;
    if (!out.ip) throw new Error('ip-api failed');
  } catch (err) {
    try { const r = await proxyFetch('https://api.ipify.org?format=json', { proxy: e.url, timeoutMs: 20000 }); out.ip = JSON.parse(r.body.toString('utf8')).ip; }
    catch (e2) { out.err = e2.message; }
  }
  try { const h = await proxyFetch('https://hailuoai.video/zh-Intl', { proxy: e.url, timeoutMs: 20000 }); out.h3 = h.status; } catch (e3) { out.h3 = 0; }
  out.ms = Date.now() - t0;
  return out;
}

(async () => {
  const cmd = process.argv[2] || 'exits';
  const filt = (argval('exits', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (cmd === 'exits') {
    const list = exitList(filt);
    console.log('可用出口 ' + list.length + ' 个：');
    for (const e of list) console.log('  :' + e.port + '  ' + e.name.padEnd(30) + ' 上游=' + e.upstream);
    return;
  }

  if (cmd === 'health') {
    const list = exitList(filt);
    console.log('并发体检 ' + list.length + ' 个出口…\n');
    const res = await Promise.all(list.map(probe));
    const ips = res.map((r) => r.ip).filter(Boolean);
    for (const r of res) console.log('  :' + r.port + '  ' + String(r.name).slice(0, 22).padEnd(24) + ' 出口=' + String(r.ip || '(失败)').padEnd(16) + ' ' + String(r.country || '').padEnd(14) + ' ' + String(r.city || '').padEnd(12) + ' H3=' + r.h3 + '  ' + r.ms + 'ms');
    console.log('\n去重后不同出口 IP = ' + new Set(ips).size + ' 个' + (new Set(ips).size > 1 ? '  ⇒ 可并发多出口 ✅' : '  ⇒ 只有 1 个真实出口（其它 IP 相同）'));
    return;
  }

  if (cmd === 'assign') {
    const inFile = argval('in', path.join(ROOT, 'state', 'h3-accounts.in.jsonl'));
    const accounts = fs.readFileSync(inFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    const list = exitList(filt);
    if (!list.length || !accounts.length) { console.log('出口或账号为空'); process.exit(1); }
    const streams = list.map((e) => ({ exit: e, accounts: [] }));
    accounts.forEach((a, i) => streams[i % streams.length].accounts.push(a));
    const plan = { at: new Date().toISOString(), source: inFile, streams: streams.map((s) => ({ port: s.exit.port, name: s.exit.name, upstream: s.exit.upstream, accounts: s.accounts })) };
    fs.writeFileSync(PLAN, JSON.stringify(plan, null, 2));
    console.log('分配完成：' + accounts.length + ' 账号 → ' + streams.length + ' 条并发流');
    for (const s of plan.streams) console.log('  :' + s.port + '  ' + s.name + '  ← ' + s.accounts.length + ' 号  (' + s.accounts.map((a) => a.label || a.email).join(', ') + ')');
    console.log('\n计划 -> ' + PLAN);
    return;
  }

  if (cmd === 'run') {
    const planFile = argval('plan', PLAN);
    const dry = has('dry');
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    fs.mkdirSync(OPTS, { recursive: true });
    console.log('并发跑 ' + plan.streams.length + ' 条流（每流一个独立出口）' + (dry ? '  [DRY]' : '') + '\n');
    const tasks = plan.streams.filter((s) => s.accounts.length).map((s) => new Promise((resolve) => {
      const f = path.join(OPTS, 'exitmulti-' + s.port + '.jsonl');
      const outF = path.join(OPTS, 'exitmulti-' + s.port + '.out.jsonl');
      const profD = s.profiles || path.join(ROOT, 'state', 'h3-profiles', 'exit-' + s.port);
      /* ★ R168 修：一号一出口 —— 把本流出口写进每个账号，浏览器出口 + 取CK改道都走它
         （h3-batch-login 的 --proxy 只在「新建实例」时生效，已存在实例会沿用旧 proxy_config.json） */
      const accs = s.accounts.map((a) => (a.proxy ? a : Object.assign({}, a, { proxy: 'http://127.0.0.1:' + s.port })));
      fs.writeFileSync(f, accs.map((a) => JSON.stringify(a)).join('\n') + '\n');
      /* ★ R168 修：每流独立 out + 独立档案目录，避免同账号/同 profile 并发撞车
         （原实现两流都用 H3-001 -> launchPersistentContext: browser has been closed） */
      const cli = [path.join(__dirname, 'h3-batch-login.js'), '--in', f, '--out', outF, '--profiles', profD,
        '--concurrency', String(s.accounts.length),
        '--proxy', (s.upstream || ('http://127.0.0.1:' + s.port)),
        '--login-proxy', 'http://127.0.0.1:' + s.port];
      if (has('keep')) cli.push('--keep');
      const tpl = s.template || plan.template;
      if (tpl) cli.push('--template', tpl);
      console.log('  :' + s.port + '  ' + s.name + '  → ' + s.accounts.length + ' 号  档案=' + profD);
      if (dry) { console.log('     in =' + f + '\n     out=' + outF + '\n     cmd=' + cli.join(' ')); return resolve({ port: s.port, code: 0, dry: true }); }
      const p = spawn(process.execPath, cli, { cwd: ROOT });
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.stderr.on('data', (d) => { out += d.toString(); });
      p.on('exit', (code) => {
        const keep = out.split('\n').filter((l) => /OK  |FAIL |结束|失败:/.test(l));
        console.log('  :' + s.port + ' 退出码=' + code + '\n' + keep.join('\n'));
        resolve({ port: s.port, code: code, out: outF });
      });
    }));
    const r = await Promise.all(tasks);
    console.log('\n汇总: ' + JSON.stringify(r));
    return;
  }

  console.log('用法: node scripts/exit-multi.js [exits|health|assign|run] …');
})();