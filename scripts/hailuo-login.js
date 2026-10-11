/**
 * hailuo-login.js -- 海螺「号源登录/接入器」（甲路：浏览器登一次 -> 把 token 接进池子；乙路：邮箱/短信登录接口 best-effort）
 *
 * 为什么这样设计（R88 实测结论）：
 *   1) 海螺网页端登录（国内 +86 短信 / 海外 邮箱·Google）**带风控**：裸 POST /v1/api/user/login/sms/send（即使字段齐全）返回
 *      HTTP 400 code=2「请求异常，请检查请求参数」，debugInfo 为空 —— 说明还缺浏览器侧的指纹/风控票据（Akamai ak_bmsc/bm_sz、yy_platform 等）。
 *      => 纯 curl 式短信登录**不可行**，必须走浏览器（真人一次）或补风控票据。
 *   2) 因此生产路径 = **浏览器登录一次 -> 抓 COMBO=<_token>|<uuid>|<device_id> -> 本脚本 ingest 进池子**。
 *      海外站支持 邮箱/Google 登录（**不需要接码**），是号池底料的首选（新人礼 150 credit，2 天到期）。
 *
 * 用法：
 *   # 1) 验号（只读：钱包/权益/模型，不花钱）
 *   node scripts/hailuo-login.js verify --combo "<token|uuid|device>" [--base https://hailuoai.video]
 *
 *   # 2) 接进池子（本地或服务器上的 h3-platform-pool）
 *   node scripts/hailuo-login.js add --combo "..." --pool http://127.0.0.1:9940 --admin sk-hl-... --label intl-2
 *   node scripts/hailuo-login.js add --file C:\path\tokens.txt --pool ... --admin ...   # 一行一个 combo，批量
 *
 *   # 3) 抓 COMBO 的小工具（把浏览器 console 里 copy(...) 出来的串贴进文件再 ingest）
 *   node scripts/hailuo-login.js console-snippet
 *
 *   # 4) 邮箱登录（best-effort，待真号验证；缺风控票据时必然 400）
 *   node scripts/hailuo-login.js email-send --email a@b.com [--base https://hailuoai.video]
 *   node scripts/hailuo-login.js email-login --email a@b.com --code 123456 [--base ...]
 */
'use strict';
const fs = require('node:fs');
const HS = require('./hailuo-sign.js');

const args = process.argv.slice(2);
const MODE = (args[0] || 'help').toLowerCase();
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const BASE = arg('base', 'https://hailuoai.video');
let COMBO = arg('combo', '');
const POOL = arg('pool', 'http://127.0.0.1:9940');
const ADMIN = arg('admin', process.env.H3P_ADMIN_KEY || '');
const LABEL = arg('label', 'hailuo');
const FILE = arg('file', '');
const OUT = arg('out', '');

async function call(path, method, body, raw) {
  const req = HS.buildSignedRequest({ url: path, method: method, body: body, raw: raw || COMBO, time: Date.now() });
  const init = { method: method, headers: req.headers };
  if (method !== 'GET') init.body = req.bodyString;
  let r, txt = '';
  try { r = await fetch(BASE + req.url, Object.assign(init, { signal: AbortSignal.timeout(30000) })); txt = await r.text(); }
  catch (e) { return { status: 0, text: e.message, json: null }; }
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { status: r.status, text: txt, json: j };
}

async function verify(combo) {
  const c = await call('/v1/api/billing/credit', 'GET', null, combo);
  const e2 = await call('/v1/api/user/equity', 'GET', null, combo);
  const u = await call('/v1/api/user/info', 'GET', null, combo);
  const cls = HS.classifyResponse(c.status, c.json);
  const credits = c.json && c.json.data ? c.json.data.total_credit : undefined;
  const models = e2.json && e2.json.data && Array.isArray(e2.json.data.modelControl) ? e2.json.data.modelControl.map((m) => m.modelId) : [];
  const name = u.json && u.json.data && u.json.data.userInfo ? (u.json.data.userInfo.name || u.json.data.userInfo.nickname || '') : '';
  return { ok: cls.ok, http: c.status, kind: cls.kind, credits: credits, models: models, name: name, raw: { credit: c.text, equity: e2.text, info: u.text } };
}

async function addToPool(combo, label) {
  if (!ADMIN) return { ok: false, reason: 'need --admin <H3P_ADMIN_KEY>' };
  const r = await fetch(POOL.replace(/\/+$/, '') + '/pool/accounts', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN },
    body: JSON.stringify({ label: label, token: combo })
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { ok: r.status === 200, http: r.status, body: j || t };
}

const SNIPPET = [
  '// 在 hailuoai.video（或 hailuoai.com）已登录的页面上，F12 -> Console -> 允许粘贴 -> 跑这一行：',
  'copy(localStorage.getItem(\'_token\')||document.cookie.match(/(?:^|; )_token=([^;]*)/)?.[1]||\'\')  // 注意：_token 在 Cookie 里',
  'copy(\'COMBO=\'+document.cookie.match(/(?:^|; )_token=([^;]*)/)[1]+\'|\'+localStorage.getItem(\'UNIQUE_USER_ID\')+\'|\'+localStorage.getItem(\'USER_HARD_WARE_INFO\'))',
  '// 然后把控制台输出（三段用 | 连接）粘进 tokens.txt，一行一个，再：',
  '//   node scripts/hailuo-login.js add --file tokens.txt --pool http://127.0.0.1:9940 --admin <KEY> --label batch-1'
].join('\n');

(async () => {
  if (MODE === 'console-snippet') { console.log(SNIPPET); return; }

  if (MODE === 'verify') {
    const list = FILE ? fs.readFileSync(FILE, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : (COMBO ? [COMBO] : []);
    if (!list.length) { console.log('用法: verify --combo "<token|uuid|device>" 或 --file tokens.txt'); return; }
    for (const one of list) {
      COMBO = one;
      const v = await verify(one);
      console.log('[verify] ' + (v.ok ? 'OK' : 'FAIL') + ' http=' + v.http + ' kind=' + v.kind + ' 用户=' + v.name + ' 余额=' + v.credits + ' 模型=' + v.models.length + ' 个');
      if (!v.ok) console.log('   raw: ' + JSON.stringify(v.raw.credit).slice(0, 200));
    }
    return;
  }

  if (MODE === 'add') {
    const list = FILE ? fs.readFileSync(FILE, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : (COMBO ? [COMBO] : []);
    if (!list.length) { console.log('用法: add --combo "..." | --file tokens.txt  [--pool ... --admin ... --label ...]'); return; }
    let i = 0;
    for (const one of list) {
      i++;
      COMBO = one;
      const v = await verify(one);
      if (!v.ok) { console.log('[add] 第 ' + i + ' 个 验号失败(' + v.kind + ')，跳过'); continue; }
      const r = await addToPool(one, LABEL + '-' + i);
      console.log('[add] 第 ' + i + ' 个 ' + (r.ok ? '已入池' : '失败') + ' 余额=' + v.credits + ' 模型=' + v.models.length + ' -> ' + JSON.stringify(r.body).slice(0, 260));
    }
    return;
  }

  if (MODE === 'email-send' || MODE === 'email-login') {
    const email = arg('email', '');
    if (!email) { console.log('用法: ' + MODE + ' --email a@b.com [--code 123456] [--base https://hailuoai.video]'); return; }
    const path = MODE === 'email-send' ? '/v1/api/user/login/email' : '/v1/api/user/login/email';
    const body = MODE === 'email-send' ? { email: email, type: 1 } : { email: email, code: arg('code', ''), type: 2 };
    /* 注意：token 为空也能发（登录前），签名器允许 raw='' */
    const r = await call(path, 'POST', body, arg('combo', ''));
    console.log('[email] POST ' + path + '  HTTP ' + r.status);
    console.log('  ' + r.text.slice(0, 400));
    console.log('  ⚠️ 若返回 code=2「请求异常」= 缺风控票据（同 sms/send），需浏览器侧或补 device/captcha 头；body 字段名待真号确认。');
    if (r.status === 200) console.log('  响应 set-cookie 里可能有 _token，请用浏览器 DevTools 确认。');
    return;
  }

  console.log([
    'hailuo-login.js 用法：',
    '  verify        --combo "<token|uuid|device>" [--base ...] [--file tokens.txt]   只读验号（钱包/权益/模型）',
    '  add           --combo "..." | --file tokens.txt --pool http://127.0.0.1:9940 --admin <H3P_ADMIN_KEY> [--label x]',
    '  console-snippet      打印浏览器 Console 抓 COMBO 的一行命令',
    '  email-send    --email a@b.com [--base https://hailuoai.video]                best-effort（缺风控票据会 400）',
    '  email-login   --email a@b.com --code 123456                                  best-effort'
  ].join('\n'));
})();
