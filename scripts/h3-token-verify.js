'use strict';
/* r275-verify.js —— 用 r274 拿到的 H3 token 复核额度/资格 */
const fs = require('fs');
const crypto = require('crypto');
const PW = 'D:\\破甲\\1\\OpenAI.Codex_26.715.3651.0_x64(免安装版 适合大多数电脑)\\.codex\\skills\\openai-security-review\\node_modules\\playwright';
const { request } = require(PW);
const OPS = 'E:\\中转站测试\\_ops';
const LOG = OPS + '\\r275.log';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3OTU0NTM3OTQsInVzZXIiOnsiaWQiOiI1NjY4MjUxNjIwNTIxNzc5MjkiLCJuYW1lIjoiRmhkIEtub3ggTWluaSIsImF2YXRhciI6IiIsImRldmljZUlEIjoiNTY2ODE1NDM4Mjg4MTU4NzI0IiwiaXNBbm9ueW1vdXMiOmZhbHNlfX0.lS8c2h1IQUktxkP5cSQwGWokSQaxHU3Zb71b_hrpdZQ';
const Q = 'device_platform=web&app_id=3001&version_code=22203&biz_id=0&unix=';
const log = function () { const s = '[' + new Date().toISOString().slice(11, 19) + '] ' + Array.prototype.join.call(arguments, ' '); console.log(s); try { fs.appendFileSync(LOG, s + '\n', 'utf8'); } catch (e) {} };
function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }
function sign(path) {
  const ts = Date.now();
  const query = Q + ts + '&lang=zh-Hans&uuid=00000000-0000-0000-0000-000000000000&os_name=Windows&browser_name=Chrome';
  const yy = md5(encodeURIComponent(path + '?' + query) + '_' + '{}' + md5(String(ts)) + 'ooui');
  return { url: 'https://hailuoai.video' + path + '?' + query, yy, ts };
}
(async () => {
  try { fs.writeFileSync(LOG, ''); } catch (e) {}
  const ctx = await request.newContext({ proxy: { server: 'http://127.0.0.1:17899' }, timeout: 40000, ignoreHTTPSErrors: true });
  for (const p of ['/v1/api/user/equity', '/v1/api/billing/credit', '/v1/api/user/info']) {
    const s = sign(p);
    const r = await ctx.get(s.url, { headers: { token: TOKEN, yy: s.yy, 'content-type': 'application/json' } });
    const t = await r.text();
    log(p + ' -> ' + r.status() + ' : ' + t.slice(0, 700));
  }
  const nc = await ctx.get('https://hailuoai.video/public/v1/api/user/new_user_credit');
  log('/public/v1/api/user/new_user_credit -> ' + nc.status() + ' : ' + (await nc.text()).slice(0, 200));
  await ctx.dispose();
  process.exit(0);
})();