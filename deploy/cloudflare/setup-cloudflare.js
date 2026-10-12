'use strict';
/**
 * setup-cloudflare.js -- 一键把「域名 -> Cloudflare Email Routing -> Email Worker -> mailfarm /v1/ingest」配好
 *
 *   零依赖（只用 node:https + FormData 手搓 multipart）。
 *
 * 用法：
 *   node deploy/cloudflare/setup-cloudflare.js \
 *     --domain yunshudu.cyou \
 *     --ingest-url https://xxxx.trycloudflare.com/mailfarm/v1/ingest \
 *     --ingest-key <服务器 secrets.txt 里的 MAILFARM_INGEST_KEY> \
 *     [--token <CF_API_TOKEN> | 环境变量 CLOUDFLARE_API_TOKEN] \
 *     [--account <ACCOUNT_ID>] [--worker mailfarm-ingest] [--dry-run]
 *
 * 前置（必须先在 Cloudflare 后台做过）：
 *   1) 域名已加入 Cloudflare（Add a site），并把注册商处的 NS 改成 CF 给的两个 NS
 *   2) 状态变成 Active
 *   否则本脚本会明确报错告诉你缺哪步。
 *
 * 需要的 Token 权限（My Profile -> API Tokens -> Create Token -> 自定义）：
 *   - Zone / DNS            : Edit
 *   - Zone / Zone           : Read
 *   - Account / Workers Scripts : Edit
 *   - Zone / Email Routing Rules: Edit
 *   - Account / Account Settings: Read
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && process.argv[i + 1].charAt(0) !== '-') return process.argv[i + 1];
  if (process.argv.indexOf('--' + name) >= 0) return true;
  return def;
}
const DOMAIN = arg('domain', '');
const INGEST_URL = arg('ingest-url', '');
const INGEST_KEY = arg('ingest-key', '');
const TOKEN = arg('token', process.env.CLOUDFLARE_API_TOKEN || '');
const ACCOUNT = arg('account', '');
const WORKER = arg('worker', 'mailfarm-ingest');
const DRY = !!arg('dry-run', false);
const API = 'https://api.cloudflare.com/client/v4';

function req(method, url, body, headers) {
  return new Promise(function (res) {
    const u = new URL(url);
    const h = Object.assign({ 'authorization': 'Bearer ' + TOKEN, 'user-agent': 'yunshudu-cf-setup' }, headers || {});
    let data = null;
    if (body && typeof body === 'string') { data = Buffer.from(body); h['content-length'] = data.length; }
    else if (body && body.json) { data = Buffer.from(JSON.stringify(body.json)); h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    if (body && body.raw) { data = body.raw; h['content-type'] = body.ctype; h['content-length'] = data.length; }
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: method, headers: h, timeout: 30000 }, function (rr) {
      let b = [];
      rr.on('data', function (d) { b.push(d); });
      rr.on('end', function () {
        const txt = Buffer.concat(b).toString('utf8');
        let j = null; try { j = JSON.parse(txt); } catch (e) {}
        res({ status: rr.statusCode, json: j, text: txt });
      });
    });
    r.on('timeout', function () { r.destroy(); res({ status: 'TIMEOUT', text: 'timeout' }); });
    r.on('error', function (e) { res({ status: 'ERR', text: String(e.message) }); });
    if (data) r.write(data);
    r.end();
  });
}
function ok(label, r) {
  const good = r.json && r.json.success;
  console.log((good ? '  [v] ' : '  [x] ') + label + ' -> HTTP ' + r.status + (good ? '' : ' :: ' + String(r.text).slice(0, 300)));
  return good;
}
function plan(label) { console.log('  [ ] ' + label); }

(async function main() {
  console.log('=== Cloudflare 一键配置 mailfarm 收信 ===');
  console.log('域名        : ' + (DOMAIN || '(未指定)'));
  console.log('ingest URL  : ' + (INGEST_URL || '(未指定)'));
  console.log('ingest key  : ' + (INGEST_KEY ? 'len=' + INGEST_KEY.length : '(未指定)'));
  console.log('worker 名   : ' + WORKER);
  console.log('模式        : ' + (DRY ? 'DRY-RUN（只打印计划，不改任何东西）' : '真实执行'));
  console.log('');

  const miss = [];
  if (!DOMAIN) miss.push('--domain');
  if (!INGEST_URL) miss.push('--ingest-url');
  if (!INGEST_KEY) miss.push('--ingest-key');
  if (!TOKEN && !DRY) miss.push('--token 或环境变量 CLOUDFLARE_API_TOKEN');
  if (miss.length) {
    console.log('缺少参数: ' + miss.join(', '));
    console.log('');
    console.log('DRY-RUN 计划（补齐参数后按这个顺序执行）：');
    plan('GET  /zones?name=' + DOMAIN + '                     找 zone（拿 zone_id）');
    plan('GET  /accounts                                 找 account_id（或用 --account 指定）');
    plan('POST /zones/{zone}/email/routing/enable         开启 Email Routing（CF 会自动加 MX）');
    plan('POST /zones/{zone}/dns_records                 确保 TXT @ = "v=spf1 -all"');
    plan('PUT  /accounts/{acct}/workers/scripts/' + WORKER + '  上传 deploy/cloudflare/email-worker.js');
    plan('  bindings: MF_INGEST_URL=' + (INGEST_URL || '<url>') + ' , MF_INGEST_KEY=<secret>');
    plan('PUT  /accounts/{acct}/email/routing/rules/catch_all    Catch-all -> Worker ' + WORKER);
    plan('GET  /zones/{zone}/email/routing/rules/catch_all      复核');
    process.exit(2);
  }

  if (DRY) { console.log('DRY-RUN：参数齐全，真实执行时按下面顺序跑：'); plan('同上 7 步'); process.exit(0); }

  // 1) zone
  let r = await req('GET', API + '/zones?name=' + encodeURIComponent(DOMAIN));
  if (!ok('找 zone', r)) { console.log('\n提示：域名还没加到 Cloudflare？先去 Add a site 并把 NS 改成 CF 给的两个。'); process.exit(1); }
  const zone = r.json.result[0];
  if (zone.status !== 'active') console.log('  [!] zone status = ' + zone.status + '（不是 active，MX 可能还没生效，先等 NS 生效）');
  const zoneId = zone.id;
  console.log('  zone_id = ' + zoneId + ' status=' + zone.status);

  // 2) account
  let acctId = ACCOUNT;
  if (!acctId) {
    r = await req('GET', API + '/accounts?per_page=50');
    if (!ok('列 accounts', r)) process.exit(1);
    if (!r.json.result.length) { console.log('  [x] 没有可用 account'); process.exit(1); }
    acctId = r.json.result[0].id;
  }
  console.log('  account_id = ' + acctId);

  // 3) 开启 Email Routing
  r = await req('POST', API + '/zones/' + zoneId + '/email/routing/enable', { json: {} });
  ok('开启 Email Routing', r);

  // 4) SPF
  r = await req('GET', API + '/zones/' + zoneId + '/dns_records?type=TXT&name=' + encodeURIComponent(DOMAIN));
  const hasSpf = r.json && r.json.result && r.json.result.some(function (x) { return /v=spf1/i.test(x.content || ''); });
  if (hasSpf) { console.log('  [v] SPF 已存在'); }
  else {
    r = await req('POST', API + '/zones/' + zoneId + '/dns_records', { json: { type: 'TXT', name: DOMAIN, content: 'v=spf1 -all', ttl: 300, comment: 'mailfarm: 只收不发' } });
    ok('写入 TXT v=spf1 -all', r);
  }

  // 5) 上传 Worker
  const scriptPath = path.join(__dirname, 'email-worker.js');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const B = '----yunshudu' + Date.now();
  const metadata = {
    main_module: 'email-worker.js',
    compatibility_date: '2024-11-01',
    bindings: [
      { type: 'plain_text', name: 'MF_INGEST_URL', text: INGEST_URL },
      { type: 'secret_text', name: 'MF_INGEST_KEY', text: INGEST_KEY }
    ]
  };
  const parts = [
    '--' + B, 'Content-Disposition: form-data; name="metadata"', '', JSON.stringify(metadata),
    '--' + B, 'Content-Disposition: form-data; name="email-worker.js"; filename="email-worker.js"', 'Content-Type: application/javascript+module', '', script,
    '--' + B + '--', ''
  ];
  r = await req('PUT', API + '/accounts/' + acctId + '/workers/scripts/' + WORKER, { raw: Buffer.from(parts.join('\r\n')), ctype: 'multipart/form-data; boundary=' + B });
  ok('上传/更新 Worker ' + WORKER, r);

  // 6) catch-all -> worker
  r = await req('PUT', API + '/accounts/' + acctId + '/email/routing/rules/catch_all', {
    json: { name: 'mailfarm catch-all', enabled: true, matchers: [{ type: 'all' }], action: { type: 'worker', value: [WORKER] } }
  });
  ok('Catch-all 指向 Worker', r);

  // 7) 复核
  r = await req('GET', API + '/zones/' + zoneId + '/email/routing/rules/catch_all');
  if (r.json && r.json.result) {
    const a = r.json.result.action || {};
    console.log('  [v] 复核 catch-all: enabled=' + r.json.result.enabled + ' action=' + a.type + ' ' + JSON.stringify(a.value || ''));
  } else ok('复核 catch-all', r);

  const mx = await req('GET', API + '/zones/' + zoneId + '/dns_records?type=MX');
  if (mx.json && mx.json.result) {
    console.log('  MX 记录（Email Routing 自动加的）:');
    mx.json.result.forEach(function (x) { console.log('    ' + x.name + ' -> ' + x.content + ' prio=' + x.priority); });
  }
  console.log('');
  console.log('完成。接下来：');
  console.log('  1) 服务器上把该域名加进 MF_DOMAINS 并重启 mailfarm');
  console.log('  2) 发一封测试邮件到 test@' + DOMAIN + '，再查 /v1/mailboxes/test@' + DOMAIN + '/code');
  process.exit(0);
})();
