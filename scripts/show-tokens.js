/**
 * show-tokens.js -- 从本地 SQLite 读回令牌明文
 * (New API 的 /api/token 接口只返回脱敏 Key，本地排查直接读库最方便)
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(__dirname, '..');
const db = new DatabaseSync(path.join(ROOT, 'runtime', 'data', 'one-api.db'));
const rows = db.prepare('SELECT id, user_id, name, key, remain_quota, unlimited_quota, status FROM tokens ORDER BY id').all();
if (!rows.length) { console.log('(没有令牌，先跑 setup-channels.js)'); process.exit(0); }
for (const r of rows) {
  console.log(`#${r.id}\tuser=${r.user_id}\t${r.name}\tstatus=${r.status}\tquota=${r.unlimited_quota ? 'unlimited' : r.remain_quota}\n   sk-${r.key}`);
}
