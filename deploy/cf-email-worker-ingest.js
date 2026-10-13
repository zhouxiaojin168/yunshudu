/**
 * cf-email-worker-ingest.js -- Cloudflare Email Routing -> Email Worker -> 我方 mailfarm /v1/ingest
 *
 * 用途：把「任意 xxx@自有域」的信原封不动 POST 到我方服务器（无需 25 端口、无需 destination 邮箱验证）。
 * 部署：Cloudflare Dashboard -> Workers & Pages -> Create -> Worker -> 粘贴本文件 -> Settings -> Variables 配
 *        INGEST_URL = http://114.66.16.225:8099/v1/ingest     (Plain text)
 *        INGEST_KEY = <C:\yunshudu\secrets.txt 里的 MAILFARM_INGEST_KEY>   (Encrypt/Secret 推荐)
 *      然后 Email Routing -> Routes -> Catch-all -> Action = Send to a Worker -> 选本 Worker
 * 约束：被路由的收件域必须写进服务器 services.json 的 MF_DOMAINS，否则 ingest 会 400 domain not served。
 */
export default {
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).text();
    const payload = {
      to: message.to,
      from: message.from,
      subject: message.headers.get('subject') || '',
      to_header: message.headers.get('to') || '',
      raw: raw,
      text: raw
    };
    const res = await fetch(env.INGEST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-key': env.INGEST_KEY },
      body: JSON.stringify(payload)
    });
    const body = await res.text();
    console.log('ingest ' + res.status + ' to=' + message.to + ' body=' + body.slice(0, 200));
    if (!res.ok) {
      // 让 CF 侧看到失败（needs SMTP error 可触发重试）；不抛则视为已接收
      throw new Error('ingest failed ' + res.status + ': ' + body.slice(0, 120));
    }
  }
};
