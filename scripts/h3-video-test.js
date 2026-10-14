/**
 * h3-video-test.js -- 用号池里的号「真发一条 H3 视频」，验证扣费路径 + 新人免费额度是否真可用
 *
 * 用法:
 *   node scripts/h3-video-test.js --pool ../runtime/h3-accounts.jsonl        # 自动取池里第一个可用号
 *   node scripts/h3-video-test.js --token "<token>|<uuid>|<device_id>"
 *   node scripts/h3-video-test.js --models "hailuo3.0-t2v:768:4,23218:768:6"  # 依次试到成功
 *
 * 参数: --model/--res/--dur/--prompt/--poll n/--out 文件
 * 产物: runtime/evidence/h3-video-test-<ts>.json（含 前后额度、请求体、完整响应、轮询明细）
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const md5 = s => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
const uuid4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function argOf(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
const ROOT = path.resolve(__dirname, '..');
const CFG = {
  host: process.env.H3_HOST || 'hailuoai.video',
  lang: process.env.H3_LANG || 'en',
  token: argOf('token', ''),
  pool: argOf('pool', path.join(ROOT, 'runtime', 'h3-accounts.jsonl')),
  models: argOf('models', argOf('model', 'hailuo3.0-t2v') + ':' + argOf('res', '768') + ':' + argOf('dur', '4')),
  prompt: argOf('prompt', 'A small orange cat walks slowly across a wooden table in warm afternoon light, cinematic'),
  poll: Number(argOf('poll', '12')),
  out: argOf('out', ''),
};
const EVID = path.join(ROOT, 'runtime', 'evidence'); fs.mkdirSync(EVID, { recursive: true });
const OUT = CFG.out || path.join(EVID, 'h3-video-test-' + Date.now() + '.json');
const EV = { startedAt: new Date().toISOString(), host: CFG.host, steps: [] };

/* ---------- 载入号 ---------- */
let acct;
if (CFG.token) { const p = CFG.token.split('|'); acct = { token: p[0], uuid: p[1] || uuid4(), device_id: p[2] || String(Math.floor(Math.random() * 1e18)) }; }
else {
  const lines = fs.readFileSync(CFG.pool, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
  const rec = lines[lines.length - 1];
  acct = { token: rec.token, uuid: rec.uuid, device_id: rec.device_id };
  EV.account = { email: rec.email, userID: rec.userID };
}

/* ---------- 签名 + 请求 ---------- */
function signedUrl(pathname, body, method) {
  const t = Date.now();
  const q = {
    device_platform: 'web', app_id: '3001', version_code: '22203', biz_id: '0', unix: String(t),
    lang: CFG.lang, uuid: acct.uuid, os_name: 'Windows', browser_name: 'Chrome',
    browser_language: CFG.lang === 'en' ? 'en-US' : 'zh-CN', browser_platform: 'Win32',
    screen_width: '1920', screen_height: '1080', device_id: acct.device_id,
  };
  const qs = Object.keys(q).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
  const full = pathname + (pathname.includes('?') ? '&' : '?') + qs;
  const bs = (method === 'POST' || method === 'DELETE') ? JSON.stringify(body == null ? {} : body) : '{}';
  return { full, bs, yy: md5(encodeURIComponent(full) + '_' + bs + md5(String(t)) + 'ooui') };
}
function call(method, pathname, body) {
  const s = signedUrl(pathname, body, method);
  return new Promise(res => {
    const d = (method === 'POST') ? Buffer.from(s.bs, 'utf8') : null;
    const r = https.request({ host: CFG.host, port: 443, path: s.full, method,
      headers: { 'content-type': 'application/json', origin: 'https://' + CFG.host, referer: 'https://' + CFG.host + '/login',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        token: acct.token, yy: s.yy } },
      rsp => { let b = ''; rsp.on('data', x => b += x); rsp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} res({ http: rsp.statusCode, j, raw: b }); }); });
    r.setTimeout(40000, () => r.destroy(new Error('timeout')));
    r.on('error', e => res({ http: 0, j: null, raw: 'ERR ' + (e.code || e.message) }));
    if (d) r.write(d); r.end();
  });
}
const codeOf = r => (r.j && r.j.statusInfo ? Number(r.j.statusInfo.code) : NaN);
const msgOf = r => (r.j && r.j.statusInfo ? String(r.j.statusInfo.message || '') : '');

async function snapshot(tag) {
  const info = await call('GET', '/v1/api/user/info', null);
  const eq = await call('GET', '/v1/api/user/equity', null);
  const cr = await call('GET', '/v1/api/billing/credit', null);
  const sub = await call('GET', '/v1/api/user/subscription', null);
  const d = (eq.j && eq.j.data) || {};
  const c = (cr.j && cr.j.data) || {};
  const s = { tag, at: new Date().toISOString(), http: { info: info.http, equity: eq.http },
    name: info.j && info.j.data && info.j.data.userInfo ? info.j.data.userInfo.name : null,
    infoCode: codeOf(info),
    totalCredits: d.totalCredits, videoCost: d.videoCost, debitCredit: d.debitCredit,
    isNewUser: d.isNewUser, trialExpireTime: d.trialExpireTime, queueLength: d.queueLength,
    total_credit: c.total_credit, debit_credit: c.debit_credit, sub: sub.j && sub.j.data };
  EV.steps.push({ snapshot: s });
  return s;
}

(async () => {
  console.log('# 真发 H3 视频验证  host=' + CFG.host + (EV.account ? '  account=' + EV.account.email : ''));
  const before = await snapshot('before');
  console.log('扣费前: totalCredits=' + before.totalCredits + ' videoCost=' + before.videoCost + ' debitCredit=' + before.debitCredit +
    ' isNewUser=' + before.isNewUser + ' trial=' + (before.trialExpireTime ? new Date(before.trialExpireTime).toISOString() : '-') +
    ' billing.total_credit=' + before.total_credit + ' debit_credit=' + before.debit_credit);
  if (before.infoCode !== 0) { console.log('! token 无效，先换号'); fs.writeFileSync(OUT, JSON.stringify(EV, null, 1)); process.exit(4); }

  const mi = await call('GET', '/public/v2/api/multimodal/video/model/info', null);
  EV.modelInfoHttp = mi.http;

  const cands = CFG.models.split(',').map(x => { const p = x.split(':'); return { modelID: p[0], resolution: p[1] || '768', duration: Number(p[2] || 4) }; });
  let taskId = null, usedBody = null, usedCand = null, lastResp = null;
  for (const c of cands) {
    const body = { quantity: 1, parameter: { modelID: c.modelID, desc: CFG.prompt, fileList: [], useOriginPrompt: true,
      resolution: c.resolution, duration: c.duration, aspectRatio: '16:9', referenceMode: 0 }, videoExtra: {}, projectID: '0' };
    console.log('\n>> POST /v2/api/multimodal/generate/video  model=' + c.modelID + ' res=' + c.resolution + ' dur=' + c.duration + 's');
    const g = await call('POST', '/v2/api/multimodal/generate/video', body);
    lastResp = { http: g.http, json: g.j, raw: String(g.raw).slice(0, 1500) };
    EV.steps.push({ generate: { cand: c, body, http: g.http, json: g.j, raw: lastResp.raw } });
    const d = g.j && g.j.data;
    const id = d && (d.id || d.taskID || d.taskId || d.videoID);
    console.log('   HTTP ' + g.http + ' code=' + codeOf(g) + ' msg=' + msgOf(g) + '  raw=' + String(g.raw).slice(0, 300));
    if (id) { taskId = id; usedBody = body; usedCand = c; break; }
    if (g.http === 401) { console.log('   token 失效'); break; }
    await sleep(1200);
  }
  EV.request = usedBody; EV.taskId = taskId;

  if (taskId) {
    console.log('\n任务已受理 taskID=' + taskId + '，开始轮询状态…');
    for (let i = 1; i <= CFG.poll; i++) {
      await sleep(i === 1 ? 8000 : 10000);
      const dt = await call('GET', '/public/v3/api/multimodal/video/detail?id=' + encodeURIComponent(taskId), null);
      const fd = await call('POST', '/api/feed/creation/search/my', { cursor: '', limit: 10 });
      const feeds = (fd.j && fd.j.data && (fd.j.data.feeds || fd.j.data.list)) || [];
      const hit = feeds.find(f => String(((f.commonInfo || f).id) || '') === String(taskId));
      const st = hit ? ((hit.commonInfo && hit.commonInfo.status) != null ? hit.commonInfo.status : hit.status) : null;
      console.log('  [' + i + '] detail HTTP ' + dt.http + ' code=' + codeOf(dt) + ' | feed 命中=' + (hit ? 'Y status=' + st : 'n'));
      EV.steps.push({ poll: { i, detailHttp: dt.http, detailCode: codeOf(dt), detail: (dt.j && dt.j.data) || dt.raw.slice(0, 400), feedHit: !!hit, feed: hit || null } });
      if (hit && (Number(st) === 2 || Number(st) === 3 || Number(st) === 6)) break;
      if (dt.j && dt.j.data && dt.j.data.status != null && [2, 3, 6].includes(Number(dt.j.data.status))) break;
    }
  }

  const after = await snapshot('after');
  console.log('\n扣费后: totalCredits=' + after.totalCredits + ' videoCost=' + after.videoCost + ' debitCredit=' + after.debitCredit +
    ' isNewUser=' + after.isNewUser + ' billing.total_credit=' + after.total_credit + ' debit_credit=' + after.debit_credit);
  const delta = {
    totalCredits: (after.totalCredits || 0) - (before.totalCredits || 0),
    debitCredit: (after.debitCredit || 0) - (before.debitCredit || 0),
    billing_debit: (after.debit_credit || 0) - (before.debit_credit || 0),
    billing_total: (after.total_credit || 0) - (before.total_credit || 0),
  };
  EV.delta = delta; EV.finishedAt = new Date().toISOString();
  console.log('\n==== 结论 ====');
  console.log('受理任务: ' + (taskId ? 'Y (' + taskId + ')' : 'N —— 最后一次响应: HTTP ' + (lastResp && lastResp.http) + ' code=' + (lastResp && lastResp.json && lastResp.json.statusInfo && lastResp.json.statusInfo.code) + ' msg=' + (lastResp && lastResp.json && lastResp.json.statusInfo && lastResp.json.statusInfo.message)));
  console.log('额度变化: ' + JSON.stringify(delta));
  fs.writeFileSync(OUT, JSON.stringify(EV, null, 1));
  console.log('证据: ' + OUT);
})();