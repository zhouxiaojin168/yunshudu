/**
 * hailuo-sign.js -- 海螺(hailuoai.com)网页端请求签名器（乙路专用）
 *
 * 逆向自 cdn.hailuoai.com/hailuo-video-web/prod-zh-0.1.797 前端包，逐条对应：
 *   1) 鉴权：axios 请求拦截器 `e.headers.token = getLocalStorageToken()`  -> 取 localStorage['_token']
 *   2) 时间戳：`let i = Date.parse(new Date().toString())`                  -> 毫秒
 *   3) 公共参数：`p(e,t) = {device_platform:'web', app_id:AF, version_code:Zw, biz_id:Kz, unix:e}`
 *      常量来源 module 99273：AF='3001'  Zw='22203'  Kz='0'
 *      `y(e)` 再补 lang / uuid(=localStorage['UNIQUE_USER_ID']) / device_id(=localStorage['USER_HARD_WARE_INFO'])
 *      / os_name / browser_name / device_memory / cpu_core_num / browser_language / browser_platform / screen_*
 *   4) 参与签名的 path：`h(url, params)` = 去掉 client_scene 项的 url + ('&'|'?') + URLSearchParams(params)
 *   5) 签名：`b({time, body, hasSearchParamsPath, method})`
 *        d = encodeURIComponent(path) + '_' + bodyStr + md5(String(time)) + 'ooui'
 *        return { encrypt: md5(d), bodyString: JSON.stringify(body) }
 *      -> `e.headers.yy = encrypt`（签名放 header 'yy'），`e.data = bodyString`，`e.params = {}`
 *      -> bodyStr：POST/DELETE 用 body；其余(GET/HEAD) 固定 '{}'；若外层已带 yy 头则用该值代替 body
 *   6) 响应信封：{statusInfo:{code,httpCode,message,serviceTime,requestID,debugInfo,serverAlert}, data}
 *      铁证错误码（module 33087 / 79986）：
 *        1000048 = 需要登录（token 失效）          -> 换成「换号」信号
 *        22      = 封禁/申诉                       -> 换成「封号」信号
 *        2400026 / 2400040 = 贝壳不足(credits 不足) -> 换成「余额不足」信号（等价 402）
 *        2400025 / 2400039 = 通用业务错误
 *      HTTP 401 = 未授权；120000ms 超时；30 = 重试次数
 *
 * 账号 token 编码（我们池子侧约定，一行搞定一个海螺号）：
 *   '<_token>'                      只给 token（uuid/device_id 用内置稳定值）
 *   '<_token>|<uuid>|<device_id>'   三个都给（推荐：号在哪台设备注册的就填哪台的）
 */
'use strict';
const crypto = require('crypto');

const md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

/* module 99273 常量（前端硬编码） */
const APP_ID = '3001';
const VERSION_CODE = '22203';
const BIZ_ID = '0';
const DEVICE_PLATFORM = 'web';
const SIGN_SALT = 'ooui';

/* 错误码 -> 池子语义 */
const CODE_MAP = {
  '1000048': 'AUTH_EXPIRED',   /* 需要登录 -> 换号 */
  '22': 'ACCOUNT_BANNED',      /* 封禁 -> 换号并下线 */
  '2400026': 'NO_CREDITS',     /* 贝壳不足 -> 等价 402，换号 */
  '2400040': 'NO_CREDITS',
  '2400025': 'BIZ_ERROR',
  '2400039': 'BIZ_ERROR'
};

function parseToken(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const parts = s.split('|');
  return { token: parts[0], uuid: parts[1] || '', device_id: parts[2] || '' };
}

/* 稳定伪 uuid：没给 uuid 时用 token 派生，保证同一号每次签名一致 */
function deriveUuid(seed) {
  const h = md5(String(seed));
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

function publicParams(opts) {
  const o = opts || {};
  const uuid = o.uuid || deriveUuid(o.token || 'anon');
  const p = {
    device_platform: DEVICE_PLATFORM,
    app_id: APP_ID,
    version_code: VERSION_CODE,
    biz_id: BIZ_ID,
    unix: String(o.unix),
    lang: o.lang || 'zh-Hans',
    uuid: uuid,
    os_name: o.os_name || 'Windows',
    browser_name: o.browser_name || 'Chrome',
    browser_language: o.browser_language || 'zh-CN',
    browser_platform: o.browser_platform || 'Win32',
    screen_width: String(o.screen_width == null ? 1920 : o.screen_width),
    screen_height: String(o.screen_height == null ? 1080 : o.screen_height)
  };
  if (o.device_id) p.device_id = o.device_id;
  if (o.device_memory) p.device_memory = String(o.device_memory);
  if (o.cpu_core_num) p.cpu_core_num = String(o.cpu_core_num);
  return p;
}

/* 前端 g(): 去掉 query 里的 client_scene 项（它不属于签名） */
function stripClientScene(url) {
  const t = String(url);
  const hi = t.indexOf('#');
  const head = hi === -1 ? t : t.slice(0, hi);
  const tail = hi === -1 ? '' : t.slice(hi);
  const qi = head.indexOf('?');
  if (qi === -1) return t;
  const path = head.slice(0, qi);
  const keep = head.slice(qi + 1).split('&').filter((kv) => kv && kv.split('=', 1)[0] !== 'client_scene').join('&');
  return path + (keep ? '?' + keep : '') + tail;
}

/* 前端 h(url, params): 把公共参数拼成最终 url（这就是签名里那份 path） */
function hasSearchParamsPath(url, params) {
  const o = stripClientScene(url);
  const hi = o.indexOf('#');
  const head = hi === -1 ? o : o.slice(0, hi);
  const tail = hi === -1 ? '' : o.slice(hi);
  const qs = Object.keys(params || {}).filter((k) => params[k] != null).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]))).join('&');
  const sep = head.includes('?') ? '&' : '?';
  return head + (qs ? sep + qs : '') + tail;
}

/* 前端 b({time, body, hasSearchParamsPath, method, bodyToYY}) */
function computeSign(o) {
  const method = String(o.method || 'GET').toUpperCase();
  let bodyStr = (method === 'POST' || method === 'DELETE') ? JSON.stringify(o.body == null ? {} : o.body) : '{}';
  const bodyForSign = o.bodyToYY ? o.bodyToYY : bodyStr;
  const d = encodeURIComponent(o.hasSearchParamsPath) + '_' + bodyForSign + md5(String(o.time)) + SIGN_SALT;
  return { yy: md5(d), bodyString: bodyStr };
}

/* 一把梭：给 url/method/body/token 产出真实可发的 {url, headers, bodyString} */
function buildSignedRequest(o) {
  const raw = o.raw != null ? String(o.raw) : (o.token != null ? String(o.token) : '');
  const parsed = parseToken(raw);
  const t = { token: parsed.token, uuid: o.uuid || parsed.uuid, device_id: o.device_id || parsed.device_id };
  const time = o.time == null ? Date.now() : Number(o.time);
  const params = publicParams({ unix: time, uuid: t.uuid, device_id: t.device_id, token: t.token, lang: o.lang,
    os_name: o.os_name, browser_name: o.browser_name, browser_language: o.browser_language,
    browser_platform: o.browser_platform, screen_width: o.screen_width, screen_height: o.screen_height });
  const path = hasSearchParamsPath(o.url, params);
  const s = computeSign({ time: time, body: o.body, method: o.method, hasSearchParamsPath: path, bodyToYY: o.bodyToYY });
  const headers = Object.assign({
    token: t.token,
    yy: s.yy,
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    origin: 'https://hailuoai.com',
    referer: 'https://hailuoai.com/zh/home',
    'user-agent': o.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }, o.extraHeaders || {});
  return { url: path, headers: headers, bodyString: s.bodyString, time: time, params: params, yy: s.yy };
}

/* 把海螺响应信封翻译成池子语义 */
function classifyResponse(httpStatus, json) {
  const st = json && json.statusInfo;
  if (st && Number(st.code) === 0) return { ok: true, code: 0, message: st.message || '' };
  const code = st ? String(st.code) : '';
  const kind = CODE_MAP[code] || '';
  if (kind === 'AUTH_EXPIRED') return { ok: false, kind: kind, http: httpStatus, code: code, message: st.message, retryable: false, switchAccount: true };
  if (kind === 'ACCOUNT_BANNED') return { ok: false, kind: kind, http: httpStatus, code: code, message: st.message, retryable: false, switchAccount: true, disableAccount: true };
  if (kind === 'NO_CREDITS') return { ok: false, kind: 'NO_CREDITS', http: httpStatus, code: code, message: st.message, retryable: false, switchAccount: true };
  return { ok: false, kind: kind || ('HTTP_' + httpStatus), http: httpStatus, code: code, message: (st && st.message) || '', retryable: httpStatus >= 500 || httpStatus === 429, switchAccount: false };
}

module.exports = { md5: md5, parseToken: parseToken, deriveUuid: deriveUuid, publicParams: publicParams,
  stripClientScene: stripClientScene, hasSearchParamsPath: hasSearchParamsPath, computeSign: computeSign,
  buildSignedRequest: buildSignedRequest, classifyResponse: classifyResponse,
  APP_ID: APP_ID, VERSION_CODE: VERSION_CODE, BIZ_ID: BIZ_ID, CODE_MAP: CODE_MAP };