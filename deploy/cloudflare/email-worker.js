/**
 * cloudflare-email-worker.js -- 把 Cloudflare Email Routing 收到的邮件转给自建 mailfarm
 *
 * 为什么用它：自建 SMTP 需要机房放行 25 端口（国内云默认封杀，实测 114.66.16.225 的
 * 25/2525 无论是否监听都被 RST）。Cloudflare Email Routing 免费、不需要 25，
 * 在 CF 边缘收信后用 Worker 把邮件 POST 到我们服务器上的 /v1/ingest。
 *
 * 部署步骤（Cloudflare Dashboard）：
 *   1) 域名加入 Cloudflare（DNS 由 CF 托管）-> Email -> Email Routing -> 启用
 *   2) Email Routing -> Routes -> Catch-all address -> Action: Send to a Worker -> 选本 Worker
 *   3) 本 Worker 的 Variables and Secrets 里配：
 *        MF_INGEST_URL = https://<你的隧道或反代域名>/v1/ingest
 *        MF_INGEST_KEY = <服务器 secrets.txt 里的 MAILFARM_INGEST_KEY>
 *   4) 服务端 MF_DOMAINS 必须包含该域名，否则 ingest 返回 400
 *
 * 注意：Email Routing 只允许「转发到已验证地址」或「交给 Worker」，Worker 里可以自由 fetch，
 *      这正是绕过 25 端口封锁的关键点。
 */
export default {
  async email(message, env, ctx) {
    const chunkList = [];
    const reader = message.raw.getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      chunkList.push(r.value);
    }
    let size = 0;
    for (const c of chunkList) size += c.length;
    const all = new Uint8Array(size);
    let off = 0;
    for (const c of chunkList) { all.set(c, off); off += c.length; }
    const raw = new TextDecoder('utf-8').decode(all);

    const payload = {
      to: message.to,
      from: message.from,
      subject: message.headers.get('subject') || '',
      raw: raw,
      received_at: new Date().toISOString()
    };

    const res = await fetch(env.MF_INGEST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ingest-key': env.MF_INGEST_KEY || ''
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    if (!res.ok) {
      // 让 CF 侧能看见失败原因（可在 Worker Logs 里查）
      console.log('ingest failed', res.status, text.slice(0, 300));
      throw new Error('mailfarm ingest ' + res.status + ': ' + text.slice(0, 200));
    }
    console.log('ingest ok', message.to, text.slice(0, 200));
  }
};
