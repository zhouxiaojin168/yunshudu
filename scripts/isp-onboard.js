#!/usr/bin/env node
/**
 * isp-onboard.js -- 静态 ISP / 任意上游「一键接入 + 验活」
 *
 * 为什么需要：静态住宅 ISP 是养号/取CK/过风控的关键出口，
 *             但拿到凭据后必须先验「真静态 + 非 IDC + 能到目标站」，否则白挂。
 *
 * 用法：
 *   node scripts/isp-onboard.js add <port> "http://user:pass@host:port" [note]
 *   node scripts/isp-onboard.js verify <port>
 *   node scripts/isp-onboard.js status
 *
 * 判定：连打 3 次出口 IP —— 三次相同 ⇒ 真静态（>=2 次不同 ⇒ 轮换池，可用于其它用途但不能当静态号）
 *       出口 ASN/ISP 命中 IDC 关键词 ⇒ 标记为「数据中心 IP」（H3 注册易被风控）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { proxyFetch } = require('./h3-proxy-fetch');

const ROOT = path.resolve(__dirname, '..');
const STORE = path.join(ROOT, 'state', 'isp.json');
const IDC = /hosting|cloud|data ?cent|datacent|server|idc|amazon|aws|google|microsoft|azure|aliyun|alibaba|tencent|ovh|hetzner|digitalocean|linode|vultr|contabo|oracle|leaseweb|choopa|eons|m247|psychz|quadranet|colocrossing|frantech|buyvm|netcup|gcore|beget|selectel|timeweb|ihc/i;
const RESIDENTIAL = /residential|broadband|telecom|communications|comcast|verizon|at&t|spectrum|cox|charter|kddi|softbank|ntt|docomo|sk ?broadband|kt |lg u|cable|unlimited|home|isp/i;

function argval(i, dflt) { return process.argv[i] === undefined ? dflt : process.argv[i]; }
function load() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { return { items: [] }; } }
function save(o) { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(o, null, 2)); }

function classify(geo) {
  const text = [geo && geo.isp, geo && geo.org, geo && geo.as].filter(Boolean).join(' ');
  if (RESIDENTIAL.test(text) && !IDC.test(text)) return { kind: '住宅/宽带', risk: '低', why: 'ISP 关键词命中住宅/宽带运营商' };
  if (IDC.test(text)) return { kind: '数据中心(IDC)', risk: '高', why: 'ASN/ISP 命中 IDC 关键词：' + text };
  return { kind: '未知', risk: '中', why: '无明确 ISP 标签：' + (text || '(空)') };
}

async function exitOnce(via) {
  /* 首选 ip-api(http)（国内出口也可达），失败再试 ipify */
  try {
    const g = await proxyFetch('http://ip-api.com/json/?fields=status,query', { proxy: via, timeoutMs: 20000 });
    const gj = JSON.parse(g.body.toString('utf8'));
    if (gj && gj.query) return gj.query;
  } catch (e) { /* fallthrough */ }
  const r = await proxyFetch('https://api.ipify.org?format=json', { proxy: via, timeoutMs: 25000 });
  return JSON.parse(r.body.toString('utf8')).ip;
}

async function verify(port) {
  const via = 'http://127.0.0.1:' + port;
  const report = { port, via, at: new Date().toISOString(), ips: [], stable: null, geo: null, klass: null, reach: {}, ok: false };
  for (let i = 0; i < 3; i++) {
    try { report.ips.push(await exitOnce(via)); } catch (e) { report.ips.push('ERR:' + e.message); }
    await new Promise((r) => setTimeout(r, 400));
  }
  const good = report.ips.filter((x) => x && x.indexOf('ERR:') < 0);
  report.stable = good.length >= 2 && new Set(good).size === 1;
  if (good[0]) {
    try {
      const r2 = await proxyFetch('http://ip-api.com/json/' + good[0] + '?fields=status,country,regionName,city,isp,org,as,query,proxy,hosting', { proxy: via, timeoutMs: 20000 });
      report.geo = JSON.parse(r2.body.toString('utf8'));
      report.klass = classify(report.geo);
    } catch (e) { report.geo = { status: 'fail', error: e.message }; }
  }
  for (const [name, url] of [['hailuoai.video', 'https://hailuoai.video/zh-Intl'], ['google', 'https://www.google.com/'], ['ipify', 'https://api.ipify.org?format=json']]) {
    const t0 = Date.now();
    try { const r = await proxyFetch(url, { proxy: via, timeoutMs: 25000 }); report.reach[name] = { status: r.status, ms: Date.now() - t0 }; }
    catch (e) { report.reach[name] = { status: 0, ms: Date.now() - t0, err: e.message }; }
  }
  report.ok = report.stable && report.reach['hailuoai.video'] && report.reach['hailuoai.video'].status > 0 && report.reach['hailuoai.video'].status < 400;
  // 写库
  const db = load();
  const idx = db.items.findIndex((x) => x.port === port);
  if (idx >= 0) db.items[idx] = report; else db.items.push(report);
  save(db);

  console.log('== 通道 ' + via + ' 验活报告 ==');
  console.log('出口 IP 3 连打：' + report.ips.join('  |  '));
  console.log('静态判定    ：' + (report.stable ? '✅ 真静态（3 次同 IP）' : '❌ 非静态 / 或失败（轮换或断线）'));
  if (report.geo && report.geo.query) {
    console.log('落地        ：' + [report.geo.country, report.geo.regionName, report.geo.city].filter(Boolean).join(' '));
    console.log('ISP/ASN     ：' + (report.geo.isp || '-') + ' / ' + (report.geo.as || '-') + (report.geo.hosting ? '  [hosting=true]' : ''));
    console.log('类型判定    ：' + report.klass.kind + ' 风控=' + report.klass.risk + '  (' + report.klass.why + ')');
  }
  for (const k of Object.keys(report.reach)) { const r = report.reach[k]; console.log('可达 ' + k.padEnd(14) + '：' + (r.status || 'ERR') + '  ' + r.ms + 'ms' + (r.err ? ('  ' + r.err) : '')); }
  console.log('结论        ：' + (report.ok ? '✅ 可用于 H3/Dola 出口' : '⚠️ 不建议直接用于 H3（先看上面哪一步红）'));
  return report;
}

(async () => {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'add') {
    const port = Number(process.argv[3]);
    const upstream = process.argv[4];
    const note = process.argv[5] || '静态ISP';
    if (!port || !upstream) { console.log('用法: node scripts/isp-onboard.js add <port> "http://user:pass@host:port" [note]'); process.exit(1); }
    if (!/^(http|https|socks5(h)?):\/\//.test(upstream)) { console.log('上游必须以 http:// https:// socks5:// socks5h:// 开头'); process.exit(1); }
    const r = spawnSync(process.execPath, [path.join(__dirname, 'bridge-manager.js'), 'add', String(port), upstream, note], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
    await verify(port);
    return;
  }
  if (cmd === 'verify') { await verify(Number(process.argv[3] || 0) || (load().items[0] || {}).port); return; }
  if (cmd === 'status') {
    const db = load();
    if (!db.items.length) { console.log('还没有接入任何 ISP 通道。先跑：node scripts/isp-onboard.js add 17899 "http://user:pass@host:port"'); return; }
    for (const it of db.items) console.log(':' + it.port + '  ' + (it.ips && it.ips[0]) + '  ' + (it.geo && it.geo.country) + '  ' + (it.klass && it.klass.kind) + '  静态=' + it.stable + '  H3=' + (it.reach && it.reach['hailuoai.video'] && it.reach['hailuoai.video'].status));
    return;
  }
  console.log('用法: node scripts/isp-onboard.js [add|verify|status] …');
})();