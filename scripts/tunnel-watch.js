/**
 * tunnel-watch.js -- 盯 cloudflared quick tunnel 的临时域名，落盘 + 同步到站点 ServerAddress
 *
 *   为什么需要：cloudflared 免账号「快速隧道」给的域名是**临时**的（重启就换）。
 *   这个守护进程每隔 TW_INTERVAL 秒扫一遍 cloudflared 的日志，抓到最新域名后：
 *     1) 写到 <root>\state\tunnel-url.txt（给 post-deploy 做健康探针，也方便人看）
 *     2) 通过管理 API 把站点 ServerAddress 改成该域名（分享链接才指向对的地址）
 *
 *   环境变量：
 *     TW_ROOT  默认 <repo>/..（即 C:\yunshudu）
 *     TW_LOG   cloudflared 日志，默认 C:\yunshudu\logs\cloudflared.err.log
 *     TW_STATE 域名落盘，默认 <TW_ROOT>/state/tunnel-url.txt
 *     TW_API   管理 API，默认 http://127.0.0.1:3000
 *     TW_USER  管理员用户名，默认 root
 *     TW_PASS  管理员密码；不设则从 <TW_ROOT>\secrets.txt 的 ADMIN_PASSWORD 读
 *     TW_INTERVAL 轮询秒数，默认 20
 *     TW_SET_SERVER_ADDRESS '0' 时只落盘不改站点（默认改）
 *
 *   用法: node scripts/tunnel-watch.js [--once]
 */
const fs = require('fs');
const path = require('path');

const NL = String.fromCharCode(10);
const ROOT = process.env.TW_ROOT || path.resolve(__dirname, '..');
const LOGF = process.env.TW_LOG || 'C:\\yunshudu\\logs\\cloudflared.err.log';
const STATE = process.env.TW_STATE || path.join(ROOT, 'state', 'tunnel-url.txt');
const API = String(process.env.TW_API || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const USER = process.env.TW_USER || 'root';
const INTERVAL = Math.max(5, Number(process.env.TW_INTERVAL || 20));
const SET_ADDR = process.env.TW_SET_SERVER_ADDRESS !== '0';
const ONCE = process.argv.indexOf('--once') >= 0;

let bomDone = false;
function log(line) {
  const s = '[' + new Date().toISOString() + '] ' + line;
  console.log(s);
  try {
    const dir = path.join(ROOT, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'tunnel-watch.log');
    if (!bomDone && !fs.existsSync(f)) fs.writeFileSync(f, String.fromCharCode(0xFEFF), 'utf8');
    bomDone = true;
    fs.appendFileSync(f, s + NL, 'utf8');
  } catch (e) {}
}

function readPass() {
  if (process.env.TW_PASS) return String(process.env.TW_PASS);
  const cands = [path.join(ROOT, 'secrets.txt'), 'C:\\yunshudu\\secrets.txt'];
  for (const p of cands) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const m = txt.match(/^ADMIN_PASSWORD=(.+)$/m);
      if (m) return m[1].trim();
    } catch (e) {}
  }
  return '';
}

const TUNNEL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/g;

function sniffUrl() {
  try {
    const size = fs.statSync(LOGF).size;
    if (size <= 0) return '';
    const rd = Math.min(size, 300000);
    const fd = fs.openSync(LOGF, 'r');
    const buf = Buffer.alloc(rd);
    fs.readSync(fd, buf, 0, rd, size - rd);
    fs.closeSync(fd);
    const found = buf.toString('utf8').match(TUNNEL_RE);
    if (found && found.length) return found[found.length - 1];
  } catch (e) {}
  return '';
}

function writeState(url) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, url + NL, 'utf8');
    return true;
  } catch (e) { log('writeState error: ' + e.message); return false; }
}

function touchState() {
  try {
    const now = new Date();
    fs.utimesSync(STATE, now, now);
  } catch (e) {}
}

async function setServerAddress(url) {
  if (!SET_ADDR) return false;
  const pass = readPass();
  if (!pass) { log('no ADMIN_PASSWORD -> skip ServerAddress sync'); return false; }
  try {
    const lr = await fetch(API + '/api/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: pass })
    });
    const lj = await lr.json();
    if (!lj.success) { log('login FAIL ' + JSON.stringify(lj).slice(0, 150)); return false; }
    const H = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + lj.data.access_token,
      'New-Api-User': String(lj.data.id)
    };
    const r = await fetch(API + '/api/option/', {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ key: 'ServerAddress', value: url })
    });
    const j = await r.json();
    log('ServerAddress -> ' + url + ' :: http ' + r.status + ' ' + (j.success ? 'ok' : JSON.stringify(j).slice(0, 150)));
    return !!j.success;
  } catch (e) {
    log('setServerAddress ERROR ' + e.message);
    return false;
  }
}

let last = '';
let missCount = 0;

async function tick() {
  const url = sniffUrl();
  if (!url) {
    missCount++;
    if (missCount === 1 || missCount % 15 === 0) log('no tunnel url yet in ' + LOGF + ' (miss=' + missCount + ')');
    return;
  }
  missCount = 0;
  if (url !== last) {
    last = url;
    if (writeState(url)) log('tunnel url = ' + url + ' (written to ' + STATE + ')');
    await setServerAddress(url);
  } else {
    touchState();
  }
}

async function main() {
  log('tunnel-watch start log=' + LOGF + ' state=' + STATE + ' api=' + API + ' interval=' + INTERVAL + 's setAddr=' + SET_ADDR);
  await tick();
  if (ONCE) {
    if (!last) { log('--once: no url found'); process.exit(1); }
    log('--once done, url=' + last);
    process.exit(0);
  }
  setInterval(() => { tick().catch((e) => log('tick error ' + e.message)); }, INTERVAL * 1000);
}

process.on('SIGTERM', () => { log('SIGTERM -> exit'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT -> exit'); process.exit(0); });

main().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
