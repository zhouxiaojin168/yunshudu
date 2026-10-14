#!/usr/bin/env node
/**
 * dola-pool.js -- 「Dola 实例当浏览器池」的调度层（Dola 本地自动化 API 客户端）
 *
 * 依据 DolaMultiBrowser 字符串与内嵌插件 dola_browser_bridge：
 *   GET  /api/health             实例清单（id/name/platform/running/current）
 *   POST /api/instance/ensure    {instanceId?} 未启动自动启动
 *   POST /api/panel/sync         {instanceId?, text, images[], autoSend, use30s, clearFirst} 粘贴文案/参考图（未启动会自启）
 *   POST /api/panel/generate     需 auto_send=true（发送后等待生成）
 *   POST /api/task/wait-video    等待生成完成/回传 mp4
 *   默认端口 17823（= 浏览器 config.json 的 automationPort / dola_port.json）
 *
 * 用法：
 *   node scripts/dola-pool.js list
 *   node scripts/dola-pool.js ensure --instances Dola-01,Dola-02
 *   node scripts/dola-pool.js send --text "一只猫在雪地奔跑" --instances Dola-01,Dola-02 [--image D:\a.png] [--auto-send] [--clear-first]
 *   node scripts/dola-pool.js distribute --in prompts.jsonl [--field text] [--auto-send]    # 一号一条，轮流分发
 *   环境变量：DOLA_PORT / DOLA_HOST
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.DOLA_HOST || '127.0.0.1';
const PORT = Number(process.env.DOLA_PORT || 17823);

function argval(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || String(v).indexOf('--') === 0) ? dflt : v;
}
const has = (n) => process.argv.indexOf('--' + n) >= 0;

function call(method, p, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({
      host: HOST, port: PORT, path: p, method: method,
      headers: Object.assign({ 'content-type': 'application/json' }, data ? { 'content-length': data.length } : {})
    }, function (x) {
      let b = ''; x.on('data', (d) => b += d);
      x.on('end', function () { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: x.statusCode, json: j, raw: b.slice(0, 800) }); });
    });
    r.setTimeout(timeoutMs || 30000, function () { r.destroy(); reject(new Error('timeout ' + p)); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/* 兼容 snake_case / camelCase 两种字段名 */
function pick(id, ids) {
  const list = (ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return {};
  const i = list.indexOf(id);
  return { instanceId: id, index: i, list: list };
}

async function cmdList() {
  const r = await call('GET', '/api/health');
  if (!r.json || !r.json.ok) { console.log('health 失败: ' + r.raw); return; }
  const ins = (r.json.instances || []);
  console.log('Dola v' + r.json.version + '  实例 ' + ins.length + ' 个：');
  for (const x of ins) console.log('  ' + String(x.id).padEnd(12) + ' platform=' + x.platform + '  running=' + x.running + (x.current ? '  (current)' : ''));
  return ins;
}

async function cmdEnsure(ids) {
  const list = (ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) { const h = await call('GET', '/api/health'); list.push.apply(list, (h.json.instances || []).map((x) => x.id)); }
  for (const id of list) {
    const r = await call('POST', '/api/instance/ensure', { instance_id: id, instance_name: id }, 120000);
    console.log('ensure ' + id + ' -> ' + (r.json ? JSON.stringify(r.json) : r.raw));
  }
}

async function cmdSend(text, ids, opts) {
  const list = (ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) { const h = await call('GET', '/api/health'); list.push((h.json.instances || []).filter((x) => x.running)[0].id); }
  for (const id of list) {
    /* 字段名以 Dola 内嵌插件 dola_browser_bridge/main.py 为准（snake_case） */
    const body = { instance_id: id, instance_name: id, text: text, image_paths: opts.images, auto_send: !!opts.autoSend, use_30s: !!opts.use30s, clear_first: !!opts.clearFirst };
    if (opts.autoSend && opts.wait) { body.timeout_seconds = opts.timeoutSec; if (opts.outputDir) body.output_dir = opts.outputDir; }
    const r = await call('POST', '/api/panel/sync', body, opts.timeoutMs);
    console.log('[send] ' + id + ' -> ' + (r.json ? JSON.stringify(r.json) : r.status + ' ' + r.raw));
    if (r.json && r.json.ok && opts.autoSend && opts.wait) {
      const w = await call('POST', '/api/task/wait-video', { instance_id: id, instance_name: id, timeout_seconds: opts.timeoutSec || 600, output_dir: opts.outputDir || undefined }, (opts.timeoutSec || 600) * 1000 + 30000);
      console.log('[wait] ' + id + ' -> ' + (w.json ? JSON.stringify(w.json).slice(0, 400) : w.raw));
    }
  }
}

async function cmdDistribute(inFile, field, opts) {
  const lines = fs.readFileSync(path.resolve(inFile), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const items = lines.map(function (l) {
    if (l.trim()[0] === '{') { const j = JSON.parse(l); return { text: j[field] || j.text || '', image: j.image || null }; }
    return { text: l, image: null };
  });
  const h = await call('GET', '/api/health');
  let ins = (h.json.instances || []).filter((x) => x.platform === 'Dola').map((x) => x.id);
  if (opts.ids) ins = opts.ids.split(',').map((s) => s.trim()).filter(Boolean);
  console.log('[distribute] 分镜 ' + items.length + ' 条 → 实例 ' + ins.length + ' 个（一号一条）');
  for (let i = 0; i < Math.min(items.length, ins.length); i++) {
    const body = { instance_id: ins[i], instance_name: ins[i], text: items[i].text, image_paths: items[i].image ? [items[i].image] : [], auto_send: !!opts.autoSend, use_30s: !!opts.use30s, clear_first: !!opts.clearFirst };
    const r = await call('POST', '/api/panel/sync', body, opts.timeoutMs);
    console.log('  ' + ins[i] + ' <- ' + String(items[i].text).slice(0, 42) + ' ... ' + (r.json ? ('ok=' + r.json.ok + ' textChars=' + r.json.textChars) : r.raw));
  }
  if (items.length > ins.length) console.log('  ⚠ 还有 ' + (items.length - ins.length) + ' 条未分配（每实例最多一条，请增加实例或分批）');
}

(async function main() {
  const cmd = process.argv[2] || 'list';
  const ids = argval('instances', '');
  const opts = {
    ids: ids, autoSend: has('auto-send'), clearFirst: has('clear-first'), wait: has('wait'),
    timeoutSec: Number(argval('timeout-seconds', 600)), timeoutMs: Number(argval('timeout', 120000)),
    images: String(argval('image', '')).split(',').filter(Boolean), use30s: has('use-30s'), outputDir: argval('output-dir', '')
  };
  if (cmd === 'list' || cmd === 'health') await cmdList();
  else if (cmd === 'ensure') await cmdEnsure(ids);
  else if (cmd === 'send') await cmdSend(String(argval('text', '')), ids, opts);
  else if (cmd === 'distribute') await cmdDistribute(argval('in', ''), argval('field', 'text'), opts);
  else { console.log('用法: node scripts/dola-pool.js [list|ensure|send|distribute] …'); process.exit(2); }
  process.exit(0);
})().catch(function (e) { console.log('FATAL ' + e.message); process.exit(1); });