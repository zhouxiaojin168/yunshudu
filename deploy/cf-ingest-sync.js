#!/usr/bin/env node
/**
 * cf-ingest-sync.js —— 让 Cloudflare Email Worker 的收货地址永远跟着当前隧道走。
 *
 * 为什么需要：quick tunnel(trycloudflare) 每次 cloudflared 重启都会换域名，
 *   而 CF Worker 只认写死的 URL —— 隧道一换，收信立刻断。
 *   本脚本每 5 分钟比对一次，发现不一致就自动改绑（幂等，无变更时零写入）。
 *
 * 运行位置：服务器（计划任务 yunshudu-cf-ingest-sync）
 * 依赖文件：
 *   C:\yunshudu\secrets\cf-token.txt                        CF API Token(Workers Scripts:Edit)
 *   C:\yunshudu\state\tunnel-url.txt                        tunnel-watch 维护的当前隧道
 *   C:\yunshudu\app\deploy\cf-email-worker-ingest.js        本仓同步下来的 Worker 源码
 *   C:\yunshudu\secrets.txt                                 MAILFARM_INGEST_KEY
 */
const fs = require('fs');
const path = require('path');
const API = 'https://api.cloudflare.com/client/v4';
const ROOT = process.env.CF_SYNC_ROOT || 'C:\\yunshudu';
const WORKER = process.env.CF_SYNC_WORKER || 'yunshudu-ingest';
const FALLBACK_IP = process.env.CF_SYNC_FALLBACK || 'http://114.66.16.225:8099/v1/ingest';
const F = {
  token: path.join(ROOT, 'secrets', 'cf-token.txt'),
  secretsTxt: path.join(ROOT, 'secrets.txt'),
  tunnel: path.join(ROOT, 'state', 'tunnel-url.txt'),
  workerSrc: path.join(ROOT, 'app', 'deploy', 'cf-email-worker-ingest.js'),
  fixed: path.join(ROOT, 'state', 'cf-ingest-fixed.txt'),
  log: path.join(ROOT, 'logs', 'cf-ingest-sync.log')
};
function log(m) {
  const line = '[' + new Date().toISOString() + '] ' + m;
  console.log(line);
  try { fs.appendFileSync(F.log, line + String.fromCharCode(10)); } catch (e) {}
}
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }
function firstLine(s) { return String(s).split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean)[0] || ''; }
function secretVal(name) {
  const t = readText(F.secretsTxt);
  const m = t.match(new RegExp('(?:^|\\n)\\s*' + name + '\\s*=\\s*([^\\r\\n]+)'));
  return m ? m[1].trim() : '';
}

(async function () {
  const token = firstLine(readText(F.token)) || secretVal('CF_API_TOKEN');
  if (!token) return log('SKIP no-token (' + F.token + ')');
  const tunnel = firstLine(readText(F.tunnel)).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(tunnel)) return log('SKIP bad-tunnel [' + tunnel + ']');
  const key = secretVal('MAILFARM_INGEST_KEY');
  if (!key) return log('SKIP no-ingest-key');
  const src = readText(F.workerSrc);
  if (!/export default/.test(src)) return log('SKIP no-worker-src ' + F.workerSrc);

  // 固定域名优先（命名隧道 ingest.qingzhou.autos）；没有固定域名才退回 quick tunnel
  const tunnelBase = tunnel + '/mailfarm/v1/ingest';
  const fixed = firstLine(readText(F.fixed)).replace(/\/+$/, '');
  const primary = /^https?:\/\//.test(fixed) ? fixed : tunnelBase;
  const list = [primary];
  if (tunnelBase !== primary) list.push(tunnelBase);
  if (list.indexOf(FALLBACK_IP) < 0) list.push(FALLBACK_IP);
  const want = { INGEST_URL: primary, INGEST_URLS: list.join(',') };

  const H = { Authorization: 'Bearer ' + token };
  let r = await fetch(API + '/accounts', { headers: H });
  const acc = await r.json();
  const accs = (acc && acc.result) || [];
  if (!accs.length) return log('FAIL accounts ' + r.status + ' ' + JSON.stringify(acc).slice(0, 160));
  const aid = accs[0].id;

  r = await fetch(API + '/accounts/' + aid + '/workers/services/' + WORKER + '/environments/production/bindings', { headers: H });
  const cur = await r.json();
  const map = {};
  ((cur && cur.result) || []).forEach(function (b) { if (b.type === 'plain_text') map[b.name] = b.text; });
  if (map.INGEST_URL === want.INGEST_URL && map.INGEST_URLS === want.INGEST_URLS) return log('OK unchanged (' + want.INGEST_URL + ')');

  const meta = {
    main_module: 'worker.js',
    compatibility_date: '2025-01-01',
    bindings: [
      { type: 'plain_text', name: 'INGEST_URL', text: want.INGEST_URL },
      { type: 'plain_text', name: 'INGEST_URLS', text: want.INGEST_URLS },
      { type: 'secret_text', name: 'INGEST_KEY', text: key }
    ]
  };
  const fd = new FormData();
  fd.set('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'metadata.json');
  fd.set('worker.js', new Blob([src], { type: 'application/javascript+module' }), 'worker.js');
  const up = await fetch(API + '/accounts/' + aid + '/workers/scripts/' + WORKER, { method: 'PUT', headers: H, body: fd });
  const body = await up.text();
  log((up.ok ? 'SYNCED ' : 'FAIL ') + up.status + ' -> ' + want.INGEST_URL + ' :: ' + body.slice(0, 160).replace(/\s+/g, ' '));
})();