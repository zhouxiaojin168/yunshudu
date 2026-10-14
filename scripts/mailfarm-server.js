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
const fs = require('fs');
const path = require('path');

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
  version: '0.3.2',
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
  store: envStr('MF_STORE', 'memory').toLowerCase(),
  stateDir: envStr('MF_STATE_DIR', 'state'),
  stateFile: envStr('MF_STATE_FILE', ''),
  snapshotEvery: envInt('MF_SNAPSHOT_EVERY', 500),
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

function strongCodes(s) {
  const out = [];
  const rex = [RE_KW_DIGIT, RE_KW_ALNUM];
  for (let i = 0; i < rex.length; i++) {
    const re = rex[i];
    re.lastIndex = 0;
    let m;
    const str = String(s || '');
    while ((m = re.exec(str)) !== null) {
      if (m[1] && out.indexOf(m[1]) < 0) out.push(m[1]);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}

function extractCodes(subject, text, limit) {
  const out = [];
  const max = limit || 5;
  function push(v, alphaOnly, free, bf, af) {
    const t = (v === undefined || v === null) ? '' : String(v).trim();
    if (free) {
      if (/[-\/.:_]/.test(String(bf || '')) || /[-\/.:_]/.test(String(af || ''))) return;
      if (/^(19|20)[0-9]{2}$/.test(t)) return;
      if (/^0+$/.test(t)) return;
      if (/^([0-9])\1+$/.test(t)) return;
    }
    if (isCode(t, alphaOnly) && out.indexOf(t) < 0) out.push(t);
  }
  const blobs = [];
  if (subject) blobs.push(String(subject));
  if (text) blobs.push(String(text));
  const rounds = [[RE_KW_DIGIT, false, false], [RE_KW_ALNUM, false, false], [RE_ANY_DIGIT, false, true], [RE_ANY_ALNUM, true, true]];
  for (let r = 0; r < rounds.length; r++) {
    const re = rounds[r][0];
    const alphaOnly = rounds[r][1];
    const free = rounds[r][2] === true;
    for (let b = 0; b < blobs.length; b++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(blobs[b])) !== null) {
        const bf = m.index > 0 ? blobs[b].charAt(m.index - 1) : '';
        const af = blobs[b].charAt(m.index + m[0].length);
        push(m[1], alphaOnly, free, bf, af);
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
  storeKind: 'memory',
  statePath: '',
  lines: 0,
  loaded: 0,

  initStore: function () {
    if (CFG.store !== 'file') { this.storeKind = 'memory'; return; }
    this.storeKind = 'file';
    let p = CFG.stateFile;
    if (!p) {
      const base = path.isAbsolute(CFG.stateDir) ? CFG.stateDir : path.join(__dirname, '..', CFG.stateDir);
      p = path.join(base, 'mailfarm.jsonl');
    }
    this.statePath = p;
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) {}
    const self = this;
    try {
      if (fs.existsSync(p)) {
        const txt = fs.readFileSync(p, 'utf8');
        const now = Date.now();
        const arr = txt.split(String.fromCharCode(10));
        arr.forEach(function (line) {
          if (!line.trim()) return;
          let e = null;
          try { e = JSON.parse(line); } catch (err) { return; }
          self.replay(e, now);
        });
        self.lines = arr.filter(function (x) { return x.trim(); }).length;
      }
    } catch (e) { log('WARN state load fail: ' + e.message); }
    log('store=file path=' + this.statePath + ' loaded_events=' + this.loaded + ' boxes=' + this.boxes.size);
  },

  replay: function (e, now) {
    if (!e || !e.t) return;
    const a = String(e.a || '').toLowerCase();
    if (!a) return;
    if (e.t === 'box') {
      if (e.e && e.e < now) return;
      if (!this.boxes.has(a)) {
        this.boxes.set(a, { address: a, domain: e.d || '', created_at: e.c || now, expires_at: e.e || (now + CFG.mailboxTtlS * 1000), messages: [] });
      }
      this.loaded++;
      return;
    }
    if (e.t === 'msg') {
      let box = this.boxes.get(a);
      if (!box) {
        const dom = a.indexOf('@') >= 0 ? a.split('@').pop() : 'unknown';
        if (CFG.domains.indexOf(dom) < 0) return;
        box = { address: a, domain: dom, created_at: now, expires_at: now + CFG.mailboxTtlS * 1000, messages: [] };
        this.boxes.set(a, box);
      }
      if (e.m) {
        box.messages.push(e.m);
        if (box.messages.length > CFG.maxMsgs) box.messages = box.messages.slice(-CFG.maxMsgs);
        this.receivedTotal++;
        this.loaded++;
      }
      return;
    }
  },

  persist: function (evt) {
    if (this.storeKind !== 'file' || !this.statePath) return;
    try {
      fs.appendFileSync(this.statePath, JSON.stringify(evt) + String.fromCharCode(10), 'utf8');
      this.lines++;
      if (this.lines >= CFG.snapshotEvery) this.compact();
    } catch (e) { log('WARN persist fail: ' + e.message); }
  },

  compact: function () {
    if (this.storeKind !== 'file' || !this.statePath) return;
    const now = Date.now();
    const lines = [];
    this.boxes.forEach(function (b) {
      if (b.expires_at < now) return;
      lines.push(JSON.stringify({ t: 'box', a: b.address, d: b.domain, c: b.created_at, e: b.expires_at }));
      b.messages.forEach(function (m) { lines.push(JSON.stringify({ t: 'msg', a: b.address, m: m })); });
    });
    const tmp = this.statePath + '.tmp';
    try {
      fs.writeFileSync(tmp, lines.length ? lines.join(String.fromCharCode(10)) + String.fromCharCode(10) : '', 'utf8');
      fs.renameSync(tmp, this.statePath);
      this.lines = lines.length;
      log('state compacted boxes=' + this.boxes.size + ' lines=' + lines.length);
    } catch (e) { log('WARN compact fail: ' + e.message); }
  },

  pickDomain: function (want) {
    if (want && CFG.domains.indexOf(want) >= 0) return want;
    if (CFG.domains.length === 0) return 'localhost';
    const d = CFG.domains[this.rr % CFG.domains.length];
    this.rr++;
    return d;
  },

  addDomains: function (list) {
    const added = [];
    (Array.isArray(list) ? list : []).forEach(function (d) {
      const x = String(d || '').trim().toLowerCase().replace(/^\.+/, '');
      if (!x || CFG.domains.indexOf(x) >= 0) return;
      CFG.domains.push(x);
      added.push(x);
    });
    return added;
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
    const boxRec = { address: addr, domain: dom, created_at: now, expires_at: now + CFG.mailboxTtlS * 1000, messages: [] };
    this.boxes.set(addr, boxRec);
    this.acquiredTotal++;
    this.persist({ t: 'box', a: addr, d: dom, c: now, e: now + CFG.mailboxTtlS * 1000 });
    return { address: addr, domain: dom, expires_at: Math.round((now + CFG.mailboxTtlS * 1000) / 1000) };
  },

  acquireBatch: function (n, prefix) {
    let k = Number(n || 1); if (!Number.isFinite(k) || k < 1) k = 1; if (k > 500) k = 500;
    const out = [];
    for (let i = 0; i < k; i++) out.push(this.acquire(prefix));
    return out;
  },

  deliver: function (rcpt, sender, subject, text, extra) {
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
    const msg = { ts: Math.round(now / 1000), sender: sender || '', rcpt: addr, subject: subject || '', text: text || '', codes: codes };
    if (extra && extra.to) msg.to = String(extra.to).toLowerCase();
    if (extra && extra.delivered_to) msg.delivered_to = String(extra.delivered_to).toLowerCase();
    if (extra && extra.raw) msg.raw = String(extra.raw).slice(0, 30000);
    if (extra && extra.pick) msg.pick = extra.pick;
    box.messages.push(msg);
    if (box.messages.length > CFG.maxMsgs) box.messages = box.messages.slice(-CFG.maxMsgs);
    this.receivedTotal++;
    this.persist({ t: 'msg', a: addr, m: msg });
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

  messages: function (address, limit, withRaw) {
    const addr = String(address || '').trim().toLowerCase();
    const box = this.boxes.get(addr);
    if (!box) return null;
    const k = Number(limit || 20);
    return box.messages.slice(-k).map(function (m) {
      const o = { ts: m.ts, sender: m.sender, rcpt: m.rcpt, to: m.to || '', delivered_to: m.delivered_to || '', subject: m.subject, codes: m.codes, body_preview: String(m.text || '').slice(0, 500), pick: m.pick || null };
      if (withRaw) o.raw = String(m.raw || '');
      return o;
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
      service: CFG.service, version: CFG.version, store: this.storeKind, domains: CFG.domains,
      state_path: this.statePath || null, persist_loaded: this.loaded,
      mailboxes: this.boxes.size, mailboxes_with_codes: withCodes, messages: msgs,
      acquired_total: this.acquiredTotal, received_total: this.receivedTotal,
      smtp_enabled: CFG.smtpEnabled, uptime_s: Math.round((Date.now() - this.startedAt) / 100) / 10
    };
  },

  healthz: function () {
    return { ok: true, version: CFG.version, store: this.storeKind, domains: CFG.domains, uptime_s: Math.round((Date.now() - this.startedAt) / 100) / 10 };
  }
};

/* --------------------- 邮件正文解析（MIME 够用版） --------------------- */
/* ---------- 邮件正文解析：折叠头 / RFC2047 / 多部分 / base64 / QP / 字符集 ---------- */
const _TD = (function () { try { return typeof TextDecoder !== "undefined" ? TextDecoder : null; } catch (e) { return null; } })();
function stripTags(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, String.fromCharCode(34)).replace(/&#39;|&apos;/gi, String.fromCharCode(39)).replace(/&amp;/gi, "&")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function qpDecode(s) {
  return String(s).replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
}
function b64ToBytes(s) { return Buffer.from(String(s).replace(/[^A-Za-z0-9+/=]/g, ""), "base64"); }
function b64Decode(s) { return b64ToBytes(s).toString("utf8"); }
function decodeBytesToText(bytes, charset) {
  let cs = String(charset || "").trim().toLowerCase().replace(/^["\x27]|["\x27]$/g, "");
  if (!cs || cs === "us-ascii" || cs === "ascii" || cs === "unknown-8bit") cs = "utf-8";
  if (cs === "gb2312" || cs === "gb_2312" || cs === "gbk" || cs === "cp936" || cs === "gb18030") cs = "gb18030";
  if (cs === "big5" || cs === "big-5" || cs === "cp950") cs = "big5";
  if (cs === "utf8") cs = "utf-8";
  if (cs.indexOf("iso-8859-1") === 0 || cs.indexOf("latin") === 0) cs = "utf-8";
  try { if (_TD) return new _TD(cs).decode(new Uint8Array(bytes)); } catch (e) {}
  try { if (_TD) return new _TD("utf-8").decode(new Uint8Array(bytes)); } catch (e) {}
  return Buffer.from(bytes).toString("utf8");
}
function qpToBytes(body) {
  const s = String(body); const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "=") {
      const h = s.substr(i + 1, 2);
      if (/^[0-9A-Fa-f]{2}$/.test(h)) { bytes.push(parseInt(h, 16)); i += 2; continue; }
      if (h.charAt(0) === "\r" || h.charAt(0) === "\n") { while (i + 1 < s.length && /[\r\n]/.test(s.charAt(i + 1))) i++; continue; }
      bytes.push(61); continue;
    }
    const code = s.charCodeAt(i);
    if (code < 128) { bytes.push(code); }
    else { const b = Buffer.from(c, "utf8"); for (let k = 0; k < b.length; k++) bytes.push(b[k]); }
  }
  return bytes;
}
function decodePart(body, enc, charset) {
  const e = String(enc || "").toLowerCase().trim();
  if (e === "base64") return decodeBytesToText(b64ToBytes(body), charset);
  if (e === "quoted-printable") return decodeBytesToText(qpToBytes(body), charset);
  return String(body);
}
function unfoldHead(h) { return String(h).replace(/\r?\n[ \t]+/g, " "); }
function headerVal(head, name) {
  const m = unfoldHead(head).match(new RegExp("^" + name + ":[ \t]*(.*)$", "im"));
  return m ? m[1].trim() : "";
}
function decodeRFC2047(str) {
  return String(str).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function (_, cs, mode, payload) {
    if (mode.toUpperCase() === "B") return decodeBytesToText(b64ToBytes(payload), cs);
    return decodeBytesToText(Buffer.from(qpDecode(payload.replace(/_/g, " ")), "binary"), cs);
  });
}
function collectParts(raw) {
  const parts = [];
  (function walk(part) {
    const s0 = String(part).replace(/^\r?\n+/, "");
    const he = s0.search(/\r?\n\r?\n/);
    let head = "", body = s0;
    if (he >= 0) { const mm = s0.slice(he).match(/\r?\n\r?\n/); head = s0.slice(0, he); body = s0.slice(he + (mm ? mm[0].length : 0)); }
    const ctype = String(headerVal(head, "content-type") || "").toLowerCase();
    const enc = headerVal(head, "content-transfer-encoding");
    const charset = (ctype.match(/charset\s*=\s*"?([^";\s]+)"?/) || [])[1] || "";
    let bnd = (ctype.match(/boundary\s*=\s*"?([^";\s]+)"?/) || [])[1] || headerVal(head, "boundary");
    if (bnd) bnd = String(bnd).replace(/^"|"$/g, "");
    if (/multipart/i.test(ctype) && bnd) {
      const pieces = body.split(new RegExp("--" + String(bnd).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      for (let i = 0; i < pieces.length; i++) {
        const pc = pieces[i];
        if (/^--/.test(pc.trim())) continue;
        if (!pc.trim()) continue;
        walk(pc);
      }
      return;
    }
    parts.push({ ctype: ctype, text: decodePart(body, enc, charset) });
  })(String(raw).replace(/\r\n/g, NL));
  return parts;
}
function collectText(raw) {
  const parts = collectParts(raw);
  const plain = parts.filter(function (p) { return /text\/plain/i.test(p.ctype) || !p.ctype; }).map(function (p) { return p.text; }).join(NL);
  if (plain.trim()) return plain;
  const html = parts.filter(function (p) { return /text\/html/i.test(p.ctype); }).map(function (p) { return stripTags(p.text); }).join(NL);
  if (html.trim()) return html;
  return parts.map(function (p) { return /text\/html/i.test(p.ctype) ? stripTags(p.text) : p.text; }).join(NL);
}
function parseMessage(raw) {
  const s0 = String(raw).replace(/\r\n/g, NL).replace(/^From .*\n/, "");
  const i = s0.indexOf(NL + NL);
  let head = s0, body = "";
  if (i >= 0) { head = s0.slice(0, i); body = s0.slice(i + 2); }
  const subjectRaw = headerVal(head, "subject");
  const dto = headerVal(head, "delivered-to") || headerVal(head, "x-original-to") || headerVal(head, "x-forwarded-to");
  return {
    subject: decodeRFC2047(subjectRaw),
    from: decodeRFC2047(headerVal(head, "from")).toLowerCase(),
    to: decodeRFC2047(headerVal(head, "to")).toLowerCase(),
    delivered_to: decodeRFC2047(dto).toLowerCase(),
    text: (function () {
      const full = collectText(s0);
      if (full && full.replace(/[\s\u0000]/g, '').length) return full;
      return body ? collectText(body) : full;
    })()
  };
}

/* 兜底：无论头有没有被截掉，都能从「Content-Transfer-Encoding: base64」块里把正文捞出来 */
function salvageEncoded(raw) {
  const src = String(raw);
  const out = [];
  const chunks = src.split(/content-transfer-encoding:\s*base64/i);
  for (let i = 1; i < chunks.length; i++) {
    let c = chunks[i];
    const he = c.search(/\r?\n\r?\n/);
    if (he >= 0) c = c.slice(he).replace(/^\r?\n\r?\n/, '');
    c = String(c).split(/--{2,}/)[0];
    c = c.replace(/[^A-Za-z0-9+/=]/g, '');
    if (c.length >= 16) {
      const d = Buffer.from(c, 'base64').toString('utf8');
      if (!d || d.replace(/[\s\u0000-\u0008]/g, '').length < 2) continue;
      out.push(/<\/?(?:html|body|div|table|tr|td|span|p|a|br|img)\b/i.test(d) ? stripTags(d) : d);
    }
  }
  if (!out.length) {
    const t = src.replace(/[^A-Za-z0-9+/=]/g, '');
    if (t.length >= 16 && t.length % 4 === 0) {
      try {
        const d = Buffer.from(t, 'base64').toString('utf8');
        if (d && /[\u4e00-\u9fa5]|[A-Za-z]{3}/.test(d)) out.push(d);
      } catch (e) {}
    }
  }
  return out.join(NL);
}

function mimeHeadRatio(s) {
  const lines = String(s || "").split(/\r?\n/);
  const n = Math.min(lines.length, 25);
  if (!n) return 0;
  let h = 0;
  for (let i = 0; i < n; i++) if (/^[A-Za-z][A-Za-z0-9-]{1,38}:\s/.test(lines[i])) h++;
  return h / n;
}
function looksMimey(s) {
  const t = String(s || "");
  if (/content-transfer-encoding|----=_nextpart/i.test(t)) return true;
  if (/^received:|^arc-|^dkim-signature:|^authentication-results:|^x-qq-mime|^message-id:/im.test(t)) return true;
  if (/this is a multi-part message/i.test(t)) return true;
  if (/^[A-Za-z0-9+/=\s]{400,}$/.test(t.trim())) return true;
  if (mimeHeadRatio(t) > 0.55 && t.split(/\r?\n/).length >= 4) return true;
  return false;
}
function bodyScore(s) {
  const t = String(s || "");
  if (!t.replace(/[\s\u0000]/g, "").length) return -1e9;
  const nStrong = strongCodes(t).length;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (t.match(/[A-Za-z]{3,}/g) || []).length;
  const nDigits = (t.match(/(?<![0-9])[0-9]{4,8}(?![0-9])/g) || []).length;
  let sc = 0;
  sc += nStrong * 10000;
  sc += Math.min(60, cjk) * 8;
  sc += Math.min(40, words) * 2;
  sc += Math.min(6, nDigits) * 3;
  sc -= Math.min(60, Math.floor(t.length / 900));
  if (looksMimey(t)) sc -= 1000000;
  return sc;
}
/* ----------------------------- SMTP 收信 ----------------------------- */
function startSmtp() {
  const server = net.createServer(function (sock) {
    let buf = '';
    let inData = false;
    let dataLines = [];
    let mailFrom = '';
    let rcptTos = [];
    sock.setTimeout(120000);
    sock.write('220 ' + CFG.smtpIdent + ' ' + CFG.smtpIdent + CRLF);

    function reply(s) { try { sock.write(s + CRLF); } catch (e) {} }

    function finishData() {
      const raw = dataLines.join(NL);
      let okCount = 0;
      let subj = '';
      try {
        const m = parseMessage(raw.replace(/\n\.\./g, '\n.'));
        subj = m.subject;
        for (let i = 0; i < rcptTos.length; i++) {
          if (store.deliver(rcptTos[i], mailFrom, m.subject, m.text, { to: m.to, delivered_to: m.delivered_to })) okCount++;
        }
      } catch (e) { log('WARN parse fail:', e.message); }
      log('smtp recv from=' + mailFrom + ' rcpt=' + rcptTos.join(',') + ' ok=' + okCount + ' subject=' + JSON.stringify(String(subj).slice(0, 60)));
      dataLines = []; rcptTos = []; mailFrom = '';
      reply('250 Message accepted for delivery');
    }

    function handle(line) {
      if (inData) {
        if (line === '.') { inData = false; finishData(); return; }
        if (dataLines.length < 20000) dataLines.push(line);
        return;
      }
      const up = line.toUpperCase();
      if (up.indexOf('EHLO') === 0 || up.indexOf('HELO') === 0) {
        sock.write('250-' + CFG.smtpIdent + CRLF);
        sock.write('250-SIZE ' + CFG.smtpMaxSize + CRLF);
        sock.write('250-8BITMIME' + CRLF);
        sock.write('250 HELP' + CRLF);
        return;
      }
      if (up.indexOf('MAIL FROM') === 0) {
        const m = line.match(/<([^>]*)>/);
        mailFrom = m ? m[1] : line.slice(line.indexOf(':') + 1).trim();
        reply('250 OK');
        return;
      }
      if (up.indexOf('RCPT TO') === 0) {
        const m = line.match(/<([^>]*)>/);
        if (m) rcptTos.push(m[1].trim().toLowerCase());
        reply('250 OK');
        return;
      }
      if (up === 'DATA') {
        if (rcptTos.length === 0) { reply('503 need RCPT first'); return; }
        inData = true; dataLines = [];
        reply('354 End data with <CR><LF>.<CR><LF>');
        return;
      }
      if (up.indexOf('RSET') === 0) { mailFrom = ''; rcptTos = []; dataLines = []; inData = false; reply('250 OK'); return; }
      if (up.indexOf('NOOP') === 0) { reply('250 OK'); return; }
      if (up.indexOf('VRFY') === 0) { reply('252 Cannot VRFY'); return; }
      if (up.indexOf('HELP') === 0) { reply('250 OK'); return; }
      if (up.indexOf('QUIT') === 0) { reply('221 Bye'); try { sock.end(); } catch (e) {} return; }
      reply('250 OK');
    }

    sock.on('data', function (chunk) {
      buf += chunk.toString('utf8');
      for (;;) {
        const i1 = buf.indexOf(CRLF);
        const i2 = buf.indexOf(NL);
        let cut = -1, sep = 0;
        if (i1 >= 0 && (i2 < 0 || i1 <= i2)) { cut = i1; sep = 2; }
        else if (i2 >= 0) { cut = i2; sep = 1; }
        else break;
        const line = buf.slice(0, cut);
        buf = buf.slice(cut + sep);
        handle(line);
      }
    });
    sock.on('error', function () {});
    sock.on('timeout', function () { try { sock.destroy(); } catch (e) {} });
  });
  server.on('error', function (e) {
    log('WARN SMTP 未启动 (' + CFG.smtpHost + ':' + CFG.smtpPort + ') -> ' + e.code + ' ' + e.message);
    log('     提示：机房封 25 时用 MF_SMTP_ENABLE=0，改用 POST /v1/ingest（Cloudflare Email Worker）。');
  });
  server.listen(CFG.smtpPort, CFG.smtpHost, function () {
    log('SMTP listening on ' + CFG.smtpHost + ':' + CFG.smtpPort + ' (ident=' + CFG.smtpIdent + ')');
  });
  return server;
}

/* ----------------------------- HTTP API ----------------------------- */
function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length });
  res.end(b);
}
function readBody(req, cb) {
  let chunks = [], len = 0;
  req.on('data', function (c) { len += c.length; if (len > 1048576) { try { req.destroy(); } catch (e) {} return; } chunks.push(c); });
  req.on('end', function () {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return cb({});
    try { cb(JSON.parse(raw)); } catch (e) { cb(null); }
  });
}
function keyOf(req) { return req.headers['x-api-key'] || req.headers['x-ingest-key'] || ''; }
function badKey(req) {
  if (!CFG.apiKey) return false;
  return String(keyOf(req)) !== CFG.apiKey;
}
function acquireKeyBad(req) {
  if (!CFG.requireKeyOnAcquire) return false;
  if (!CFG.apiKey) return false;
  return String(req.headers['x-api-key'] || '') !== CFG.apiKey;
}

const httpServer = http.createServer(function (req, res) {
  let path = '/';
  let query = {};
  try {
    const u = new URL(req.url, 'http://localhost');
    path = decodeURIComponent(u.pathname);
    u.searchParams.forEach(function (v, k) { query[k] = v; });
  } catch (e) { json(res, 400, { detail: 'bad url' }); return; }
  const method = req.method || 'GET';

  if (method === 'GET' && path === '/healthz') return json(res, 200, store.healthz());

  if (method === 'GET' && (path === '/v1/public/stats')) return json(res, 200, store.stats());

  if (method === 'GET' && path === '/v1/stats') {
    if (badKey(req)) return json(res, 401, { detail: 'bad api key' });
    return json(res, 200, store.stats());
  }
  /* /v1/domains：与上游实测契约对齐（GET 列出 / POST 追加，运行时生效，内存态） */
  if (path === '/v1/domains') {
    if (badKey(req)) return json(res, 401, { detail: 'bad api key' });
    if (method === 'GET') return json(res, 200, { ok: true, domains: CFG.domains });
    if (method === 'POST') {
      return readBody(req, function (b) {
        if (b === null) return json(res, 400, { detail: 'bad json' });
        const added = store.addDomains(b.domains);
        if (added.length) log('domains added: ' + added.join(','));
        json(res, 200, { ok: true, added: added, domains: CFG.domains });
      });
    }
    return json(res, 405, { detail: 'Method Not Allowed' });
  }

  if (method === 'POST' && path === '/v1/mailboxes/acquire') {
    if (acquireKeyBad(req)) return json(res, 401, { detail: 'bad api key' });
    return readBody(req, function (b) {
      if (b === null) return json(res, 400, { detail: 'bad json' });
      json(res, 200, store.acquire(b.prefix, b.domain));
    });
  }

  if (method === 'POST' && path === '/v1/mailboxes/acquire_batch') {
    if (acquireKeyBad(req)) return json(res, 401, { detail: 'bad api key' });
    return readBody(req, function (b) {
      if (b === null) return json(res, 400, { detail: 'bad json' });
      const boxes = store.acquireBatch(b.n === undefined ? 10 : b.n, b.prefix);
      json(res, 200, { count: boxes.length, mailboxes: boxes });
    });
  }

  // 收信：给 Cloudflare Email Worker / 转发器用（不需要 25 端口）
  if (method === 'POST' && path === '/v1/ingest') {
    const _src = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '');
    const _ua = String(req.headers['user-agent'] || '').slice(0, 48);
    if (CFG.ingestKey && String(keyOf(req)) !== CFG.ingestKey) {
      log('INGEST 401 src=' + _src + ' ua=' + _ua + ' keylen=' + String(keyOf(req)).length + ' want=' + CFG.ingestKey.length + ' host=' + String(req.headers['host'] || ''));
      return json(res, 401, { detail: 'bad api key' });
    }
    return readBody(req, function (b) {
      if (b === null) { log('INGEST 400 src=' + _src + ' bad-json'); return json(res, 400, { detail: 'bad json' }); }
      let subject = b.subject || '';
      let text = b.text || '';
      let _mp = null;
      if (b.raw) { try { _mp = parseMessage(String(b.raw)); } catch (e) { log('WARN ingest raw parse fail: ' + e.message); } }
      if (_mp && _mp.subject && (!subject || /^(mime-version|content-type|received|arc-|dkim-|return-path)/i.test(String(subject).trim()) || /^=\?/.test(String(subject).trim()))) subject = _mp.subject;
      let _pick = null;
      if (b.raw) {
        let _salv = ''; try { _salv = salvageEncoded(String(b.raw)); } catch (e) {}
        const cands = [];
        if (_mp && String(_mp.text || '').trim()) cands.push({ src: 'parsed', v: String(_mp.text) });
        if (_salv.trim()) cands.push({ src: 'salvage', v: String(_salv) });
        if (String(b.text || '').trim()) cands.push({ src: 'payload', v: String(b.text) });
        let best = '', bestScore = -1e18, bestSrc = '-';
        for (let ci = 0; ci < cands.length; ci++) {
          const csrc = cands[ci].src;
          const prio = csrc === 'parsed' ? 400 : (csrc === 'salvage' ? 0 : 0);
          const sc = bodyScore(cands[ci].v) + prio;
          if (sc > bestScore) { bestScore = sc; best = cands[ci].v; bestSrc = csrc; }
        }
        if (best) text = best;
        _pick = { src: bestSrc, score: bestScore, n: cands.length, lens: cands.map(function (c) { return String(c.v).length; }), names: cands.map(function (c) { return c.src; }) };
        log('INGEST-PICK src=' + bestSrc + ' score=' + bestScore + ' n=' + cands.length + ' lens=' + JSON.stringify(_pick.lens) + ' rawlen=' + String(b.raw).length);
      }
      if (!text && b.html) text = stripTags(b.html);
      const to = b.to || b.rcpt || b.address || '';
      let _extra = null;
      if (b.raw) { try { const _mp = parseMessage(String(b.raw)); _extra = { to: _mp.to, delivered_to: _mp.delivered_to }; } catch (e) { /* ignore */ } }
      if (b.to_header) { _extra = _extra || {}; _extra.to = String(b.to_header).toLowerCase(); }
      if (b.raw) { _extra = _extra || {}; _extra.raw = String(b.raw).slice(0, 30000); }
      if (_pick) { _extra = _extra || {}; _extra.pick = _pick; }
      const ok = store.deliver(to, b.from || b.sender || '', subject, text, _extra);
      if (!ok) { log('INGEST 400 src=' + _src + ' to=' + String(to).toLowerCase() + ' domain-not-served'); return json(res, 400, { detail: 'domain not served (add it to MF_DOMAINS)' }); }
      log('INGEST 200 src=' + _src + ' ua=' + _ua + ' to=' + String(to).toLowerCase() + ' from=' + String(b.from || b.sender || '') + ' codes=' + JSON.stringify(extractCodes(subject, text, 3)));
      json(res, 200, { ok: true, address: String(to).toLowerCase(), codes: extractCodes(subject, text, 5) });
    });
  }

  let m = path.match(/^\/v1\/mailboxes\/(.+)\/(code|messages)$/);
  if (m && method === 'GET') {
    const address = m[1];
    const kind = m[2];
    if (badKey(req)) return json(res, 401, { detail: 'bad api key' });
    if (kind === 'code') {
      let t = Number(query.timeout || 0); if (!Number.isFinite(t) || t < 0) t = 0; if (t > 120) t = 120;
      const deadline = Date.now() + t * 1000;
      (function poll() {
        const code = store.latestCode(address);
        if (code) return json(res, 200, { address: address, code: code, found: true });
        if (Date.now() >= deadline) return json(res, 200, { address: address, code: null, found: false });
        setTimeout(poll, 250);
      })();
      return;
    }
    let lim = Number(query.limit || 20); if (!Number.isFinite(lim) || lim < 1) lim = 20; if (lim > 200) lim = 200;
    const msgs = store.messages(address, lim, /^(1|true|yes)$/i.test(String(query.raw || '')));
    if (msgs === null) return json(res, 404, { detail: 'mailbox not found' });
    return json(res, 200, { address: address, count: msgs.length, messages: msgs });
  }

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    const s = store.stats();
    const body = '<html><head><meta charset="utf-8"><title>' + CFG.service + '</title></head><body>' +
      '<h3>' + CFG.service + ' ' + CFG.version + ' (node)</h3>' +
      '<p>domains: ' + s.domains.join(' , ') + '</p>' +
      '<p>mailboxes: ' + s.mailboxes + ' | messages: ' + s.messages + '</p>' +
      '<p>smtp_enabled: ' + s.smtp_enabled + '</p>' +
      '<p><a href="/docs">/docs</a> - <a href="/openapi.json">/openapi.json</a></p></body></html>';
    const b = Buffer.from(body, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length });
    return res.end(b);
  }

  json(res, 404, { detail: 'Not Found' });
});

/* ------------------------------- main ------------------------------- */
function main() {
  store.initStore();
  httpServer.listen(CFG.httpPort, CFG.httpHost, function () {
    log(CFG.service + ' ' + CFG.version + ' (node) starting');
    log('HTTP listening on http://' + CFG.httpHost + ':' + CFG.httpPort);
    log('domains = ' + CFG.domains.join(','));
    log('api_key ' + (CFG.apiKey ? 'enabled' : 'disabled (dev mode)') + ' | ingest_key ' + (CFG.ingestKey ? 'enabled' : 'disabled'));
    if (CFG.smtpEnabled) startSmtp();
    else log('SMTP disabled (MF_SMTP_ENABLE=0) -> 只走 POST /v1/ingest');
  });
  httpServer.on('error', function (e) { log('FATAL HTTP bind fail: ' + e.message); process.exit(2); });
}
main();
