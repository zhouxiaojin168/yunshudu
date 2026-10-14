#!/usr/bin/env node
/**
 * ysd-gw-client.js -- 自建网关「本地接入端」（SOCKS5 -> 自建出口中继）
 * 本机监听 127.0.0.1:18081，提供**无鉴权 SOCKS5**（只绑本机）；每条连接透传到
 * ysd-gw-server.js，出口即那台服务器的 IP。Playwright: proxy:{server:'socks5://127.0.0.1:18081'}
 * 用法：GW_REMOTE=114.66.16.225:38472 GW_TOKEN=xxx GW_LOCAL_PORT=18081 node ysd-gw-client.js
 */
'use strict';
const net = require('net');
const fs = require('fs');
const REMOTE = String(process.env.GW_REMOTE || '114.66.16.225:38472');
const RH = REMOTE.split(':')[0], RP = Number(REMOTE.split(':')[1]);
const TOKEN = process.env.GW_TOKEN || '';
const LPORT = Number(process.env.GW_LOCAL_PORT || 18081);
const LOGF = process.env.GW_LOG || '';
function log(s) { const l = '[' + new Date().toISOString() + '] ' + s; console.log(l); if (LOGF) { try { fs.appendFileSync(LOGF, l + String.fromCharCode(10)); } catch (e) {} } }

function dialRemote(host, port, cb) {
  const up = net.connect({ host: RH, port: RP });
  up.setNoDelay(true);
  up.once('connect', function () {
    up.write('GW1 ' + TOKEN + ' ' + host + ' ' + port + String.fromCharCode(10));
    let hb = '';
    const onH = function (d) {
      hb += d.toString('latin1');
      if (hb.indexOf(String.fromCharCode(10)) < 0) return;
      up.removeListener('data', onH);
      if (hb.indexOf('GW1 OK') === 0) cb(null, up);
      else { up.destroy(); cb(new Error('gw rejected')); }
    };
    up.on('data', onH);
  });
  up.once('error', function (e) { cb(e); });
  return up;
}

const server = net.createServer(function (sock) {
  sock.setNoDelay(true);
  let stage = 'greet';
  let buf = Buffer.alloc(0);
  let up = null, handshook = false;

  sock.on('data', function (chunk) {
    if (stage === 'pipe') return;
    buf = Buffer.concat([buf, chunk]);
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
      if (stage === 'req') {
        if (buf.length < 5) return;
        if (buf[0] !== 5 || buf[1] !== 1) { sock.destroy(); return; }
        const atyp = buf[3];
        let host = '', port = 0, need = 0;
        if (atyp === 1) { need = 4 + 4 + 2; if (buf.length < need) return; host = buf.slice(4, 8).join('.'); port = buf.readUInt16BE(8); }
        else if (atyp === 3) { if (buf.length < 5) return; const l = buf[4]; need = 5 + l + 2; if (buf.length < need) return; host = buf.slice(5, 5 + l).toString('utf8'); port = buf.readUInt16BE(5 + l); }
        else if (atyp === 4) { need = 4 + 16 + 2; if (buf.length < need) return; const h = buf.slice(4, 20); const parts = []; for (let i = 0; i < 16; i += 2) parts.push(h.readUInt16BE(i).toString(16)); host = parts.join(':'); port = buf.readUInt16BE(20); }
        else { sock.destroy(); return; }
        const rest = buf.slice(need);
        buf = Buffer.alloc(0);
        stage = 'pipe';
        log('CONNECT ' + host + ':' + port);
        const fail = function (code) { try { sock.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])); } catch (e) {} sock.destroy(); };
        up = dialRemote(host, port, function (err) {
          if (err) return fail(5);
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          sock.removeAllListeners('data');
          sock.on('data', function (d) { up.write(d); });
          up.on('data', function (d) { sock.write(d); });
          up.on('close', function () { try { sock.destroy(); } catch (e) {} });
          sock.on('close', function () { try { up.destroy(); } catch (e) {} });
          sock.on('error', function () { try { up.destroy(); } catch (e) {} });
          up.on('error', function () { try { sock.destroy(); } catch (e) {} });
          if (rest.length) up.write(rest);
          handshook = true;
        });
        return;
      }
      return;
    }
  });
  sock.on('error', function () { try { if (up) up.destroy(); } catch (e) {} });
});
server.listen(LPORT, '127.0.0.1', function () { log('SOCKS5 local 127.0.0.1:' + LPORT + '  ->  gw ' + REMOTE); });
process.on('uncaughtException', function (e) { log('uncaught ' + e.message); });