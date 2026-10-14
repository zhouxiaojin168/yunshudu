#!/usr/bin/env node
/**
 * ysd-gw-server.js -- 自建网关「出口中继」（跑在国外/自有服务器上）
 * 目的：IDC 会对明文 HTTP 做 DPI 注入拦截（未备案提示页），所以不能直接开 HTTP 代理。
 *       这里用「自定义二进制握手 + 裸 TCP 透传」，DPI 看不出协议，Playwright 侧再用本地 SOCKS5 接入。
 * 握手：client 连上后发  GW1 <token> <host> <port>\n   -> server 回 GW1 OK\n 之后双向裸转发。
 * 用法：GW_PORT=38472 GW_TOKEN=xxx node ysd-gw-server.js
 */
'use strict';
const net = require('net');
const fs = require('fs');
const PORT = Number(process.env.GW_PORT || 38472);
const HOST = process.env.GW_HOST || '0.0.0.0';
const TOKEN = process.env.GW_TOKEN || '';
const LOGF = process.env.GW_LOG || '';
function log(s) { const l = '[' + new Date().toISOString() + '] ' + s; console.log(l); if (LOGF) { try { fs.appendFileSync(LOGF, l + String.fromCharCode(10)); } catch (e) {} } }
let live = 0;
const server = net.createServer(function (sock) {
  sock.setNoDelay(true);
  let buf = '';
  let stage = 'hello';
  let up = null;
  const onData = function (d) {
    if (stage === 'hello') {
      buf += d.toString('latin1');
      const nl = buf.indexOf(String.fromCharCode(10));
      if (nl < 0) { if (buf.length > 512) sock.destroy(); return; }
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      const p = line.split(' ');
      if (p.length < 4 || p[0] !== 'GW1' || (TOKEN && p[1] !== TOKEN)) { sock.write('GW1 BAD' + String.fromCharCode(10)); return sock.destroy(); }
      const host = p[2], port = Number(p[3]);
      up = net.connect({ host: host, port: port }, function () {
        stage = 'pipe'; live++;
        sock.write('GW1 OK' + String.fromCharCode(10));
        if (buf) { up.write(buf); buf = ''; }
        sock.removeListener('data', onData);
        sock.pipe(up); up.pipe(sock);
      });
      up.on('error', function () { try { sock.write('GW1 ERR' + String.fromCharCode(10)); } catch (e) {} sock.destroy(); });
      sock.on('close', function () { live--; try { up.destroy(); } catch (e) {} });
      return;
    }
  };
  sock.on('data', onData);
  sock.on('error', function () { try { if (up) up.destroy(); } catch (e) {} });
});
server.listen(PORT, HOST, function () { log('ysd-gw listening ' + HOST + ':' + PORT + ' token=' + (TOKEN ? 'on' : 'off')); });
setInterval(function () { log('live=' + live); }, 300000);