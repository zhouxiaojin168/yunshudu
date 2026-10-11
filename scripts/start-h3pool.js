/**
 * start-h3pool.js -- 起/停「平台池（H3 式）」两个进程
 *   node scripts/start-h3pool.js start [--checkin 60000] [--daily 300]
 *   node scripts/start-h3pool.js stop
 *   node scripts/start-h3pool.js status
 * 演示值：签到间隔 60s（生产 86400s=1 天）、每次签到 300 credit、账号上限 1200
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const LOGD = path.join(ROOT, 'runtime', 'logs');
fs.mkdirSync(LOGD, { recursive: true });
const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PIDS = { mockofficial: path.join(LOGD, 'mock-official.pid'), h3pool: path.join(LOGD, 'h3-platform-pool.pid') };
function stopOne(name) {
  const f = PIDS[name]; if (!fs.existsSync(f)) return;
  const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
  try { process.kill(pid); console.log('已停 ' + name + ' pid=' + pid); } catch (e) { console.log(name + ' pid=' + pid + ' 已不在'); }
  fs.unlinkSync(f);
}
function startOne(name, script, env) {
  const out = fs.openSync(path.join(LOGD, name + '.out.log'), 'a');
  const err = fs.openSync(path.join(LOGD, name + '.err.log'), 'a');
  const c = cp.spawn(process.execPath, [path.join(ROOT, 'scripts', script)], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, err], env: Object.assign({}, process.env, env || {}) });
  c.unref(); fs.writeFileSync(PIDS[name], String(c.pid), 'ascii'); console.log('已起 ' + name + ' pid=' + c.pid);
}
if (cmd === 'stop') { stopOne('mockofficial'); stopOne('h3pool'); process.exit(0); }
if (cmd === 'status') {
  for (const k of Object.keys(PIDS)) {
    if (!fs.existsSync(PIDS[k])) { console.log(k + ': 未运行'); continue; }
    const pid = parseInt(fs.readFileSync(PIDS[k], 'utf8').trim(), 10);
    let alive = true; try { process.kill(pid, 0); } catch (e) { alive = false; }
    console.log(k + ': pid=' + pid + ' alive=' + alive);
  }
  process.exit(0);
}
stopOne('mockofficial'); stopOne('h3pool');
const checkin = String(Number(argOf('--checkin', 60000)));
const daily = String(Number(argOf('--daily', 300)));
startOne('mockofficial', 'mock-official.js', { OFFICIAL_PORT: '9941', OFFICIAL_DAILY_CREDITS: daily });
startOne('h3pool', 'h3-platform-pool.js', { H3P_PORT: '9940', H3P_UPSTREAM: 'http://127.0.0.1:9941', H3P_CHECKIN_MS: checkin, H3P_DAILY_CREDITS: daily });
console.log('参数: 签到间隔=' + checkin + 'ms  每次签到=' + daily + ' credit');