#!/usr/bin/env node
/**
 * h3-proxy-scan.js -- 本机代理扫描（Dola「代理控制中心 / 本机代理扫描」对位物）
 * 依据：DolaMultiBrowser.dll 字符串 BtnScanProxy_Click / DetectLocalProxyPorts / ProbeRemoteProxyHosts
 *       / ExplainLocalProxy / DescribeSystemProxyLine；文案「未扫到本机代理端口。请打开代理软件的混合端口
 *       或系统代理；只开 TUN 时没有端口可填」。
 * 用法：node scripts/h3-proxy-scan.js [--extra 8080,1080] [--assign state/h3-profiles]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
/* 净化外部返回：非法字节会打崩 stdout 管道（实测 8080 的 HTML 直接把进程打断） */
const clean = (s) => { try { return String(s).replace(/[^\x20-\x7E\u4e00-\u9fa5]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28); } catch (e) { return ''; } };

function argval(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || String(v).indexOf('--') === 0) ? dflt : v;
}

const PORTS = [
  10090, 10091, 7890, 7891, 7892, 7897, 7898, 7899,
  1080, 1081, 1082, 1087, 10808, 10809, 10810,
  8889, 8888, 8118, 20171, 20172, 2080, 2081, 33210,
  4780, 4781, 4782, 9090, 10080, 10800, 10801, 8080, 8081, 8887, 1086,
  /* ★ Dola「本地中转/代理桥」默认探测端口（字符串取证：17896/17897/7897 等） */
  17896, 17897, 17898, 17899, 17890, 17891, 17892, 17893, 17894, 17895, 7897
];

function systemProxy() {
  const out = [];
  for (const k of ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
                   'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']) {
    try {
      const reg = execFileSync('reg', ['query', k], { encoding: 'utf8', timeout: 8000 });
      const m = {};
      for (const line of reg.split(/\r?\n/)) {
        const mm = /^\s*(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
        if (mm) m[mm[1]] = mm[2].trim();
      }
      if (m.ProxyEnable && String(m.ProxyEnable) !== '0' && m.ProxyServer) out.push({ from: 'system:' + k.split('\\')[0], server: m.ProxyServer });
    } catch (e) { out.push({ from: 'system:' + k.split('\\')[0], error: String(e.message).slice(0, 40) }); }
  }
  return out;
}

function probeHttp(port) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    let done = false;
    const fin = (o) => { if (!done) { done = true; resolve(Object.assign({ port: port, ms: Date.now() - t0 }, o)); } };
    const req = http.request({
      host: '127.0.0.1', port: port, method: 'GET',
      path: 'http://ip-api.com/json/?fields=status,country,countryCode,query,isp',
      headers: { host: 'ip-api.com', 'user-agent': 'curl/8' }
    }, function (rsp) {
      let b = '';
      rsp.on('data', (x) => b += x);
      rsp.on('end', function () {
        let j = null; try { j = JSON.parse(b); } catch (e) {}
        if (j && j.query) fin({ ok: true, ip: j.query, country: j.country, cc: j.countryCode, isp: j.isp, kind: 'http' });
        else fin({ ok: false, note: 'not-http' });
      });
    });
    req.setTimeout(6000, function () { req.destroy(); fin({ ok: false, note: 'timeout' }); });
    req.on('error', (e) => fin({ ok: false, note: clean(e.code || e.message) }));
    req.end();
  });
}

function tcpOpen(port) {
  return new Promise(function (resolve) {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const s = net.connect({ host: '127.0.0.1', port: port });
    s.setTimeout(500);
    s.on('connect', () => { s.destroy(); fin(true); });
    s.on('timeout', () => { s.destroy(); fin(false); });
    s.on('error', () => fin(false));
  });
}

function probeSocks5(port) {
  return new Promise(function (resolve) {
    let done = false;
    const fin = (o) => { if (!done) { done = true; resolve(o); } };
    const s = net.connect({ host: '127.0.0.1', port: port });
    s.setTimeout(2500);
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', (d) => { s.destroy(); fin(d && d[0] === 5 ? { ok: true, kind: 'socks5' } : { ok: false, kind: null }); });
    s.on('timeout', () => { s.destroy(); fin({ ok: false, kind: null }); });
    s.on('error', () => fin({ ok: false, kind: null }));
  });
}

async function main() {
  const extra = String(argval('extra', '')).split(',').map(Number).filter(Boolean);
  const ports = Array.from(new Set(PORTS.concat(extra))).filter((x) => x > 0 && x < 65536);
  const sys = systemProxy();
  console.log('[1/3] 系统代理: ' + (sys.length ? JSON.stringify(sys) : '无（只开 TUN 时没有端口可填 —— Dola 原文）'));
  console.log('[2/3] 逐个真连本机 ' + ports.length + ' 个候选端口…');

  const found = [];
  const raw = [];
  for (const p of ports) {
    let h;
    try { h = await probeHttp(p); } catch (e) { h = { ok: false, note: 'throw:' + e.message }; }
    if (h.ok) {
      found.push(h);
      console.log('  OK HTTP   127.0.0.1:' + p + '  ->  ' + clean(h.ip) + '  ' + clean(h.country || '') + '  ' + h.ms + 'ms  ' + clean(h.isp || ''));
      continue;
    }
    let open = false;
    try { open = await tcpOpen(p); } catch (e) { open = false; }
    if (!open) continue;
    /* 注意：对「已经会回 HTTP 内容的端口」绝不能再发 SOCKS5 握手字节（实测会把本机 8080 上的服务/管道打崩，
       进程静默退出且结果文件写不出来）。只在 HTTP 探测「连上了但不是 HTTP 响应」时才试 SOCKS5。 */
    let sk = { ok: false };
    if (h.note !== 'not-http') { try { sk = await probeSocks5(p); } catch (e) {} }
    if (sk.ok) { found.push({ port: p, kind: 'socks5', ip: null }); console.log('  OK SOCKS5 127.0.0.1:' + p + ' (handshake ok)'); }
    else { raw.push({ port: p, note: clean(h.note) }); console.log('  · 127.0.0.1:' + p + ' 有端口但非 HTTP/SOCKS5 代理'); }
  }
  console.log('[3/3] 端口遍历完成（' + ports.length + ' 个），命中 ' + found.length + ' 个');

  const out = { at: new Date().toISOString(), system: sys, proxies: found, nonProxyListening: raw, proxyList: found.map((f) => (f.kind || 'http') + '://127.0.0.1:' + f.port) };
  fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'state', 'h3-proxies.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('[结果] 可用代理 ' + found.length + ' 个 -> state/h3-proxies.json');
  console.log('[可直接用] --proxy-list "' + out.proxyList.join(',') + '"');

  const assignDir = argval('assign', '');
  if (assignDir && found.length) {
    const dirs = fs.readdirSync(assignDir).filter((d) => /^H3-\d+$/.test(d)).sort();
    dirs.forEach(function (d, i) {
      const f = found[i % found.length];
      const pf = path.join(assignDir, d, 'proxy_config.json');
      let cur = {}; try { cur = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch (e) {}
      const nx = Object.assign({}, cur, {
        enabled: true, type: f.kind || 'http', host: '127.0.0.1', port: f.port,
        username: '', password: '', remark: 'scan:' + (f.ip || ''), useLocalChain: false,
        localChainHost: '127.0.0.1', localChainPort: 17896, localChainType: 'http'
      });
      fs.writeFileSync(pf, JSON.stringify(nx, null, 2), 'utf8');
      console.log('  ' + d + ' <- ' + (f.kind || 'http') + '://127.0.0.1:' + f.port + ' (出口 ' + (f.ip || '?') + ')');
    });
  }
}

main().then(() => process.exit(0)).catch((e) => { console.log('FATAL ' + e.message); process.exit(1); });