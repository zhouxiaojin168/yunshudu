#!/usr/bin/env node
/**
 * exit-rotate.js -- 机场「出口池」轮换器（猫猫云 / 任意 mihomo・clash-meta 通用）
 *
 * 作用：把 mihomo 选择器组里的 100 个节点当成「可轮换海外出口池」——
 *       每个 H3/漫剧/Dola 账号登录前切一个节点 → 出口 IP 不同 → 天然「一号一出口」。
 *
 * 依赖：mihomo external-controller（猫猫云默认 http://127.0.0.1:9790）
 *      出口探针走本地桥（默认 http://127.0.0.1:17899），桥上游=127.0.0.1:10090
 *
 * 用法：
 *   node scripts/exit-rotate.js list [--region 美国] [--rate 0.5x]
 *   node scripts/exit-rotate.js current
 *   node scripts/exit-rotate.js switch "0.5x 🇺🇸 美国直连 US - 11"
 *   node scripts/exit-rotate.js probe
 *   node scripts/exit-rotate.js rotate --count 5 --region 美国 [--keep]
 *   node scripts/exit-rotate.js restore
 *
 * 环境变量：MIHOMO_API / EXIT_GROUP / EXIT_VIA / EXIT_OUT
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { proxyFetch } = require('./h3-proxy-fetch');

const ROOT = path.resolve(__dirname, '..');
const API = (process.env.MIHOMO_API || 'http://127.0.0.1:9790').replace(/\/+$/, '');
const GROUP = process.env.EXIT_GROUP || '猫猫云';
const VIA = process.env.EXIT_VIA || 'http://127.0.0.1:17899';
const OUT = process.env.EXIT_OUT || path.join(ROOT, 'state', 'exit-ips.jsonl');
const STATE = path.join(ROOT, 'state', 'exit-rotate.json');

function argval(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || String(v).indexOf('--') === 0) ? dflt : v;
}
const has = (n) => process.argv.indexOf('--' + n) >= 0;

async function apiGet(p) {
  const r = await fetch(API + p);
  if (!r.ok) throw new Error('mihomo ' + p + ' -> ' + r.status);
  return r.json();
}
async function apiPut(p, body) {
  const r = await fetch(API + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: (await r.text()).slice(0, 200) };
}
function saveState(o) { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(o, null, 2)); }
function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return {}; } }

function isFallback(name) { return /^(DIRECT|REJECT|GLOBAL|自动选择|故障转移|负载均衡|猫猫云)$/.test(name); }

async function listNodes(filter) {
  const p = await apiGet('/proxies');
  let names = Object.keys(p.proxies).filter((n) => !isFallback(n) && !Array.isArray(p.proxies[n].all));
  if (filter.region) names = names.filter((n) => n.indexOf(filter.region) >= 0);
  if (filter.rate) names = names.filter((n) => n.trim().indexOf(filter.rate) === 0);
  return { all: p, names };
}

async function current() {
  const p = await apiGet('/proxies');
  const g = p.proxies[GROUP];
  return g ? g.now : null;
}

async function probe(via) {
  via = via || VIA;
  const t0 = Date.now();
  let ip = null, geo = null, err = null;
  try {
    const r = await proxyFetch('https://api.ipify.org?format=json', { proxy: via, timeoutMs: 20000 });
    ip = JSON.parse(r.body.toString('utf8')).ip;
  } catch (e) { err = e.message; }
  if (ip) {
    try {
      const r2 = await proxyFetch('http://ip-api.com/json/' + ip + '?fields=status,country,regionName,city,isp,org,as,query', { proxy: via, timeoutMs: 20000 });
      geo = JSON.parse(r2.body.toString('utf8'));
    } catch (e) { /* geo 可选 */ }
  }
  return { via, ip, geo, ms: Date.now() - t0, err };
}

async function restoreNode() {
  const st = loadState();
  if (!st.prev) return null;
  const g = await current();
  if (g === st.prev) return st.prev;
  await apiPut('/proxies/' + encodeURIComponent(GROUP), { name: st.prev });
  return st.prev;
}

(async () => {
  const cmd = process.argv[2] || 'list';
  const filter = { region: argval('region', ''), rate: argval('rate', '') };

  if (cmd === 'list') {
    const { names } = await listNodes(filter);
    const byRegion = {};
    for (const n of names) {
      const parts = n.split(/\s+/);
      const key = (parts[1] || '其他').replace('直连', '') || '其他';
      (byRegion[key] = byRegion[key] || []).push(n);
    }
    console.log('选择器组 ' + GROUP + ' 可用节点 ' + names.length + ' 个：');
    for (const k of Object.keys(byRegion)) console.log('  [' + k + '] ' + byRegion[k].length + '  ' + byRegion[k].slice(0, 2).join(' / '));
    console.log('\n提示：rotate --count N [--region 美国] 会自动轮换并记录出口 IP');
    return;
  }

  if (cmd === 'current') { console.log('当前出站节点(' + GROUP + ') = ' + (await current())); return; }

  if (cmd === 'switch') {
    const name = process.argv[3];
    if (!name) { console.log('用法: node scripts/exit-rotate.js switch "<节点名>"'); process.exit(1); }
    const st = loadState();
    if (!st.prev) { st.prev = await current(); saveState(st); }
    const r = await apiPut('/proxies/' + encodeURIComponent(GROUP), { name });
    console.log('switch ' + name + ' -> HTTP ' + r.status + (r.text ? (' ' + r.text) : ''));
    console.log('current = ' + (await current()));
    return;
  }

  if (cmd === 'probe') { console.log(JSON.stringify(await probe(argval('via', '')), null, 2)); return; }

  if (cmd === 'restore') { console.log('已恢复到 ' + (await restoreNode())); return; }

  if (cmd === 'rotate') {
    const count = Number(argval('count', 3));
    const via = argval('via', '') || VIA;
    const { names } = await listNodes(filter);
    if (!names.length) { console.log('没有匹配节点'); process.exit(1); }
    const st = loadState();
    const prev = await current();
    if (!has('keep')) { st.prev = st.prev || prev; saveState(st); }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const n = Math.min(count, names.length);
    console.log('轮换 ' + n + ' 个出口（组=' + GROUP + '，探针=' + via + '，原节点=' + prev + '）\n');
    for (let i = 0; i < n; i++) {
      const node = names[i];
      const sw = await apiPut('/proxies/' + encodeURIComponent(GROUP), { name: node });
      await new Promise((r) => setTimeout(r, 700));
      let p = await probe(via);
      if (!p.ip) { await new Promise((r) => setTimeout(r, 1200)); p = await probe(via); }
      const rec = { at: new Date().toISOString(), node, ip: p.ip, country: p.geo && p.geo.country, city: p.geo && (p.geo.city || p.geo.regionName), isp: (p.geo && (p.geo.isp || p.geo.org)) || null, as: p.geo && p.geo.as, ms: p.ms, err: p.err };
      fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
      console.log(String(i + 1).padStart(2) + '. ' + node + '\n    出口=' + (rec.ip || '(失败)') + '  ' + (rec.country || '') + ' ' + (rec.city || '') + '  ' + (rec.isp || '') + '  ' + rec.ms + 'ms');
    }
    if (!has('keep')) { await apiPut('/proxies/' + encodeURIComponent(GROUP), { name: prev }); console.log('\n已恢复原节点 = ' + prev + '  （--keep 可保留最后切换的节点）'); }
    console.log('记录 -> ' + OUT);
    return;
  }

  console.log('用法: node scripts/exit-rotate.js [list|current|switch|probe|rotate|restore] …');
})();