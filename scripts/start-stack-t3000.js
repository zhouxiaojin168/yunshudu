/**
 * start-stack-t3000.js -- 本地按 45.207.214.163:3000 形态起栈（幂等）
 *   形态：new-api(3000，需先手工/脚本起) + mailfarm(8099) + 平台池h3-platform-pool(9940)
 *         + pool-supply(9950) + edge-proxy(8080 -> 3000)
 *   用法：node scripts\start-stack-t3000.js start|stop|status
 *   说明：平台池默认指**真上游** https://hailuoai.com（摘掉沙箱 mock 9941），
 *         无真号时池内 0 号属正常，接口形状与 :3000 一致。
 */
const fs2 = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const LOGD = path.join(ROOT, 'runtime', 'logs');
const STATE = path.join(ROOT, 'state');
fs2.mkdirSync(LOGD, { recursive: true });
fs2.mkdirSync(STATE, { recursive: true });

const MF_KEY = process.env.MF_API_KEY || 'local-mf-key';
const POOL_ADMIN = process.env.H3P_ADMIN_KEY || 'sk-hl-admin';
const SUPP_ADMIN = process.env.SUPP_ADMIN_KEY || 'sk-supply-admin';
const DOMAINS = process.env.MF_DOMAINS || 'allen23.online,jixuwz.com,lopwi.cyou,sghd.college,ytu.baby';

const PROCS = {
  mailfarm: {
    script: 'scripts\\mailfarm-server.js',
    env: { MF_SERVICE_NAME:'mailfarm', MF_DOMAINS:DOMAINS, MF_HTTP_HOST:'127.0.0.1', MF_HTTP_PORT:'8099',
           MF_SMTP_ENABLE:'0', MF_STORE:'file', MF_STATE_DIR: path.join(STATE,'mailfarm'),
           MF_API_KEY: MF_KEY, MF_INGEST_KEY: process.env.MF_INGEST_KEY || 'local-ingest-key',
           MF_MAILBOX_TTL_S:'3600', MF_CODE_MAX_AGE_S:'900' },
    port: 8099, health: 'http://127.0.0.1:8099/healthz'
  },
  'h3-platform-pool': {
    script: 'scripts\\h3-platform-pool.js',
    env: { H3P_PORT:'9940', H3P_ADMIN_KEY: POOL_ADMIN,
           H3P_UPSTREAM: process.env.H3P_UPSTREAM || 'https://hailuoai.com',
           H3P_ADAPTER_FILE: path.join(ROOT,'config','pool-adapter.hailuo-web.json'),
           H3P_DB: path.join(ROOT,'runtime','data','h3platformpool.db'),
           H3P_CHECKIN_MS: process.env.H3P_CHECKIN_MS || '60000',
           H3P_DAILY_CREDITS: '300', H3P_ACCOUNT_CAP:'1200', H3P_MAX_RETRIES:'3' },
    port: 9940, health: 'http://127.0.0.1:9940/v1/public/stats'
  },
  'pool-supply': {
    script: 'scripts\\pool-supply.js',
    env: { SUPP_PORT:'9950', SUPP_ADMIN_KEY: SUPP_ADMIN,
           SUPP_POOL_API:'http://127.0.0.1:9940', SUPP_POOL_ADMIN_KEY: POOL_ADMIN,
           SUPP_MAIL_API:'http://127.0.0.1:8099', SUPP_MAIL_KEY: MF_KEY,
           SUPP_MAIL_ACQUIRE_PATH:'/v1/mailboxes/acquire',
           SUPP_REGISTER_FILE: path.join(ROOT,'config','pool-register.mailfarm.json'),
           SUPP_STATE_FILE: path.join(STATE,'pool-supply.json'),
           SUPP_LOG_FILE: path.join(LOGD,'pool-supply.log'),
           SUPP_POOL_MIN: process.env.SUPP_POOL_MIN || '0', SUPP_POOL_MAX:'200', SUPP_REFILL_BATCH:'5',
           SUPP_INTERVAL_MS:'60000', SUPP_CHECKIN_EVERY:'20' },
    port: 9950, health: 'http://127.0.0.1:9950/healthz'
  },
  'edge-proxy': {
    script: 'scripts\\edge-proxy.js',
    env: { EDGE_PORT:'8080', EDGE_HOST:'127.0.0.1', EDGE_UPSTREAM:'http://127.0.0.1:3000',
           EDGE_LOG_DIR: LOGD, EDGE_RL_MAX:'0', EDGE_ACCESS_LOG:'0',
           EDGE_ROUTES:'/mailfarm=http://127.0.0.1:8099' },
    port: 8080, health: 'http://127.0.0.1:8080/__edge/health'
  }
};

const pidFile = (n) => path.join(LOGD, n + '.pid');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };

function stop() {
  for (const n of Object.keys(PROCS)) {
    const f = pidFile(n); if (!fs2.existsSync(f)) { console.log('skip ' + n); continue; }
    const pid = parseInt(fs2.readFileSync(f,'utf8').trim(),10);
    try { process.kill(pid); console.log('stopped ' + n + ' pid=' + pid); } catch (e) { console.log(n + ' already gone'); }
    try { fs2.unlinkSync(f); } catch (e) {}
  }
}
function status() {
  for (const n of Object.keys(PROCS)) {
    const f = pidFile(n);
    const pid = fs2.existsSync(f) ? parseInt(fs2.readFileSync(f,'utf8').trim(),10) : null;
    console.log(n + ': ' + (pid ? ('pid=' + pid + ' alive=' + alive(pid)) : 'not started'));
  }
}
function startOne(n) {
  const p = PROCS[n]; const f = pidFile(n);
  if (fs2.existsSync(f)) { const pid = parseInt(fs2.readFileSync(f,'utf8').trim(),10); if (alive(pid)) { console.log('already up: ' + n + ' pid=' + pid); return; } }
  const out = fs2.openSync(path.join(LOGD, n + '.out.log'), 'a');
  const err = fs2.openSync(path.join(LOGD, n + '.err.log'), 'a');
  const c = cp.spawn(process.execPath, [path.join(ROOT, p.script)], { cwd: ROOT, detached:true, windowsHide:true,
    stdio:['ignore', out, err], env: Object.assign({}, process.env, p.env) });
  c.unref(); fs2.writeFileSync(f, String(c.pid), 'ascii');
  console.log('started ' + n + ' pid=' + c.pid + ' port=' + p.port);
}

const cmd = process.argv[2] || 'status';
if (cmd === 'stop') stop();
else if (cmd === 'status') status();
else { for (const n of Object.keys(PROCS)) startOne(n); console.log('\nwaiting 3s..'); }
