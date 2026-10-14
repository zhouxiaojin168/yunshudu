#!/usr/bin/env node
/**
 * h3-channel-verify.js -- 用「真实 H3 账号 token」验证任意出口通道
 *
 * 用途：新接了出口（机场桥 / 静态ISP / 海外VPS）后，不用发视频、不消耗额度，
 *       直接用号池里的 token 打 3 个只读接口，确认：签名对、token 活、出口没被风控。
 *
 * 用法：
 *   node scripts/h3-channel-verify.js --proxy http://127.0.0.1:17899
 *   node scripts/h3-channel-verify.js --proxy http://127.0.0.1:17899 --in state/h3-accounts.out.jsonl --limit 3
 *   node scripts/h3-channel-verify.js --proxy http://127.0.0.1:17899 --token "eyJ…" --site intl
 *
 * 号池 token 支持两种写法：裸 token / 四段式 `token|uuid|device_id|site`
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { proxyFetch } = require('./h3-proxy-fetch');

const ROOT = path.resolve(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

function argval(name, dflt) { const i = process.argv.indexOf('--' + name); if (i < 0) return dflt; const v = process.argv[i + 1]; return (v === undefined || v.indexOf('--') === 0) ? dflt : v; }

function parseToken(raw) {
  const parts = String(raw).trim().split('|');
  const tok = parts[0];
  const uuid = parts[1] || null;
  const deviceId = parts[2] || null;
  const site = parts[3] || (tok.indexOf('"id":"5') >= 0 ? 'cn' : 'intl');
  let dev = deviceId;
  try { const p = JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString('utf8')); if (!dev && p.user && p.user.deviceID) dev = p.user.deviceID; } catch (e) { /* ignore */ }
  return { token: tok, uuid: uuid || crypto.randomUUID(), deviceId: dev || null, site };
}

function signed(host, pathName, tk) {
  const t = Date.now();
  const q = {
    device_platform: 'web', app_id: '3001', version_code: '22203', biz_id: '0', unix: String(t),
    lang: 'zh-Hans', uuid: tk.uuid, os_name: 'Windows', browser_name: 'Chrome', browser_language: 'zh-CN',
    browser_platform: 'Win32', screen_width: '1920', screen_height: '1080',
  };
  if (tk.deviceId) q.device_id = tk.deviceId;
  const qs = Object.keys(q).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
  const full = pathName + '?' + qs;
  const bodyStr = '{}';
  const yy = md5(encodeURIComponent(full) + '_' + bodyStr + md5(String(t)) + 'ooui');
  return { url: 'https://' + host + full, yy };
}

async function call(host, p, tk, proxy) {
  const s = signed(host, p, tk);
  const r = await proxyFetch(s.url, { method: 'GET', proxy, timeoutMs: 30000, headers: { token: tk.token, yy: s.yy, 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA } });
  let j = null; try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { /* ignore */ }
  return { status: r.status, j, raw: r.body.toString('utf8').slice(0, 300) };
}

(async () => {
  const proxy = argval('proxy', 'http://127.0.0.1:17899');
  const host = argval('host', process.env.H3_HOST || 'hailuoai.video');
  let items = [];
  const one = argval('token', '');
  if (one) items = [{ label: 'cli', token: one, site: argval('site', 'intl') }];
  else {
    const file = argval('in', path.join(ROOT, 'state', 'h3-accounts.out.jsonl'));
    const limit = Number(argval('limit', 3));
    items = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((x) => x && x.token).slice(0, limit);
  }
  if (!items.length) { console.log('没有可用 token（--token 或 --in 文件）'); process.exit(1); }

  console.log('通道=' + proxy + '  目标=' + host + '  账号数=' + items.length + '\n');
  let ok = 0;
  for (const it of items) {
    const tk = parseToken(it.token);
    const label = (it.label || it.email || 'acct') + ' [' + tk.site + ']';
    const t0 = Date.now();
    let info, credits, equity;
    try {
      info = await call(host, '/v1/api/user/info', tk, proxy);
      credits = await call(host, '/v1/api/billing/credit', tk, proxy);
      equity = await call(host, '/v1/api/user/equity', tk, proxy);
    } catch (e) {
      console.log('❌ ' + label + '  通道失败: ' + e.message);
      continue;
    }
    const cd = credits.j && credits.j.data ? credits.j.data : null;
    const ed = equity.j && equity.j.data ? equity.j.data : null;
    const id = info.j && info.j.data ? info.j.data : null;
    const c = cd ? cd.total_credit : (ed ? ed.totalCredits : undefined);
    const uid = id && id.userInfo ? id.userInfo.userID : undefined;
    const cost = ed ? ed.videoCost : undefined;
    const good = info.status === 200 && credits.status === 200;
    if (good) ok++;
    console.log((good ? '✅' : '❌') + ' ' + label.padEnd(38) + ' info=' + info.status + ' credit=' + credits.status + ' equity=' + equity.status + '  credits=' + (c === undefined ? '-' : c) + '  cost=' + (cost === undefined ? '-' : cost) + '  userID=' + (uid || '-') + '  ' + (Date.now() - t0) + 'ms');
    if (!good) console.log('     body: ' + (info.raw || credits.raw));
  }
  console.log('\n通道结论：' + ok + '/' + items.length + ' 账号在 ' + proxy + ' 上可用' + (ok ? '  → 通道可用于 H3 抓号/续期' : '  → 通道不可用，先跑 isp-onboard verify'));
})();