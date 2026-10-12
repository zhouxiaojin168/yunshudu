#!/usr/bin/env node
/* eslint-disable */
/*
 * imap-mail-bridge.js - 零依赖「真实 IMAP 邮箱 -> mailfarm 同款 HTTP 契约」桥
 *
 * 用途：把任何标准 IMAP 邮箱（如 Spaceship 的 Spacemail、Gmail、QQ 企业邮等）
 *       包装成与自建 mailfarm 完全一致的 HTTP 接口，于是 pool-supply 只需把
 *       SUPP_MAIL_API 指到本服务即可，不必改一行注册流程代码。
 *
 * 契约（与 mailfarm-server.js 对齐）:
 *   GET  /healthz
 *   POST /v1/mailboxes/acquire            {prefix?}  -> {address, domain}
 *   GET  /v1/mailboxes/{address}/code?timeout=N      -> {address, code, found}
 *   GET  /v1/mailboxes/{address}/messages?limit=N    -> {address, count, messages}
 *   GET  /v1/stats
 *   鉴权: 头 x-api-key（IMB_API_KEY 为空则不校验）
 *
 * 环境变量:
 *   IMB_HOST         IMAP 主机（默认 mail.spacemail.com）
 *   IMB_PORT         IMAP 端口（默认 993）
 *   IMB_TLS          1=TLS（默认）0=明文（仅本地自测）
 *   IMB_TLS_INSECURE 1=跳过证书校验（默认 0，保持校验）
 *   IMB_USER         邮箱完整地址，如 yipian@qingzhou.autos
 *   IMB_PASS         邮箱密码
 *   IMB_DOMAIN       对外生成的收信域名（默认取 IMB_USER 的 @ 后半段）
 *   IMB_PREFIX       生成地址时的默认前缀（默认 hl）
 *   IMB_ALIASES      已建好的固定别名，逗号分隔（可选，留空则按前缀+时间戳生成）
 *   IMB_ALLOW_ANY    1=只要拿到邮件就算命中（不做收件人匹配，默认 0）
 *   IMB_FOLDER       收件文件夹（默认 INBOX）
 *   IMB_HTTP_HOST    HTTP 监听地址（默认 127.0.0.1）
 *   IMB_HTTP_PORT    HTTP 端口（默认 8098）
 *   IMB_API_KEY      x-api-key
 *   IMB_POLL_MS      等码时的轮询间隔（默认 3000）
 *   IMB_MAX_SCAN     每次拉取最多看最近多少封（默认 40）
 *   IMB_LOOKBACK_H   只回看最近多少小时（默认 24）
 *   IMB_MARK_SEEN    1=读取后标记已读（默认 0，用 BODY.PEEK 不改变服务器状态）
 *
 * 本地自测: node scripts/imap-mail-bridge-selftest.js
 */

'use strict';

var net = require('net');
var tls = require('tls');
var http = require('http');

var CRLF = String.fromCharCode(13) + String.fromCharCode(10);
var NL = String.fromCharCode(10);

function envStr(k, d) {
  var v = process.env[k];
  return (v === undefined || v === null || v === '') ? d : String(v);
}
function envInt(k, d) {
  var v = Number(process.env[k]);
  return (Number.isFinite(v) && v > 0) ? Math.floor(v) : d;
}
function nowIso() { return new Date().toISOString(); }

var CFG = {
  service: 'imap-mail-bridge',
  version: '1.0.0',
  host: envStr('IMB_HOST', 'mail.spacemail.com'),
  port: envInt('IMB_PORT', 993),
  tls: envStr('IMB_TLS', '1') !== '0',
  insecure: envStr('IMB_TLS_INSECURE', '0') === '1',
  user: envStr('IMB_USER', ''),
  pass: envStr('IMB_PASS', ''),
  domain: envStr('IMB_DOMAIN', ''),
  prefix: envStr('IMB_PREFIX', 'hl'),
  aliases: envStr('IMB_ALIASES', '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
  allowAny: envStr('IMB_ALLOW_ANY', '0') === '1',
  folder: envStr('IMB_FOLDER', 'INBOX'),
  httpHost: envStr('IMB_HTTP_HOST', '127.0.0.1'),
  httpPort: envInt('IMB_HTTP_PORT', 8098),
  apiKey: envStr('IMB_API_KEY', ''),
  pollMs: envInt('IMB_POLL_MS', 3000),
  maxScan: envInt('IMB_MAX_SCAN', 40),
  lookbackH: envInt('IMB_LOOKBACK_H', 24),
  markSeen: envStr('IMB_MARK_SEEN', '0') === '1'
};

if (!CFG.domain && CFG.user.indexOf('@') > 0) CFG.domain = CFG.user.split('@')[1];

function log() {
  var a = Array.prototype.slice.call(arguments);
  console.log('[' + nowIso() + '] ' + a.join(' '));
}

/* ----------------------- 验证码提取（与 mailfarm 同款规则） ----------------------- */
var KW = '(?:验证码|校验码|动态码|确认码|安全码|verification\\s*code|verify\\s*code|login\\s*code|security\\s*code|one[\\s-]?time\\s*(?:code|password)|otp|認証コード|인증\\s*번호)';
var RE_KW_DIGIT = new RegExp(KW + '[^0-9]{0,24}([0-9]{4,8})', 'gi');
var RE_KW_ALNUM = new RegExp(KW + '[^A-Za-z0-9]{0,24}([A-Za-z0-9]{4,8})', 'gi');
var RE_ANY_DIGIT = /(?<![0-9])([0-9]{4,8})(?![0-9])/g;
var RE_ANY_ALNUM = /(?<![A-Za-z0-9])([A-Z0-9]{5,8})(?![A-Za-z0-9])/g;

function isCode(tok, allowAlphaOnly) {
  if (!tok) return false;
  var t = String(tok).trim();
  if (t.length < 4 || t.length > 8) return false;
  if (/[0-9]/.test(t)) return true;
  if (allowAlphaOnly && t === t.toUpperCase() && t.length >= 5 && /^[A-Z0-9]+$/.test(t)) return true;
  return false;
}

function extractCodes(subject, text, limit) {
  var out = [];
  var max = limit || 5;
  function push(v, alphaOnly) {
    var t = (v === undefined || v === null) ? '' : String(v).trim();
    if (isCode(t, alphaOnly) && out.indexOf(t) < 0) out.push(t);
  }
  var blobs = [];
  if (subject) blobs.push(String(subject));
  if (text) blobs.push(String(text));
  var rounds = [[RE_KW_DIGIT, false], [RE_KW_ALNUM, false], [RE_ANY_DIGIT, false], [RE_ANY_ALNUM, true]];
  for (var r = 0; r < rounds.length; r++) {
    var re = rounds[r][0];
    var alphaOnly = rounds[r][1];
    for (var b = 0; b < blobs.length; b++) {
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(blobs[b])) !== null) {
        push(m[1], alphaOnly);
        if (out.length >= max) return out;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  return out;
}

/* ----------------------- MIME 解析 ----------------------- */
function stripTags(html) {
  return String(html).replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, NL)
    .replace(/<\/p>/gi, NL)
    .replace(/<[^>]+>/g, ' ');
}
function qpDecode(s) {
  return String(s).replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
}
function b64Decode(s) {
  try { return Buffer.from(String(s).replace(/\s+/g, ''), 'base64').toString('utf8'); } catch (e) { return ''; }
}
function decodePart(body, enc) {
  var e = String(enc || '').toLowerCase();
  if (e === 'base64') return b64Decode(body);
  if (e === 'quoted-printable') return qpDecode(body);
  return String(body);
}
function decodeHeaderWord(s) {
  return String(s).replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g, function (_, mode, payload) {
    return String(mode).toUpperCase() === 'B' ? b64Decode(payload) : qpDecode(String(payload).replace(/_/g, ' '));
  });
}
function collectText(raw) {
  var out = [];
  (function walk(part) {
    var headEnd = part.search(/\r?\n\r?\n/);
    if (headEnd < 0) { out.push(part); return; }
    var head = part.slice(0, headEnd);
    var sepLen = part.slice(headEnd).match(/\r?\n\r?\n/)[0].length;
    var body = part.slice(headEnd + sepLen);
    var ctype = (head.match(/content-type:\s*([^;\r\n]+)/i) || [])[1] || '';
    var enc = (head.match(/content-transfer-encoding:\s*([^\r\n;]+)/i) || [])[1] || '';
    var bnd = (head.match(/boundary="?([^";\r\n]+)"?/i) || [])[1];
    if (/multipart/i.test(ctype) && bnd) {
      var pieces = body.split('--' + bnd);
      for (var i = 0; i < pieces.length; i++) {
        var pc = pieces[i];
        if (/^--/.test(pc.trim())) continue;
        if (!pc.trim()) continue;
        walk(pc);
      }
      return;
    }
    var decoded = decodePart(body, enc);
    if (/text\/html/i.test(ctype)) decoded = stripTags(decoded);
    out.push(decoded);
  })(String(raw).replace(/\r\n/g, NL));
  return out.join(NL);
}
function parseHeaders(head) {
  var map = {};
  var lines = String(head).split(/\r?\n/);
  var cur = null;
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (/^[ \t]/.test(ln) && cur) { map[cur] += ' ' + ln.trim(); continue; }
    var m = ln.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (m) { cur = m[1].toLowerCase(); map[cur] = m[2]; }
  }
  return map;
}
function parseMessage(raw) {
  var text = String(raw);
  var sep = text.indexOf(CRLF + CRLF);
  var sep2 = text.indexOf(NL + NL);
  var head = text, body = '';
  if (sep >= 0) { head = text.slice(0, sep); body = text.slice(sep + 4); }
  else if (sep2 >= 0) { head = text.slice(0, sep2); body = text.slice(sep2 + 2); }
  var h = parseHeaders(head);
  var subject = decodeHeaderWord(h['subject'] || ''.trim()).trim();
  var from = decodeHeaderWord(h['from'] || '').trim();
  var toRaw = [h['delivered-to'], h['x-original-to'], h['to'], h['cc']].filter(Boolean).join(', ');
  var addrs = [];
  String(toRaw).replace(/[^\s,<>,;"]+/g, function (t) {
    var a = String(t).replace(/[<>"]/g, '').trim().toLowerCase();
    if (a.indexOf('@') > 0) addrs.push(a);
    return '';
  });
  var fullText = collectText(text);
  var codes = extractCodes(subject, fullText, 5);
  return {
    subject: subject,
    from: from,
    to: addrs,
    to_raw: toRaw.trim(),
    date: decodeHeaderWord(h['date'] || '').trim(),
    message_id: (h['message-id'] || '').trim(),
    text: fullText.slice(0, 20000),
    codes: codes
  };
}

module.exports = {
  CFG: CFG,
  extractCodes: extractCodes,
  parseMessage: parseMessage,
  collectText: collectText
};

/* ----------------------- IMAP 客户端（零依赖：按行 + literal 计数解析） ----------------------- */
function q(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

function imapDate(hoursBack) {
  var d = new Date(Date.now() - hoursBack * 3600 * 1000);
  var mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  var dd = d.getUTCDate();
  return (dd < 10 ? '0' + dd : '' + dd) + '-' + mon + '-' + d.getUTCFullYear();
}

function ImapClient(cfg) {
  this.cfg = cfg;
  this.sock = null;
  this.buf = Buffer.alloc(0);
  this.tagN = 0;
  this.cur = null;
  this.literalNeed = 0;
  this.literalLine = null;
  this.q = Promise.resolve();
  this.greetSettled = false;
  this.greetOk = false;
  this.greetErr = null;
  this.closed = false;
  this.selected = '';
  this.exists = 0;
}

ImapClient.prototype.destroy = function () {
  this.closed = true;
  try { if (this.sock) this.sock.destroy(); } catch (e) {}
};

ImapClient.prototype.connect = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    var done = false;
    var opts = { host: self.cfg.host, port: self.cfg.port };
    var s;
    if (self.cfg.tls) {
      opts.servername = self.cfg.host;
      opts.rejectUnauthorized = !self.cfg.insecure;
      s = tls.connect(opts);
    } else {
      s = net.connect(opts);
    }
    self.sock = s;
    s.on('data', function (c) { try { self._onData(c); } catch (e) { self._fail(e); } });
    s.on('error', function (e) { self._fail(e); if (!done) { done = true; reject(e); } });
    s.on('close', function () { self.closed = true; self._fail(new Error('IMAP connection closed')); });
    function tick() {
      if (self.greetSettled) {
        if (self.greetOk) { if (!done) { done = true; resolve(); } }
        else { if (!done) { done = true; reject(self.greetErr || new Error('IMAP greeting failed')); } }
        return;
      }
      if (self.closed) { if (!done) { done = true; reject(self.greetErr || new Error('IMAP closed before greeting')); } return; }
      setTimeout(tick, 5);
    }
    tick();
    setTimeout(function () { if (!done && !self.greetSettled) { done = true; reject(new Error('IMAP greeting timeout')); } }, 15000);
  });
};

ImapClient.prototype._fail = function (e) {
  if (this.cur && !this.cur.settled) { this.cur.settled = true; this.cur.reject(e); }
};

ImapClient.prototype._onData = function (chunk) {
  this.buf = Buffer.concat([this.buf, chunk]);
  for (;;) {
    if (this.literalNeed > 0) {
      if (this.buf.length < this.literalNeed) return;
      var lit = this.buf.slice(0, this.literalNeed);
      this.buf = this.buf.slice(this.literalNeed);
      this.literalNeed = 0;
      if (this.cur) { this.cur.literals.push(lit); this.cur.literalFor.push(this.literalLine); }
      this.literalLine = null;
      continue;
    }
    var i = this.buf.indexOf(CRLF);
    var skip = 2;
    if (i < 0) { i = this.buf.indexOf(NL); skip = 1; }
    if (i < 0) return;
    var line = this.buf.slice(0, i).toString('utf8');
    this.buf = this.buf.slice(i + skip);
    this._onLine(line);
  }
};

ImapClient.prototype._onLine = function (line) {
  if (!this.greetSettled) {
    if (/^\*\s+(OK|PREAUTH)/i.test(line)) { this.greetSettled = true; this.greetOk = true; return; }
    if (/^\*\s+BYE/i.test(line)) { this.greetSettled = true; this.greetOk = false; this.greetErr = new Error('IMAP BYE: ' + line); return; }
  }
  var m;
  if (line.charAt(0) === '*') {
    if (this.cur) this.cur.untagged.push(line);
    m = line.match(/\{(\d+)\}$/);
    if (m) { this.literalNeed = parseInt(m[1], 10); this.literalLine = line; }
    return;
  }
  if (line.charAt(0) === '+') {
    var c0 = this.cur;
    if (c0 && c0.onCont) {
      var data = c0.onCont();
      if (data !== null && data !== undefined) { try { this.sock.write(data); } catch (e) {} }
    }
    return;
  }
  m = line.match(/^(\S+)\s+(OK|NO|BAD)(.*)$/i);
  if (m) {
    var c = this.cur;
    if (c && c.tag === m[1] && !c.settled) {
      c.settled = true;
      var ok = /^OK$/i.test(m[2]);
      var trailer = String(m[3] || '').trim();
      if (ok) { c.resolve(c); }
      else {
        var e = new Error('IMAP ' + String(m[2]).toUpperCase() + ' <' + c.text + '> ' + trailer);
        e.status = String(m[2]).toUpperCase();
        c.reject(e);
      }
    }
    return;
  }
};

ImapClient.prototype.cmd = function (text, opts) {
  var self = this;
  opts = opts || {};
  function run() {
    return new Promise(function (resolve, reject) {
      if (self.closed || !self.sock) return reject(new Error('IMAP not connected'));
      var tag = 'T' + (++self.tagN);
      var c = {
        tag: tag, text: text, untagged: [], literals: [], literalFor: [],
        settled: false, resolve: resolve, reject: reject, onCont: opts.onCont || null
      };
      self.cur = c;
      try { self.sock.write(tag + ' ' + text + CRLF); }
      catch (e) { c.settled = true; return reject(e); }
    });
  }
  var p = self.q.then(run, run);
  self.q = p.then(function () {}, function () {});
  return p;
};

ImapClient.prototype.login = function (user, pass) {
  var self = this;
  return this.cmd('LOGIN ' + q(user) + ' ' + q(pass)).catch(function (e) {
    var used = false;
    var b64 = Buffer.from(String.fromCharCode(0) + user + String.fromCharCode(0) + pass, 'utf8').toString('base64');
    return self.cmd('AUTHENTICATE PLAIN', {
      onCont: function () { if (used) return null; used = true; return b64 + CRLF; }
    });
  });
};

ImapClient.prototype.select = function (name) {
  var self = this;
  var folder = name || 'INBOX';
  return this.cmd('SELECT ' + q(folder)).then(function (r) {
    self.selected = folder;
    self.exists = 0;
    r.untagged.forEach(function (l) {
      var mm = l.match(/^\*\s+(\d+)\s+EXISTS/i);
      if (mm) self.exists = parseInt(mm[1], 10);
    });
    return self.exists;
  });
};

ImapClient.prototype.uidSearch = function (criteria) {
  var out = [];
  return this.cmd('UID SEARCH ' + (criteria || 'ALL')).then(function (r) {
    r.untagged.forEach(function (l) {
      var mm = l.match(/^\*\s+SEARCH\b(.*)$/i);
      if (!mm) return;
      String(mm[1]).trim().split(/\s+/).forEach(function (t) { if (/^\d+$/.test(t)) out.push(Number(t)); });
    });
    return out;
  });
};

ImapClient.prototype.fetchRaw = function (uid) {
  var item = this.cfg.markSeen ? 'BODY[]' : 'BODY.PEEK[]';
  return this.cmd('UID FETCH ' + uid + ' (' + item + ')').then(function (r) {
    if (!r.literals.length) return '';
    var idx = 0;
    for (var i = 0; i < r.literalFor.length; i++) {
      if (r.literalFor[i] && /FETCH/i.test(r.literalFor[i])) { idx = i; break; }
    }
    return r.literals[idx].toString('utf8');
  });
};

/* ----------------------- 同步与查询 ----------------------- */
var state = {
  startedAt: Date.now(),
  acquiredTotal: 0,
  sessions: 0,
  lastSyncAt: 0,
  lastError: '',
  uids: new Set(),
  msgs: []
};

async function imapSync(force) {
  if (!CFG.user || !CFG.pass) throw new Error('IMB_USER / IMB_PASS 未配置');
  if (!force && Date.now() - state.lastSyncAt < 1200) return state.msgs;
  var c = new ImapClient(CFG);
  await c.connect();
  state.sessions++;
  try {
    await c.login(CFG.user, CFG.pass);
    await c.select(CFG.folder);
    var uids = await c.uidSearch('SINCE ' + imapDate(CFG.lookbackH));
    var fresh = uids.filter(function (u) { return !state.uids.has(u); });
    var tail = fresh.slice(-Math.max(1, CFG.maxScan));
    for (var i = 0; i < tail.length; i++) {
      var uid = tail[i];
      state.uids.add(uid);
      var raw = await c.fetchRaw(uid);
      if (!raw) continue;
      var mp = parseMessage(raw);
      mp.uid = uid;
      mp.received_at = Date.now();
      state.msgs.push(mp);
    }
    if (state.msgs.length > 500) state.msgs = state.msgs.slice(-500);
    state.lastSyncAt = Date.now();
    state.lastError = '';
  } finally {
    try { await c.cmd('LOGOUT'); } catch (e) {}
    try { c.destroy(); } catch (e) {}
  }
  return state.msgs;
}

function matchMsgs(address) {
  var a = String(address || '').trim().toLowerCase();
  var out = [];
  for (var i = state.msgs.length - 1; i >= 0; i--) {
    var m = state.msgs[i];
    if (CFG.allowAny) { out.push(m); continue; }
    if (m.to.indexOf(a) >= 0) { out.push(m); continue; }
    if (CFG.user && a === String(CFG.user).toLowerCase()) { out.push(m); continue; }
  }
  return out;
}

function latestCode(address, maxAgeS) {
  var list = matchMsgs(address);
  var now = Date.now();
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    if (maxAgeS && now - m.received_at > maxAgeS * 1000) continue;
    if (m.codes && m.codes.length) return { code: m.codes[0], subject: m.subject, from: m.from, received_at: m.received_at };
  }
  return null;
}

function healthz() {
  return {
    service: CFG.service,
    version: CFG.version,
    mode: 'imap-bridge',
    imap: CFG.host + ':' + CFG.port + (CFG.tls ? ' (tls)' : ' (plain)'),
    mailbox: CFG.user || '(unset)',
    domain: CFG.domain || '(unset)',
    aliases: CFG.aliases,
    allow_any: CFG.allowAny,
    api_key: CFG.apiKey ? 'enabled' : 'disabled (dev mode)',
    sessions: state.sessions,
    last_sync_at: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : null,
    last_error: state.lastError,
    cached_messages: state.msgs.length,
    uptime_s: Math.round((Date.now() - state.startedAt) / 1000)
  };
}

function acquire(prefix) {
  var pre = String(prefix || CFG.prefix || 'hl').replace(/[^A-Za-z0-9._-]/g, '');
  var address;
  if (CFG.aliases.length) {
    address = CFG.aliases[state.acquiredTotal % CFG.aliases.length];
  } else {
    address = pre + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36) + '@' + CFG.domain;
  }
  state.acquiredTotal++;
  return { address: address.toLowerCase(), domain: CFG.domain, mode: 'imap-bridge', created_at: Date.now() };
}

/* ----------------------- HTTP ----------------------- */
function json(res, code, obj) {
  var b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
}
function readBody(req, cb) {
  var chunks = [];
  var len = 0;
  req.on('data', function (c) { len += c.length; if (len > 1048576) { try { req.destroy(); } catch (e) {} return; } chunks.push(c); });
  req.on('end', function () {
    var s = Buffer.concat(chunks).toString('utf8').trim();
    if (!s) return cb({});
    try { cb(JSON.parse(s)); } catch (e) { cb(null); }
  });
}
function keyOf(req) { return req.headers['x-api-key'] || ''; }
function badKey(req) {
  if (!CFG.apiKey) return false;
  return String(keyOf(req)) !== CFG.apiKey;
}

var httpServer = http.createServer(function (req, res) {
  var path = '/';
  var query = {};
  try {
    var u = new URL(req.url, 'http://localhost');
    path = decodeURIComponent(u.pathname);
    u.searchParams.forEach(function (v, k) { query[k] = v; });
  } catch (e) { json(res, 400, { detail: 'bad url' }); return; }
  var method = req.method || 'GET';

  if (method === 'GET' && (path === '/healthz' || path === '/v1/public/stats')) return json(res, 200, healthz());

  if (method === 'GET' && path === '/v1/stats') {
    if (badKey(req)) return json(res, 401, { detail: 'bad api key' });
    return json(res, 200, healthz());
  }

  if (method === 'POST' && path === '/v1/mailboxes/acquire') {
    if (badKey(req)) return json(res, 401, { detail: 'bad api key' });
    return readBody(req, function (b) {
      if (b === null) return json(res, 400, { detail: 'bad json' });
      json(res, 200, acquire(b.prefix));
    });
  }

  if (method === 'POST' && path === '/v1/mailboxes/acquire_batch') {
    if (badKey(req)) return json(res, 401, { detail: 'bad api key' });
    return readBody(req, function (b) {
      if (b === null) return json(res, 400, { detail: 'bad json' });
      var n = Number(b.n || 10);
      if (!Number.isFinite(n) || n < 1) n = 10;
      if (n > 200) n = 200;
      var boxes = [];
      for (var i = 0; i < n; i++) boxes.push(acquire(b.prefix));
      json(res, 200, { count: boxes.length, mailboxes: boxes });
    });
  }

  var m = path.match(/^\/v1\/mailboxes\/(.+)\/(code|messages)$/);
  if (m && method === 'GET') {
    var address = m[1];
    var kind = m[2];
    if (badKey(req)) return json(res, 401, { detail: 'bad api key' });
    if (kind === 'code') {
      var t = Number(query.timeout || 0);
      if (!Number.isFinite(t) || t < 0) t = 0;
      if (t > 120) t = 120;
      var deadline = Date.now() + t * 1000;
      var poll = function () {
        Promise.resolve()
          .then(function () { return imapSync(true); })
          .then(function () {
            var hit = latestCode(address, 86400);
            if (hit) return json(res, 200, { address: address, code: hit.code, found: true, subject: hit.subject, from: hit.from, received_at: new Date(hit.received_at).toISOString(), mode: 'imap-bridge' });
            if (Date.now() >= deadline) return json(res, 200, { address: address, code: null, found: false, mode: 'imap-bridge' });
            setTimeout(poll, CFG.pollMs);
          })
          .catch(function (e) {
            state.lastError = e.message;
            if (Date.now() >= deadline) return json(res, 200, { address: address, code: null, found: false, error: e.message, mode: 'imap-bridge' });
            setTimeout(poll, CFG.pollMs);
          });
      };
      return poll();
    }
    var lim = Number(query.limit || 20);
    if (!Number.isFinite(lim) || lim < 1) lim = 20;
    if (lim > 200) lim = 200;
    return Promise.resolve()
      .then(function () { return imapSync(true); })
      .then(function () {
        var list = matchMsgs(address).slice(0, lim).map(function (mm) {
          return { from: mm.from, subject: mm.subject, codes: mm.codes, received_at: new Date(mm.received_at).toISOString(), uid: mm.uid };
        });
        json(res, 200, { address: address, count: list.length, messages: list, mode: 'imap-bridge' });
      })
      .catch(function (e) { json(res, 502, { detail: 'imap error: ' + e.message }); });
  }

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    var s = healthz();
    var body = '<html><head><meta charset="utf-8"><title>' + CFG.service + '</title></head><body>' +
      '<h3>' + CFG.service + ' ' + CFG.version + ' (imap bridge)</h3>' +
      '<p>imap: ' + s.imap + ' | mailbox: ' + s.mailbox + ' | domain: ' + s.domain + '</p>' +
      '<p>cached messages: ' + s.cached_messages + ' | api_key: ' + s.api_key + '</p>' +
      '</body></html>';
    var b2 = Buffer.from(body, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b2.length });
    return res.end(b2);
  }

  json(res, 404, { detail: 'Not Found' });
});

function startServer() {
  httpServer.listen(CFG.httpPort, CFG.httpHost, function () {
    log(CFG.service + ' ' + CFG.version + ' starting');
    log('IMAP ' + CFG.host + ':' + CFG.port + (CFG.tls ? ' (tls)' : ' (plain)') + ' | mailbox ' + (CFG.user || '(unset)'));
    log('HTTP listening on http://' + CFG.httpHost + ':' + CFG.httpPort);
    log('domain ' + (CFG.domain || '(unset)') + ' | aliases ' + (CFG.aliases.length || 0) + ' | api_key ' + (CFG.apiKey ? 'enabled' : 'disabled'));
    if (!CFG.user || !CFG.pass) log('WARN: IMB_USER / IMB_PASS 未配置 -> 只会在请求时报错');
  });
  httpServer.on('error', function (e) { log('FATAL HTTP bind fail: ' + e.message); process.exit(2); });
}

module.exports.ImapClient = ImapClient;
module.exports.imapSync = imapSync;
module.exports.latestCode = latestCode;
module.exports.acquire = acquire;
module.exports.healthz = healthz;
module.exports.startServer = startServer;
module.exports.imapDate = imapDate;

if (require.main === module) startServer();
