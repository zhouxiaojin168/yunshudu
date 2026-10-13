#!/usr/bin/env node
/**
 * h3-refill.js —— H3 号厂「补号器」：把 h3-register.js 造出的号批量灌进平台池
 *
 * 依据（实证）：
 *   · h3-register.js 产出的 state jsonl 每行 = 一个号（含 token / uuid / site / credit / user / email）
 *   · 平台池（h3-platform-pool.js）号源入口：
 *       单号  POST <pool>/pool/accounts        {label, token, credits?}
 *       批量  POST <pool>/pool/accounts/bulk   {accounts:[{label, token, credits?}]}
 *       状态  GET  <pool>/pool/stats           （需 x-admin-key）
 *       签到  POST <pool>/pool/checkin
 *   · 池侧 token 约定：'<token>|<uuid>|<device_id>|<site>'，site ∈ {cn,intl}（hailuo-multi 适配器）
 *
 * 用法：
 *   node h3-refill.js                          # 把 state 里所有号灌进本机池(127.0.0.1:9940)
 *   node h3-refill.js --register 3             # 先造 3 个号，再造完自动灌池
 *   node h3-refill.js --state state/h3-accounts.jsonl --farm-out state/h3-farm.jsonl
 *   node h3-refill.js --pool http://127.0.0.1:9940 --key sk-hl-admin --site intl
 *   node h3-refill.js --checkin                # 灌完顺带触发一次池签到
 *   node h3-refill.js --dry                    # 只看要灌什么，不真发请求
 *
 * 环境变量：H3_POOL_URL / H3_POOL_KEY / H3_SITE / H3_STATE
 * 零依赖（node 内置）。
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
function argvVal(name, d) { const i = process.argv.indexOf(name); return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : d; }
function has(name) { return process.argv.indexOf(name) >= 0; }

const STATE = argvVal('--state', process.env.H3_STATE || path.join(ROOT, 'state', 'h3-accounts.jsonl'));
const FARM_OUT = argvVal('--farm-out', path.join(ROOT, 'state', 'h3-farm.jsonl'));
const POOL = String(argvVal('--pool', process.env.H3_POOL_URL || 'http://127.0.0.1:9940')).replace(/\/+$/, '');
const KEY = argvVal('--key', process.env.H3_POOL_KEY || 'sk-hl-admin');
const SITE = argvVal('--site', process.env.H3_SITE || 'intl');
const DRY = has('--dry');
const DO_CHECKIN = has('--checkin');
const REG_N = parseInt(argvVal('--register', '0'), 10) || 0;

function log() { console.log('[' + new Date().toISOString() + '] ' + Array.prototype.join.call(arguments, ' ')); }

function req(method, url, headers, bodyObj) {
  return new Promise(function (resolve) {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const body = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const h = Object.assign({ 'content-type': 'application/json' }, headers || {});
    if (body) h['content-length'] = String(body.length);
    const mod = isHttps ? https : http;
    const r = mod.request({ method: method, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search, headers: h }, function (res) {
      let b = ''; res.setEncoding('utf8');
      res.on('data', function (c) { b += c; });
      res.on('end', function () { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j, text: b }); });
    });
    r.on('error', function (e) { resolve({ status: 0, json: null, text: String(e.message) }); });
    if (body) r.write(body);
    r.end();
  });
}

function readAccounts() {
  if (!fs.existsSync(STATE)) { log('找不到 state 文件 ' + STATE); return []; }
  const lines = fs.readFileSync(STATE, 'utf8').split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const ln of lines) { try { const r = JSON.parse(ln); if (r && r.token) out.push(r); } catch (e) {} }
  return out;
}

function randGuid() { const h = require('crypto').randomBytes(16).toString('hex'); return [h.slice(0,8),h.slice(8,12),'4'+h.slice(13,16),(parseInt(h.slice(16,17),16)&3|8).toString(16)+h.slice(17,20),h.slice(20,32)].join('-'); }
function toPoolToken(rec) {
  const site = rec.site || SITE;
  /* R144b 实证：hailuoai.video 的请求必须带「显式 uuid」(任意合法 GUID 均可) 且「不带 device_id」；
     否则上游挂起 -> 池侧判定 PROBE_AUTH_FAILED。所以 uuid 缺失时随机补一个，device_id 一律留空。 */
  const uuid = rec.uuid || (rec.user && rec.user.deviceID) || randGuid();
  const dev = '';
  return String(rec.token) + '|' + uuid + '|' + dev + '|' + site;
}

(async function main() {
  log('pool=' + POOL + ' site=' + SITE + ' state=' + STATE + (DRY ? ' [DRY]' : ''));

  if (REG_N > 0 && !DRY) {
    log('== 先造号：h3-register.js --count ' + REG_N + ' ==');
    const reg = spawnSync(process.execPath, [path.join(__dirname, 'h3-register.js'), '--count', String(REG_N)], { stdio: 'inherit' });
    log('register exit=' + reg.status);
  }

  const accts = readAccounts();
  if (!accts.length) { log('state 里没有可用账号（无 token），结束'); return; }
  log('读到 ' + accts.length + ' 个号（含 token）');

  /* 1) 写 farm 文件（给 pool-supply 的 SUPP_FARM_FILE 用） */
  const farmLines = accts.map(function (r) { return JSON.stringify({ label: 'h3-' + (r.site || SITE) + '-' + (r.email || '').slice(0, 20), token: toPoolToken(r), credits: (r.credit && r.credit.totalCredits) || 0 }); });
  if (!DRY) { fs.mkdirSync(path.dirname(FARM_OUT), { recursive: true }); fs.writeFileSync(FARM_OUT, farmLines.join('\n') + '\n', 'utf8'); }
  log('farm 文件 -> ' + FARM_OUT + ' (' + farmLines.length + ' 行)');

  /* 2) 拉池状态，算增量 */
  const st = await req('GET', POOL + '/pool/stats', { 'x-admin-key': KEY });
  if (st.status !== 200 || !st.json) { log('池 /pool/stats 读不到：status=' + st.status + ' ' + String(st.text).slice(0, 160)); if (!DRY) return; }
  const have = new Set((((st.json || {}).accounts) || []).map(function (a) { return String(a.token); }));
  const batch = [];
  for (let i = 0; i < accts.length; i++) {
    const tok = toPoolToken(accts[i]);
    if (have.has(tok)) continue;
    const _c = (accts[i].credit && accts[i].credit.totalCredits) || 0;
    const _obj = { label: 'h3-' + (accts[i].site || SITE) + '-' + (accts[i].email || ('#' + (i + 1))).slice(0, 24), token: tok };
    if (_c > 0) _obj.credits = _c;   /* credits>0 才带上；省略则池侧自动探余额(probeWallet) */
    batch.push(_obj);
  }
  log('新号 ' + batch.length + ' 个（池里已有 ' + have.size + ' 个）');
  if (DRY) { batch.forEach(function (b) { log('  DRY + ' + b.label + ' token=' + b.token.slice(0, 24) + '...' + b.token.slice(-10)); }); return; }
  if (!batch.length) { log('没有新号要灌'); }

  /* 3) 批量灌池（老池没有 bulk 就退回单条） */
  for (const b of batch) {
    const r = await req('POST', POOL + '/pool/accounts', { 'x-admin-key': KEY }, b);
    log('  + ' + b.label + ' -> HTTP ' + r.status + ' ' + String(r.text).slice(0, 160));
  }

  /* 4) 可选：触发签到 */
  if (DO_CHECKIN) { const c = await req('POST', POOL + '/pool/checkin', { 'x-admin-key': KEY }, {}); log('checkin -> HTTP ' + c.status + ' ' + String(c.text).slice(0, 200)); }

  /* 5) 复核：池里每个号的 credits */
  const st2 = await req('GET', POOL + '/pool/stats', { 'x-admin-key': KEY });
  const acc = ((st2.json || {}).accounts) || [];
  log('=== 池现状（' + acc.length + ' 号）===');
  for (const a of acc) log('  #' + a.id + ' ' + a.label + ' credits=' + a.credits + ' healthy=' + a.healthy + ' site=' + String(a.token).split('|')[3] + ' token=' + String(a.token).slice(0, 18) + '...');
})();