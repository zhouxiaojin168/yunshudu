/**
 * add-maildomain.js -- 自有收信域「接入」工具（R144y 新增）
 *
 * 作用：把一个新自有域/子域从「DNS 现状体检」一路带到「写进我方配置 + 跑健康探针」，一条命令出结论。
 *
 * 用法：
 *   node scripts\add-maildomain.js --domain m1.qingzhou.autos
 *   node scripts\add-maildomain.js --domain m1.qingzhou.autos --write
 *   node scripts\add-maildomain.js --domain m1.qingzhou.autos --cf-zone qingzhou.autos --cf-token xxx --cf-routing --cf-worker yunshudu-ingest
 *   node scripts\add-maildomain.js --domain a.com,b.com --json
 *
 * 判定口径（收信通道）：
 *   MX = route1/2/3.mx.cloudflare.net  -> 通道 A（CF Email Routing catch-all -> Worker -> 我方 /v1/ingest）
 *   MX = 114.66.16.225                 -> 通道 C（直收；服务器机房封 25，默认不可用）
 *   MX = smtp.google.com/.googlemail   -> 通道 B（Google 邮箱 + IMAP 桥，需地址真实存在 RCPT 250）
 *   其它/无 MX                          -> 警告或 NEEDS_DNS
 *
 * 说明：解析走本机 DNS（UDP/53）。本机若挂系统代理，node 直连 DoH 会被挡，故不用 DoH。
 * 退出码：0 = 全部通过；2 = 有硬问题（外来域/无 NS/无收信面）；1 = 参数或运行错误
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const dns = require('dns').promises;

const ROOT = path.resolve(__dirname, '..');
const SERVICES = path.join(ROOT, 'services.json');
const HEALTH = path.join(ROOT, 'scripts', 'mail-domain-health.js');

/* R144y: 外来域硬黑名单（与 mail-compat-server.js 同一口径） */
const FOREIGN_DOMAINS = ['jixuwz.com', 'allen23.online', 'lopwi.cyou', 'sghd.college', 'ytu.baby'];
const OUR_IP = '114.66.16.225';
const INGEST_URL = 'http://' + OUR_IP + ':8099/v1/ingest';
const CF_ROUTING_MX = ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net', 'route3.mx.cloudflare.net'];

const argv = process.argv.slice(2);
function has(f) { return argv.indexOf(f) >= 0; }
function val(f, d) { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : (d === undefined ? '' : d); }

const DOMAINS = val('--domain', '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const JSON_OUT = has('--json');
const WRITE = has('--write');
const CF_TOKEN = val('--cf-token', process.env.CF_API_TOKEN || '');
const CF_ROUTING = has('--cf-routing');
const CF_WORKER = val('--cf-worker', '');
const CF_APPLY = has('--cf-apply');
const CF_ZONE_OVERRIDE = val('--cf-zone', '');

function say(m) { if (!JSON_OUT) console.log(m); }
function die(msg) { if (!JSON_OUT) console.log('FATAL: ' + msg); process.exit(1); }

/* R144y: 多解析器回退（本机 DNS 有负缓存/8.8.8.8 有 DNSSEC 残留时能扛住） */
const RESOLVERS = [[], ['1.1.1.1'], ['223.5.5.5']];
async function withResolvers(fn) {
  const orig = dns.getServers();
  try {
    for (const r of RESOLVERS) {
      try { if (r.length) dns.setServers(r); const v = await fn(); if (v && v.length) return v; }
      catch (e) { /* 换下一个 */ }
    }
    return [];
  } finally { try { dns.setServers(orig); } catch (e) {} }
}
async function resNs(d) { return withResolvers(function () { return dns.resolveNs(d); }); }
async function resMx(d) { return withResolvers(async function () { const r = await dns.resolveMx(d); return r.map(x => x.exchange + '(' + x.priority + ')'); }); }
async function resTxt(d) { return withResolvers(async function () { const r = await dns.resolveTxt(d); return r.map(a => a.join('')); }); }
function spfOf(list) { return (list || []).filter(t => /^v=spf1/i.test(t)); }
function dmarcOf(list) { return (list || []).filter(t => /^v=DMARC1/i.test(t)); }

function cfApi(method, p, body) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    if (!CF_TOKEN) return reject(new Error('no --cf-token'));
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({ host: 'api.cloudflare.com', port: 443, path: '/client/v4' + p, method, timeout: 20000,
      headers: Object.assign({ authorization: 'Bearer ' + CF_TOKEN }, payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) }, res => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(s) }); } catch (e) { resolve({ status: res.statusCode, raw: s }); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function runHealthProbe(d) {
  return new Promise(resolve => {
    const out = path.join(ROOT, 'runtime', '_add-maildomain-health-' + Date.now() + '.json');
    const c = cp.spawn(process.execPath, [HEALTH, '--domains', d, '--out', out, '--json', '--no-control'], { cwd: ROOT });
    let s = ''; c.stdout.on('data', x => s += x); c.stderr.on('data', x => s += x);
    c.on('close', () => {
      let doc = null; try { doc = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) {}
      try { fs.unlinkSync(out); } catch (e) {}
      resolve(doc && doc.domains && doc.domains[d] ? doc.domains[d] : { status: 'unknown', msg: 'probe failed: ' + s.slice(-160) });
    });
  });
}

function planFor(mx) {
  const mxL = mx.map(x => String(x).toLowerCase());
  if (mxL.some(x => CF_ROUTING_MX.some(c => x.indexOf(c) >= 0))) return { ch: 'A', how: 'Cloudflare Email Routing catch-all -> Worker -> POST ' + INGEST_URL };
  if (mxL.some(x => x.indexOf(OUR_IP) >= 0)) return { ch: 'C', how: 'MX 直指我方 ' + OUR_IP + '（服务器机房封 25，默认不可用）' };
  if (mxL.some(x => x.indexOf('google.com') >= 0 || x.indexOf('googlemail') >= 0)) return { ch: 'B', how: 'Google 邮箱 + IMAP 桥（地址须真实存在，RCPT 要 250）' };
  if (!mx.length) return { ch: '?', how: '无 MX：按所选通道补 MX（A=route1/2/3.mx.cloudflare.net）' };
  return { ch: '!', how: '收信面不可控（MX -> ' + mx.join(',') + '）；除非确认那台归你，否则别用' };
}

function cfIntentFor(zone, d, hasSpf, hasDmarc) {
  const out = [];
  out.push({ api: 'GET', path: '/zones?name=' + zone, why: '取 zone id' });
  /* 已有 SPF 就绝不动它（apex 上的 Google SPF 不能被 v=spf1 -all 顶掉） */
  if (!hasSpf) out.push({ api: 'POST', path: '/zones/{zone_id}/dns_records', body: { type: 'TXT', name: d, content: 'v=spf1 -all', ttl: 1 }, why: '只收不发 SPF（防冒名）' });
  else out.push({ api: 'SKIP', path: '/zones/{zone_id}/dns_records(TXT ' + d + ')', why: '已有 SPF，保持不动' });
  if (!hasDmarc) out.push({ api: 'POST', path: '/zones/{zone_id}/dns_records', body: { type: 'TXT', name: '_dmarc.' + d, content: 'v=DMARC1; p=none; rua=mailto:dmarc@' + zone, ttl: 1 }, why: 'DMARC 基线' });
  else out.push({ api: 'SKIP', path: '/zones/{zone_id}/dns_records(TXT _dmarc.' + d + ')', why: '已有 DMARC，保持不动' });
  if (CF_ROUTING) {
    out.push({ api: 'POST', path: '/zones/{zone_id}/email/routing/enable', why: '开 Email Routing（CF 自动写 MX）' });
    out.push({ api: 'PUT', path: '/zones/{zone_id}/email/routing/rules/catch_all',
      body: { enabled: true, name: 'catch-all', matchers: [{ type: 'all' }], actions: [{ type: CF_WORKER ? 'worker' : 'forward', value: [CF_WORKER || 'REPLACE_WITH_VERIFIED_MAILBOX'] }] },
      why: CF_WORKER ? ('catch-all -> Worker ' + CF_WORKER + ' -> POST ' + INGEST_URL) : 'catch-all -> 固定邮箱（必须已验证且你读得到）' });
  }
  return out;
}

function upsertServiceEnv(name, key, add) {
  const doc = JSON.parse(fs.readFileSync(SERVICES, 'utf8'));
  const svc = (doc.services || []).find(s => s.name === name);
  if (!svc) return { ok: false, why: 'service not found: ' + name };
  const cur = String((svc.env || {})[key] || '').split(',').map(s => s.trim()).filter(Boolean);
  const before = cur.slice();
  add.forEach(d => { if (cur.indexOf(d) < 0) cur.push(d); });
  if (cur.join(',') === before.join(',')) return { ok: true, changed: false, value: cur.join(',') };
  svc.env[key] = cur.join(',');
  const bak = SERVICES + '.bak-addmaildomain-' + Date.now();
  fs.copyFileSync(SERVICES, bak);
  fs.writeFileSync(SERVICES, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return { ok: true, changed: true, value: cur.join(','), backup: path.basename(bak) };
}

(async function main() {
  if (!DOMAINS.length) die('用法: node scripts\\add-maildomain.js --domain <域[,域2]> [--write] [--cf-token X --cf-routing --cf-worker NAME] [--json]');
  const report = { version: 1, checked_at: new Date().toISOString(), ours_ip: OUR_IP, ingest: INGEST_URL, domains: {}, cf_intent: [], writes: [] };
  let hard = 0;
  for (const d of DOMAINS) {
    const parts = d.split('.');
    const zone = CF_ZONE_OVERRIDE || (parts.length > 2 ? parts.slice(-2).join('.') : d);
    const rec = { domain: d, zone: zone, is_subdomain: d !== zone };
    if (FOREIGN_DOMAINS.some(f => d === f || d.endsWith('.' + f))) { rec.verdict = 'REJECT'; rec.why = '命中外来域黑名单（不属我方）'; hard++; }
    const [ns, mx, txt, dmarcTxt] = await Promise.all([resNs(d), resMx(d), resTxt(d), resTxt('_dmarc.' + d)]);
    const spf = spfOf(txt), dmarc = dmarcOf(dmarcTxt);
    rec.ns = ns; rec.mx = mx; rec.spf = spf.join(' | '); rec.dmarc = dmarc.join(' | ');
    const plan = planFor(mx);
    rec.channel = plan.ch; rec.how = plan.how;
    if (!rec.verdict) {
      if (!ns.length) { rec.verdict = 'NO_NS'; hard++; }
      else if (!mx.length || plan.ch === '!' || plan.ch === '?') { rec.verdict = 'NEEDS_DNS'; hard++; }
      else rec.verdict = 'DNS_OK';
    }
    if (!spf.length) rec.warn_spf = '缺 SPF（建议 v=spf1 -all）';
    if (!dmarc.length) rec.warn_dmarc = '缺 DMARC（建议 v=DMARC1; p=none; ...）';
    say('=== ' + d + '   (zone=' + zone + (rec.is_subdomain ? ', 子域' : '') + ')');
    say('  NS    : ' + (ns.join(',') || '(无)'));
    say('  MX    : ' + (mx.join(',') || '(无)'));
    say('  SPF   : ' + (spf.join(' | ') || '(缺)'));
    say('  DMARC : ' + (dmarc.join(' | ') || '(缺)'));
    say('  通道  : ' + plan.ch + ' -> ' + plan.how);
    if (rec.verdict === 'REJECT') { rec.health = { status: 'skipped', msg: '外来域，不消耗探针配额' }; say('  探针  : skipped（外来域不消耗发码配额）'); }
    else {
      rec.health = await runHealthProbe(d);
      say('  探针  : ' + rec.health.status + ' code=' + (rec.health.code === undefined ? '-' : rec.health.code) + ' ' + String(rec.health.msg || '').slice(0, 60));
    }
    if (rec.verdict === 'DNS_OK' && rec.health.status === 'blocked') say('  ⚠️ 目标平台已判 blocked —— 先别投入');
    say('  结论  : ' + rec.verdict + (rec.why ? ' (' + rec.why + ')' : ''));
    report.domains[d] = rec;
    report.cf_intent = report.cf_intent.concat(cfIntentFor(zone, d, spf.length > 0, dmarc.length > 0));
  }
  if (report.cf_intent.length) {
    say('\n=== Cloudflare ' + (CF_TOKEN ? (CF_APPLY ? '(apply)' : '(dry-run，加 --cf-apply 才真发请求)') : '(未提供 token，仅列清单)') + ' ===');
    for (const it of report.cf_intent) {
      say('  ' + it.api + ' ' + it.path + (it.body ? '  body=' + JSON.stringify(it.body) : ''));
      if (CF_TOKEN && CF_APPLY && it.api !== 'GET') {
        try { const r = await cfApi(it.api, it.path, it.body); say('    -> ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 140)); }
        catch (e) { say('    -> ERR ' + e.message); }
      }
    }
  }
  if (WRITE) {
    if (hard) say('\nWRITE 跳过：有 ' + hard + ' 个硬问题域');
    else {
      const ok = Object.keys(report.domains).filter(x => report.domains[x].verdict === 'DNS_OK');
      const w1 = upsertServiceEnv('mailfarm', 'MF_DOMAINS', ok);
      const w2 = upsertServiceEnv('mail-compat', 'COMPAT_DOMAINS', ok);
      say('\n=== 写入 services.json ===');
      say('  MF_DOMAINS     -> ' + JSON.stringify(w1));
      say('  COMPAT_DOMAINS -> ' + JSON.stringify(w2));
      report.writes = [w1, w2];
    }
  } else if (hard === 0) say('\n提示：加 --write 可把域写进 services.json（MF_DOMAINS / COMPAT_DOMAINS）');
  if (JSON_OUT) console.log(JSON.stringify(report, null, 1));
  process.exit(hard ? 2 : 0);
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
