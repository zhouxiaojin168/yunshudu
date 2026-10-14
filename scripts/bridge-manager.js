#!/usr/bin/env node
/**
 * bridge-manager.js -- 代理桥管理器（Dola/H3 共用出口的统一入口）
 *
 * 桥 = scripts/h3-proxy-bridge.js（HTTP+SOCKS5 同端口；自动探测或指定上游）
 * 配置文件：state/bridges.json
 *   [{"port":17896,"upstream":"http://127.0.0.1:10090","note":"Dola-01/03 + H3(JP 机场)"},
 *    {"port":17897,"upstream":"socks5://127.0.0.1:18081","note":"自建隧道(CN)"},
 *    {"port":18082,"upstream":"","note":"自动探测(取CK/J P)"}]
 *
 * 用法：
 *   node scripts/bridge-manager.js status            # 每个桥：监听/出口IP/国家
 *   node scripts/bridge-manager.js up [--force]      # 起全部桥（已在听则跳过；--force 先杀再起）
 *   node scripts/bridge-manager.js down [port]       # 停全部 / 停指定端口
 *   node scripts/bridge-manager.js switch <port> <upstream>   # 换上游并重启该桥（例：静态ISP）
 *   node scripts/bridge-manager.js add <port> <upstream> [note]
 *   node scripts/bridge-manager.js rm <port>
 *   node scripts/bridge-manager.js exit-ip <port>    # 单桥出口实测
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'state');
const CONF = path.join(STATE, 'bridges.json');
const BRIDGE = path.join(__dirname, 'h3-proxy-bridge.js');
const LOGDIR = path.join(STATE, 'bridge-logs');

const DEFAULT_CONF = [
  { port: 17896, upstream: 'http://127.0.0.1:10090', note: 'Dola 本机中转口 → JP 机场' },
  { port: 17897, upstream: 'socks5://127.0.0.1:18081', note: '第二出口 → 自建隧道 CN' },
  { port: 18082, upstream: '', note: '自动探测 → 取CK独立出口' }
];

function loadConf() {
  try { const j = JSON.parse(fs.readFileSync(CONF, 'utf8')); if (Array.isArray(j)) return j; } catch (e) {}
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(CONF, JSON.stringify(DEFAULT_CONF, null, 2), 'utf8');
  return DEFAULT_CONF.slice();
}
function saveConf(c) { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(CONF, JSON.stringify(c, null, 2), 'utf8'); }

function listening(port) {
  return new Promise(function (res) {
    const s = net.connect({ host: '127.0.0.1', port: port });
    s.setTimeout(700);
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('timeout', () => { s.destroy(); res(false); });
    s.on('error', () => res(false));
  });
}

function exitIp(port, timeoutMs) {
  return new Promise(function (res) {
    const req = http.request({ host: '127.0.0.1', port: port, method: 'GET', path: 'http://ip-api.com/json/?fields=status,query,country,isp', headers: { host: 'ip-api.com', 'user-agent': 'curl/8' } }, function (r) {
      let b = ''; r.on('data', (d) => b += d);
      r.on('end', function () { let j = null; try { j = JSON.parse(b); } catch (e) {} res(j || { raw: b.slice(0, 80) }); });
    });
    req.setTimeout(timeoutMs || 12000, function () { req.destroy(); res({ err: 'timeout' }); });
    req.on('error', (e) => res({ err: e.code || e.message }));
    req.end();
  });
}

function killByPort(port) {
  const out = cp.execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*h3-proxy-bridge.js*--port*' } | Select-Object -ExpandProperty ProcessId"],
    { encoding: 'utf8' });
  const pids = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let killed = 0;
  for (const pid of pids) {
    const cl = cp.execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"ProcessId=" + pid + "\").CommandLine"], { encoding: 'utf8' });
    if (cl.indexOf('--port ' + port) >= 0 || cl.indexOf('--port", "' + port) >= 0 || new RegExp('--port\\D{0,3}' + port + '\\b').test(cl)) {
      try { cp.execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); killed++; } catch (e) {}
    }
  }
  return killed;
}

function start(cfg) {
  fs.mkdirSync(LOGDIR, { recursive: true });
  const logf = path.join(LOGDIR, 'bridge-' + cfg.port + '.log');
  const out = fs.openSync(logf, 'a');
  const args = [BRIDGE, '--port', String(cfg.port)];
  if (cfg.upstream) args.push('--upstream', cfg.upstream);
  const p = cp.spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  p.unref();
  return p.pid;
}

(async function main() {
  const cmd = process.argv[2] || 'status';
  const conf = loadConf();

  if (cmd === 'status') {
    for (const c of conf) {
      const up = await listening(c.port);
      let line = '  ' + String(c.port).padEnd(6) + (up ? 'LISTEN ' : '--     ') + ' 上游=' + (c.upstream || '(自动探测)').padEnd(34) + ' ' + (c.note || '');
      if (up) { const e = await exitIp(c.port, 12000); line += '  出口=' + (e.query || e.err) + (e.country ? ' / ' + e.country : ''); }
      console.log(line);
    }
    return;
  }
  if (cmd === 'up') {
    const force = process.argv.indexOf('--force') >= 0;
    for (const c of conf) {
      const up = await listening(c.port);
      if (up && !force) { console.log('  ' + c.port + ' 已在监听，跳过'); continue; }
      if (up && force) killByPort(c.port);
      const pid = start(c);
      console.log('  ' + c.port + ' 启动 pid=' + pid + ' 上游=' + (c.upstream || '(自动探测)'));
      await new Promise((r) => setTimeout(r, 1200));
    }
    for (const c of conf) { const up = await listening(c.port); console.log('  [校验] ' + c.port + ' ' + (up ? 'OK' : 'FAIL')); }
    return;
  }
  if (cmd === 'down') {
    const only = process.argv[3] ? Number(process.argv[3]) : 0;
    for (const c of conf) { if (!only || c.port === only) console.log('  停 ' + c.port + ' -> killed=' + killByPort(c.port)); }
    return;
  }
  if (cmd === 'switch') {
    const port = Number(process.argv[3]); const upstream = process.argv[4] || '';
    const c = conf.find((x) => x.port === port);
    if (!c) { console.log('  没有这个桥：' + port); process.exit(2); }
    c.upstream = upstream; saveConf(conf);
    killByPort(port);
    await new Promise((r) => setTimeout(r, 600));
    const pid = start(c);
    await new Promise((r) => setTimeout(r, 1500));
    const e = await exitIp(port, 15000);
    console.log('  ' + port + ' 已切上游=' + (upstream || '(自动探测)') + ' pid=' + pid + ' 出口=' + (e.query || e.err) + (e.country ? ' / ' + e.country : ''));
    return;
  }
  if (cmd === 'add') {
    const port = Number(process.argv[3]); const upstream = process.argv[4] || ''; const note = process.argv[5] || '';
    if (conf.find((x) => x.port === port)) { console.log('  已存在'); return; }
    conf.push({ port: port, upstream: upstream, note: note }); saveConf(conf);
    const pid = start({ port: port, upstream: upstream });
    console.log('  已加 ' + port + ' pid=' + pid);
    return;
  }
  if (cmd === 'rm') {
    const port = Number(process.argv[3]);
    killByPort(port);
    saveConf(conf.filter((x) => x.port !== port));
    console.log('  已移除 ' + port);
    return;
  }
  if (cmd === 'exit-ip') {
    const port = Number(process.argv[3]);
    console.log(JSON.stringify(await exitIp(port, 15000)));
    return;
  }
  console.log('用法: node scripts/bridge-manager.js [status|up|down|switch|add|rm|exit-ip] …');
})().catch(function (e) { console.log('FATAL ' + e.message); process.exit(1); });