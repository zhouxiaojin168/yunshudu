# CF 收信链路修复记录（R144aj ~ R144bd）

## 1. 现象
- CF Email Routing 活动日志：真信显示「送达失败」（qq.com -> hlrealtest@/qingzhou01@qingzhou.autos）
- 我方 mailfarm 日志里**一条 INGEST 记录都没有** -> 信根本没到服务器

## 2. 排查（全部实测）
| 检查 | 结果 |
|---|---|
| 本机 POST http://114.66.16.225:8099/v1/ingest | 200（x-ingest-key 正确）|
| 境外 8 节点 TCP 8099/8080（check-host.net）| 全部可达（无 geo 封锁）|
| 隧道 443 `...trycloudflare.com/mailfarm/...` | 200 |
| 服务器自投（SMTP route1.mx.cloudflare.net:25）| `421 4.3.0 Upstream error` —— 复现成功 |
| 线上 Worker 内容/变量（CF API 拉取）| v2 代码 + INGEST_URL/INGEST_KEY 均已配置 |
| catch-all 规则 | enabled，actions=[{type:worker,value:[yunshudu-ingest]}] |

## 3. 根因（A/B 实验定论）
把 Worker 的 `INGEST_URL` 从 `http://114.66.16.225:8099/v1/ingest` 换成
`https://<隧道域名>/mailfarm/v1/ingest` 后：
- CF 收信 `250 2.0.0 Ok`（不再 421）
- 我方日志 `INGEST 200 src=2a06:98c0:3600::103`（Cloudflare 出口 IP）

=> **Cloudflare Worker 的 fetch 无法访问「IP 字面量 + 8099 非标端口」，但可以访问 443 上的域名。**

## 4. 修复内容
1. `scripts/mailfarm-server.js` -> **0.2.0**
   - `/v1/ingest` 增加取证日志：`INGEST 200/401/400 src=… ua=… to=… codes=[…]`
   - MIME 正文解析升级：折叠头展开、RFC2047(B/Q) 主题与地址解码、多部分递归、
     base64 / quoted-printable、字符集（utf-8 / gb18030 / big5，TextDecoder）
   - ingest 侧：只要有 `raw` 就优先用解析结果（原实现把整封原文当正文存了）
   - 取码 `extractCodes`：过滤年份(19xx/20xx)、全同数字(0000/1111)、日期相邻数字
2. `deploy/cf-email-worker-ingest.js` -> **v3**
   - 邮件路径同 v2；新增 fetch 自检入口 `/__selftest?k=<INGEST_KEY>`
     （返回 CF 各出口到每个候选地址的真实结果）
   - `INGEST_URL` + `INGEST_URLS` 多候选回退、单跳 8s 超时、401 抛错、其余 4xx 仅 WARN
3. `deploy/cf-ingest-sync.js` + 计划任务 `yunshudu-cf-ingest-sync`（每 5 分钟）
   - 读 `state/tunnel-url.txt` 与线上 Worker 绑定比对，不一致就自动改绑（幂等；无变更不写）
   - 自愈实测：把 INGEST_URL 故意写成 `http://127.0.0.1:1/BROKEN` -> 18 秒后 `SYNCED 200` 修回

## 5. 当前定值
- Worker: `yunshudu-ingest`（account 6d9ea976a763336b37059a5008a246e6）
- `INGEST_URL` = `https://<隧道域名>/mailfarm/v1/ingest`
- `INGEST_URLS` = 上者, `http://114.66.16.225:8099/v1/ingest`（备用；CF 出站打不通，仅留作兼容）
- `INGEST_KEY` = secrets.txt 的 `MAILFARM_INGEST_KEY`（Encrypt 存储）
- 服务器 CF token: `C:\yunshudu\secrets\cf-token.txt`（ACL 仅 SYSTEM/Administrators）

## 6. 遗留 / 建议
- **quick tunnel 不稳定**：trycloudflare 域名会变（已被 sync 任务兜住），也非长期方案。
  建议升级为**命名隧道 + 固定域名** `ingest.qingzhou.autos`（443，CF 原生域名），
  需要额外权限 `Account: Cloudflare Tunnel: Edit`（或在 Zero Trust 面板建一次隧道）。
- 若日后要让 CF 直连机房（不走隧道），需用 CF **支持的源站端口**(如 8080) + 域名 + Origin Rule 改端口。
---

## 7. 命名隧道落地（R144bs ~ R144bw，已完成）
- 隧道：`yunshudu-ingest`，id `897e926d-e0c8-4cde-93a5-9f75c1452533`，`config_src=cloudflare`，status=**healthy**
- ingress：`ingest.qingzhou.autos` → `http://127.0.0.1:8099`（其余 404）
- DNS：`ingest.qingzhou.autos` CNAME → `897e926d-….cfargotunnel.com`，**proxied**
- 服务器：`C:\yunshudu\bin\cloudflared.exe service install <token>` → Windows 服务 `Cloudflared`（Running / Automatic）
- Worker 绑定（由 `cf-ingest-sync` 自动改绑）：
  - `INGEST_URL`  = `https://ingest.qingzhou.autos/v1/ingest`
  - `INGEST_URLS` = 固定域名, quick tunnel, `http://114.66.16.225:8099/v1/ingest`
- 自愈升级：`state\cf-ingest-fixed.txt` 存在时**固定域名优先**，quick tunnel 降级为回退；
  实测两次运行：`SYNCED 200 -> https://ingest.qingzhou.autos/v1/ingest` → 再跑 `OK unchanged`（幂等）
- 验证：`GET https://ingest.qingzhou.autos/healthz` → 200 `{"version":"0.3.1"}`；
  `POST https://ingest.qingzhou.autos/v1/ingest` → 200 `{"ok":true,"codes":["778899"]}`

## 8. 权限清单（最终需要）
| 用途 | 权限 |
|---|---|
| 上传/改绑 Worker | Account → Workers Scripts → **Edit** |
| 读 Worker 绑定/日志 | Account → Workers Tail → Read |
| 改 catch-all | Zone → Email Routing Rules → **Edit** |
| 建 ingest CNAME | Zone → DNS → **Edit** |
| 解析 zone | Zone → Zone → Read |
| 建命名隧道 | Account → Cloudflare Tunnel → **Edit** ← 最后补的这条 |
