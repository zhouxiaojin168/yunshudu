/**
 * hailuo-console-snippet.js -- 抓一次真实的「创作视频」请求（在浏览器 Console 里跑）
 * 用法：打开 https://hailuoai.video/ （已登录）→ F12 Console → 输入「允许粘贴」→ 粘贴下面整段 → 去点一次「创作视频」→ 把 [CAPTURE] 输出发我
 */
(function () {
  const tag = '%c[CAPTURE]';
  const style = 'color:#0a0;font-weight:bold';
  const log = (kind, url, method, headers, body) => {
    console.log(tag + ' ' + kind + ' ' + (method || '') + ' ' + url, style);
    try { console.log('headers=', JSON.stringify(headers)); } catch (e) {}
    console.log('body=', body);
  };
  const scrub = (h) => {
    const o = {};
    try { new Headers(h).forEach((v, k) => { o[k] = /token|yy/i.test(k) ? String(v).slice(0, 20) + '…(' + String(v).length + ')' : v; }); } catch (e) {}
    return o;
  };
  const of = window.fetch;
  window.fetch = function () {
    try {
      const a = arguments, u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url);
      const init = a[1] || {};
      if (/generate\/(video|image|audio)/.test(u || '')) log('FETCH', u, init.method || 'GET', scrub(init.headers), init.body);
    } catch (e) {}
    return of.apply(this, arguments);
  };
  const oo = XMLHttpRequest.prototype.open, ss = XMLHttpRequest.prototype.send, sh = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; this.__h = {}; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { this.__h[k] = /token|yy/i.test(k) ? String(v).slice(0, 20) + '…(' + String(v).length + ')' : v; } catch (e) {} return sh.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) { try { if (/generate\/(video|image|audio)/.test(this.__u || '')) log('XHR', this.__u, this.__m, this.__h, b); } catch (e) {} return ss.apply(this, arguments); };
  console.log('%c已挂钩：现在去点一次「创作视频」（或生视频/Agent 出片），生成的请求会打在这里。', 'color:#0a0;font-weight:bold');
})();
