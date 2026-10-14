#!/usr/bin/env node
/**
 * h3-proxy-fetch.js -- 走指定出口的 Node HTTP 客户端（零依赖）
 *   用途（= Dola「取CK 走独立代理/静态IP，不回走实例浏览代理」的对位物）：
 *     取号/取CK/额度校验这些「服务端请求」可以强制走一条独立出口，
 *     与浏览器实例的浏览出口（proxy_config.json）解耦，互不污染。
 *
 * 支持代理：http://[user:pass@]host:port  、 socks5://host:port
 * 用法：
 *   const { proxyFetch } = require('./h3-proxy-fetch.js');
 *   const r = await proxyFetch('https://hailuoai.video/v1/api/user/info', { headers:{token} }, 'http://127.0.0.1:18081');
 *   => { status, headers, body, text, json() }
 * 命令行自检：
 *   node scripts/h3-proxy-fetch.js http://ip-api.com/json/?fields=query,country  http://127.0.0.1:18081
 */
'use strict';
const net = require('net');
const tls = require('tls');

function parseProxy(p) {
  const u = new URL(String(p));
  const socks = u.protocol === 'socks5:' || u.protocol === 'socks5h:';
  return {
    socks: socks, host: u.hostname,
    port: Number(u.port || (socks ? 1080 : 8080)),
    user: u.username ? decodeURIComponent(u.username) : '',
    pass: u.password ? decodeURIComponent(u.password) : ''
  };
}

/* 与代理建立到 target 的隧道（返回已连通的 socket） */
function openTunnel(proxy, targetHost, targetPort, cb) {
  const P = typeof proxy === 'string' ? parseProxy(proxy) : proxy;
  const sock = net.connect({ host: P.host, port: P.port });
  sock.setNoDelay(true);
  let settled = false;
  const done = (e, s) => { if (!settled) { settled = true; cb(e, s); } };
  sock.once('error', (e) => done(e));
  sock.once('connect', function () {
    if (P.socks) {
      const wantAuth = !!P.user;
      sock.write(Buffer.from(wantAuth ? [5, 2, 0, 2] : [5, 1, 0]));
      let st = 0;
      const onD = function (d) {
        if (st === 0) {
          if (!(d[0] === 5)) { sock.destroy(); return done(new Error('socks5 bad ver')); }
          if (d[1] === 2) {
            const ub = Buffer.from(P.user, 'utf8'), pb = Buffer.from(P.pass, 'utf8');
            sock.write(Buffer.concat([Buffer.from([1, ub.length]), ub, Buffer.from([pb.length]), pb]));
            return;
          }
          if (d[1] !== 0) { sock.destroy(); return done(new Error('socks5 need ' + d[1])); }
          st = 1;
          const hb = Buffer.from(targetHost, 'utf8');
          sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb, Buffer.from([targetPort >> 8, targetPort & 0xff])]));
          return;
        }
        if (st === 1) {
          sock.removeListener('data', onD);
          if (d[1] !== 0) { sock.destroy(); return done(new Error('socks5 reply ' + d[1])); }
          return done(null, sock);
        }
      };
      sock.on('data', onD);
      return;
    }
    let head = 'CONNECT ' + targetHost + ':' + targetPort + ' HTTP/1.1\r\nHost: ' + targetHost + ':' + targetPort + '\r\n';
    if (P.user) head += 'Proxy-Authorization: Basic ' + Buffer.from(P.user + ':' + P.pass).toString('base64') + '\r\n';
    head += '\r\n';
    sock.write(head);
    let buf = '';
    const onD = function (d) {
      buf += d.toString('latin1');
      const nl = buf.indexOf('\r\n\r\n');
      if (nl < 0) { if (buf.length > 4096) { sock.destroy(); done(new Error('head too big')); } return; }
      sock.removeListener('data', onD);
      const code = Number((/^HTTP\/1\.[01] (\d{3})/.exec(buf) || [])[1] || 0);
      if (code !== 200) { sock.destroy(); return done(new Error('proxy ' + code)); }
      const rest = Buffer.from(buf.slice(nl + 4), 'latin1');
      done(null, sock);
      if (rest.length) sock.unshift(rest);
    };
    sock.on('data', onD);
  });
}

/* 极简 HTTP/1.1 响应解析（Content-Length / chunked / 直到关闭） */
function readResponse(sock, cb) {
  let buf = Buffer.alloc(0);
  let headDone = false, status = 0, headers = {}, clen = null, chunked = false, body = Buffer.alloc(0);
  let chunkState = 'size', chunkLeft = 0;
  const onD = function (d) {
    buf = Buffer.concat([buf, d]);
    if (!headDone) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = buf.slice(0, i).toString('latin1');
      buf = buf.slice(i + 4);
      const lines = head.split('\r\n');
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] || '');
      status = m ? Number(m[1]) : 0;
      for (const l of lines.slice(1)) {
        const k = l.indexOf(':');
        if (k > 0) headers[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim();
      }
      clen = headers['content-length'] !== undefined ? Number(headers['content-length']) : null;
      chunked = /chunked/i.test(headers['transfer-encoding'] || '');
      headDone = true;
    }
    if (chunked) {
      for (;;) {
        if (chunkState === 'size') {
          const i = buf.indexOf('\r\n');
          if (i < 0) return;
          const sz = parseInt(buf.slice(0, i).toString('latin1').split(';')[0], 16);
          buf = buf.slice(i + 2);
          if (sz === 0) { finish(); return; }
          chunkLeft = sz; chunkState = 'data';
        }
        if (chunkState === 'data') {
          if (buf.length < chunkLeft) return;
          body = Buffer.concat([body, buf.slice(0, chunkLeft)]);
          buf = buf.slice(chunkLeft);
          chunkLeft = 0; chunkState = 'crlf';
        }
        if (chunkState === 'crlf') {
          if (buf.length < 2) return;
          buf = buf.slice(2);
          chunkState = 'size';
        }
      }
      return;
    }
    if (clen !== null) {
      if (buf.length >= clen) { body = Buffer.concat([body, buf.slice(0, clen)]); finish(); }
      return;
    }
    /* 无长度（1xx/204/304 或 connection close）→ 看是否已结束 */
    if (status === 204 || status === 304 || (status >= 100 && status < 200)) { finish(); return; }
    body = Buffer.concat([body, buf]); buf = Buffer.alloc(0);
  };
  let finished = false;
  function finish() { if (finished) return; finished = true; sock.removeListener('data', onD); cb(null, { status, headers, body }); }
  sock.on('data', onD);
  sock.on('close', function () { if (!finished && (!chunked && clen === null)) finish(); });
  sock.on('error', (e) => { if (!finished) { finished = true; sock.removeListener('data', onD); cb(e); } });
}

/**
 * proxyFetch(url, {method, headers, body, proxy, timeoutMs, insecure})
 * proxy 省略/为空 ⇒ 直连
 */
function proxyFetch(url, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const isTls = u.protocol === 'https:';
    const port = Number(u.port || (isTls ? 443 : 80));
    const timeoutMs = opts.timeoutMs || 30000;
    const bodyBuf = opts.body === undefined || opts.body === null ? null : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf8'));
    const path = u.pathname + u.search;

    function afterTunnel(err, sock) {
      if (err) return reject(err);
      sock.setTimeout(timeoutMs, function () { sock.destroy(); reject(new Error('timeout ' + url)); });
      let s = sock;
      const go = function () {
        const h = Object.assign({ Host: u.host, Connection: 'close', 'Accept-Encoding': 'identity' }, opts.headers || {});
        if (bodyBuf) h['Content-Length'] = String(bodyBuf.length);
        h['Content-Length'] = h['Content-Length'] || (opts.method && opts.method !== 'GET' ? '0' : undefined);
        if (h['Content-Length'] === undefined) delete h['Content-Length'];
        const head = (opts.method || (bodyBuf ? 'POST' : 'GET')) + ' ' + path + ' HTTP/1.1\r\n' +
          Object.keys(h).filter((k) => h[k] !== undefined && h[k] !== null).map((k) => k + ': ' + h[k]).join('\r\n') + '\r\n\r\n';
        s.write(head, 'latin1');
        if (bodyBuf) s.write(bodyBuf);
        readResponse(s, function (e, r) {
          if (e) return reject(e);
          const text = r.body.toString('utf8');
          resolve({
            status: r.status, headers: r.headers, body: r.body, text: text,
            json: function () { try { return JSON.parse(text); } catch (e2) { return null; } }
          });
          try { s.destroy(); } catch (e3) {}
        });
      };
      if (isTls) {
        const t = tls.connect({ socket: sock, servername: u.hostname, rejectUnauthorized: opts.insecure === false });
        t.setTimeout(timeoutMs, function () { t.destroy(); reject(new Error('tls timeout')); });
        t.once('secureConnect', function () { s = t; go(); });
        t.once('error', (e) => reject(e));
      } else go();
    }

    if (!opts.proxy) {
      const sock = net.connect({ host: u.hostname, port: port });
      sock.setNoDelay(true);
      sock.once('connect', () => afterTunnel(null, sock));
      sock.once('error', (e) => reject(e));
    } else openTunnel(opts.proxy, u.hostname, port, afterTunnel);
  });
}

module.exports = { proxyFetch, openTunnel, readResponse, parseProxy };

/* 命令行自检：node scripts/h3-proxy-fetch.js <url> [proxy] */
if (require.main === module) {
  const url = process.argv[2] || 'http://ip-api.com/json/?fields=query,country,isp';
  const proxy = process.argv[3] || '';
  proxyFetch(url, { proxy: proxy, timeoutMs: 25000 }).then(function (r) {
    console.log('status=' + r.status + '  proxy=' + (proxy || 'direct'));
    console.log(r.text.slice(0, 400));
  }).catch(function (e) { console.log('ERR ' + e.message); process.exit(1); });
}