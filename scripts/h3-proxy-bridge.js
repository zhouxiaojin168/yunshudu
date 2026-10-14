#!/usr/bin/env node
/**
 * h3-proxy-bridge.js -- Dola「代理桥」对位物
 *   依据 Dola 字符串：`[代理桥] 软件内置中转，自动探测出海端口` / DetectLocalProxyPorts / ProbeRemoteProxyHosts
 *   / 「按主机、端口、账号、密码填写，取CK时不走左侧代理」/「未扫到本机代理端口…只开 TUN 时没有端口可填」
 *
 * 作用：本机起一个「双协议本地桥」（HTTP 代理 + SOCKS5，同端口按首字节自动识别），
 *       自动探测本机已有出海口（mihomo/clash/v2ray 混合端口）作为上游，
 *       把出口统一成 127.0.0.1:18082；实例/脚本只填这一个地址，切换出口只需换桥的上游。
 *
 * 用法：
 *   node scripts/h3-proxy-bridge.js                                  # 自动探测上游，监听 18082
 *   node scripts/h3-proxy-bridge.js --upstream http://127.0.0.1:10090
 *   node scripts/h3-proxy-bridge.js --upstream socks5://127.0.0.1:18081
 *   node scripts/h3-proxy-bridge.js --port 18082 --extra 8080 --no-scan
 *   环境变量：BRIDGE_PORT / BRIDGE_UPSTREAM / BRIDGE_SCAN=0
 */
'use strict';
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

function argval(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || String(v).indexOf('--') === 0) ? dflt : v;
}
const has = (n) => process.argv.indexOf('--' + n) >= 0;

const PORT = Number(argval('port', process.env.BRIDGE_PORT || 18082));
const SCAN = !has('no-scan') && process.env.BRIDGE_SCAN !== '0';
const CANDIDATES = [10090, 10091, 7890, 7891, 7897, 7899, 1080, 10808, 10809, 8118, 20171, 2080, 10800, 8889]
  .concat(String(argval('extra', '')).split(',').map(Number).filter(Boolean));

let UPSTREAM = argval('upstream', process.env.BRIDGE_UPSTREAM || '');

function log(s) { console.log('[' + new Date().toISOString() + '] ' + s); }
const clean = (s) => String(s).replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

/* ---------- 上游探测（Dola DetectLocalProxyPorts 对位） ---------- */
function probeHttpProxy(port) {
  return new Promise(function (resolve) {
    let done = false;
    const fin = (o) => { if (!done) { done = true; resolve(o); } };
    const req = http.request({
      host: '127.0.0.1', port: port, method: 'GET',
      path: 'http://ip-api.com/json/?fields=status,country,countryCode,query,isp',
      headers: { host: 'ip-api.com', 'user-agent': 'curl/8' }
    }, function (rsp) {
      let b = ''; rsp.on('data', (x) => b += x);
      rsp.on('end', function () {
        let j = null; try { j = JSON.parse(b); } catch (e) {}
        if (j && j.query) fin({ ok: true, url: 'http://127.0.0.1:' + port, ip: j.query, country: clean(j.country), isp: clean(j.isp) });
        else fin({ ok: false });
      });
    });
    req.setTimeout(6000, function () { req.destroy(); fin({ ok: false }); });
    req.on('error', () => fin({ ok: false }));
    req.end();
  });
}

async function autoDetectUpstream() {
  log('[探测] 扫描本机 ' + CANDIDATES.length + ' 个候选出海口…');
  for (const p of CANDIDATES) {
    const h = await probeHttpProxy(p);
    if (h.ok) {
      log('  OK 127.0.0.1:' + p + ' -> ' + h.ip + '  ' + h.country + '  ' + h.isp);
      return h.url;
    }
  }
  return null;
}

/* ---------- 上游连接（HTTP CONNECT / SOCKS5 上游都支持） ---------- */
function upstreamConnect(targetHost, targetPort, cb) {
  let u = null;
  try { u = new URL(UPSTREAM); } catch (e) { return cb(new Error('bad upstream ' + UPSTREAM)); }
  const uh = u.hostname, up = Number(u.port || (u.protocol === 'socks5:' || u.protocol === 'socks5h:' ? 1080 : 8080));
  const sock = net.connect({ host: uh, port: up });
  sock.setNoDelay(true);
  let settled = false;
  const done = (e, s) => { if (!settled) { settled = true; cb(e, s); } };
  sock.once('error', (e) => done(e));
  sock.once('connect', function () {
    if (u.protocol === 'socks5:' || u.protocol === 'socks5h:') {
      sock.write(Buffer.from([5, 1, 0]));
      let st = 0;
      const onD = function (d) {
        if (st === 0) {
          if (!(d[0] === 5 && d[1] === 0)) { sock.destroy(); return done(new Error('socks5 auth')); }
          st = 1;
          const hb = Buffer.from(targetHost, 'utf8');
          sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb, Buffer.from([targetPort >> 8, targetPort & 0xff])]));
          return;
        }
        sock.removeListener('data', onD);
        if (d[1] !== 0) { sock.destroy(); return done(new Error('socks5 reply ' + d[1])); }
        return done(null, sock);
      };
      sock.on('data', onD);
      return;
    }
    let head = 'CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\nHost: ' + targetHost + ':' + targetPort + '\r\n';
    if (u.username) head += 'Proxy-Authorization: Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')).toString('base64') + '\r\n';
    head += '\r\n';
    sock.write(head);
    let buf = '';
    const onD = function (d) {
      buf += d.toString('latin1');
      const nl = buf.indexOf('\r\n\r\n');
      if (nl < 0) { if (buf.length > 4096) { sock.destroy(); done(new Error('big head')); } return; }
      sock.removeListener('data', onD);
      const code = Number((/^HTTP\/1\.[01] (\d{3})/.exec(buf) || [])[1] || 0);
      if (code !== 200) { sock.destroy(); return done(new Error('upstream ' + code + ' ' + clean(buf.split('\r\n')[0]))); }
      const rest = Buffer.from(buf.slice(nl + 4), 'latin1');
      done(null, sock);
      if (rest.length) sock.unshift(rest);
    };
    sock.on('data', onD);
  });
}

/* ---------- 双协议接入端（★注意：首包必须回灌，否则客户端请求停在 first 里没人处理） ---------- */
let nConn = 0, nFail = 0;
const server = net.createServer(function (sock) {
  sock.setNoDelay(true);
  sock.once('data', function (first) {
    const isSocks = first[0] === 0x05;
    if (isSocks) handleSocks(sock, first);
    else handleHttp(sock, first);
  });
  sock.on('error', () => {});
});

function pipeBoth(sock, up, host, port) {
  nConn++;
  log('-> ' + host + ':' + port + '  (#live=' + nConn + ')');
  const onUpErr = (e) => { nFail++; log('x  ' + host + ':' + port + ' upstream err ' + clean(e.message)); try { sock.destroy(); } catch (e2) {} };
  up.once('error', onUpErr);
  sock.once('error', () => { try { up.destroy(); } catch (e) {} });
  sock.once('close', () => { try { up.destroy(); } catch (e) {} });
  sock.pipe(up); up.pipe(sock);
}

function handleSocks(sock, first) {
  let buf = first;
  let stage = 'greet';
  const feed = function () {
    for (;;) {
      if (stage === 'greet') {
        if (buf.length < 2) return;
        const nm = buf[1];
        if (buf.length < 2 + nm) return;
        buf = buf.slice(2 + nm);
        sock.write(Buffer.from([5, 0]));
        stage = 'req';
        continue;
      }
      if (stage !== 'req') return;
      if (buf.length < 5) return;
      if (buf[0] !== 5 || buf[1] !== 1) { sock.destroy(); return; }
      const atyp = buf[3];
      let host = '', port = 0, need = 0;
      if (atyp === 1) { need = 10; if (buf.length < need) return; host = buf.slice(4, 8).join('.'); port = buf.readUInt16BE(8); }
      else if (atyp === 3) { if (buf.length < 5) return; const l = buf[4]; need = 5 + l + 2; if (buf.length < need) return; host = buf.slice(5, 5 + l).toString('utf8'); port = buf.readUInt16BE(5 + l); }
      else if (atyp === 4) { need = 22; if (buf.length < need) return; const h = buf.slice(4, 20); const ps = []; for (let i = 0; i < 16; i += 2) ps.push(h.readUInt16BE(i).toString(16)); host = ps.join(':'); port = buf.readUInt16BE(20); }
      else { sock.destroy(); return; }
      const rest = buf.slice(need);
      buf = Buffer.alloc(0);
      stage = 'pipe';
      sock.removeListener('data', onData);
      upstreamConnect(host, port, function (err, s) {
        if (err) { nFail++; log('x  ' + host + ':' + port + ' ' + clean(err.message)); try { sock.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); } catch (e) {} return sock.destroy(); }
        sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) s.write(rest);
        pipeBoth(sock, s, host, port);
      });
      return;
    }
  };
  const onData = (d) => { buf = Buffer.concat([buf, d]); feed(); };
  sock.on('data', onData);
  feed();               /* ★ 回灌首包 */
}

function handleHttp(sock, first) {
  let buf = first;
  const feed = function () {
    const nl = buf.indexOf('\r\n\r\n');
    if (nl < 0) { if (buf.length > 65536) sock.destroy(); return; }
    sock.removeListener('data', onData);
    const head = buf.slice(0, nl).toString('latin1');
    const bodyRest = buf.slice(nl + 4);
    const lines = head.split('\r\n');
    const m = /^([A-Z]+)\s+(\S+)\s+HTTP\/1\.[01]$/.exec(lines[0] || '');
    if (!m) { sock.destroy(); return; }
    const method = m[1];
    let url = m[2];
    let host = '', port = 80;
    if (method === 'CONNECT') {
      const hp = url.split(':');
      host = hp[0]; port = Number(hp[1] || 443);
    } else if (url.indexOf('http://') === 0) {
      const u = new URL(url);
      host = u.hostname; port = Number(u.port || 80);
      url = u.pathname + u.search;
    } else {
      const hl = lines.find((l) => /^host:/i.test(l)) || '';
      const hv = hl.slice(hl.indexOf(':') + 1).trim();
      host = hv.split(':')[0]; port = Number(hv.split(':')[1] || 80);
    }
    if (!host) { sock.destroy(); return; }
    upstreamConnect(host, port, function (err, s) {
      if (err) {
        nFail++; log('x  ' + host + ':' + port + ' ' + clean(err.message));
        try { sock.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); } catch (e) {}
        return sock.destroy();
      }
      if (method === 'CONNECT') {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (bodyRest.length) s.write(bodyRest);
      } else {
        const keep = lines.slice(1).filter((l) => !/^proxy-connection:/i.test(l));
        s.write(method + ' ' + url + ' HTTP/1.1\r\n' + keep.join('\r\n') + '\r\n\r\n', 'latin1');
        if (bodyRest.length) s.write(bodyRest);
      }
      pipeBoth(sock, s, host, port);
    });
  };
  const onData = (d) => { buf = Buffer.concat([buf, d]); feed(); };
  sock.on('data', onData);
  feed();               /* ★ 回灌首包 */
}

/* ---------- main ---------- */
(async function main() {
  if (!UPSTREAM && SCAN) UPSTREAM = await autoDetectUpstream();
  if (!UPSTREAM) { log('未探测到可用上游，退出（可用 --upstream 手动指定）'); process.exit(2); }
  log('[代理桥] 上游 = ' + UPSTREAM);
  server.listen(PORT, '127.0.0.1', function () {
    log('[代理桥] 监听 127.0.0.1:' + PORT + '  支持 HTTP(绝对URI/CONNECT) + SOCKS5（同端口自动识别）');
    try {
      const st = path.resolve(__dirname, '..', 'state');
      fs.mkdirSync(st, { recursive: true });
      fs.writeFileSync(path.join(st, 'h3-bridge.json'), JSON.stringify({
        at: new Date().toISOString(), listen: '127.0.0.1:' + PORT, upstream: UPSTREAM,
        http: 'http://127.0.0.1:' + PORT, socks5: 'socks5://127.0.0.1:' + PORT
      }, null, 2), 'utf8');
    } catch (e) {}
  });
})();
process.on('uncaughtException', (e) => log('uncaught ' + e.message));