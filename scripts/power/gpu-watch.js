'use strict';
/**
 * gpu-watch.js -- watch the GPU count of THIS instance's machine; power_on the moment a card frees.
 * Runs every minute from task scheduler (A at :51, B at :21 => effective 30s).
 */
const fs = require('fs');
const path = require('path');
const ROOT = 'C:\\yunshudu';
const CFG = path.join(ROOT, 'app', 'config', 'autodl.json');
const LOCAL = path.join(ROOT, 'secrets', 'autodl.local.json');
const TOK = path.join(ROOT, 'secrets', 'autodl-token.txt');
const LOG = path.join(ROOT, 'logs', 'gpu-watch.log');
const STATE = path.join(ROOT, 'state', 'gpu-watch.json');
const POWERED = path.join(ROOT, 'state', 'gpu-watch-poweron.json');

function log(s) {
  const line = '[' + new Date().toISOString() + '] ' + s;
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch (e) {}
  console.log(line);
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } }
function writeJson(f, obj) {
  const tmp = f + '.tmp' + process.pid;
  try { fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8'); fs.renameSync(tmp, f); }
  catch (e) { try { fs.writeFileSync(f, JSON.stringify(obj), 'utf8'); } catch (e2) {} }
}
function walkFind(node, uuid, depth) {
  if (!node || typeof node !== 'object' || (depth || 0) > 7) return null;
  if (Array.isArray(node)) { for (const it of node) { const f = walkFind(it, uuid, (depth || 0) + 1); if (f) return f; } return null; }
  if (node.uuid === uuid || node.instance_uuid === uuid) return node;
  for (const k of Object.keys(node)) { const f = walkFind(node[k], uuid, (depth || 0) + 1); if (f) return f; }
  return null;
}
const H = (token) => ({ 'authorization': token, 'content-type': 'application/json', 'AppVersion': '0.0.0' });
async function listInstances(token) {
  const r = await fetch('https://www.autodl.com/api/v1/instance', { method: 'POST', headers: H(token), body: JSON.stringify({ page_index: 1, page_size: 100 }) });
  return await r.json();
}

(async () => {
  const token = (fs.readFileSync(TOK, 'utf8') || '').trim();
  let cfg = readJson(CFG);
  const local = readJson(LOCAL);
  for (const k of Object.keys(local)) cfg[k] = local[k];
  const uuid = cfg.instance_uuid;
  if (!token || !uuid) { log('ERROR missing token/uuid'); process.exit(1); }
  const st = readJson(STATE);

  const j = await listInstances(token);
  if (!j || j.code !== 'Success') { log('ERROR list failed: ' + (j && j.code) + ' ' + (j && j.msg)); process.exit(1); }
  const d = walkFind(j, uuid);
  if (!d) { log('ERROR instance ' + uuid + ' not found'); process.exit(1); }

  const status = d.status;
  const idle = Number(d.gpu_idle_num);
  const all = Number(d.gpu_all_num);
  const alias = d.machine_alias || d.machine_id;

  if (status && status !== 'shutdown') {
    if (st.last !== 'up') log('STATE up status=' + status + ' gpu=' + idle + '/' + all + ' machine=' + alias);
    writeJson(STATE, { last: 'up', status, at: new Date().toISOString(), idle, all });
    return;
  }

  if (idle > 0) {
    const pr = await fetch('https://www.autodl.com/api/v1/instance/power_on', { method: 'POST', headers: H(token), body: JSON.stringify({ instance_uuid: uuid, uuid: uuid }) });
    const pj = await pr.json().catch(() => ({}));
    log('POWER_ON req idle=' + idle + '/' + all + ' machine=' + alias + ' -> ' + (pj.code || '') + ' ' + (pj.msg || ''));
    writeJson(POWERED, { at: new Date().toISOString(), idle, all, code: pj.code || '', msg: pj.msg || '' });
    writeJson(STATE, { last: pj.code || 'power_on', at: new Date().toISOString(), idle, all, status: 'power_on_requested' });
    if (pj.code === 'Success') {
      await new Promise(r => setTimeout(r, 15000));
      try {
        const j2 = await listInstances(token);
        const d2 = walkFind(j2, uuid);
        if (d2) log('POWER_ON check 15s: status=' + d2.status + ' gpu=' + d2.gpu_idle_num + '/' + d2.gpu_all_num);
        writeJson(STATE, { last: 'up', at: new Date().toISOString(), status: (d2 && d2.status) || 'unknown', idle: d2 ? Number(d2.gpu_idle_num) : null, all: d2 ? Number(d2.gpu_all_num) : null });
      } catch (e) { log('WARN post-power check failed: ' + e.message); }
    }
    return;
  }

  const prevIdle = st.idle, prevStatus = st.status;
  if (prevIdle !== idle || prevStatus !== status) log('WAIT status=' + status + ' gpu=' + idle + '/' + all + ' machine=' + alias);
  writeJson(STATE, { last: 'wait', at: new Date().toISOString(), idle, all, status });
})().catch(e => log('ERROR ' + e.message));
