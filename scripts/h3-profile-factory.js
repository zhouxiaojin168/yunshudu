#!/usr/bin/env node
/**
 * h3-profile-factory.js -- H3 批量登录「实例工厂」（Dola 同构）
 *
 * 逆向依据：docs/豆啦啦浏览器-登录原理逆向(R142).md §3.1 / §5
 *   Dola 的「取CK」第一步就是「建实例 profile（代理/静态IP + 指纹）」。
 *   本模块把那一层剥出来，直接给海螺 H3 用：
 *
 *     实例目录 H3-001/
 *       fingerprint_config.json   Dola 同构字段（ua / javascriptFingerprint / screen / timezone / network / canvas / audio）
 *       proxy_config.json         Dola 同构（enabled/type/host/port/username/password/useLocalChain/...）
 *       account_config.json       Dola 同构（type/points/login/homePage）
 *       login_state.json          登录态快照（token/userID/email/credits/at）——Dola 是 cookies.json，H3 是这份
 *
 *   并导出 buildFingerprint / buildInitScript：
 *     init script 在每个页面「文档开始前」注入，覆盖 navigator.* / WebGL / canvas / audio / WebRTC，
 *     并清理 __pwInitScripts（Playwright 痕迹）—— 全部照 Dola 的手法（--exclude-switches=enable-automation 等价物）。
 *
 * 用法：
 *   node scripts/h3-profile-factory.js --n 5 --out state/h3-profiles            # 造 5 个实例
 *   node scripts/h3-profile-factory.js --n 3 --proxy http://127.0.0.1:10090    # 每个实例写同一条出口（实测用）
 *   node scripts/h3-profile-factory.js --list                                  # 看现有实例与指纹摘要
 *   node scripts/h3-profile-factory.js --template-from "E:\dola2.5\dola\Dola-01\fingerprint_config.json"
 *                                                                              # 直接拿 Dola 真身指纹当模板
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* ---------- Dola 同构指纹模型池（Windows + Chrome（已对齐本机真身 154.0.8037.98）） ---------- */
const UA_MODELS = [
  {
    id: 'win10-chrome-154-intel', label: 'Windows 10 · Chrome 154 · Intel UHD Graphics 630',
    os: 'Windows 10', browser: 'Chrome 154',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="154", "Chromium";v="154", "Not_A Brand";v="24"',
    secChUaFullVersionList: '"Google Chrome";v="154.0.8037.98", "Chromium";v="154.0.8037.98", "Not_A Brand";v="24.0.0.0"',
    secChUaPlatform: 'Windows', secChUaPlatformVersion: '10.0.0', secChUaArch: 'x86', secChUaBitness: '64', secChUaMobile: '?0',
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    hardwareConcurrency: 4, deviceMemory: 4, screen: { width: 1920, height: 1080, deviceScaleFactor: 1 }
  },
  {
    id: 'win11-chrome-154-nvidia', label: 'Windows 11 · Chrome 154 · NVIDIA RTX 4060',
    os: 'Windows 11', browser: 'Chrome 154',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="154", "Chromium";v="154", "Not_A Brand";v="24"',
    secChUaFullVersionList: '"Google Chrome";v="154.0.8037.98", "Chromium";v="154.0.8037.98", "Not_A Brand";v="24.0.0.0"',
    secChUaPlatform: 'Windows', secChUaPlatformVersion: '15.0.0', secChUaArch: 'x86', secChUaBitness: '64', secChUaMobile: '?0',
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    hardwareConcurrency: 16, deviceMemory: 8, screen: { width: 2560, height: 1440, deviceScaleFactor: 1 }
  },
  {
    id: 'win10-chrome-154-amd', label: 'Windows 10 · Chrome 154 · AMD Radeon RX 6600',
    os: 'Windows 10', browser: 'Chrome 154',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="154", "Chromium";v="154", "Not_A Brand";v="24"',
    secChUaFullVersionList: '"Google Chrome";v="154.0.8037.98", "Chromium";v="154.0.8037.98", "Not_A Brand";v="24.0.0.0"',
    secChUaPlatform: 'Windows', secChUaPlatformVersion: '10.0.0', secChUaArch: 'x86', secChUaBitness: '64', secChUaMobile: '?0',
    webglVendor: 'Google Inc. (AMD)',
    webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6600 (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    hardwareConcurrency: 12, deviceMemory: 8, screen: { width: 1920, height: 1080, deviceScaleFactor: 1 }
  },
  {
    id: 'win11-chrome-154-intel-arc', label: 'Windows 11 · Chrome 154 · Intel Arc A750',
    os: 'Windows 11', browser: 'Chrome 154',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="154", "Chromium";v="154", "Not_A Brand";v="24"',
    secChUaFullVersionList: '"Google Chrome";v="154.0.8037.98", "Chromium";v="154.0.8037.98", "Not_A Brand";v="24.0.0.0"',
    secChUaPlatform: 'Windows', secChUaPlatformVersion: '15.0.0', secChUaArch: 'x86', secChUaBitness: '64', secChUaMobile: '?0',
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) Arc(TM) A750 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    hardwareConcurrency: 8, deviceMemory: 8, screen: { width: 1536, height: 864, deviceScaleFactor: 1.25 }
  }
];

const TZ_POOL = ['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'America/Los_Angeles'];

/* ---------- 构造一个实例的指纹（Dola 字段一一对应） ---------- */
function buildFingerprint(index /* 0-based */, opts) {
  opts = opts || {};
  const base = opts.baseModel || UA_MODELS[index % UA_MODELS.length];
  const langs = opts.languages || (index % 2 === 0 ? ['zh-CN', 'zh', 'en-US', 'en'] : ['en-US', 'en', 'zh-CN', 'zh']);
  const tz = opts.timezone || TZ_POOL[index % TZ_POOL.length];
  return {
    enabled: '1',
    ua: {
      id: base.id, label: base.label, os: base.os, browser: base.browser,
      userAgent: base.userAgent,
      secChUa: base.secChUa, secChUaFullVersionList: base.secChUaFullVersionList,
      secChUaPlatform: base.secChUaPlatform, secChUaPlatformVersion: base.secChUaPlatformVersion,
      secChUaArch: base.secChUaArch, secChUaBitness: base.secChUaBitness, secChUaMobile: base.secChUaMobile
    },
    javascriptFingerprint: {
      navigatorUserAgent: base.userAgent,
      navigatorUserAgentData: {
        brands: base.secChUa,
        fullVersionList: base.secChUaFullVersionList,
        mobile: false, platform: base.secChUaPlatform,
        architecture: base.secChUaArch, bitness: base.secChUaBitness,
        platformVersion: base.secChUaPlatformVersion
      },
      platform: 'Win32', vendor: 'Google Inc.',
      languages: langs,
      hardwareConcurrency: base.hardwareConcurrency,
      deviceMemory: base.deviceMemory,
      maxTouchPoints: 0,
      webglVendor: base.webglVendor,
      webglRenderer: base.webglRenderer
    },
    screen: base.screen,
    timezone: tz,
    network: { webRtcPolicy: 'disable_non_proxied_udp' },
    canvas: { noise: '1' },
    audio: { noise: '1' }
  };
}

function buildProxy(index, opts) {
  opts = opts || {};
  if (opts.proxyList && opts.proxyList.length) {
    const raw = opts.proxyList[index % opts.proxyList.length];
    try { const u = new URL(raw); return { enabled: true, type: u.protocol.replace(':', '') || 'http', host: u.hostname, port: Number(u.port || 80), username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || ''), remark: '', useLocalChain: false, localChainHost: '127.0.0.1', localChainPort: 17896, localChainType: 'http' }; } catch (e) {}
  }
  const one = opts.proxy || 'http://127.0.0.1:10090';
  try {
    const u = new URL(one);
    return { enabled: !!opts.proxy, type: u.protocol.replace(':', '') || 'http', host: u.hostname, port: Number(u.port || 80), username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || ''), remark: opts.proxyRemark || '', useLocalChain: false, localChainHost: '127.0.0.1', localChainPort: 17896, localChainType: 'http' };
  } catch (e) {
    return { enabled: false, type: 'http', host: '', port: 0, username: '', password: '', remark: '', useLocalChain: false, localChainHost: '127.0.0.1', localChainPort: 17896, localChainType: 'http' };
  }
}

/* ---------- 页面初始化脚本：把指纹真正"装"进浏览器（Dola §5 同款手法） ---------- */
function buildInitScript(fp) {
  const F = JSON.stringify({
    platform: fp.javascriptFingerprint.platform,
    vendor: fp.javascriptFingerprint.vendor,
    languages: fp.javascriptFingerprint.languages,
    hardwareConcurrency: fp.javascriptFingerprint.hardwareConcurrency,
    deviceMemory: fp.javascriptFingerprint.deviceMemory,
    maxTouchPoints: fp.javascriptFingerprint.maxTouchPoints,
    webglVendor: fp.javascriptFingerprint.webglVendor,
    webglRenderer: fp.javascriptFingerprint.webglRenderer,
    uaData: fp.javascriptFingerprint.navigatorUserAgentData,
    timezone: fp.timezone,
    canvasNoise: String(fp.canvas && fp.canvas.noise) === '1',
    audioNoise: String(fp.audio && fp.audio.noise) === '1',
    webRtc: (fp.network && fp.network.webRtcPolicy) || 'default'
  });
  return '(function(){try{' + [
    'var F=' + F + ';',
    /* 清掉 Playwright 自己的痕迹（Dola 也干这事） */
    'try{delete window.__pwInitScripts;}catch(e){}',
    'var def=function(o,p,v){try{Object.defineProperty(o,p,{get:function(){return v;},set:function(){},configurable:true});}catch(e){}};',
    /* navigator 面 */
    'def(Navigator.prototype,"webdriver",undefined);',
    'def(Navigator.prototype,"platform",F.platform);',
    'def(Navigator.prototype,"vendor",F.vendor);',
    'def(Navigator.prototype,"languages",F.languages);',
    'def(Navigator.prototype,"language",F.languages[0]);',
    'def(Navigator.prototype,"hardwareConcurrency",F.hardwareConcurrency);',
    'def(Navigator.prototype,"deviceMemory",F.deviceMemory);',
    'def(Navigator.prototype,"maxTouchPoints",F.maxTouchPoints);',
    'try{var b=(F.uaData.brands||"").split(",").map(function(s){var m=/v="([0-9]+)"/.exec(s);var bm=/^"?([^"]+)"?/.exec(s.trim());return {brand:(bm?bm[1]:s).trim(),version:m?m[1]:"0"};});',
    'var fv=(F.uaData.fullVersionList||"").split(",").map(function(s){var m=/v="([0-9.]+)"/.exec(s);var bm=/^"?([^"]+)"?/.exec(s.trim());return {brand:(bm?bm[1]:s).trim(),version:m?m[1]:"0"};});',
    'var uad={brands:b,fullVersionList:fv,mobile:false,platform:F.uaData.platform,',
    ' getHighEntropyValues:function(h){var r={architecture:F.uaData.architecture,bitness:F.uaData.bitness,model:"",platform:F.uaData.platform,platformVersion:F.uaData.platformVersion,uaFullVersion:(fv[0]&&fv[0].version)||"",fullVersionList:fv,wow64:false};',
    '  try{for(var i=0;i<(h||[]).length;i++){if(!(h[i] in r)) r[h[i]]="";}}catch(e){} return Promise.resolve(r);},',
    ' toJSON:function(){return {brands:b,mobile:false,platform:F.uaData.platform};}};',
    'def(Navigator.prototype,"userAgentData",uad);}catch(e){}',
    /* WebGL 面 */
    'try{var patchGL=function(proto){var gp=proto.getParameter;proto.getParameter=function(p){if(p===37445)return F.webglVendor;if(p===37446)return F.webglRenderer;return gp.apply(this,arguments);};',
    ' var ge=proto.getExtension;proto.getExtension=function(n){if(n==="WEBGL_debug_renderer_info")return {UNMASKED_VENDOR_WEBGL:37445,UNMASKED_RENDERER_WEBGL:37446};return ge.apply(this,arguments);};};',
    'if(window.WebGLRenderingContext)patchGL(WebGLRenderingContext.prototype);if(window.WebGL2RenderingContext)patchGL(WebGL2RenderingContext.prototype);}catch(e){}',
    /* canvas 噪声（Dola canvas.noise=1） */
    'if(F.canvasNoise){try{var tdu=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(){try{var c=this.getContext("2d");if(c&&this.width&&this.height){c.fillStyle="rgba(0,0,0,0.0039)";c.fillRect(0,0,1,1);c.fillStyle="rgba(0,0,0,1)";}}catch(e){}return tdu.apply(this,arguments);};}catch(e){}',
    'try{var gid=CanvasRenderingContext2D.prototype.getImageData;CanvasRenderingContext2D.prototype.getImageData=function(){var d=gid.apply(this,arguments);try{if(d&&d.data&&d.data.length>8){d.data[0]=(d.data[0]^1)&255;d.data[4]=(d.data[4]^1)&255;}}catch(e){}return d;};}catch(e){}}',
    /* audio 噪声（Dola audio.noise=1） */
    'if(F.audioNoise){try{var gcb=AnalyserNode.prototype.getFloatFrequencyData;if(gcb){AnalyserNode.prototype.getFloatFrequencyData=function(a){gcb.apply(this,arguments);if(a&&a.length){a[0]=a[0]+0.0000001;}};}}catch(e){}',
    'try{var gcd=AnalyserNode.prototype.getByteFrequencyData;if(gcd){AnalyserNode.prototype.getByteFrequencyData=function(a){gcd.apply(this,arguments);if(a&&a.length){a[0]=(a[0]^(a[0]&1))&255;}};}}catch(e){}}',
    /* WebRTC：disable_non_proxied_udp -> 抹掉 host 候选，避免泄漏真实 IP */
    'if(F.webRtc==="disable_non_proxied_udp"){try{var rtc=window.RTCPeerConnection||window.webkitRTCPeerConnection;if(rtc){var Op=rtc.prototype.createOffer;rtc.prototype.createOffer=function(){var self=this;try{self.setConfiguration&&self.setConfiguration({iceServers:[],iceTransportPolicy:"relay"});}catch(e){}return Op.apply(this,arguments);};}}catch(e){}}',
    '}catch(e){}'
  ].join('') + '})();';
}

/* ---------- 造实例 ---------- */
function makeInstances(n, opts) {
  opts = opts || {};
  const outDir = path.resolve(opts.out || path.join(ROOT, 'state', 'h3-profiles'));
  fs.mkdirSync(outDir, { recursive: true });
  const made = [];
  for (let i = 0; i < n; i++) {
    const pad = String(i + 1).padStart(3, '0');
    const id = 'H3-' + pad;
    const dir = path.join(outDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const fp = buildFingerprint(i, opts);
    const px = buildProxy(i, opts);
    fs.writeFileSync(path.join(dir, 'fingerprint_config.json'), JSON.stringify(fp, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'proxy_config.json'), JSON.stringify(px, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'account_config.json'), JSON.stringify({ type: '3', points: '0', login: '0', homePage: 'https://hailuoai.video/zh-Intl' }, null, 2), 'utf8');
    made.push({ id: id, dir: dir, ua: fp.ua.id, tz: fp.timezone, proxy: px.enabled ? (px.host + ':' + px.port) : null });
  }
  return { outDir: outDir, instances: made };
}

function listInstances(dir) {
  const outDir = path.resolve(dir || path.join(ROOT, 'state', 'h3-profiles'));
  if (!fs.existsSync(outDir)) return [];
  return fs.readdirSync(outDir).filter(function (d) { return /^H3-\d+$/.test(d); }).sort().map(function (d) {
    const dir2 = path.join(outDir, d);
    let fp = null, px = null, st = null;
    try { fp = JSON.parse(fs.readFileSync(path.join(dir2, 'fingerprint_config.json'), 'utf8')); } catch (e) {}
    try { px = JSON.parse(fs.readFileSync(path.join(dir2, 'proxy_config.json'), 'utf8')); } catch (e) {}
    try { st = JSON.parse(fs.readFileSync(path.join(dir2, 'login_state.json'), 'utf8')); } catch (e) {}
    return { id: d, dir: dir2, ua: fp && fp.ua && fp.ua.id, tz: fp && fp.timezone, proxy: px && px.enabled ? (px.host + ':' + px.port) : null, loggedIn: !!(st && st.token), label: st && st.label, credits: st && st.credits };
  });
}

function loadFingerprint(profileDir) { return JSON.parse(fs.readFileSync(path.join(profileDir, 'fingerprint_config.json'), 'utf8')); }
function loadProxy(profileDir) {
  try { return JSON.parse(fs.readFileSync(path.join(profileDir, 'proxy_config.json'), 'utf8')); } catch (e) { return null; }
}
function proxyToPlaywright(px) {
  if (!px || !px.enabled || !px.host) return null;
  const s = (px.type || 'http') + '://' + (px.username ? encodeURIComponent(px.username) + ':' + encodeURIComponent(px.password) + '@' : '') + px.host + (px.port ? ':' + px.port : '');
  return { server: (px.type || 'http') + '://' + px.host + (px.port ? ':' + px.port : ''), username: px.username || undefined, password: px.password || undefined, _raw: s };
}

/* ---------- CLI ---------- */
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return (v === undefined || v.indexOf('--') === 0) ? true : v;
}
if (require.main === module) {
  const n = Number(arg('n', 0));
  if (process.argv.indexOf('--list') >= 0) {
    const rows = listInstances(arg('out', null));
    console.log('实例数=' + rows.length);
    for (const r of rows) console.log('  ' + r.id + '  ua=' + r.ua + '  tz=' + r.tz + '  proxy=' + (r.proxy || 'off') + '  loggedIn=' + r.loggedIn + (r.label ? '  label=' + r.label + '  credits=' + r.credits : ''));
    return;
  }
  let baseModel = null;
  const tf = arg('template-from', null);
  if (tf && typeof tf === 'string' && fs.existsSync(tf)) {
    const d = JSON.parse(fs.readFileSync(tf, 'utf8'));
    baseModel = { id: d.ua.id + '(dola)', label: d.ua.label, os: d.ua.os, browser: d.ua.browser, userAgent: d.ua.userAgent, secChUa: d.ua.secChUa, secChUaFullVersionList: d.ua.secChUaFullVersionList, secChUaPlatform: d.ua.secChUaPlatform, secChUaPlatformVersion: d.ua.secChUaPlatformVersion, secChUaArch: d.ua.secChUaArch, secChUaBitness: d.ua.secChUaBitness, secChUaMobile: d.ua.secChUaMobile, webglVendor: d.javascriptFingerprint.webglVendor, webglRenderer: d.javascriptFingerprint.webglRenderer, hardwareConcurrency: d.javascriptFingerprint.hardwareConcurrency, deviceMemory: d.javascriptFingerprint.deviceMemory, screen: d.screen };
    console.log('模板取自 Dola 真身: ' + tf);
  }
  if (!n) { console.log('用法: node scripts/h3-profile-factory.js --n 5 [--out <dir>] [--proxy <url>] [--proxy-list a,b,c] [--template-from <dola fp.json>] [--list]'); return; }
  const r = makeInstances(n, { out: arg('out', null), proxy: arg('proxy', 'http://127.0.0.1:10090'), proxyList: (function () { const s = arg('proxy-list', null); return (s && typeof s === 'string') ? s.split(',') : null; })(), baseModel: baseModel });
  console.log('已造实例 ' + r.instances.length + ' 个 -> ' + r.outDir);
  for (const i of r.instances) console.log('  ' + i.id + '  ua=' + i.ua + '  tz=' + i.tz + '  proxy=' + (i.proxy || 'off'));
}

module.exports = { UA_MODELS, buildFingerprint, buildProxy, buildInitScript, makeInstances, listInstances, loadFingerprint, loadProxy, proxyToPlaywright };
