/**
 * cf-email-worker-ingest.js -- Cloudflare Email Routing -> Email Worker -> self-hosted mailfarm /v1/ingest
 *
 * 用途：把「任意 xxx@自有域」的信原封不动 POST 到自有服务器（无需 25 端口、无需 destination 邮箱验证）。
 *
 * 部署（Cloudflare Dashboard）：
 *   Workers & Pages -> Create -> Worker -> 粘贴本文件 -> Deploy
 *   Settings -> Variables and Secrets:
 *     INGEST_URL  = http://114.66.16.225:8099/v1/ingest          (最小可用；单地址)
 *     INGEST_URLS = http://114.66.16.225:8099/v1/ingest,https://<隧道域名>/mailfarm/v1/ingest   (推荐：多候选自动回退)
 *     INGEST_KEY  = <服务器 C:\yunshudu\secrets.txt 里的 MAILFARM_INGEST_KEY>   (点 Encrypt)
 *   然后 Email Routing -> Routes/Catch-all -> Action = Send to a Worker -> 选本 Worker
 *
 * 行为（v2 / R144aj）：
 *   1) 依次尝试 INGEST_URL + INGEST_URLS（去重）里的每个地址；任一 2xx = 成功。
 *   2) 单次请求 8s 超时；网络异常或 5xx -> 换下一个候选。
 *   3) 401/403（密钥错）-> throw，让 CF 记「送达失败」并把问题暴露出来。
 *   4) 其他 4xx（如 400 domain not served）-> 只 console.log WARN，不退回。
 *   5) 全部候选失败 -> throw（CF 记送达失败）。
 *   Workers Logs 里会打印 INGEST_CF 前缀的每一跳结果，用来定位是「打不到」还是「密钥错」。
 *
 * 约束：被路由的收件域必须写进服务器 services.json 的 MF_DOMAINS，否则 ingest 会 400 domain not served。
 */
function candidateUrls(env) {
  const out = [];
  const push = (u) => { u = String(u || '').trim(); if (u && out.indexOf(u) === -1) out.push(u); };
  push(env.INGEST_URL);
  String(env.INGEST_URLS || '').split(',').forEach(push);
  return out;
}

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
    const list = candidateUrls(env);
    const key = String(env.INGEST_KEY || '');
    console.log('INGEST_CF v2 to=' + message.to + ' from=' + message.from + ' urls=' + JSON.stringify(list) + ' key_len=' + key.length);
    if (!list.length) throw new Error('INGEST_URL / INGEST_URLS not configured');

    let last = '';
    for (const url of list) {
      let res = null, body = '', err = null;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-ingest-key': key },
          body: JSON.stringify(payload),
          signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(8000) : undefined
        });
        body = await res.text();
      } catch (e) { err = (e && e.message) ? e.message : String(e); }
      last = 'url=' + url + ' err=' + err + ' status=' + (res && res.status) + ' body=' + String(body).slice(0, 200);
      console.log('INGEST_CF ' + last);
      if (!err && res && res.status >= 200 && res.status < 300) return;
      if (!err && res && (res.status === 401 || res.status === 403)) throw new Error('ingest auth failed: ' + last);
    }
    throw new Error('all ingest targets failed: ' + last);
  }
};
