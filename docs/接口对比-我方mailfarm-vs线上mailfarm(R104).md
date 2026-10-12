# 代码/契约对比：我方 mailfarm vs 线上 mailfarm（R104）

实测时间 2026-10-12 ｜ 全部**只读 GET**（对第三方零写入）

## 0. 被测对象与存活状态

| 主机 | 端口探测结果 | 说明 |
|---|---|---|
| `45.207.214.163` | **22=OPEN，其余 25/80/443/3000/8080/8099/8899/9940 全部 TIMEOUT（被丢包）** | 中转站 `:3000` **已下线**，抓不到它的前端代码 |
| `45.207.214.211` | 22=OPEN、**25=OPEN**、8099=OPEN | **邮箱农场节点①**（5 个域） |
| **`45.207.214.98`** | 22=OPEN、**25=OPEN**、8099=OPEN | **邮箱农场节点②（新发现）**，只服务 `761231.xyz` |

## 1. 结论一句话

**收信那一层「就是这套」——同一份接口契约；但实现语言不同（他 Python/FastAPI，我们零依赖 Node），且我们比他多一个免 25 的入口。**
中转站 `:3000` 那一层（New API）已经下线，无法抓代码；不过 New API 是开源件，我们服务器上跑的是同一套。

## 2. 身份指纹（逐字段对比）

| 项 | 线上（`.211:8099` / `.98:8099`） | 我方（`mailfarm-server.js`） |
|---|---|---|
| HTTP Server 头 | `uvicorn` | 无（Node `http`） |
| Swagger title | `mailfarm` | `mailfarm` |
| version | `0.1.0` | `0.1.0` |
| store | `memory` | `memory` |
| `/docs` | 200（Swagger UI） | 无 |
| `/openapi.json` | **200**（本次就是靠它拿到完整接口清单） | 无 |

`GET /healthz` 逐字对比：
```
线上 : {"ok":true,"version":"0.1.0","store":"memory","domains":[...],"uptime_s":20719.9}
我方 : {"ok":true,"version":"0.1.0","store":"memory","domains":[...],"uptime_s":N}   ← 同字段
```

## 3. 端点逐条对比（来自线上 `/openapi.json` 实测）

| 线上 | 我方 | 一致？ |
|---|---|---|
| `GET /healthz` | ✅ 同名 | ✅ |
| `POST /v1/mailboxes/acquire`（`AcquireBody{prefix?,domain?}`） | ✅ 同名同参 | ✅ |
| `POST /v1/mailboxes/acquire_batch`（`AcquireBatchBody{n=10,prefix?}`） | ✅ 同名同参同默认值 | ✅ |
| `GET /v1/mailboxes/{address}/code` | ✅ 同名 | ✅ |
| `GET /v1/mailboxes/{address}/messages` | ✅ 同名 | ✅ |
| `GET /v1/stats` | ✅ 同名；无 key 双方都 `401 {"detail":"bad api key"}`（**逐字相同**） | ✅ |
| **`GET/POST /v1/domains`**（`DomainAddBody{domains:[str]}`） | ❌ 原来没有 → **本次已补齐** | ✅（已对齐） |
| — （线上没有） | `POST /v1/ingest`（我方自加：免 25 端口的收信入口） | ➕ 增量 |
| — （线上没有） | `GET /v1/public/stats`、`GET /`（HTML 概览） | ➕ 增量 |
| `GET /` / `/index.html` / `/metrics` / `/v1/public/stats`（线上） | — | 线上全部 **404** |

## 4. 本次新发现：他们在「按域拆节点」扩张

`761231.xyz`（线上第 6 个收信域）实测：

| 项 | 值 | 含义 |
|---|---|---|
| NS | `memphis.ns.cloudflare.com` / `sreeni.ns.cloudflare.com` | **Cloudflare 托管 DNS**（其余 5 个域是 Spaceship 的 `launch*.spaceship.net`） |
| MX | `mail.761231.xyz` | 自建收信 |
| `mail.761231.xyz` A | **`45.207.214.98`** | 专用收信机（**与 .211 分开**） |
| apex A | `45.207.214.98` | 同机 |
| TXT | `v=spf1 -all` | 只收不发（和其它域一致） |

即：**新域 = 新 IP + 新 mailfarm 实例 + CF 托管 DNS**。这正好印证「收信层可以横向复制”，也说明**用 Cloudflare 管域是行得通的**（我方路线 A/B 的先例）。

## 5. 本次已补齐的差异（代码改动）

- `scripts/mailfarm-server.js`：新增 `/v1/domains`（`GET` 列出、`POST` 追加，`x-api-key` 校验，运行时生效，内存态）。
  - 追加成功后**立即可收信**（`deliver()` 读的是同一个 `CFG.domains`）。
- `scripts/mailfarm-selftest.js`：新增 4 条断言（列表 / 无 key 401 / POST 追加 / 新增域立即可收信）。
- 自测：**PASS=23 FAIL=0**（原 19 条 → 23 条）。

## 6. 仍然存在的差异（有意保留）

| 差异 | 原因 |
|---|---|
| 我们多 `POST /v1/ingest` | 机房封 25，必须留一条「别人代收 → 我推给我」的入口 |
| 我们多 `/`、`/v1/public/stats` | 运维可读性 |
| 他们没有 `/docs` 之外的运维面 | 与我们无关 |
| 持久化 | **双方都是 `store=memory`** —— 重启即丢。生产要换 Redis/SQLite |

## 7. 对我们落地的意义

1. **契约已被证明是「行业通用形态」**：只要 pool-supply 按这套打，换任何一家实现都不用改代码。
2. **IMAP 桥是对这份契约的等价替换**（同样 `/acquire` + `/code`），所以爷爷无论选哪家邮箱，注册流程都不用改。
3. 他们**按域拆节点 + CF 管域** 的做法说明：`qingzhou.autos` 想升级成生产规模，照抄这个拓扑就行。
