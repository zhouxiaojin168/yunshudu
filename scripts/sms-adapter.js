/**
 * sms-adapter.js -- 接码平台「取号 / 查码」响应的解析适配层
 *
 *   为什么单独抽出来：各接码平台的响应格式完全不一样，有 JSON 的、有纯文本协议的，
 *   号码有国内号（1[3-9]xxxxxxxxx）也有国际号（+447xxxxxxxxx / +1202xxxxxxx）。
 *   pool-supply.js 只负责发请求，认不认识响应交给这里，方便单测。
 *
 *   支持三类响应：
 *     A. JSON      {"phone":"+1202...","id":123}  /  {"data":{"number":..,"request_id":..}}
 *                  sms-man:  {"success":true,"number":"79...","request_id":123}
 *                  onlinesim: {"response":"79991234567","tzid":123}
 *     B. 文本协议  sms-activate: ACCESS_NUMBER:1234:79991234567 / STATUS_OK:1234 / STATUS_WAIT_CODE
 *     C. 兜底      正文里出现的第一个「像手机号」的数字串
 */
'use strict';

/* 中国大陆手机号（最强信号，优先匹配） */
const RE_CN = /1[3-9]\d{9}/;
/* 国际号：7~15 位数字，可带前导 + */
const RE_INTL = /\+?\d{7,15}/;

/* 服务端还在等短信 —— 继续轮询，不算失败 */
const RE_WAITING = /STATUS_WAIT_CODE|STATUS_WAIT_RETRY|STATUS_WAIT_RESEND|ACCESS_READY|ACCESS_RETRY_GET|TRY_AGAIN_LATER/i;
/* 明确终结 —— 立刻停，别等到超时 */
const RE_TERMINAL = /STATUS_CANCEL|NO_ACTIVATION|BAD_STATUS|WRONG_MAX_PRICE|NO_NUMBERS|NO_BALANCE|BANNED/i;

function pick(obj, paths) {
  for (const p of paths) {
    let v = obj;
    for (const k of String(p).split('.')) {
      v = (v == null || typeof v !== 'object') ? undefined : v[k];
    }
    if (v !== undefined && v !== null && String(v) !== '') return String(v);
  }
  return null;
}

/* 统一号码格式：保留可选前导 +，其余只留数字 */
function normPhone(s) {
  const t = String(s == null ? '' : s).trim();
  const plus = t.charAt(0) === '+';
  const d = t.replace(/[^0-9]/g, '');
  return (plus ? '+' : '') + d;
}

function tryJson(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || (t.charAt(0) !== '{' && t.charAt(0) !== '[')) return null;
  try {
    const j = JSON.parse(t);
    return (j && typeof j === 'object') ? j : null;
  } catch (e) { return null; }
}

/**
 * 解析「取号」响应
 * @returns {{phone?:string,id?:string,error?:string}}
 */
function parsePhone(body) {
  const text = String(body == null ? '' : body).trim();
  const j = tryJson(text);

  if (j && !Array.isArray(j)) {
    if (j.success === false) {
      return { error: String(j.error_code || j.error_msg || j.message || 'api_error') };
    }
    if (j.status !== undefined && Number(j.status) === 0 && !pick(j, ['phone', 'data.phone', 'number', 'data.number'])) {
      return { error: String(j.message || 'api_error') };
    }
    const phone = pick(j, [
      'phone', 'data.phone', 'number', 'data.number', 'tel', 'data.tel',
      'msisdn', 'data.msisdn', 'phoneNumber', 'data.phoneNumber', 'response', 'data.response'
    ]);
    const id = pick(j, [
      'id', 'phone_id', 'data.id', 'data.phone_id', 'request_id', 'data.request_id',
      'activation_id', 'data.activation_id', 'tzid', 'data.tzid', 'order_id', 'data.order_id'
    ]);
    if (phone && /\d{7,}/.test(String(phone))) return { phone: normPhone(phone), id: id ? String(id) : normPhone(phone) };
  }

  /* 文本协议：ACCESS_NUMBER:<activationId>:<phone> */
  let m = text.match(/ACCESS_NUMBER\s*[:=]\s*([A-Za-z0-9_-]+)\s*[:=]\s*(\+?\d[\d]{5,15})/i);
  if (m) return { phone: normPhone(m[2]), id: String(m[1]) };

  m = text.match(/ACCESS_NUMBER\s*[:=]\s*(\+?\d[\d]{5,15})/i);
  if (m) return { phone: normPhone(m[1]), id: normPhone(m[1]) };

  /* 兜底：正文里第一个像号的数字串（国内号优先） */
  const cn = text.match(RE_CN);
  if (cn) return { phone: cn[0], id: cn[0] };
  const intl = text.match(RE_INTL);
  if (intl) return { phone: normPhone(intl[0]), id: normPhone(intl[0]) };

  return { error: 'no_phone_in_body: ' + text.slice(0, 120) };
}

/**
 * 解析「查码」响应
 * @returns {{code?:string,waiting?:boolean,terminal?:boolean,error?:string}}
 */
function parseCode(body) {
  const text = String(body == null ? '' : body).trim();

  /* JSON 必须先判：错误码里可能带 NO_BALANCE/CANCEL 等字样，
     若先跑文本终结正则会把 error_code 也一起吞掉、丢掉结构化信息。 */
  const j = tryJson(text);
  if (j && !Array.isArray(j)) {
    if (j.success === false) return { terminal: true, error: String(j.error_code || j.error_msg || j.message || 'api_error') };
    if (j.status !== undefined && Number(j.status) === 0) return { terminal: true, error: String(j.message || 'api_error') };
    const code = pick(j, ['code', 'data.code', 'sms_code', 'data.sms_code', 'smsCode', 'data.smsCode', 'verify_code', 'data.verify_code']);
    if (code) {
      const m = String(code).match(/\d{3,8}/);
      if (m) return { code: m[0] };
    }
    if (j.received === false || j.status === 'waiting') return { waiting: true };
  }

  if (RE_TERMINAL.test(text)) return { terminal: true, error: text.slice(0, 60) };

  const ok = text.match(/STATUS_OK\s*[:=]\s*(\d{3,8})/i);
  if (ok) return { code: ok[1] };

  if (RE_WAITING.test(text)) return { waiting: true };

  const m = text.match(/\b(\d{4,8})\b/);
  if (m) return { code: m[1] };

  return { waiting: true };
}

module.exports = { parsePhone, parseCode, normPhone, RE_WAITING, RE_TERMINAL };
