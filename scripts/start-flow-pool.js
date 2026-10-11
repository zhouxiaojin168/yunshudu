/**
 * start-flow-pool.js -- 起/停「池②」两个进程（模拟 Google Flow 上游 + 账号池引擎）
 *
 *   node scripts/start-flow-pool.js start [--ban 20] [--at-ttl 60] [--at-refresh 30]
 *   node scripts/start-flow-pool.js stop
 *   node scripts/start-flow-pool.js status
 *
 * 默认值 = 照抄 flow2api 的生产值（ban 43200s=12h / AT 刷新阈值 3600s）；
 * 验收测试时会用 --ban 20 --at-refresh 30 把时间压缩，好观察 12h 冷却与刷新阈值行为。
 */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const LOGD = path.join(ROOT, 'runtime', 'logs');
fs.mkdirSync(LOGD, { recursive: true });

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const PIDS = {
  mockflow: path.join(LOGD, 'mock-flow.pid'),
  flowpool: path.join(LOGD, 'flow-pool.pid')
};

function stopOne(name) {
  const f = PIDS[name];
  if (!fs.existsSync(f)) return;
  const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
  try { process.kill(pid); console.log('已停 ' + name + ' pid=' + pid); } catch (e) { console.log(name + ' pid=' + pid + ' 已不在'); }
  fs.unlinkSync(f);
}
function startOne(name, script, env) {
  const out = fs.openSync(path.join(LOGD, name + '.out.log'), 'a');
  const err = fs.openSync(path.join(LOGD, name + '.err.log'), 'a');
  const c = cp.spawn(process.execPath, [path.join(ROOT, 'scripts', script)],
    { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, err], env: Object.assign({}, process.env, env || {}) });
  c.unref();
  fs.writeFileSync(PIDS[name], String(c.pid), 'ascii');
  console.log('已起 ' + name + ' pid=' + c.pid);
}

if (cmd === 'stop') { stopOne('mockflow'); stopOne('flowpool'); process.exit(0); }

if (cmd === 'status') {
  for (const k of Object.keys(PIDS)) {
    if (!fs.existsSync(PIDS[k])) { console.log(k + ': 未运行'); continue; }
    const pid = parseInt(fs.readFileSync(PIDS[k], 'utf8').trim(), 10);
    let alive = true; try { process.kill(pid, 0); } catch (e) { alive = false; }
    console.log(k + ': pid=' + pid + ' alive=' + alive);
  }
  process.exit(0);
}

// start
stopOne('mockflow'); stopOne('flowpool');
const ban = String(Number(argOf('--ban', 43200)));
const ttl = String(Number(argOf('--at-ttl', 3600)));
const refresh = String(Number(argOf('--at-refresh', 3600)));
startOne('mockflow', 'mock-flow.js', { FLOW_PORT: '9931', FLOW_AT_TTL_SECONDS: ttl });
startOne('flowpool', 'flow-pool.js', {
  FLOW_POOL_PORT: '9930', FLOW_UPSTREAM: 'http://127.0.0.1:9931',
  FLOW_BAN_SECONDS: ban, FLOW_AT_REFRESH_SECONDS: refresh
});
console.log('参数: ban=' + ban + 's  AT_TTL=' + ttl + 's  AT刷新阈值=' + refresh + 's');