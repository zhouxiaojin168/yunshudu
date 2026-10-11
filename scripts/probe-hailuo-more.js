/**
 * probe-hailuo-more.js -- 乙路深度探针（真号，只读 GET）
 *   node scripts/probe-hailuo-more.js --token "<_token>|<uuid>|<device_id>" [--out <dir>]
 * 作用：把「额度 / 权益 / 模型清单 / 算力包价格 / 订阅价格 / 明细」一次性拉全，
 *      原始 JSON 落盘（不进仓库），控制台只打印字段路径 + 关键数值。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const HS = require('./hailuo-sign.js');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const RAW = arg('token', '');
const OUT = arg('out', path.join(process.cwd(), 'tmp', 'hailuo-live'));
const BASE = arg('base', 'https://hailuoai.com');

const GETS = [
  ['credit', '/v1/api/billing/credit'],
  ['equity', '/v1/api/user/equity'],
  ['subscription', '/v1/api/user/subscription'],
  ['credit_combo', '/v2/api/charge/credit_combo'],
  ['web_sub', '/v2/api/charge/web/sub'],
  ['monthly_gift_eligible', '/v1/api/charge/monthly_gift_eligible'],
  ['transactions_give', '/v1/api/billing/transactions?page=1&page_size=20&transaction_type=3'],
];

function walk(o, pre, out) {
  if (o === null || typeof o !== 'object') { out.push(pre + ' = ' + JSON.stringify(o)); return out; }
  for (const k of Object.keys(o)) {
    const v = o[k], p = pre ? pre + '.' + k : k;
    if (v !== null && typeof v === 'object') walk(v, p, out); else out.push(p + ' = ' + JSON.stringify(v));
  }
  return out;
}

(async () => {
  if (!RAW) { console.log('用法: node scripts/probe-hailuo-more.js --token "<token|uuid|device>"'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, url] of GETS) {
    const req = HS.buildSignedRequest({ url: url, method: 'GET', raw: RAW, time: Date.now() });
    let r, txt = '', j = null;
    try {
      r = await fetch(BASE + req.url, { method: 'GET', headers: req.headers, signal: AbortSignal.timeout(20000) });
      txt = await r.text();
      try { j = JSON.parse(txt); } catch (e) { j = null; }
    } catch (e) { console.log('### ' + name + ' 网络错误 ' + e.message); continue; }
    fs.writeFileSync(path.join(OUT, name + '.json'), txt, 'utf8');
    const cls = HS.classifyResponse(r.status, j);
    console.log('\n### ' + name + '  GET ' + url);
    console.log('    HTTP ' + r.status + ' | code=' + (j && j.statusInfo ? j.statusInfo.code : 'n/a') + ' | ' + (cls.ok ? 'OK' : cls.kind) + ' | bytes=' + txt.length);
    if (j) { const ps = walk(j, '', []); console.log('    ' + ps.length + ' 个叶字段' + (ps.length > 120 ? '（只打印前 120）' : '')); console.log('      ' + ps.slice(0, 120).join('\n      ')); }
    else console.log('    原始(前 300): ' + txt.slice(0, 300));
  }
  console.log('\n原始 JSON 已落盘: ' + OUT);
})();