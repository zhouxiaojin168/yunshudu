/**
 * sync-tunnel-url.js -- 把当前 cloudflared 快速隧道地址写进 web/index.html 的 window.__API_BASE__
 *
 *   node scripts/sync-tunnel-url.js            # 读 runtime/public-gateway-url.txt 写入 index.html（幂等）
 *   node scripts/sync-tunnel-url.js --push     # 写完再跑一次 auto-sync --once 推上去
 *   node scripts/sync-tunnel-url.js --clear    # 清空（回退成"同源/本地"模式）
 *
 * 为什么需要：cloudflared 免账号快速隧道的域名是**临时**的，重启就会换；
 * 每次换地址都要同步一次 __API_BASE__，否则线上页面只能显示内嵌快照。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IDX = path.join(ROOT, 'web', 'index.html');
const URLF = path.join(ROOT, 'runtime', 'public-gateway-url.txt');
const argv = process.argv.slice(2);

let url = '';
if (argv.includes('--clear')) {
  url = '';
} else {
  if (!fs.existsSync(URLF)) { console.error('缺少 ' + URLF + '，先跑 scripts/start-public-gateway.ps1'); process.exit(1); }
  url = fs.readFileSync(URLF, 'utf8').replace(/^\uFEFF/, '').trim().replace(/\/+$/, '');
  if (url && !/^https:\/\/[a-z0-9][a-z0-9.-]*$/.test(url)) { console.error('API_BASE 格式不对(需 https://域名): ' + url); process.exit(1); }
}

const html = fs.readFileSync(IDX, 'utf8');
const re = /<script>window\.__API_BASE__\s*=\s*'[^']*';<\/script>/;
if (!re.test(html)) { console.error('index.html 里没找到 __API_BASE__ 占位'); process.exit(1); }
const next = html.replace(re, "<script>window.__API_BASE__ = '" + url + "';</script>");
if (next === html) { console.log('__API_BASE__ 无变化，跳过写入 (' + (url || '清空') + ')'); }
else { fs.writeFileSync(IDX, next, 'utf8'); console.log('已写入 __API_BASE__ = ' + (url || '(清空)')); }

if (argv.includes('--push')) {
  const tokFile = path.join(process.env.USERPROFILE || '', '.yunshudu', 'gh-token.txt');
  const env = Object.assign({}, process.env);
  try { if (fs.existsSync(tokFile)) env.GITHUB_TOKEN = fs.readFileSync(tokFile, 'utf8').trim(); } catch (e) {}
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'auto-sync.js'), '--once'], { cwd: ROOT, encoding: 'utf8', env });
  console.log((r.stdout || '').trim());
}