'use strict';
/**
 * mailfarm-server.js -- 零依赖 Node 版 mailfarm（无 Python、无第三方包）
 *
 *   和 Python 版（E:\中转站测试\mailfarm）**端点/字段/banner 完全一致**，
 *   但只用 node:http + node:net，方便直接跑在只有 Node 的 Windows 服务器上。
 *
 *   收信两条路（可同时开）：
 *     ① 自建 SMTP（MF_SMTP_PORT，默认 25）—— 需要机房放行 25
 *     ② HTTP ingest（POST /v1/ingest）—— 给 Cloudflare Email Worker / Postfix pipe / 转发器用，
 *        不需要 25 端口，这是 25 被封锁时的落地路径
 *
 *   环境变量：见 README.md（MF_* 同名同义）。
 *   用法：node scripts/mailfarm-server.js
 */
const http = require('http');
const net = require('net');

const NL = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);

function envStr(k, d) {
  const v = process.env[k];
  if (v === undefined || v === null || String(v) === '') return (d === undefined ? '' : d);
  return String(v);
}
function envInt(k, d) {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
}
function log() {
  const a = Array.prototype.slice.call(arguments);
  console.log('[' + new Date().toISOString() + '] ' + a.join(' '));
}

const CFG = {
  service: envStr('MF_SERVICE_NAME', 'mailfarm'),
  version: '0.1.0',
  domains: envStr('MF_DOMAINS', 'localhost').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
  apiKey: envStr('MF_API_KEY', ''),
  ingestKey: envStr('MF_INGEST_KEY', ''),
  requireKeyOnAcquire: ['1', 'true', 'yes'].indexOf(envStr('MF_REQUIRE_KEY_ON_ACQUIRE', '0').toLowerCase()) >= 0,
  httpHost: envStr('MF_HTTP_HOST', '127.0.0.1'),
  httpPort: envInt('MF_HTTP_PORT', 8099),
  smtpHost: envStr('MF_SMTP_HOST', '0.0.0.0'),
  smtpPort: envInt('MF_SMTP_PORT', 25),
  smtpIdent: envStr('MF_SMTP_IDENT', 'mailfarm'),
  smtpMaxSize: envInt('MF_SMTP_MAX_SIZE', 33554432),
  smtpEnabled: ['0', 'false', 'no'].indexOf(envStr('MF_SMTP_ENABLE', '1').toLowerCase()) < 0,
  mailboxTtlS: envInt('MF_MAILBOX_TTL_S', 3600),
  codeMaxAgeS: envInt('MF_CODE_MAX_AGE_S', 900),
  maxMsgs: envInt('MF_MAX_MSGS_PER_BOX', 50),
  maxBoxes: envInt('MF_MAX_BOXES', 5000),
};

/* ----------------------------- 验证码提取 ----------------------------- */
const KW = '(?:验证码|校验码|动态码|确认码|安全码|verification\\s*code|verify\\s*code|login\\s*code|security\\s*code|one[\\s-]?time\\s*(?:code|password)|otp|認証コード|인증\\s*번호)';
const RE_KW_DIGIT = new RegExp(KW + '[^0-9]{0,24}([0-9]{4,8})', 'gi');
const RE_KW_ALNUM = new RegExp(KW + '[^A-Za-z0-9]{0,24}([A-Za-z0-9]{4,8})', 'gi');
const RE_ANY_DIGIT = /(?<![0-9])([0-9]{4,8})(?![0-9])/g;
const RE_ANY_ALNUM = /(?<![A-Za-z0-9])([A-Z0-9]{5,8})(?![A-Za-z0-9])/g;

function isCode(tok, allowAlphaOnly) {
  if (!tok) return false;
  const t = String(tok).trim();
  if (t.length < 4 || t.length > 8) return false;
  if (/[0-9]/.test(t)) return true;
  if (allowAlphaOnly && t === t.toUpperCase() && t.length >= 5 && /^[A-Z0-9]+$/.test(t)) return true;
  return false;
}

function extractCodes(subject, text, limit) {
  const out = [];
  const max = limit || 5;
  function push(v, alphaOnly) {
    const t = (v === undefined || v === null) ? '' : String(v).trim();
    if (isCode(t, alphaOnly) && out.indexOf(t) < 0) out.push(t);
  }
  const blobs = [];
  if (subject) blobs.push(String(subject));
  if (text) blobs.push(String(text));
  const rounds = [[RE_KW_DIGIT, false], [RE_KW_ALNUM, false], [RE_ANY_DIGIT, false], [RE_ANY_ALNUM, true]];
  for (let r = 0; r < rounds.length; r++) {
    const re = rounds[r][0];
    const alphaOnly = rounds[r][1];
    for (let b = 0; b < blobs.length; b++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(blobs[b])) !== null) {
        push(m[1], alphaOnly);
        if (out.length >= max) return out;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  return out;
}

/* ----------------------------- 邮箱存储 ----------------------------- */
const crypto = require('crypto');
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';

const store = {
  boxes: new Map(),
  startedAt: Date.now(),
  acquiredTotal: 0,
  receivedTotal: 0,
  rr: 0,

  pickDomain: function (want) {
    if (want && CFG.domains.indexOf(want) >= 0) return want;
    if (CFG.domains.length === 0) return 'localhost';
    const d = CFG.domains[this.rr % CFG.domains.length];
    this.rr++;
    return d;
  },

  gc: function () {
    const now = Date.now();
    const self = this;
    Array.from(this.boxes.keys()).forEach(function (a) {
      const b = self.boxes.get(a);
      if (b && b.expires_at < now) self.boxes.delete(a);
    });
  },

  acquire: function (prefix, domain) {
    this.gc();
    if (this.boxes.size >= CFG.maxBoxes) {
      const sorted = Array.from(this.boxes.values()).sort(function (x, y) { return x.created_at - y.created_at; });
      const self = this;
      sorted.slice(0, this.boxes.size - CFG.maxBoxes + 1).forEach(function (b) { self.boxes.delete(b.address); });
    }
    const dom = this.pickDomain(domain);
    let pre = String(prefix || 'mb').trim().toLowerCase().replace(/[^a-z0-9\-_.]/g, '');
    if (!pre) pre = 'mb';
    let addr = '';
    for (let i = 0; i < 8; i++) {
      addr = pre + crypto.randomBytes(8).toString('hex').slice(0, 10) + '@' + dom;
      if (!this.boxes.has(addr)) break;
    }
    const now = Date.now();
    this.boxes.set(addr, { address: addr, domain: dom, created_at: now, expires_at: now + CFG.mailboxTtlS * 1000, messages: [] });
    this.acquiredTotal++;
    return { address: addr, domain: dom, expires_at: Math.round((now + CFG.mailboxTtlS * 1000) / 1000) };
  },

  acquireBatch: function (n, prefix) {
    let k = Number(n || 1); if (!Number.isFinite(k) || k < 1) k = 1; if (k > 500) k = 500;
    const out = [];
    for (let i = 0; i < k; i++) out.push(this.acquire(prefix));
    return out;
  },

  deliver: function (rcpt, sender, subject, text) {
    const addr = String(rcpt || '').trim().toLowerCase();
    if (!addr) return false;
    const now = Date.now();
    let box = this.boxes.get(addr);
    if (!box) {
      const dom = addr.indexOf('@') >= 0 ? addr.split('@').pop() : 'unknown';
      if (CFG.domains.indexOf(dom) < 0) return false;   // catch-all 只覆盖自己的收信域
      box = { address: addr, domain: dom, created_at: now, expires_at: now + CFG.mailboxTtlS * 1000, messages: [] };
      this.boxes.set(addr, box);
    }
    const codes = extractCodes(subject, text, 5);
    box.messages.push({ ts: Math.round(now / 1000), sender: sender || '', rcpt: addr, subject: subject || '', text: text || '', codes: codes });
    if (box.messages.length > CFG.maxMsgs) box.messages = box.messages.slice(-CFG.maxMsgs);
    this.receivedTotal++;
    return true;
  },

  latestCode: function (address, maxAgeS) {
    const addr = String(address || '').trim().toLowerCase();
    const box = this.boxes.get(addr);
    if (!box) return null;
    const age = (maxAgeS === undefined || maxAgeS === null) ? CFG.codeMaxAgeS : maxAgeS;
    const now = Date.now();
    for (let i = box.messages.length - 1; i >= 0; i--) {
      const m = box.messages[i];
      if (now - m.ts * 1000 > age * 1000) continue;
      if (m.codes && m.codes.length) return m.codes[0];
    }
    return null;
  },

  messages: function (address, limit) {
    const addr = String(address || '').trim().toLowerCase();
    const box = this.boxes.get(addr);
    if (!box) return null;
    const k = Number(limit || 20);
    return box.messages.slice(-k).map(function (m) {
      return { ts: m.ts, sender: m.sender, rcpt: m.rcpt, subject: m.subject, codes: m.codes, body_preview: String(m.text || '').slice(0, 500) };
    });
  },

  stats: function () {
    this.gc();
    let withCodes = 0, msgs = 0;
    this.boxes.forEach(function (b) {
      msgs += b.messages.length;
      if (b.messages.some(function (m) { return m.codes && m.codes.length; })) withCodes++;
    });
    return {
      service: CFG.service, version: CFG.version, store: 'memory', domains: CFG.domains,
      mailboxes: this.boxes.size, mailboxes_with_codes: withCodes, messages: msgs,
      acquired_total: this.acquiredTotal, received_total: this.receivedTotal,
      smtp_enabled: CFG.smtpEnabled, uptime_s: Math.round((Date.now() - this.startedAt) / 100) / 10
    };
  },

  healthz: function () {
    return { ok: true, version: CFG.version, store: 'memory', domains: CFG.domains, uptime_s: Math.round((Date.now() - this.startedAt) / 100) / 10 };
  }
};

/* --------------------- 邮件正文解析（MIME 够用版） --------------------- */
function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}
function qpDecode(s) {
  return String(s).replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
}
function b64Decode(s) { try { return Buffer.from(String(s).replace(/\s+/g, ''), 'base64').toString('utf8'); } catch (e) { return ''; } }
function decodePart(body, enc) {
  const e = String(enc || '').toLowerCase();
  if (e === 'base64') return b64Decode(body);
  if (e === 'quoted-printable') return qpDecode(body);
  return String(body);
}
function collectText(raw) {
  const out = [];
  (function walk(part) {
    const headEnd = part.search(/\r?\n\r?\n/);
    if (headEnd < 0) { out.push(part); return; }
    const head = part.slice(0, headEnd);
    const sepLen = part.slice(headEnd).match(/\r?\n\r?\n/)[0].length;
    const body = part.slice(headEnd + sepLen);
    const ctype = (head.match(/content-type:\s*([^;\r\n]+)/i) || [])[1] || '';
    const enc = (head.match(/content-transfer-encoding:\s*([^\r\n;]+)/i) || [])[1] || '';
    const bnd = (head.match(/boundary="?([^";\r\n]+)"?/i) || [])[1];
    if (/multipart/i.test(ctype) && bnd) {
      const pieces = body.split('--' + bnd);
      for (let i = 0; i < pieces.length; i++) {
        const pc = pieces[i];
        if (/^--/.test(pc.trim())) continue;
        if (!pc.trim()) continue;
        walk(pc);
      }
      return;
    }
    let decoded = decodePart(body, enc);
    if (/text\/html/i.test(ctype)) decoded = stripTags(decoded);
    out.push(decoded);
  })(String(raw).replace(/\r\n/g, NL));
  return out.join(NL);
}
function parseMessage(raw) {
  const text = String(raw);
  const sep = text.indexOf(CRLF + CRLF);
  const sep2 = text.indexOf(NL + NL);
  let head = text, body = '';
  if (sep >= 0) { head = text.slice(0, sep); body = text.slice(sep + 4); }
  else if (sep2 >= 0) { head = text.slice(0, sep2); body = text.slice(sep2 + 2); }
  const subjectRaw = (head.match(/^subject:\s*(.*)$/im) || [])[1] || '';
  let subject = subjectRaw.trim();
  if (/^=\?/.test(subject)) {
    subject = subject.replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g, function (_, mode, payload) {
      return mode.toUpperCase() === 'B' ? b64Decode(payload) : qpDecode(payload.replace(/_/g, ' '));
    });
  }
  const from = ((head.match(/^from:\s*(.*)$/im) || [])[1] || '').trim();
  return { subject: subject, from: from, text: collectText(body) };
}
