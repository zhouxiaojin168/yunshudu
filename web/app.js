/* ===== yunshudu 门户前端 =====
 * 数据源优先级：页面内嵌快照(#snapshot) → 在线实时拉取(同源 /api 或 http://127.0.0.1:3300)
 */
(function () {
  'use strict';

  var SNAP = JSON.parse(document.getElementById('snapshot').textContent || '{}');
  // 数据源：① index.html 里的 window.__API_BASE__ ② 同源 /api 反代 ③ 本地网关
  var LIVE_BASE = (typeof window.__API_BASE__ === 'string' && window.__API_BASE__)
    ? window.__API_BASE__.replace(/\/+$/, '')
    : ((location.protocol === 'http:' || location.protocol === 'https:')
        ? ''                               // 由 serve-web.js 同源代理 /api
        : 'http://127.0.0.1:3300');        // 直接双击打开时，指向本地网关

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var num = function (n, d) {
    if (n == null || n === '' || isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: d == null ? 6 : d });
  };

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return d.toLocaleString('zh-CN', { hour12: false });
    } catch (e) { return iso; }
  }

  /* ---------- render ---------- */
  function render(snap) {
    var s = snap.site || {};
    var name = s.name || 'yunshudu';

    document.title = name + ' · AI 网关';
    $('brandName').textContent = name;
    $('heroName').textContent = name;
    $('footName').textContent = name;
    $('year').textContent = String(new Date().getFullYear());

    var online = !!s.version;
    $('liveDot').className = 'dot' + (online ? '' : ' off');
    $('liveText').textContent = online
      ? (name + ' 在线 · ' + s.version)
      : '离线快照（点"刷新站点数据"试试）';

    if (s.server_address) $('panelBtn').href = s.server_address;

    var modelCount = (snap.models || []).length;
    var chans = snap.channels || [];
    var poolKeys = chans.reduce(function (a, c) { return a + (c.key_count || 0); }, 0);

    $('stats').innerHTML = [
      stat('运行状态', online ? '在线' : '离线快照', s.version || '', true),
      stat('模型数', String(modelCount), (snap.auto_groups || []).join(' / ') || '—'),
      stat('渠道 / 号池', String(chans.length), '池内 key 共 ' + poolKeys + ' 把'),
      stat('额度单位', num(s.quota_per_unit, 0), '1 单位 = ' + num(s.quota_per_unit, 0) + ' quota'),
      stat('USD 汇率', String(s.usd_exchange_rate == null ? '—' : s.usd_exchange_rate), '本币 ' + (s.currency_symbol && s.currency_symbol !== '¤' ? s.currency_symbol : '¥'))
    ].join('');

    $('overviewCards').innerHTML = [
      card('OpenAI 兼容协议', '任何 OpenAI SDK / 客户端把 Base URL 换成本站地址即可用，无需改代码。', ['/v1/chat/completions', '/v1/models'], ''),
      card('多 Key 渠道池', '一个渠道塞 N 把 key，池内轮询；单号失效只踢单号，不牵连整池。', ['multi_to_single', 'polling', '402→401'], 'ok'),
      card('注册与账号', s.register_enabled ? '当前开放自助注册，注册后即可在控制台签发令牌。' : '当前已关闭自助注册，需要管理员开号。', [s.register_enabled ? 'RegisterEnabled = true' : 'RegisterEnabled = false'], s.register_enabled ? 'ok' : 'warn'),
      card('数据来源', '本页快照由 scripts/build-site-json.js 从本地网关抓取；在线时可实时刷新。', [fmtTime(snap.generatedAt)], '')
    ].join('');

    $('curSym').textContent = s.currency_symbol && s.currency_symbol !== '¤' ? s.currency_symbol : '¥';
    $('curRate').textContent = String(s.currency_rate == null ? '—' : s.currency_rate);
    $('qpu').textContent = num(s.quota_per_unit, 0);
    $('usdRate').textContent = String(s.usd_exchange_rate == null ? '—' : s.usd_exchange_rate);

    /* pricing */
    var rows = (snap.models || []).map(function (m) {
      var byCount = Number(m.quota_type) === 1 || (m.model_price && Number(m.model_price) > 0);
      var priceCell = byCount
        ? num(m.model_price, 6) + ' / 次'
        : '倍率 ' + num(m.model_ratio, 4) + (m.completion_ratio ? ' (补 ' + num(m.completion_ratio, 4) + ')' : '');
      return '<tr>' +
        '<td><b>' + esc(m.model_name) + '</b></td>' +
        '<td>' + (byCount ? '<span class="tag ok">按次</span>' : '<span class="tag">按量</span>') + '</td>' +
        '<td class="num">' + priceCell + '</td>' +
        '<td class="mono">' + esc((m.groups || []).join(',') || 'default') + '</td>' +
        '<td class="mono">' + esc((m.endpoints || []).join(',') || 'openai') + '</td>' +
        '</tr>';
    }).join('');
    $('pricingBody').innerHTML = rows || '<tr><td colspan="5" style="color:var(--fg-dim2)">暂无模型（确认网关已启动且已配置模型分组）</td></tr>';

    /* channels */
    var crows = (snap.channels || []).map(function (c) {
      var pool = c.is_multi_key
        ? '<span class="tag ok">池 · ' + c.key_count + ' 把 key</span>'
        : '<span class="tag warn">单 key</span>';
      var st = Number(c.status) === 1 ? '<span class="tag ok">启用</span>' : '<span class="tag bad">禁用</span>';
      return '<tr>' +
        '<td class="mono">' + esc(c.id) + '</td>' +
        '<td><b>' + esc(c.name) + '</b><div class="kv">priority ' + esc(c.priority) + ' · weight ' + esc(c.weight) + ' · auto_ban ' + esc(c.auto_ban) + '</div></td>' +
        '<td class="mono">' + esc(c.base_url) + '</td>' +
        '<td class="mono">' + esc((c.models || []).join(',')) + '</td>' +
        '<td>' + pool + '</td>' +
        '<td>' + st + '</td>' +
        '</tr>';
    }).join('');
    $('channelBody').innerHTML = crows || '<tr><td colspan="6" style="color:var(--fg-dim2)">暂无渠道</td></tr>';

    $('footMeta').textContent = 'snapshot ' + fmtTime(snap.generatedAt) + (s.pricing_version ? ' · pricing ' + String(s.pricing_version).slice(0, 12) : '');
  }

  function stat(k, v, s, small) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div>' +
      '<div class="v' + (small ? ' small' : '') + '">' + esc(v) + '</div>' +
      '<div class="s">' + esc(s || '') + '</div></div>';
  }
  function card(h, p, tags, kind) {
    var t = (tags || []).map(function (x) { return '<span class="tag ' + (kind || '') + '">' + esc(x) + '</span>'; }).join('');
    return '<div class="card"><h3>' + esc(h) + '</h3><p>' + esc(p) + '</p><div class="tagline">' + t + '</div></div>';
  }

  /* ---------- live refresh ---------- */
  function withTimeout(p, ms) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, ms);
    return p(ctl.signal).finally(function () { clearTimeout(t); });
  }

  function fetchJson(url, ms) {
    return withTimeout(function (signal) {
      return fetch(url, { signal: signal, cache: 'no-store' });
    }, ms || 4000).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function refresh() {
    var btn = $('refreshBtn');
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = '拉取中…';

    Promise.all([
      fetchJson(LIVE_BASE + '/api/status', 4000).then(function (j) { return j.data; }),
      fetchJson(LIVE_BASE + '/api/pricing', 4000).catch(function () { return null; })
    ]).then(function (res) {
      var status = res[0] || {};
      var pricing = res[1] || {};
      var next = JSON.parse(JSON.stringify(SNAP));
      next.generatedAt = new Date().toISOString();
      next.site = Object.assign({}, next.site, {
        name: status.system_name || next.site.name,
        version: status.version || next.site.version,
        register_enabled: !!status.register_enabled,
        quota_per_unit: status.quota_per_unit,
        usd_exchange_rate: status.usd_exchange_rate,
        currency_symbol: status.custom_currency_symbol,
        currency_rate: status.custom_currency_exchange_rate,
        server_address: status.server_address || next.site.server_address,
        pricing_version: pricing.pricing_version || next.site.pricing_version
      });
      if (Array.isArray(pricing.data) && pricing.data.length) {
        next.models = pricing.data.map(function (m) {
          return {
            model_name: m.model_name, quota_type: m.quota_type, model_price: m.model_price,
            model_ratio: m.model_ratio, completion_ratio: m.completion_ratio,
            groups: m.enable_groups || [], endpoints: m.supported_endpoint_types || []
          };
        });
        next.auto_groups = pricing.auto_groups || next.auto_groups;
      }
      SNAP = next;
      render(next);
      btn.textContent = '已刷新';
      setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1200);
    }).catch(function (e) {
      btn.textContent = '拉取失败';
      setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1600);
      // 连不上网关时退回离线快照模式（把版本号清空，render 会自动切成"离线快照"）
      if (SNAP.site) SNAP.site.version = '';
      render(SNAP);
      var lt = $('liveText'); if (lt) lt.textContent = '离线快照 · 未连接网关（' + (LIVE_BASE || '同源') + '）';
      console.warn('live refresh failed:', e.message);
    });
  }

  /* ---------- interactions ---------- */
  document.addEventListener('click', function (ev) {
    var tab = ev.target.closest ? ev.target.closest('.tab[data-pane]') : null;
    if (tab) {
      var box = tab.closest('.codebox');
      box.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      box.querySelectorAll('.pane').forEach(function (x) { x.classList.remove('active'); });
      tab.classList.add('active');
      var pane = document.getElementById(tab.getAttribute('data-pane'));
      if (pane) pane.classList.add('active');
      var cp = box.querySelector('.copy');
      if (cp) cp.setAttribute('data-copy', tab.getAttribute('data-pane'));
      return;
    }
    var cp2 = ev.target.closest ? ev.target.closest('.copy[data-copy]') : null;
    if (cp2) {
      var p = document.getElementById(cp2.getAttribute('data-copy'));
      if (!p) return;
      var txt = p.innerText;
      navigator.clipboard.writeText(txt).then(function () {
        var old = cp2.textContent; cp2.textContent = '已复制';
        setTimeout(function () { cp2.textContent = old; }, 1100);
      }).catch(function () {});
    }
  });

  $('refreshBtn').addEventListener('click', refresh);

  render(SNAP);
  // 走 http 打开时自动静默刷新一次（拿最新数据）
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    setTimeout(refresh, 400);
  }
})();