# 对照表：实测 mailfarm（45.207.214.211:8099） vs 本地自建实现

勘查时间：2026-10-11 | 本地实现：`E:\中转站测试\mailfarm` | 自测：`tests/smoke.py` → PASS=14 FAIL=0

## 0. 身份对比

| 项 | 实测（线上） | 本地实现 |
|---|---|---|
| Swagger title | `mailfarm` | `mailfarm`（`MF_SERVICE_NAME`） |
| version | `0.1.0` | `0.1.0` |
| store | `memory` | `memory` |
| 框架指纹 | FastAPI + uvicorn | FastAPI + uvicorn |
| `/docs` | 200 Swagger | 200 Swagger |
| `/openapi.json` | 200（已存档 `r90-pool-recon\mailfarm\openapi.json`） | 200 |

> 实测 openapi 的 `components.schemas` 字段名 = `AcquireBody{prefix,domain}` / `AcquireBatchBody{n(default 10),prefix}`，本地 `api.py` 的 pydantic 模型**同名同字段同默认值**。

## 1. 端点逐条对齐

| 方法+路径 | 实测参数 | 实测返回 | 本地返回 |
|---|---|---|---|
| `GET /healthz` | （公开，无需 key） | `{"ok":true,"version":"0.1.0","store":"memory","domains":[...],"uptime_s":N}` | **同字段** |
| `POST /v1/mailboxes/acquire` | header `x-api-key`(可选) + body `AcquireBody` | `{address,domain,expires_at}` | **同** |
| `POST /v1/mailboxes/acquire_batch` | body `AcquireBatchBody`（n 默认 10） | 批量地址 | `{count,mailboxes:[...]}` |
| `GET /v1/mailboxes/{address}/code` | `timeout` 0..120 | `{address,code,found}` | **同** |
| `GET /v1/mailboxes/{address}/messages` | `limit` 1..200 | 信件列表 | `{address,count,messages:[...]}` |
| `GET /v1/stats` | header `x-api-key` | 需 key（无 key→401） | 无 key→`401 {"detail":"bad api key"}` |

## 2. 鉴权行为对齐（实测铁证）

| 场景 | 实测 | 本地 |
|---|---|---|
| `GET /v1/stats` 不带 key | `401 {"detail":"bad api key"}`（**逐字**） | `401 {"detail":"bad api key"}` |
| `GET /healthz` | 公开 200 | 公开 200 |
| acquire 是否强制 key | 实测**未强制**（可选 header） | 默认不强制，`MF_REQUIRE_KEY_ON_ACQUIRE=1` 才强制 |

## 3. SMTP 指纹对齐（实测铁证）

| 项 | 实测 | 本地 |
|---|---|---|
| 欢迎 banner | `220 mailfarm mailfarm` | `220 mailfarm mailfarm`（`_FarmSMTP(hostname=ident=mailfarm)`） |
| EHLO 扩展 | `250-SIZE 33554432` / `250-8BITMIME` / `250 HELP` | `data_size_limit=33554432` + `enable_SMTPUTF8=True` |
| 开放端口 | **仅 25**（110/143/465/587/993/995 全拒） | 仅 SMTP 一端口 |
| 语义 | 只收不发（SPF `v=spf1 -all`） | 纯收信，无出站 |

## 4. 域名与投递语义

| 项 | 实测 | 本地 |
|---|---|---|
| 收信域（实测 healthz 原文） | `allen23.online`,`jixuwz.com`,`lopwi.cyou`,`sghd.college`,`ytu.baby` | 由 `MF_DOMAINS` 指定（自测用 `allen23.online,ytu.baby`） |
| 分配方式 | acquire 从域池挑 | 轮询（round-robin） |
| catch-all | 是（任意 local-part 都收） | 是（`deliver()` 对已知域自动建箱） |
| 地址形态 | `<prefix><rand>@<domain>` | `<prefix><10位rand>@<domain>` |

## 5. 验证码提取

本地 `codes.py` 优先级：

1. 关键词 + 数字（验证码/校验码/verification code/verify code/login code/security code/one-time code|password/otp/認証コード/인증 번호）
2. 关键词 + 字母数字混合
3. 通用 4~8 位数字（前后不接数字）
4. 通用 5~8 位大写字母数字（低优先级，仅当不含数字时才放宽纯字母）

**关键修正**：主题与正文**分开扫**，且 `_is_code()` 要求「含数字」或「全大写纯字母 ≥5 位」，避免 `subject="Login code"` + `body="Your ..."` 跨边界误抓成 `Your`。（自测第 12 条：英文 one-time password → `A7K9Q2`）

## 6. 自测 14 条断言（smoke.py）

| # | 断言 | 结果 |
|---|---|---|
| 1 | 启动 /healthz | PASS |
| 2 | /healthz 返回 domains 清单 | PASS |
| 3 | /healthz store=memory | PASS |
| 4 | acquire 返回地址 | PASS |
| 5 | acquire 前缀生效 | PASS |
| 6 | acquire_batch n=3 | PASS |
| 7 | 取到验证码 483920 | PASS |
| 8 | messages 可读且带 codes | PASS |
| 9 | stats 无 key → 401 | PASS |
| 10 | stats 带 key → 200 | PASS |
| 11 | 无码时按 timeout 返回 found=false（~2.0s） | PASS |
| 12 | 英文 one-time password 抽取 = A7K9Q2 | PASS |
| 13 | 未知邮箱 → 404 | PASS |
| 14 | openapi 端点齐全（7 条，含 `/`） | PASS |

## 7. 生产前必须补的（本地未做）

- 持久化存储（Redis/SQLite）替换内存 dict
- 限速/配额与来源校验（防被白嫖）
- DKIM/退信（若将来需要发信）
- 池健康度指标进 `/v1/stats`
- 与注册机对接：`pool-supply` / 注册机拿到 `address` 后轮询 `/code?timeout=…`
