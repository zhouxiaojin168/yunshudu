/**
 * auto-sync.js -- 本地改动自动同步到 GitHub（实时监听 + 定时兜底）
 *
 *   node scripts/auto-sync.js                    # 常驻：监听文件变化，防抖后自动提交推送
 *   node scripts/auto-sync.js --once             # 只跑一次同步（给计划任务用）
 *   node scripts/auto-sync.js --interval 300     # 兜底定时器间隔秒数（默认 300，0=关闭）
 *
 * 每次同步做的事：
 *   1) 尽力重建网页快照（网关在线时，让线上 Pages 的数据跟着更新）
 *   2) git add -A -> 没变化就跳过
 *   3) 敏感信息自检（命中 sk-xxx / password: / access_token: 直接中止，不推）
 *   4) git commit -> git push
 *
 * token 读取顺序：环境变量 GITHUB_TOKEN > runtime/github-token.txt > $CODEX_HOME/work/tools/gh-token.json
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOGD = path.join(ROOT, 'runtime', 'logs');
const LOGF = path.join(LOGD, 'auto-sync.log');
const GIT = process.env.GIT_EXE || 'E:\\git\\Git\\cmd\\git.exe';
const PROXY = process.env.GIT_PROXY || 'http://127.0.0.1:10090';

const argv = process.argv.slice(2);
const ONCE = argv.includes('--once');
const argOf = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : dflt; };
const DEBOUNCE_MS = argOf('--debounce', 8) * 1000;
const INTERVAL_MS = argOf('--interval', 300) * 1000;
let muteUntil = 0;   // 同步期间自己写文件产生的 watch 事件，直接忽略
let lastPushAt = 0;  // 上次推送成功时间（无新提交时的推送节流）

fs.mkdirSync(LOGD, { recursive: true });

let logBomDone = false;
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    // 首次创建时补 BOM，方便 PowerShell 5.1 的 Get-Content 正确显示中文
    if (!logBomDone && !fs.existsSync(LOGF)) { fs.writeFileSync(LOGF, '\uFEFF', 'utf8'); }
    logBomDone = true;
    fs.appendFileSync(LOGF, line + '\n', 'utf8');
  } catch (e) {}
}

function git(args, opts) {
  return spawnSync(GIT, ['-C', ROOT, ...args], Object.assign({ encoding: 'utf8', timeout: 120000 }, opts || {}));
}

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  // token 绝不放进仓库目录，只放仓库外。查找顺序：
  //   ① GITHUB_TOKEN 环境变量  ② GITHUB_TOKEN_FILE 指定的文件
  //   ③ %USERPROFILE%\.yunshudu\gh-token.txt（推荐，最稳）
  //   ④ %CODEX_HOME%\work\tools\gh-token.json
  const cands = [];
  if (process.env.GITHUB_TOKEN_FILE) cands.push(process.env.GITHUB_TOKEN_FILE);
  if (process.env.USERPROFILE) cands.push(path.join(process.env.USERPROFILE, '.yunshudu', 'gh-token.txt'));
  if (process.env.CODEX_HOME) cands.push(path.join(process.env.CODEX_HOME, 'work', 'tools', 'gh-token.json'));
  for (const p of cands) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
      if (raw.startsWith('{')) { const j = JSON.parse(raw); if (j.access_token) return j.access_token; }
      else if (raw) return raw;
    } catch (e) {}
  }
  return null;
}

function remoteUrl() {
  const r = git(['remote', 'get-url', 'origin']);
  return (r.stdout || '').trim();
}

/* ---- 敏感信息自检：命中就中止本次推送 ---- */
/* 只对"新增的行"做检查，并跳过本文件自身；要求值确实长得像密钥，避免误伤文档/正则 */
const GUARD_SELF = ['scripts/auto-sync.js'];   // 这些文件永远不算'新增敏感内容'（它们本身就是规则）
const NEVER_TRACK = ['runtime/github-token.txt', 'runtime/credentials.txt', 'runtime/test-token.txt'];  // 双保险：命中直接拒绝
const RISKY = [
  /\bsk-[A-Za-z0-9]{32,}\b/,                                                  // 平台令牌明文
  /\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}/,       // JWT
  /(?:access_token|api[_-]?key|passwd|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_\-\/\+\.=!@#$%^&*]{24,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];
function riskyHits() {
  const names = (git(['diff', '--cached', '--name-only']).stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  const hits = [];
  for (const n of names) {
    if (GUARD_SELF.includes(n)) continue;
    if (NEVER_TRACK.includes(n)) { hits.push(n + ' :: 该文件被列为绝不入库'); continue; }
    const d = git(['diff', '--cached', '--unified=0', '--', n]);
    if (d.status !== 0) continue;
    for (const ln of (d.stdout || '').split('\n')) {
      if (!ln.startsWith('+') || ln.startsWith('+++')) continue;
      for (const re of RISKY) {
        if (re.test(ln)) { hits.push(n + ' :: ' + ln.slice(1, 150).trim()); break; }
      }
    }
  }
  return hits;
}
function rebuildSnapshot() {
  const script = path.join(ROOT, 'scripts', 'build-site-json.js');
  if (!fs.existsSync(script)) return;
  const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  if (r.status === 0) log('  快照已重建');
  else log('  快照重建跳过（网关可能没开）');
}

function sync(reason) {
  muteUntil = Date.now() + 5000;   // 同步期间屏蔽自触发
  log(`同步开始（${reason}）`);
  rebuildSnapshot();

  let r = git(['add', '-A']);
  if (r.status !== 0) return log('  git add 失败: ' + (r.stderr || '').trim());

  const st = git(['status', '--porcelain']);
  if ((st.stdout || '').trim()) {
    const hits = riskyHits();
    if (hits.length) {
      git(['reset']);
      log('  ✋ 检测到疑似敏感信息，已中止（未提交、未推送）：');
      hits.slice(0, 5).forEach(h => log('    ' + h));
      return;
    }
    const msg = 'auto-sync: ' + new Date().toLocaleString('zh-CN', { hour12: false });
    r = git(['commit', '-m', msg]);
    if (r.status !== 0) return log('  commit 失败: ' + ((r.stderr || '') + (r.stdout || '')).trim().slice(0, 300));
    log('  committed: ' + msg);
  } else {
    // 没有新提交：只在"距上次成功推送超过 5 分钟"时才推一次，避免空转
    if (Date.now() - lastPushAt < 5 * 60 * 1000) return log('  没有新变化，且刚推过，跳过');
    log('  没有新变化（兜底推一次，保证之前失败的能自愈）');
  }

  const tok = readToken();
  const url = remoteUrl();
  if (!tok || !url) return log('  ⚠ 缺少 token 或 remote，已提交但未推送');
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!m) return log('  ⚠ remote 不是 github 地址: ' + url);
  const pushUrl = `https://${m[1]}:${tok}@github.com/${m[1]}/${m[2]}.git`;

  r = git(['-c', 'credential.helper=', '-c', `http.proxy=${PROXY}`, 'push', pushUrl, 'main:main'],
          { env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }) });
  if (r.status === 0) { lastPushAt = Date.now(); log('  ✅ pushed -> ' + `https://github.com/${m[1]}/${m[2]}`); }
  else log('  ❌ push 失败: ' + ((r.stderr || '') + (r.stdout || '')).trim().slice(0, 300));
}

/* ---------- 主流程 ---------- */
if (ONCE) { sync('--once'); process.exit(0); }

log(`监听启动：${ROOT}`);
log(`  防抖 ${DEBOUNCE_MS / 1000}s ｜ 兜底定时 ${INTERVAL_MS ? INTERVAL_MS / 1000 + 's' : '关闭'} ｜ 日志 runtime/logs/auto-sync.log`);
if (!readToken()) log('  ⚠ 没读到 GitHub token，改动只会提交不会推送');

let timer = null;
let pending = false;
function bump(why) {
  pending = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { pending = false; sync('文件变化'); }, DEBOUNCE_MS);
}

const SKIP = [path.sep + '.git' + path.sep, path.sep + 'runtime' + path.sep, path.sep + 'node_modules' + path.sep];
try {
  fs.watch(ROOT, { recursive: true }, (ev, name) => {
    if (!name) return;
    const full = path.sep + name;
    if (SKIP.some(s => full.includes(s))) return;
    if (name.endsWith('.log') || name.endsWith('.pid') || name.endsWith('.tmp')) return;
    if (Date.now() < muteUntil) return;   // 自己刚写过的文件，别自触发
    bump(name);
  });
  log('  fs.watch 已挂载（recursive）');
} catch (e) {
  log('  ⚠ fs.watch 失败，仅靠兜底定时器: ' + e.message);
}

if (INTERVAL_MS > 0) {
  setInterval(() => { if (!pending) sync('兜底定时'); }, INTERVAL_MS);
}

process.on('SIGINT', () => { log('收到退出信号，收尾一次'); sync('退出前'); process.exit(0); });