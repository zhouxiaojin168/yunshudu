# mailfarm 落地实录（R95）：Node 版 + 服务器部署 + 25 端口封锁实测

时间：2026-10-12 | 目标机：自有服务器 `114.66.16.225`（Windows Server 2012 R2）

---

## 一、做了什么

| # | 动作 | 状态 |
|---|---|---|
| 1 | 写**零依赖 Node 版** mailfarm（`scripts/mailfarm-server.js`），端点/字段/SMTP banner 与线上实测一致 | ✅ |
| 2 | 新增 `POST /v1/ingest`（收整封原文 raw，自动解析 MIME + 提码）——**不需要 25 端口**的收信通道 | ✅ |
| 3 | pool-supply 接入邮箱补号：`type=mail-acquire` / `type=mail-wait` | ✅ |
| 4 | `services.json` 注册 `mailfarm` 服务（端口 8099），随部署自动建计划任务 | ✅ |
| 5 | 服务器实测：任务 Running、8099 监听、healthz/401/acquire/ingest/取码 全通 | ✅ |
| 6 | 25 端口能否落地：**实测被机房白名单封锁** | ❌ 需工单 |
| 7 | DNS 记录落地：**需要自有域名**（当前没有） | ⏳ 待域名 |

## 二、服务器实测证据（原始输出摘要）

**任务状态**
~~~
yunshudu-deploy=Ready   yunshudu-edge=Running       yunshudu-h3pool=Running
yunshudu-mailfarm=Running  yunshudu-new-api=Running  yunshudu-pool-supply=Running
yunshudu-portal=Running yunshudu-tunnel=Running    yunshudu-tunnel-watch=Running
~~~

**监听**：`TCP 0.0.0.0:8099 LISTENING 3928`

**/healthz**
~~~json
{"ok":true,"version":"0.1.0","store":"memory","domains":["allen23.online","jixuwz.com","lopwi.cyou","sghd.college","ytu.baby"],"uptime_s":10.2}
~~~

**鉴权**：`/v1/stats` 无 key -> `HTTP 401 {"detail":"bad api key"}`；带 key -> 200（含 `smtp_enabled:false`）

**收发闭环**（服务器本机）
~~~
acquired = srv7751a04b2b@allen23.online
ingest   -> codes = 246810
/code    -> 246810 found=True
~~~

**pool-supply 已认到邮箱补号**
~~~
[..] 邮箱补号已就绪 mailfarm=http://127.0.0.1:8099 prefix=hl
~~~

**mailfarm 启动日志**
~~~
mailfarm 0.1.0 (node) starting
HTTP listening on http://0.0.0.0:8099
api_key enabled | ingest_key enabled
SMTP disabled (MF_SMTP_ENABLE=0) -> 只走 POST /v1/ingest
~~~

## 三、25 端口的对照实验（结论：机房封锁，非本机问题）

| 实验 | 结果 |
|---|---|
| Windows 防火墙三档 | **全关** |
| 本机起 25 监听 | `LISTEN_25=True` |
| 外网连 25 ×6 | 全 **ECONNREFUSED**，服务端 0 命中 |
| 换 2525 再试 | 本机 `LISTEN_2525=True`，外网 4 次全 **ECONNREFUSED** |
| 外网可达端口 | 仅 `80`(被劫持) `3000` `8080` `3389` `5985` `8899` |

→ 机房**端口白名单**。要「MX 直指本机:25 收信」必须找 IDC 解封（国内通常还要备案）。

**替代方案（已写好代码）**：`deploy/cloudflare/email-worker.js` ——
Cloudflare Email Routing Catch-all → Worker → `POST /v1/ingest`，**全程不需要 25**。
外部可达性走已有 cloudflared 隧道，绕开机房白名单。

## 四、要正式上线，只差两样

1. **一个自有域名**（买 TLD 后加 3 条记录，用 `node scripts/mailfarm-dns-check.js 你的域` 自检）：

| 类型 | 名称 | 值 |
|---|---|---|
| `MX` | `@` | `mail.你的域`（优先级 10） |
| `A` | `mail` | 期望收信机 IP（走 CF 的话由 CF 托管 MX） |
| `TXT` | `@` | `v=spf1 -all` |

2. **外部能访问 `/v1/ingest`**：
   - 方式 B（推荐，免 25）：CF Email Routing → Worker → 隧道域名
   - 方式 A：IDC 解封 25，MX 直指本机

## 五、自检命令（可复现）

~~~powershell
# 本地：端点形状 + CM Worker 通道（19 项）
node scripts\mailfarm-selftest.js            # PASS=19 FAIL=0
# 本地：取邮箱->上游发码->取码->注册->入池（8 项）
node scripts\mailfarm-register-e2e.js        # PASS=8  FAIL=0
# 域名体检（买到域后跑）
node scripts\mailfarm-dns-check.js 你的域
~~~

## 六、运营方域名 DNS 实测（顺带产出）

跑 `mailfarm-dns-check.js` 复核线上 5 个收信域：

| 域 | MX | A | SPF |
|---|---|---|---|
| allen23.online | mail.allen23.online | 45.207.214.211 | v=spf1 -all |
| jixuwz.com | mail.jixuwz.com | 45.207.214.211 | **缺失** |
| lopwi.cyou | mail.lopwi.cyou | 45.207.214.211 | v=spf1 -all |
| sghd.college | mail.sghd.college | 45.207.214.211 | v=spf1 -all |
| ytu.baby | mail.ytu.baby | 45.207.214.211 | v=spf1 -all |

→ 5 域共用**同一台收信机**；`jixuwz.com` 是「品牌主域」没配 SPF，其余 4 个是「消耗域」配了只收不发。
