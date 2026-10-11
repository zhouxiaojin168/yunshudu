/**
 * mock-pool.js -- 本地模拟"上游号池"，验证 New API 多 Key 渠道池行为
 *
 *   A 组  http://127.0.0.1:9921   2 个 key，每个 2 次额度   -> 健康
 *   B 组  http://127.0.0.1:9922   1 个 key，额度 0          -> 永远 402 欠费
 *
 * 上游返回 402 (insufficient balance) 时，站点侧用 status_code_mapping {"402":"401"}
 * 把它当成认证失败，从而【只把这一把 key 踢掉】，轮询自动换下一个号。
 *
 * 每个请求都会打印一行日志，便于取证"到底打到了哪个 key"：
 *   [mock][A] key=sk-a1  used=1/2  POST /v1/chat/completions -> 200
 *   [mock][A] key=sk-a1  used=2/2  POST /v1/chat/completions -> 402 insufficient balance
 */
const http = require('http');

function makeUpstream(tag, name, port, quota, defaultQuota) {
  const used = {};
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const total = quota[key] !== undefined ? quota[key] : defaultQuota;
      const spent = used[key] || 0;

      if (!key || total - spent <= 0) {
        console.log(`[mock][${tag}] key=${key || '(none)'}  used=${spent}/${total}  ${req.method} ${req.url} -> 402 insufficient balance`);
        res.writeHead(402, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: { message: 'insufficient balance', type: 'insufficient_quota', code: 'insufficient_quota' }
        }));
      }
      used[key] = spent + 1;

      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        console.log(`[mock][${tag}] key=${key}  used=${spent + 1}/${total}  GET ${req.url} -> 200`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'MiniMax-H3', object: 'model' }] }));
      }

      let model = 'MiniMax-H3';
      try { model = JSON.parse(body).model || model; } catch (e) {}

      console.log(`[mock][${tag}] key=${key}  used=${spent + 1}/${total}  ${req.method} ${req.url} -> 200 (${model})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: `[${name}] served key=${key} (${spent + 1}/${total})` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }));
    });
  });
  srv.listen(port, () => console.log(`[mock-pool] ${name} on ${port}  (keys=${JSON.stringify(quota)} default=${defaultQuota})`));
  return srv;
}

makeUpstream('A', 'UPSTREAM-A(healthy)', 9921, { 'sk-a1': 2, 'sk-a2': 2 }, 2);
makeUpstream('B', 'UPSTREAM-B(quota-dead)', 9922, { 'sk-b1': 0 }, 0);
