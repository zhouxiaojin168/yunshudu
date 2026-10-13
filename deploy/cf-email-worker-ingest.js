/**
 * cf-email-worker-ingest.js (v3 + 自检)
 * 邮件路径与 v2 完全一致；额外加一个 fetch 自检入口 /__selftest?k=<INGEST_KEY>
 *   -> 让 Cloudflare 自己尝试 POST 到每个候选地址，并把结果原样吐回来（判断 CF 出口可达性）
 */
function candidateUrls(env) {
  const out = [];
  const push = (u) => { u = String(u || '').trim(); if (u && out.indexOf(u) === -1) out.push(u); };
  push(env.INGEST_URL);
  String(env.INGEST_URLS || '').split(',').forEach(push);
  return out;
}

async function deliver(url, env, message) {
  const raw = message.raw ? await new Response(message.raw).text() : '';
  const payload = {
    to: message.to, from: message.from,
    subject: message.subject || '',
    to_header: message.to_header || '',
    raw: raw, text: raw
  };
  return await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': String(env.INGEST_KEY || '') },
    body: JSON.stringify(payload),
    signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(8000) : undefined
  });
}

async function probe(env) {
  const results = [];
  for (const url of candidateUrls(env)) {
    const t0 = Date.now();
    let rec = { url: url, ms: 0 };
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-key': String(env.INGEST_KEY || '') },
        body: JSON.stringify({ to: 'hlcfselftest@qingzhou.autos', from: 'cf-selftest@workers.dev', subject: 'CF self-test', text: 'Your verification code is 000111' }),
        signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(8000) : undefined
      });
      rec.status = r.status;
      rec.ok = r.ok;
      rec.body = (await r.text()).slice(0, 200);
    } catch (e) {
      rec.err = (e && e.message) ? e.message : String(e);
    }
    rec.ms = Date.now() - t0;
    results.push(rec);
  }
  return results;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__selftest') {
      if (url.searchParams.get('k') !== String(env.INGEST_KEY || 'nolock')) {
        return new Response(JSON.stringify({ error: 'bad k' }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      const info = {
        colo: (request.cf && request.cf.colo) || null,
        ingest_url: env.INGEST_URL || null,
        ingest_urls: env.INGEST_URLS || null,
        key_len: String(env.INGEST_KEY || '').length,
        results: await probe(env)
      };
      return new Response(JSON.stringify(info, null, 2), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('yunshudu-ingest up', { status: 200 });
  },

  async email(message, env, ctx) {
    const list = candidateUrls(env);
    const key = String(env.INGEST_KEY || '');
    console.log('INGEST_CF v3 to=' + message.to + ' from=' + message.from + ' urls=' + JSON.stringify(list) + ' key_len=' + key.length);
    if (!list.length) throw new Error('INGEST_URL / INGEST_URLS not configured');
    const raw = await new Response(message.raw).text();
    const payload = {
      to: message.to, from: message.from,
      subject: message.headers.get('subject') || '',
      to_header: message.headers.get('to') || '',
      raw: raw, text: raw
    };
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