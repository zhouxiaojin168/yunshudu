/**
 * probe-upstream.js -- 上游「探针」：把任意上游的 3 个接口探成池子能用的适配器配置
 *
 *   为什么需要它：池子只认 wallet / checkin / task 三个接口，但每家上游的
 *   地址、鉴权位置、返回字段名都不一样。这个脚本直接把「观测」变成「配置」。
 *
 *   用法（最常用）：
 *     node scripts/probe-upstream.js --base https://up.example.com --token <账号token> --all
 *
 *   常用参数：
 *     --base    上游 base url（必填）
 *     --token   上游账号 token（必填）
 *     --auth    token 放哪：bearer | body | header（默认 body）
 *     --field   body/header 模式下的字段名（默认 token）
 *     --wallet  钱包接口路径（默认 /official/v2/wallet）
 *     --checkin 签到接口路径（默认 /official/v2/checkin）
 *     --task    出片接口路径（默认 /official/v2/task）
 *     --model   出片探针用的模型名（默认 MiniMax-H3）
 *     --all     = 三个接口都探（签到会真的领一次额度，注意）
 *     --out     把猜好的适配器写到指定文件（默认只打印）
 *
 *   只读优先：默认只探 wallet（不消耗、不领额度）；--checkin / --task 才会真的动账户。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const LF = String.fromCharCode(10);

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  if (v === undefined || v.charAt(0) === '-') return true;
  return v;
}
const BASE = String(arg('base', '')).replace(/\/+$/, '');
const TOKEN = String(arg('token', ''));
const AUTH = String(arg('auth', 'body'));
const FIELD = String(arg('field', 'token'));
const P_WALLET = String(arg('wallet', '/official/v2/wallet'));
const P_CHECKIN = String(arg('checkin', '/official/v2/checkin'));
const P_TASK = String(arg('task', '/official/v2/task'));
const MODEL = String(arg('model', 'MiniMax-H3'));
const ALL = !!arg('all', false);
const OUT = arg('out', '');

if (!BASE || !TOKEN) {
  console.log('用法: node scripts/probe-upstream.js --base https://up.example.com --token <tok> [--auth bearer|body|header] [--all] [--out config/pool-adapter.real.json]');
  process.exit(2);
}

function buildInit(payload) {
  const headers = { 'content-type': 'application/json' };
  const body = Object.assign({}, payload || {});
  const t = body.token;
  delete body.token;
  if (t) {
    if (AUTH === 'bearer') headers['authorization'] = 'Bearer ' + t;
    else if (AUTH === 'header') headers[FIELD.toLowerCase()] = String(t);
    else body[FIELD] = t;
  }
  return { method: 'POST', headers: headers, body: JSON.stringify(body) };
}

async function call(p, payload) {
  const url = BASE + p;
  try {
    const r = await fetch(url, buildInit(payload));
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    return { url: url, status: r.status, json: j, raw: txt };
  } catch (e) {
    return { url: url, status: 0, json: null, raw: '<fetch 失败> ' + String(e && e.message || e) };
  }
}

/* 把 JSON 拍平成 [{path,key,value}]，深度 <= 3，用于猜字段 */
function flat(o, prefix, out, depth) {
  if (depth > 3 || o === null || typeof o !== 'object') return out;
  for (const k of Object.keys(o)) {
    const v = o[k];
    const p = prefix ? prefix + '.' + k : k;
    if (v !== null && typeof v === 'object') flat(v, p, out, depth + 1);
    else out.push({ path: p, key: k, value: v });
  }
  return out;
}
function find(items, reKey, reVal) {
  for (const it of items) {
    if (reKey && !reKey.test(it.key)) continue;
    if (reVal && !reVal.test(String(it.value))) continue;
    return it.path;
  }
  return undefined;
}
const NUM = /^-?[0-9]+(\.[0-9]+)?$/;

async function main() {
  console.log('== 探针 base=' + BASE + ' auth=' + AUTH + ' token=' + TOKEN.slice(0, 6) + '... ==');
  const guess = { wallet: {}, checkin: {}, task: {} };

  const w = await call(P_WALLET, { token: TOKEN });
  console.log('[' + w.status + '] wallet ' + w.url);
  console.log('  raw: ' + String(w.raw).slice(0, 600));
  if (w.json) {
    const items = flat(w.json, '', [], 0);
    const bal = find(items, /balance|credit|quota|remain|left|point|score/i, NUM) || find(items, /balance|credit|quota/i, undefined);
    if (bal) { guess.wallet.credits = bal; console.log('  -> 余额字段猜: ' + bal); }
    else console.log('  -> 没猜出余额字段，请人工看上面的 raw（候选：' + items.filter((x) => NUM.test(String(x.value))).map((x) => x.path).slice(0, 8).join(', ') + '）');
  }

  if (ALL || arg('checkin', false) === true) {
    const c = await call(P_CHECKIN, { token: TOKEN });
    console.log('[' + c.status + '] checkin ' + c.url + '   <-- 注意：这会真的领一次额度');
    console.log('  raw: ' + String(c.raw).slice(0, 600));
    if (c.json) {
      const items = flat(c.json, '', [], 0);
      const b = find(items, /before|old|prev|from/i, NUM);
      const a = find(items, /after|new|now|to|balance|credit/i, NUM);
      const d = find(items, /delta|add|reward|inc|gain/i, NUM);
      if (b) guess.checkin.credits_before = b;
      if (a) guess.checkin.credits_after = a;
      if (d) guess.checkin.delta = d;
      console.log('  -> before=' + (b || '?') + ' after=' + (a || '?') + ' delta=' + (d || '?'));
    }
  }

  if (ALL || arg('task', false) === true) {
    const payload = { token: TOKEN, model: MODEL, spec: { prompt: 'probe' }, cost: 0 };
    const t = await call(P_TASK, payload);
    console.log('[' + t.status + '] task ' + t.url + '  model=' + MODEL);
    console.log('  raw: ' + String(t.raw).slice(0, 800));
    if (t.json) {
      const items = flat(t.json, '', [], 0);
      const id = find(items, /task_?id|job_?id|request_?id|^id$|uid/i, undefined);
      const url = find(items, /url|video|result|output|download|file/i, /^https?:\/\//);
      const wb = find(items, /wallet.*before|before|old|prev/i, NUM);
      const wa = find(items, /wallet.*after|after|new|now/i, NUM);
      const dl = find(items, /wallet.*delta|delta|cost|paid|charge/i, NUM);
      if (id) guess.task.task_id = id;
      if (url) guess.task.result_url = url;
      if (wb) guess.task.wallet_before = wb;
      if (wa) guess.task.wallet_after = wa;
      if (dl) guess.task.delta = dl;
      console.log('  -> task_id=' + (id || '?') + ' url=' + (url || '?') + ' wallet=' + (wb || '?') + '/' + (wa || '?') + ' delta=' + (dl || '?'));
    }
  }

  const adapter = {
    _note: '由 scripts/probe-upstream.js 探测生成；base/path/auth/map 请以真上游实际返回为准。',
    name: 'real-upstream',
    base: BASE,
    auth: { type: AUTH, field: FIELD },
    endpoints: {
      wallet: { method: 'POST', path: P_WALLET, map: Object.assign({ credits: 'balance' }, guess.wallet) },
      checkin: { method: 'POST', path: P_CHECKIN, map: Object.assign({ credits_before: 'before', credits_after: 'after', delta: 'delta' }, guess.checkin) },
      task: { method: 'POST', path: P_TASK, map: Object.assign({ task_id: 'task_id', result_url: 'video_url', wallet_before: 'wallet.before', wallet_after: 'wallet.after', delta: 'wallet.delta' }, guess.task) }
    }
  };
  const txt = JSON.stringify(adapter, null, 2);
  console.log(LF + '== 建议的适配器配置（粘贴进 config/pool-adapter.real.json 即可）==');
  console.log(txt);
  if (typeof OUT === 'string' && OUT) {
    const f = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
    fs.writeFileSync(f, txt + LF, 'utf8');
    console.log('已写入: ' + f);
  }
  console.log(LF + '提示：池子用环境变量 H3P_UPSTREAM 覆盖 base，用 H3P_ADAPTER_FILE 指定本文件的路径。');
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
