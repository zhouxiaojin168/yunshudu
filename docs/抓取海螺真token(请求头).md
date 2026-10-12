# 抓取海螺(kailuo)真 token —— 只从「请求头」抓，别看 localStorage

## 为什么
hailuoai.com 的 `localStorage._token` 现在是 **null**（站点改成只放请求头），
cookie `_token` 也是空。所以浏览器里能拿到的 token **只能是发出去请求的 `token` 请求头**。

## 用法（30 秒）
1. 浏览器登录 https://hailuoai.com 并停在「我的」页
2. F12 → Console → 粘贴下面整段 → 回车（若提示粘贴警告，先输 `允许粘贴`）
3. 点一下页面里的「我的/创作」任意按钮，或直接 **F5 刷新**
4. 控制台出现绿色 `TOKEN=...` 即拿到；把 `TOKEN|uuid|device_id` 三段整条发我

```js
(() => {
  const of = window.fetch;
  window.fetch = function (...a) {
    try {
      const u = a[0] && (a[0].url || a[0]);
      const h = (a[1] && a[1].headers) || {};
      const get = (k) => typeof h.get === 'function' ? h.get(k) : (h[k] || h[k.toLowerCase()]);
      const tok = get('token');
      if (tok && String(u).includes('/v1/api/')) {
        console.log('%cTOKEN=' + tok, 'color:#0a0;font-weight:bold');
        console.log('%cUUID=' + get('uuid'), 'color:#0a0');
      }
    } catch (e) {}
    return of.apply(this, a);
  };
  console.log('hook 已装：去点一下「我的」或 F5 刷新，控制台会打印 TOKEN=');
})();
```

## 拿到后我怎么用
```
POST http://127.0.0.1:9940/pool/accounts
  header: x-admin-key: sk-hl-admin
  body:   {"label":"hailuo-cn-1","token":"<TOKEN>|<uuid>|<device_id>"}
```
不带 `credits` 字段 → 池子会自动**探真钱包**（GET /v1/api/billing/credit），
探通 = 号可用并写入真实贝壳数；探 401 = AUTH_EXPIRED（token 已失效）。

## 判定要点（本轮实测）
- 我们的签名器（scripts/hailuo-sign.js）**已被真上游接受**：请求返回 HTTP 200 + 业务信封
  `{"statusInfo":{"code":1000048}}`，说明 token/yy 签名链路正确，只是 token 本身失效。
- 业务码对照：1000048=AUTH_EXPIRED(换号) / 22=封禁 / 2400026/2400040=贝壳不足(402) / code 0=OK
