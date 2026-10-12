/**
 * test-call.js -- 端到端验证"多 Key 渠道池"行为
 *   连续 N 次 /v1/chat/completions，观察：轮询换 key / 402->401 单 key 熔断 / 渠道自动禁用
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const KEY = fs.readFileSync(path.join(ROOT, 'runtime', 'test-token.txt'), 'utf8').trim();
const BASE = 'http://127.0.0.1:3000';
const N = Number(process.argv[2] || 8);

(async () => {
  console.log(`token=${KEY}`);
  for (let i = 1; i <= N; i++) {
    const r = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: 'MiniMax-H3', messages: [{ role: 'user', content: 'ping ' + i }] })
    });
    const t = await r.text();
    let info = t.slice(0, 150).replace(/\s+/g, ' ');
    try { const j = JSON.parse(t); info = j.choices ? j.choices[0].message.content : (j.error ? JSON.stringify(j.error) : info); } catch (e) {}
    console.log(`  call#${i}  HTTP ${r.status}  ${info}`);
  }
})();
