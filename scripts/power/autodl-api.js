'use strict';
/**
 * autodl-api.js —— AutoDL 控制台 API 客户端（R1187 王炸）
 *
 * 逆向来源（真凭实据）：自建机内 curl 抓 https://www.autodl.com/assets/instance.4daa8be5.js
 *   源码原文：const t={findAll:"api/v1/instance",initInstance:"api/v1/instance/init",
 *     stop:"api/v1/instance/power_off", start:"api/v1/instance/power_on",
 *     recreate:"api/v1/instance/recreate", release:"api/v1/instance/release",
 *     restartInstance:"api/v1/instance/restart", getDetail:"api/v1/instance/detail",
 *     monitor:"api/v1/instance/monitor", timedShutdown:"api/v1/instance/timed/shutdown", ...}
 *   请求拦截器原文：headers:{Authorization: getToken(), AppVersion: ...}
 *   其中 getToken = () => localStorage.getItem("token")   （www.autodl.com 登录态）
 *
 * 实测（无 token）：HTTP 200 {"code":"AuthorizeFailed","data":null,"msg":"登录超时，请重新登录"}
 *   -> 说明端点存在、只差鉴权；有 token 即真开关机。
 *
 * 注意：AutoDL 没有公开的「开放API」，这是控制台自己的接口；token 会过期，
 *       过期表现就是 AuthorizeFailed，此时去浏览器重新取一次 localStorage.token 覆盖 token_file 即可。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');       // C:\yunshudu\app  ->  C:\yunshudu
const CFG_PATH = process.env.AUTODL_CFG || path.join(ROOT, 'config', 'autodl.json');
const CFG_PATH_EX = path.join(ROOT, 'config', 'autodl.json.example');

const DEFAULTS = {
  enabled: false,
  dry_run: true,
  api_base: 'https://www.autodl.com',
  instance_uuid: '',
  token_file: path.join(ROOT, 'secrets', 'autodl-token.txt'),
  max_off_days: 13,
  idle_minutes: 30,
  check_interval_sec: 300,
  cooldown_minutes: 20,
  relay_health: 'http://127.0.0.1:9123/healthz',
  h3_hourly_cny: 2.93,
  log_file: path.join(ROOT, 'logs', 'h3-power.log'),
  state_file: path.join(ROOT, 'state', 'h3-power.json'),
  endpoints: {
    list: 'api/v1/instance',
    start: 'api/v1/instance/power_on',
    shutdown: 'api/v1/instance/power_off',
    restart: 'api/v1/instance/restart',
    detail: 'api/v1/instance/detail',
    monitor: 'api/v1/instance/monitor',
    timedShutdown: 'api/v1/instance/timed/shutdown',
  },
};

function loadCfg() {
  let f = {};
  const p = fs.existsSync(CFG_PATH) ? CFG_PATH : (fs.existsSync(CFG_PATH_EX) ? CFG_PATH_EX : null);
  if (p) { try { f = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { f = {}; } }
  const cfg = Object.assign({}, DEFAULTS, f);
  cfg.endpoints = Object.assign({}, DEFAULTS.endpoints, f.endpoints || {});
  cfg.cfg_path = p || '(none)';
  // ★ R1187: app\ 目录每次部署会被 robocopy /MIR 覆盖 -> 「武装开关」必须放在部署范围之外。
  //   这里再叠加 C:\yunshudu\secrets\autodl.local.json（存在即生效），改它不会被部署冲掉。
  //   路径取 token_file 的同级目录（= C:\yunshudu\secrets），不依赖 ROOT 层级，robocopy /MIR 也碰不到。
  const localCfg = process.env.AUTODL_LOCAL_CFG || path.join(path.dirname(String(cfg.token_file || path.join(ROOT, 'secrets', 'x'))), 'autodl.local.json');
  if (fs.existsSync(localCfg)) {
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(localCfg, 'utf8'))); cfg.local_cfg_path = localCfg; } catch (e) { cfg.local_cfg_error = e.message; }
  }
  if (process.env.AUTODL_TOKEN) cfg.token = process.env.AUTODL_TOKEN;
  if (process.env.AUTODL_UUID) cfg.instance_uuid = process.env.AUTODL_UUID;
  if (process.env.AUTODL_BASE) cfg.api_base = process.env.AUTODL_BASE;
  if (process.env.AUTODL_MAX_OFF_DAYS) cfg.max_off_days = Number(process.env.AUTODL_MAX_OFF_DAYS);
  if (process.env.AUTODL_IDLE_MIN) cfg.idle_minutes = Number(process.env.AUTODL_IDLE_MIN);
  if (process.env.AUTODL_DRYRUN === '0') cfg.dry_run = false;
  cfg.api_base = String(cfg.api_base || '').replace(/\/+$/, '');
  return cfg;
}

function getToken(cfg) {
  if (cfg.token) return String(cfg.token).trim();
  try { return fs.readFileSync(cfg.token_file, 'utf8').trim(); } catch (e) { return ''; }
}

function log(cfg, msg) {
  const s = '[' + new Date().toISOString() + '] ' + msg;
  console.log(s);
  try {
    fs.mkdirSync(path.dirname(cfg.log_file), { recursive: true });
    fs.appendFileSync(cfg.log_file, s + '\n', 'utf8');
  } catch (e) {}
}

async function call(cfg, key, body, method) {
  const ep = cfg.endpoints[key] || key;
  const url = /^https?:/.test(ep) ? ep : cfg.api_base + '/' + ep.replace(/^\/+/, '');
  const tok = getToken(cfg);
  const headers = { 'content-type': 'application/json', 'AppVersion': '0.0.0' };
  if (tok) headers.Authorization = tok;
  const init = { method: method || 'POST', headers };
  if (init.method !== 'GET' && body !== undefined) init.body = JSON.stringify(body || {});
  let r, txt;
  r = await fetch(url, init);
  txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (e) {}
  return { http: r.status, url: url, body: j, raw: txt };
}

function walkFind(node, uuid, depth) {
  if (!node || typeof node !== 'object' || (depth || 0) > 6) return null;
  if (Array.isArray(node)) {
    for (const it of node) { const f = walkFind(it, uuid, (depth || 0) + 1); if (f) return f; }
    return null;
  }
  if (node.uuid === uuid) return node;
  for (const k of Object.keys(node)) { const f = walkFind(node[k], uuid, (depth || 0) + 1); if (f) return f; }
  return null;
}

/** 列出账号下所有实例（原始返回，用于摸清字段） */
async function listInstances(cfg) {
  const body = { page_index: 1, page_size: 100 };
  return await call(cfg, 'list', body);
}

/** 找我们那台实例的当前状态对象 */
async function status(cfg) {
  const r = await listInstances(cfg);
  if (!r.body || r.body.code !== 'Success') return { ok: false, http: r.http, code: (r.body && r.body.code) || null, msg: (r.body && r.body.msg) || r.raw.slice(0, 200), raw: r.body };
  const inst = walkFind(r.body, cfg.instance_uuid) || null;
  return { ok: true, http: r.http, instance: inst, raw: r.body };
}

async function powerOn(cfg, opts) {
  const r = await call(cfg, 'start', { instance_uuid: cfg.instance_uuid, uuid: cfg.instance_uuid });
  const ok = !!(r.body && (r.body.code === 'Success' || r.body.data === true));
  log(cfg, (ok ? 'power_on 成功' : 'power_on 未确认') + ' :: http=' + r.http + ' code=' + ((r.body && r.body.code) || '-') + ' msg=' + ((r.body && r.body.msg) || r.raw.slice(0, 120)));
  return { ok, ...r };
}

async function powerOff(cfg, opts) {
  const r = await call(cfg, 'shutdown', { instance_uuid: cfg.instance_uuid, uuid: cfg.instance_uuid });
  const ok = !!(r.body && (r.body.code === 'Success' || r.body.data === true));
  log(cfg, (ok ? 'power_off 成功' : 'power_off 未确认') + ' :: http=' + r.http + ' code=' + ((r.body && r.body.code) || '-') + ' msg=' + ((r.body && r.body.msg) || r.raw.slice(0, 120)));
  return { ok, ...r };
}

module.exports = { loadCfg, getToken, log, call, listInstances, status, powerOn, powerOff, DEFAULTS, CFG_PATH, ROOT };