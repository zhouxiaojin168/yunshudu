#!/usr/bin/env node
/**
 * h3-batch-login.js -- 海螺 H3「批量登录」引擎（Dola 取CK 形状的复刻）
 *
 * 逆向对位（docs/豆啦啦浏览器-登录原理逆向(R142).md §3.2 / §3.3 / §4）：
 *   Dola 取CK 每号 5 步  →  本引擎每号 5 步：
 *     ① 建/复用实例 profile（指纹 + 代理，Dola §3.1 同构字段）
 *     ② 打开 https://hailuoai.video/zh-Intl（先注入指纹 init script）
 *     ③ 登录   refresh=Firebase refreshToken→idToken→POST /v1/api/user/login
 *              email  =发码(login/sms/send 带 email)→mailfarm 读码→login/email
 *              token  =已有 _token 直接校验（等价 Dola「换CK」的「写入新号」）
 *     ④ 校验   /v1/api/user/info + /user/equity + /billing/credit（拿额度）
 *     ⑤ 落库   profile/login_state.json（=Dola 的 cookies.json）+ 输出 jsonl + 可选 --push 进池
 *
 *   Dola「一键取CK」→ 本引擎「--in <jsonl> 批量跑、失败重试、并发 N」
 *   Dola「换CK」    → 本引擎 `--swap --profile H3-00N --token <t>`（清旧号写新号）
 *   Dola「一号一出口」→ 每个实例自带 proxy_config.json，登录走实例自己的代理
 *   Dola「多实例并发」→ --concurrency N，N 个独立 profile 同时跑，互不共享 cookie/localStorage
 *
 * 用法：
 *   # 造实例
 *   node scripts/h3-profile-factory.js --n 3 --proxy http://127.0.0.1:10090
 *   # 批量登录（账号清单 jsonl）
 *   node scripts/h3-batch-login.js --in state/h3-accounts.in.jsonl --concurrency 3 \
 *        --template "E:\中转站测试\_ops\pw-prof-headed" --keep
 *   # 换号（把新号写进 H3-002）
 *   node scripts/h3-batch-login.js --swap --profile H3-002 --label h3-150 --token <_token>
 *   # 登录完直接推池
 *   node scripts/h3-batch-login.js --in ... --push --pool http://127.0.0.1:9950 --admin-key <key>
 *
 * 账号清单每行一个 JSON：
 *   {"label":"h3-a","kind":"refresh","email":"x@gmail.com","refreshToken":"AMf-vB..."}
 *   {"label":"h3-b","kind":"email","email":"hlh3xxx@qingzhou.autos"}
 *   {"label":"h3-c","kind":"token","token":"eyJhbGciOi..."}
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const PW = process.env.PW_DIR || 'D:\\破甲\\1\\OpenAI.Codex_26.715.3651.0_x64(免安装版 适合大多数电脑)\\.codex\\skills\\openai-security-review\\node_modules\\playwright';
const { chromium } = require(PW);
const factory = require('./h3-profile-factory.js');

const ROOT = path.resolve(__dirname, '..');
const MD5LIB = (() => { try { return fs.readFileSync(path.join(__dirname, 'h3-md5.js'), 'utf8'); } catch (e) { return ''; } })();
const CHROME = process.env.CHROME_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APIKEY = process.env.H3_FB_KEY || 'AIzaSyB-sV2YX_07UuZTGxpOEcjDHBqoihz1zs0';
const SITE = process.env.H3_SITE_URL || 'https://hailuoai.video/zh-Intl';
const SECRETS = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'secrets.local.json'), 'utf8')); } catch (e) { return {}; } })();
const MF_BASE = process.env.MF_BASE || (SECRETS.mailfarm && SECRETS.mailfarm.base) || 'http://114.66.16.225:8099';
const MF_KEY = process.env.MF_KEY || (SECRETS.mailfarm && SECRETS.mailfarm.key) || '';
const NL = String.fromCharCode(10);

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || String(v).indexOf('--') === 0) ? true : v;
}
const has = (name) => process.argv.indexOf('--' + name) >= 0;

const OPTS = {
  inFile: arg('in', null),
  outFile: arg('out', path.join(ROOT, 'state', 'h3-accounts.out.jsonl')),
  profilesDir: path.resolve(arg('profiles', path.join(ROOT, 'state', 'h3-profiles'))),
  template: arg('template', null),
  concurrency: Number(arg('concurrency', 1)),
  headless: String(arg('headless', 'false')) === 'true',
  proxy: arg('proxy', 'http://127.0.0.1:10090'),
  timeoutMs: Number(arg('timeout', 90000)),
  keep: has('keep'),
  push: has('push'),
  pool: arg('pool', 'http://127.0.0.1:9950'),
  adminKey: arg('admin-key', process.env.SUPP_ADMIN_KEY || 'sk-hl-admin'),
  swap: has('swap'),
  sub: arg('sub', null)          // 只跑前 N 个
};

let seq = 0;
function log(tag, msg) { console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + tag + ' ' + msg); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------------- mailfarm（邮箱号源，走 node 侧，避免页面 https→http 混合内容拦截） ---------------- */
function mfReq(method, p, body) {
  const u = new URL(MF_BASE);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise(res => {
    const d = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { 'content-type': 'application/json' };
    if (MF_KEY) h['x-api-key'] = MF_KEY;
    if (d) h['content-length'] = d.length;
    const r = mod.request({ host: u.hostname, port: u.port || 80, path: p, method: method, headers: h }, rsp => {
      let b = ''; rsp.on('data', x => b += x); rsp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ s: rsp.statusCode, json: j, raw: b.slice(0, 200) }); });
    });
    r.on('error', e => res({ s: 0, json: null, raw: 'ERR ' + e.code }));
    if (d) r.write(d); r.end();
  });
}
async function acquireMailbox(prefix, domain) {
  const r = await mfReq('POST', '/v1/mailboxes/acquire', { prefix: prefix || 'hlh3', domain: domain || 'qingzhou.autos' });
  if (!r.json || !r.json.address) throw new Error('mailbox acquire failed: ' + JSON.stringify(r.json || r.raw));
  return r.json.address;
}
async function waitMailCode(address, timeoutMs) {
  const dl = Date.now() + (timeoutMs || 150000);
  while (Date.now() < dl) {
    const r = await mfReq('GET', '/v1/mailboxes/' + encodeURIComponent(address) + '/code');
    if (r.json && r.json.code) return r.json.code;
    await sleep(2500);
  }
  return null;
}

/* ---------------- 实例 ---------------- */
function ensureInstance(index) {
  ensureDir(OPTS.profilesDir);
  const pad = String(index + 1).padStart(3, '0');
  const id = 'H3-' + pad;
  const dir = path.join(OPTS.profilesDir, id);
  if (!fs.existsSync(path.join(dir, 'fingerprint_config.json'))) {
    factory.makeInstances(index + 1, { out: OPTS.profilesDir, proxy: OPTS.proxy });
  }
  return { id: id, dir: dir };
}
function cloneTemplate(src, dst) {
  ensureDir(dst);
  const src2 = path.resolve(src);
  const dst2 = path.resolve(dst);
  if (!fs.existsSync(src2)) { log('[模板]', '不存在，跳过克隆: ' + src2); return false; }
  fs.cpSync(src2, dst2, { recursive: true, force: false, errorOnExist: false });
  return true;
}

/* ---------------- 单号：Dola 五步 ---------------- */
async function loginOne(acct, index) {
  const tag = '[' + (acct.label || ('#' + index)) + ']';
  const inst = ensureInstance(index);
  const fp = factory.loadFingerprint(inst.dir);
  const px = factory.loadProxy(inst.dir);
  const record = { label: acct.label || inst.id, kind: acct.kind || 'refresh', email: acct.email || '', profile: inst.id, profile_dir: inst.dir, started: new Date().toISOString(), ok: false, steps: [] };
  const step = (n, m, extra) => { record.steps.push({ n: n, m: m, at: new Date().toISOString(), extra: extra || null }); log(tag, '步骤' + n + ' ' + m + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 240) : '')); };

  /* ① 建实例 profile */
  if (OPTS.template && !fs.existsSync(path.join(inst.dir, 'Default'))) {
    const okc = cloneTemplate(OPTS.template, inst.dir);
    step('①', '克隆模板档案(继承 Akamai 信任态) ' + (okc ? 'ok' : 'skip'), { template: OPTS.template });
  }
  step('①', '实例就绪 profile=' + inst.id + ' ua=' + fp.ua.id + ' tz=' + fp.timezone + ' proxy=' + (px && px.enabled ? px.host + ':' + px.port : 'off'));

  const pwProxy = factory.proxyToPlaywright(px);
  let ctx = null;
  try {
    ctx = await chromium.launchPersistentContext(inst.dir, {
      executablePath: CHROME,
      headless: OPTS.headless,
      ignoreDefaultArgs: ['--enable-automation', '--no-startup-window'],
      proxy: pwProxy ? { server: pwProxy.server, username: pwProxy.username, password: pwProxy.password } : undefined,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled',
        '--window-position=-32000,-32000', '--window-size=' + Math.max(1024, Math.min(1600, fp.screen.width)) + ',' + Math.max(700, Math.min(900, fp.screen.height)),
        '--no-first-run', '--no-default-browser-check', '--lang=' + fp.javascriptFingerprint.languages[0]],
      locale: fp.javascriptFingerprint.languages[0],
      timezoneId: fp.timezone,
      userAgent: fp.ua.userAgent,
      viewport: { width: Math.min(1600, fp.screen.width), height: Math.min(900, fp.screen.height) }
    });
    ctx.setDefaultTimeout(OPTS.timeoutMs);
    await ctx.addInitScript(factory.buildInitScript(fp));
    const page = await ctx.newPage();
    page.setDefaultTimeout(OPTS.timeoutMs);

    /* ② 打开站点 */
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: OPTS.timeoutMs });
    await sleep(3500);
    await page.addScriptTag({ content: MD5LIB });
    /* 指纹实测（证明实例隔离真的生效） */
    const fpSeen = await page.evaluate(() => {
      let gl = '', gv = '', ch = '';
      try { const c = document.createElement('canvas'); c.width = 240; c.height = 60; const x = c.getContext('2d');
        x.textBaseline = 'top'; x.font = '15px Arial'; x.fillStyle = '#f60'; x.fillRect(0, 0, 120, 20); x.fillStyle = '#069'; x.fillText('h3-batch-fp', 2, 2);
        ch = (c.toDataURL().slice(-48)) + '|' + Array.prototype.join.call(x.getImageData(0, 0, 1, 1).data, ',');
        const g = document.createElement('canvas').getContext('webgl');
        if (g) { const dbg = g.getExtension('WEBGL_debug_renderer_info');
          gv = dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : g.getParameter(37445);
          gl = dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g.getParameter(37446); }
      } catch (e) {}
      return { webdriver: navigator.webdriver, platform: navigator.platform, languages: (navigator.languages || []).join(','),
        hw: navigator.hardwareConcurrency, dm: navigator.deviceMemory, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        uaData: navigator.userAgentData ? navigator.userAgentData.platform : null, webglVendor: gv, webglRenderer: gl, canvas: ch };
    }).catch(e => ({ err: e.message }));
    record.fpSeen = fpSeen;
    step('②', '站点已开，指纹实测', fpSeen);

    /* ③ 登录 */
    let token = null, loginData = null, resp = null;
    if (acct.kind === 'token' && acct.token) {
      token = acct.token;
      step('③', 'token 直灌（等价 Dola 换CK 写入新号）', { tokenLen: token.length });
    } else if (acct.kind === 'email') {
      const email = acct.email || await acquireMailbox(acct.prefix, acct.domain);
      const send = await page.evaluate(async ({ email }) => {
        const body = { phone: '', email: email, ticket: '', randStr: '' };
        const s = window.__signed('/v1/api/user/login/sms/send', 'POST', body);
        const r = await fetch(s.url, { method: 'POST', headers: { token: '', yy: s.yy, 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
        return { status: r.status, body: (await r.text()).slice(0, 600) };
      }, { email });
      step('③a', '发码 email=' + email, { status: send.status });
      const code = await waitMailCode(email, 150000);
      if (!code) throw new Error('邮箱验证码超时 ' + email);
      const lg = await page.evaluate(async ({ email, code }) => {
        const body = { email: email, code: code };
        const s = window.__signed('/v1/api/user/login/email', 'POST', body);
        const r = await fetch(s.url, { method: 'POST', headers: { token: '', yy: s.yy, 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
        return { status: r.status, body: (await r.text()).slice(0, 1200) };
      }, { email, code });
      resp = lg;
      try { loginData = JSON.parse(lg.body).data; } catch (e) {}
      record.email = email;
      step('③b', '邮箱登录 HTTP ' + lg.status, { userID: loginData && loginData.userID, isRegister: loginData && loginData.isRegister });
    } else {
      const rt = acct.refreshToken || acct.refresh_token;
      if (!rt) throw new Error('缺少 refreshToken');
      const ex = await page.evaluate(async ({ rt, key }) => {
        const r = await fetch('https://securetoken.googleapis.com/v1/token?key=' + key, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt)
        });
        const j = await r.json();
        return { status: r.status, id_token: j.id_token || null, error: j.error ? (j.error.message || JSON.stringify(j.error)) : null };
      }, { rt: rt, key: APIKEY });
      if (!ex.id_token) throw new Error('refresh 换 idToken 失败: ' + (ex.error || ex.status));
      const idToken = ex.id_token;
      const lg = await page.evaluate(async ({ idToken }) => {
        const body = { loginType: 1, authToken: idToken };
        const s = window.__signed('/v1/api/user/login', 'POST', body);
        const r = await fetch(s.url, { method: 'POST', headers: { token: '', yy: s.yy, 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
        return { status: r.status, body: (await r.text()).slice(0, 1500) };
      }, { idToken });
      resp = lg;
      try { loginData = JSON.parse(lg.body).data; } catch (e) {}
      step('③', 'refresh→idToken→login HTTP ' + lg.status, { userID: loginData && loginData.userID, isRegister: loginData && loginData.isRegister });
    }
    if (loginData && loginData.token) token = loginData.token;
    if (!token) throw new Error('没拿到 token: ' + JSON.stringify(resp || {}).slice(0, 300));

    /* ④ 校验额度 */
    const verify = {};
    for (const p of ['/v1/api/user/info', '/v1/api/user/equity', '/v1/api/billing/credit']) {
      const r = await page.evaluate(async ({ p, token }) => {
        const s = window.__signed(p, 'GET', null);
        const rr = await fetch(s.url, { method: 'GET', headers: { token: token, yy: s.yy }, credentials: 'include' });
        const t = await rr.text();
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        return { status: rr.status, json: j, raw: t.slice(0, 160) };
      }, { p: p, token: token }).catch(e => ({ status: 0, body: 'ERR ' + e.message }));
      verify[p] = { status: r.status };
      try {
        const j = r.json;
        if (!j) throw new Error('unparsed');
        verify[p].ok = true;
        if (p.endsWith('/info')) verify[p].userID = j.data && j.data.userInfo && j.data.userInfo.userID;
        if (p.endsWith('/info')) { const ui = (j.data && j.data.userInfo) || {}; verify[p].createTime = ui.createTime || 0; verify[p].retentionDays = ui.retentionDays; }
        if (p.endsWith('/info')) verify[p].email = j.data && j.data.userInfo && j.data.userInfo.email;
        if (p.endsWith('/equity')) { const d = j.data || {}; verify[p].totalCredits = d.totalCredits; verify[p].isNewUser = d.isNewUser; verify[p].trialExpireTime = d.trialExpireTime; verify[p].creditExpireText = d.creditExpireText; verify[p].videoCost = d.videoCost; }
        if (p.endsWith('/credit')) { const d = j.data || {}; verify[p].total_credit = d.total_credit; verify[p].sub_credits = d.sub_credits; verify[p].debit_credit = d.debit_credit; }
      } catch (e) { verify[p].raw = String(r.raw || '').slice(0, 160); }
    }
      const eq = verify['/v1/api/user/equity'] || {};
      const inf = verify['/v1/api/user/info'] || {};
      step('④', '额度校验', { info: inf.status, equity: eq.status, credits: eq.totalCredits, billing: (verify['/v1/api/billing/credit'] || {}).total_credit, isNewUser: eq.isNewUser, createTime: inf.createTime });

    /* ⑤ 落库：profile/login_state.json（Dola cookies.json 的对位物）+ 浏览器内登录态已自然落盘 */
    const cookies = await ctx.cookies();
    const tokCookie = cookies.find(c => c.name === '_token');
    const state = {
      label: record.label, profile: inst.id, kind: record.kind, email: record.email || (loginData && loginData.email) || '',
      userID: (loginData && loginData.userID) || (verify['/v1/api/user/info'] && verify['/v1/api/user/info'].userID) || '',
      userName: (loginData && loginData.userName) || '',
      createTime: (loginData && loginData.createTime) || (verify['/v1/api/user/info'] && verify['/v1/api/user/info'].createTime) || 0,
      retentionDays: (loginData && loginData.retentionDays) || 0,
      isRegister: loginData ? (loginData.isRegister === undefined ? null : loginData.isRegister) : null,
      creditsFromBilling: (verify['/v1/api/billing/credit'] && verify['/v1/api/billing/credit'].total_credit) || 0,
      credits: (verify['/v1/api/user/equity'] && verify['/v1/api/user/equity'].totalCredits) || 0,
      token: token, cookie_token_present: !!tokCookie, at: new Date().toISOString()
    };
    fs.writeFileSync(path.join(inst.dir, 'login_state.json'), JSON.stringify(state, null, 2), 'utf8');
    Object.assign(record, { ok: true, userID: state.userID, credits: state.credits, createTime: state.createTime, retentionDays: state.retentionDays, isRegister: state.isRegister, cookie_token_present: !!tokCookie, token: token, verify: verify });
    step('⑤', '落库 login_state.json（token ' + String(token).length + 'B, cookie=' + (!!tokCookie) + ', credits=' + state.credits + '）');

    if (!OPTS.keep) { await ctx.close().catch(() => {}); ctx = null; }
    return record;
  } catch (e) {
    record.ok = false; record.error = String(e && e.message || e);
    log(tag, '失败: ' + record.error);
    try { if (e && e.stack) record.stack = String(e.stack).slice(0, 600); } catch (e2) {}
    if (ctx && !OPTS.keep) await ctx.close().catch(() => {});
    return record;
  }
}

/* ---------------- 推送进池 ---------------- */
async function pushToPool(records) {
  const accs = records.filter(r => r.ok && r.token).map(r => ({ label: r.label, token: r.token, credits: Number(r.credits || 0) }));
  if (!accs.length) return { skipped: true };
  const u = new URL(OPTS.pool);
  const mod = u.protocol === 'https:' ? https : http;
  const payload = Buffer.from(JSON.stringify({ accounts: accs }));
  return await new Promise(res => {
    const r = mod.request({ host: u.hostname, port: u.port || 80, path: '/supply/import', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-admin-key': OPTS.adminKey } },
      rsp => { let b = ''; rsp.on('data', x => b += x); rsp.on('end', () => res({ status: rsp.statusCode, body: b.slice(0, 400) })); });
    r.on('error', e => res({ status: 0, body: 'ERR ' + e.code }));
    r.write(payload); r.end();
  });
}

/* ---------------- 换号模式（Dola「换CK」对位） ---------------- */
async function swap() {
  const prof = arg('profile', null);
  if (!prof) { console.log('需要 --profile H3-00N'); return; }
  const dir = path.join(OPTS.profilesDir, prof);
  if (!fs.existsSync(path.join(dir, 'fingerprint_config.json'))) { console.log('实例不存在: ' + dir); return; }
  const acct = { label: arg('label', prof), kind: 'token', token: arg('token', null) || arg('refresh', null), email: '' };
  if (arg('refresh', null)) { acct.kind = 'refresh'; acct.refreshToken = arg('refresh', null); }
  if (!acct.token && !acct.refreshToken) { console.log('需要 --token <_token> 或 --refresh <refreshToken>'); return; }
  log('[换号]', '正在写入登录态并刷新登录… 实例=' + prof);
  const mnum = /(\d+)$/.exec(String(prof));
  const rec = await loginOne(acct, Math.max(0, Number(mnum ? mnum[1] : 1) - 1));
  console.log(JSON.stringify(rec.ok ? { ok: true, label: rec.label, credits: rec.credits, userID: rec.userID } : { ok: false, error: rec.error }, null, 2));
}

/* ---------------- 批量 ---------------- */
(async () => {
  if (OPTS.swap) return swap();
  if (!OPTS.inFile) {
    console.log('用法: node scripts/h3-batch-login.js --in <accounts.jsonl> [--concurrency N] [--template <pw profile>] [--keep] [--push]');
    console.log('      node scripts/h3-batch-login.js --swap --profile H3-002 --token <_token>');
    return;
  }
  const lines = fs.readFileSync(OPTS.inFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
  const list = OPTS.sub ? lines.slice(0, Number(OPTS.sub)) : lines;
  log('[批量登录]', '开始，共 ' + list.length + ' 个；并发=' + OPTS.concurrency + ' 档案=' + OPTS.profilesDir + (OPTS.template ? ' 模板=' + OPTS.template : ''));
  const results = [];
  let cursor = 0;
  async function worker(w) {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      const acct = list[i];
      const rec = await loginOne(acct, i);
      results[i] = rec;
      /* 实时追加，避免中断丢数据 */
      try { ensureDir(path.dirname(OPTS.outFile)); fs.appendFileSync(OPTS.outFile, JSON.stringify(rec) + NL, 'utf8'); } catch (e) {}
    }
  }
  const ws = [];
  for (let i = 0; i < Math.max(1, Math.min(OPTS.concurrency, list.length)); i++) ws.push(worker(i));
  await Promise.all(ws);
  const okN = results.filter(r => r && r.ok).length;
  log('[批量登录]', '结束。成功 ' + okN + '，失败 ' + (list.length - okN) + ' -> ' + OPTS.outFile);
  for (const r of results) {
    if (!r) continue;
    console.log('  ' + (r.ok ? 'OK  ' : 'FAIL') + ' ' + String(r.label).padEnd(22) + ' ' + r.profile + '  credits=' + (r.credits !== undefined ? r.credits : '-') + '  userID=' + (r.userID || '-') + (r.ok ? '' : '  err=' + r.error));
  }
  if (OPTS.push) {
    const p = await pushToPool(results);
    log('[批量登录]', '推池 -> ' + JSON.stringify(p));
  }
  if (has('again')) {
    const rest = results.filter(r => !r || !r.ok).map(r => list[results.indexOf(r)]);
    log('[批量登录]', '是否再次执行未成功的号？剩 ' + rest.length + ' 个（如需重试请重新写 in.jsonl 后加 --again）');
  }
})();