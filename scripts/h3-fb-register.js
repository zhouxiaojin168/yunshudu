'use strict';
/* r274-full.js —— 完整：H3 -> FB OAuth -> 选“使用密码”-> 输密码 -> 登录 -> 回 H3 落地 */
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const PW = 'D:\\破甲\\1\\OpenAI.Codex_26.715.3651.0_x64(免安装版 适合大多数电脑)\\.codex\\skills\\openai-security-review\\node_modules\\playwright';
const { chromium } = require(PW);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OPS = 'E:\\中转站测试\\_ops';
const LOG = OPS + '\\r274.log';
const UID = '61595047781070', PWD = 'AjmalOct*11', TOTPSEC = 'BLTVDBORMKT4ODLXN65E5H347OPBOA43';
const SMS_URL = 'https://api.sms8.net/api/record?token=jiylr7hy3g4529snz6c8ai7ojx8z5pw4ddm';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = function () { const s = '[' + new Date().toISOString().slice(11, 19) + '] ' + Array.prototype.join.call(arguments, ' '); console.log(s); try { fs.appendFileSync(LOG, s + '\n', 'utf8'); } catch (e) {} };
function httpGet(u) { return new Promise((res) => { const q = https.get(u, { timeout: 15000 }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); }); q.on('error', (e) => res('ERR ' + e.message)); q.on('timeout', () => { q.destroy(); res('TIMEOUT'); }); }); }
function b32dec(s) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += A.indexOf(c).toString(2).padStart(5, '0'); const b = []; for (let i = 0; i + 8 <= bits.length; i += 8) b.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(b); }
function totp(sec) { const key = b32dec(sec); const c = Math.floor(Date.now() / 30000); const buf = Buffer.alloc(8); buf.writeUInt32BE(Math.floor(c / 4294967296), 0); buf.writeUInt32BE(c >>> 0, 4); const h = crypto.createHmac('sha1', key).update(buf).digest(); const o = h[h.length - 1] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0'); }
(async () => {
  try { fs.writeFileSync(LOG, ''); } catch (e) {}
  try { if (fs.existsSync(OPS + '\\r274-clicks.json')) fs.unlinkSync(OPS + '\\r274-clicks.json'); } catch (e) {}
  const ctx = await chromium.launchPersistentContext(OPS + '\\pw-r238-fb', {
    executablePath: CHROME, headless: false, proxy: { server: 'http://127.0.0.1:17899' },
    ignoreDefaultArgs: ['--enable-automation', '--no-startup-window'],
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--lang=zh-CN'],
    locale: 'zh-CN', viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const shot = async (n, p) => { try { await (p || page).screenshot({ path: OPS + '\\r274-' + n + '.png', timeout: 12000 }); } catch (e) {} };
  page.on('response', async (r) => { const u = r.url(); if (/\/v1\/api\/user\/login|\/v1\/api\/user\/info|\/v1\/api\/billing\/credit/i.test(u)) { let b = ''; try { b = (await r.text()).slice(0, 300); } catch (e) {} log('  <<< ' + r.status() + ' ' + u.slice(0, 100) + ' :: ' + b); } });
  await page.goto('https://hailuoai.video/zh-Intl', { waitUntil: 'domcontentloaded', timeout: 75000 }).catch(() => {});
  await sleep(5500);
  try { await page.locator('text=登录').first().click({ timeout: 6000, force: true }); } catch (e) {}
  await sleep(3000);
  try { await page.locator('text=通过 Facebook 继续').first().click({ timeout: 8000, force: true }); log('点 通过 Facebook 继续'); } catch (e) {}
  let fb = null;
  for (let i = 0; i < 15; i++) { await sleep(2000); fb = ctx.pages().find((p) => /facebook\.com/i.test(p.url())); if (fb) break; }
  if (!fb) { log('无 FB 页'); process.exit(0); }
  const pressBtn = async (re, tag) => { const b = await fb.evaluate((src) => { const re2 = new RegExp(src); for (const e of Array.prototype.slice.call(document.querySelectorAll('div[role="button"],button'))) { const t = (e.innerText || '').trim(); if (re2.test(t)) { const r = e.getBoundingClientRect(); if (r.width > 60 && r.height > 24) return { t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; } } return null; }, re.source).catch(() => null); if (b) { await fb.mouse.click(b.x, b.y); log('  点[' + tag + '] "' + b.t + '"'); return true; } log('  没找到[' + tag + ']'); return false; };
  let chosen = false, pwFilled = 0, totpTried = 0, smsTried = 0, oauth = 0, seen = '';
  for (let step = 0; step < 240; step++) {
    await sleep(2000);
    const h3st = await page.evaluate(() => Object.keys(localStorage).join(',')).catch(() => '');
    if (/_token|USER_INFO|userInfo/i.test(h3st || '')) { log('★★ H3 落地 keys=' + h3st); break; }
    const fp = ctx.pages().find((p) => /facebook\.com/i.test(p.url()));
    if (!fp) { if (step % 8 === 0) log('  [s' + step + '] 无 FB 页'); await sleep(1500); continue; }
    const u = fp.url();
    const body = await fp.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 380)).catch(() => '');
    // captcha
    const bf = fp.frames().find((f) => /recaptcha\/enterprise\/bframe/.test(f.url()));
    let n = 0, grid = null;
    try { grid = bf ? bf.locator('#rc-imageselect-target table td') : null; n = grid ? await grid.count() : 0; } catch (e) {}
    if (n >= 9) {
      let prompt = ''; try { prompt = await bf.locator('.rc-imageselect-desc-wrapper, .rc-imageselect-desc').first().innerText({ timeout: 3000 }); } catch (e) {}
      const meta = { round: step, prompt: String(prompt).replace(/\s+/g, ' ').trim(), tiles: [] };
      for (let i = 0; i < 9; i++) { const td = grid.nth(i); const b = await td.boundingBox().catch(() => null); const sel = await td.evaluate((e) => /rc-imageselect-tileselected/.test(e.className)).catch(() => null); meta.tiles.push({ i, x: b ? Math.round(b.x + b.width / 2) : null, y: b ? Math.round(b.y + b.height / 2) : null, sel }); }
      await shot('cap-s' + step, fp);
      fs.writeFileSync(OPS + '\\r274-tiles.json', JSON.stringify(meta, null, 1), 'utf8');
      log('!! CAPTCHA「' + meta.prompt + '」勾选=[' + meta.tiles.filter((t) => t.sel).map((t) => t.i).join(',') + '] -> r274-tiles.json / r274-cap-s' + step + '.png（等 r274-clicks.json 45s）');
      const cf = OPS + '\\r274-clicks.json'; let clicks = null;
      for (let w = 0; w < 15; w++) { if (fs.existsSync(cf)) { try { clicks = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch (e) { clicks = null; } if (clicks && Array.isArray(clicks.tiles)) break; } await sleep(3000); }
      if (clicks) { const want = new Set(clicks.tiles.map(Number)); for (const t of meta.tiles) { if (t.x === null) continue; const d = want.has(t.i), c = !!t.sel; if (d === c) continue; await fp.mouse.move(t.x, t.y); await sleep(150); await fp.mouse.click(t.x, t.y); await sleep(350); } try { const vb = bf.locator('#recaptcha-verify-button'); if (await vb.count()) await vb.click({ timeout: 5000, force: true }); } catch (e) {} try { fs.unlinkSync(cf); } catch (e) {} } else log('   captcha 未作答');
      await sleep(5000); continue;
    }
    const passEl = fp.locator('input[type="password"]').first();
    let hp = false; try { hp = (await passEl.count()) > 0; } catch (e) {}
    // 1) 选“使用密码”方式
    if (!chosen && /选择登录方式/.test(body)) {
      try { const l = fp.locator('label:has-text("使用密码")').first(); await l.click({ timeout: 6000 }); log('  ✔ 选 使用密码'); } catch (e) { log('  选使用密码失败 ' + e.message.slice(0, 40)); }
      await sleep(1500); await pressBtn(/^继续$/, '继续'); chosen = true; await sleep(6000); continue;
    }
    // 2) 密码（可多次）
    if (hp && pwFilled < 4) {
      const v = await passEl.inputValue().catch(() => '');
      const isLoginForm = /密码|password/i.test(body) && !/验证码/.test(body.slice(0, 60));
      if (isLoginForm) { await passEl.click({ timeout: 5000 }).catch(() => {}); await fp.keyboard.press('Control+A'); await fp.keyboard.press('Delete'); await sleep(200); await fp.keyboard.type(PWD, { delay: 45 }); pwFilled++; log('  填密码#' + pwFilled); await sleep(500); await pressBtn(/登录|继续|Log in/, '登录'); await sleep(7000); continue; }
    }
    // 3) 短信码
    if (/短信验证码|获取短信验证码|已通过短信/.test(body) && !/选择登录方式/.test(body)) {
      const ci = fp.locator('input[type="text"], input[inputmode="numeric"], input[name="approvals_code"]').first();
      let hc = false; try { hc = (await ci.count()) > 0; } catch (e) {}
      if (hc && smsTried < 5) {
        const raw = await httpGet(SMS_URL); let code = '';
        try { const j = JSON.parse(raw); const c = String((j.data || {}).code || ''); const ct = String((j.data || {}).code_time || ''); const m = c.match(/\d{4,8}/); const ms = ct ? Date.parse(ct.replace(/-/g, '/')) : 0; if (m && Date.now() - ms < 600000 && m[0] !== seen) { code = m[0]; seen = code; log('  sms8 -> ' + c.slice(0, 40)); } else log('  sms8 无新码: ' + c.slice(0, 40)); } catch (e) {}
        if (code) { smsTried++; await ci.click({ timeout: 5000, force: true }).catch(() => {}); await fp.keyboard.press('Control+A'); await fp.keyboard.type(code, { delay: 55 }); log('  填短信码 ' + code); await sleep(500); await pressBtn(/继续|提交|Continue/, '提交码'); await sleep(8000); continue; }
        await sleep(8000); continue;
      }
    }
    // 4) TOTP
    const ci2 = fp.locator('input[name="approvals_code"], form input[type="text"]').first();
    let h2 = false; try { h2 = (await ci2.count()) > 0; } catch (e) {}
    if (h2 && /双重验证|验证码|authentication code/i.test(body) && totpTried < 4) {
      const rem = 30 - (Math.floor(Date.now() / 1000) % 30); if (rem < 6) await sleep((rem + 1) * 1000);
      const code = totp(TOTPSEC); totpTried++;
      await ci2.click({ timeout: 5000, force: true }).catch(() => {}); await fp.keyboard.press('Control+A'); await fp.keyboard.type(code, { delay: 55 }); log('  填 TOTP ' + code);
      await sleep(400); await pressBtn(/继续|提交|Continue/, '提交TOTP'); await sleep(7000); continue;
    }
    // 5) 信任设备 / 每次都验证身份：多策略
    if (/信任这台设备|每次都验证/.test(body)) {
      let done = false;
      for (const nm of ['信任这台设备', '每次都验证身份']) {
        try { const l = fp.locator('div[role="button"], button, span, div').filter({ hasText: nm }).last(); if (await l.count()) { await l.click({ timeout: 5000, force: true }); log('  pw点 ' + nm); done = true; break; } } catch (e) { log('  pw ' + nm + ' err ' + e.message.slice(0, 40)); }
      }
      if (!done) {
        const b = await fp.evaluate(() => { for (const e of Array.prototype.slice.call(document.querySelectorAll('div[role="button"], button'))) { const t = (e.innerText || '').trim(); if (/信任这台设备|每次都验证/.test(t)) { const r = e.getBoundingClientRect(); if (r.width > 100) return { t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; } } return null; }).catch(() => null);
        if (b) { await fp.mouse.click(b.x, b.y); log('  coord点 ' + b.t + ' @' + b.x + ',' + b.y); } else log('  信任页找不到可点按钮');
      }
      await shot('trust', fp);
      await sleep(7000); continue;
    }
    // 6) 通用按钮：OAuth 继续 / 隐私同意 / 授权
    if (oauth < 14) {
      const b = await fp.evaluate(() => {
        const want = /继续|允许|同意|确定|Continue|Allow|确认/;
        for (const e of Array.prototype.slice.call(document.querySelectorAll('div[role="button"], button, [role="button"]'))) {
          const t = (e.innerText || '').trim();
          if (want.test(t)) { const r = e.getBoundingClientRect(); if (r.width > 60 && r.height > 24) return { t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
        }
        return null;
      }).catch(() => null);
      if (b) { await fp.mouse.click(b.x, b.y); oauth++; log('  通用点 "' + b.t + '" @' + b.x + ',' + b.y + ' (#' + oauth + ')'); await sleep(5000); continue; }
      if (step % 8 === 0) {
        const list = await fp.evaluate(() => Array.prototype.map.call(document.querySelectorAll('div[role="button"], button'), (e) => { const r = e.getBoundingClientRect(); const t = (e.innerText || '').trim().slice(0, 16); return t ? t + '@' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) : ''; }).filter(Boolean).slice(0, 12)).catch(() => []);
        log('  可点元素=' + JSON.stringify(list));
      }
    }
    if (step % 6 === 0) log('  [s' + step + '] ' + u.slice(0, 80) + ' | ' + body.slice(0, 100));
  }
  await shot('final');
  const ls = await page.evaluate(() => { const o = {}; for (const k of Object.keys(localStorage)) { const v = localStorage.getItem(k) || ''; o[k] = v.length > 400 ? v.slice(0, 400) + '…(' + v.length + ')' : v; } return o; }).catch(() => ({}));
  fs.writeFileSync(OPS + '\\r274-ls.json', JSON.stringify(ls, null, 1), 'utf8');
  log('H3 keys=' + Object.keys(ls).join(','));
  log('H3 url=' + page.url().slice(0, 120));
  try { await ctx.storageState({ path: OPS + '\\r274-state.json' }); } catch (e) {}
  log('=== 结束 ===');
  process.exit(0);
})();