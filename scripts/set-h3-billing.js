/**
 * set-h3-billing.js -- 给 new-api 模型挂「按 length 分档」的表达式计费（幂等）
 *
 *   node app/scripts/set-h3-billing.js                 # 读 config/h3-billing.json
 *   node app/scripts/set-h3-billing.js --check         # 只看当前配置，不写
 *   node app/scripts/set-h3-billing.js --file <path>   # 指定配置文件
 *
 * 环境变量:
 *   NA_API   默认 http://127.0.0.1:3000
 *   NA_USER  默认 root
 *   NA_PASS  默认从 C:\yunshudu\secrets.txt 的 ADMIN_PASSWORD 读
 *
 * 为什么需要它:
 *   new-api 的「按次计费」(ModelPrice) 对视频只能一口价，秒数/分辨率再变也一个价。
 *   真正按 length 分档要用 billing_setting.billing_mode = tiered_expr +
 *   billing_setting.billing_expr = { 模型: 表达式 }，表达式形如
 *       u("seconds") <= 6 ? tier("H3-6s", u("seconds") * 0.0034) : tier("H3-long", u("seconds") * 0.0026)
 *   字段(u("..."))必须来自插件为该模型声明的用量 schema（H3 = seconds/resolution/input_images/input_video_seconds）。
 *
 * 顺序坑（实测）:
 *   先 PUT billing_expr，再 PUT billing_mode。
 *   反着来会被拒: {"message":"billing expression is required","success":false}
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const API = String(process.env.NA_API || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const USER = process.env.NA_USER || 'root';
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const fi = argv.indexOf('--file');
const CFG_PATH = fi >= 0 ? argv[fi + 1] : path.join(ROOT, 'config', 'h3-billing.json');

function readPass() {
  if (process.env.NA_PASS) return process.env.NA_PASS;
  for (const p of ['C:/yunshudu/secrets.txt', path.join(ROOT, '..', 'secrets.txt'), path.join(ROOT, 'secrets.txt')]) {
    try {
      const m = fs.readFileSync(p, 'utf8').match(/^ADMIN_PASSWORD=(.+)$/m);
      if (m) return m[1].trim();
    } catch (e) {}
  }
  return '';
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const models = cfg.models || {};
  const lr = await fetch(API + '/api/user/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: readPass() })
  });
  const lj = await lr.json();
  if (!lj.success) { console.error('登录失败: ' + JSON.stringify(lj).slice(0, 200)); process.exit(1); }
  const H = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + lj.data.access_token,
    'New-Api-User': String(lj.data.id || 1)
  };

  const opt = async () => (await (await fetch(API + '/api/option/', { headers: H })).json()).data;
  const cur = await opt();
  const getv = (k) => ((cur.find(x => x.key === k) || {}).value) || '{}';
  const exprMap = JSON.parse(getv('billing_setting.billing_expr'));
  const modeMap = JSON.parse(getv('billing_setting.billing_mode'));

  for (const [model, spec] of Object.entries(models)) {
    const now = '现在: mode=' + (modeMap[model] || '(无)') + ' expr=' + (exprMap[model] || '(无)');
    console.log('[' + model + '] ' + now);
    console.log('     目标: mode=' + spec.mode + ' expr=' + spec.expr);
    if (CHECK) continue;
    if (exprMap[model] === spec.expr && modeMap[model] === spec.mode) { console.log('     已一致，跳过'); continue; }
    exprMap[model] = spec.expr;
    let r = await fetch(API + '/api/option/', { method: 'PUT', headers: H, body: JSON.stringify({ key: 'billing_setting.billing_expr', value: JSON.stringify(exprMap) }) });
    let j = await r.json();
    console.log('     PUT expr -> ' + (j.success ? 'ok' : JSON.stringify(j)));
    modeMap[model] = spec.mode;
    r = await fetch(API + '/api/option/', { method: 'PUT', headers: H, body: JSON.stringify({ key: 'billing_setting.billing_mode', value: JSON.stringify(modeMap) }) });
    j = await r.json();
    console.log('     PUT mode -> ' + (j.success ? 'ok' : JSON.stringify(j)));
  }

  const pr = await (await fetch(API + '/api/pricing')).json();
  console.log('\n--- /api/pricing 用户侧口径 ---');
  for (const m of (pr.data || [])) {
    if (!models[m.model_name]) continue;
    console.log('  ' + m.model_name + '  billing_mode=' + m.billing_mode);
    console.log('     expr = ' + m.billing_expr);
    console.log('     可用字段 = ' + Object.keys(m.billing_usage_schema || {}).join(', '));
  }
})().catch(e => { console.error('FATAL ' + e.message); process.exit(1); });
