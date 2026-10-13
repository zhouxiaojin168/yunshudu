# 自建域收信 · Cloudflare 转发落地读码（R144q）

- 日期：2026-10-14
- 目标：`qingzhou.autos` 只有 Cloud Identity 免费版（**无 Gmail**）⇒ 走 **Cloudflare Email Routing 免费 catch-all**，把任意 `xxx@qingzhou.autos` 转发到一个**固定邮箱**；号厂必须能**自动读到**那封邮件里的验证码。

---

## 1. 设计：两张"表" + 一个读分支

| 位置 | 改动 |
|---|---|
| `scripts/mailfarm-server.js` | ① `parseMessage` 捕获原始收件人头 `To:` / `Delivered-To:` / `X-Original-To:` / `X-Forwarded-To:` / `X-Cloudflare-*` ② `deliver()` 增参 `extra`，把 `to` / `delivered_to` 落到消息 ③ `messages()` 投影带上 `to` / `delivered_to` |
| `scripts/mail-compat-server.js` | ① `CFG.forwardMap`（env `COMPAT_FORWARD_MAP`）② `CFG.forwardBase`（env `COMPAT_FORWARD_BASE`）③ `forwardOf` / `fwdMatch` / `fwdFetch` / `handleForwardedRead` ④ 4 个端点接转发分支 ⑤ `/v1/channels` 额外返回 `forward_map` |

### 环境变量

| 变量 | 含义 | 示例 |
|---|---|---|
| `COMPAT_FORWARD_MAP` | `域=固定邮箱`，逗号分隔可多条 | `qingzhou.autos=qz@jixuwz.com` |
| `COMPAT_FORWARD_BASE` | 转发读信的**上游基址**（默认 = `COMPAT_UPSTREAM`）。跨机时指向真正收信的 mailfarm | `http://127.0.0.1:8099` |

### 读分支规则
- 地址域名命中 `COMPAT_FORWARD_MAP` → 改从**固定邮箱**读信，再按**原始收件人**过滤
- 命中判定：`to` / `delivered_to` / `rcpt` 任一包含目标地址即算命中；**上游没给原始收件人时不过滤（宁多勿漏）**
- 覆盖端点：`/v1/mailboxes/{addr}/messages`、`/v1/mailboxes/{addr}/code`、`/api/mails`、`/api/mails/{id}`

---

## 2. 本地端到端实测（R144q，2026-10-14 02:05）

- 隔离实例：mailfarm `8198`（关 SMTP、内存态、只服务 `jixuwz.com`）+ mail-compat `8199`
- **故意把 `COMPAT_UPSTREAM` 指向空端口 `8197`**，把 `COMPAT_FORWARD_BASE` 指向 `8198` ⇒ 证明转发读信确实走 FORWARD_BASE（不是碰巧读到了别的上游）
- 造一封"Cloudflare 转发形状"的信：信封收件人 = `hlcatch144q@jixuwz.com`，**正文头保留 `To: hlq144q@qingzhou.autos`**，正文含 `654321`

| 检查项 | 结果 |
|---|---|
| `POST /v1/ingest` | `{"ok":true,"codes":["654321"]}` |
| mailfarm 直读 messages | `count=1`，消息带 `to=hlq144q@qingzhou.autos` |
| `GET /v1/channels` | `forward_map={"qingzhou.autos":"hlcatch144q@jixuwz.com"}` |
| `GET /v1/mailboxes/hlq144q@qingzhou.autos/messages` | `count=1 via=forward` ✅ |
| `GET /v1/mailboxes/hlq144q@qingzhou.autos/code` | `found=true code=654321` ✅ |
| `GET /api/mails` / `/api/mails/1` | `count=1` / `code=654321 found=true` ✅ |
| 反例 `others999@qingzhou.autos` | `count=0` ✅ |

脚本：`E:\中转站测试\_ops\r144q-fwd-test.ps1`（跑完自动停掉临时实例）

---

## 3. 上线要做的两件事

1. **服务器 mail-compat 环境变量**（`C:\yunshudu\app\services.json`）：
   - `COMPAT_FORWARD_MAP=qingzhou.autos=<固定邮箱>` ← 固定邮箱必须落在 mailfarm 服务的域下
   - `COMPAT_FORWARD_BASE=http://127.0.0.1:8099`（同机即默认；跨机填真收信那台）
2. **Cloudflare**：Email Routing → Destination addresses 加这个固定邮箱 → 去该邮箱点**验证链接**（验证邮件会进 mailfarm，可用 API 读出来）→ 再打开 Catch-all

---

## 4. 文件与备份

- `scripts/mailfarm-server.js`、`scripts/mail-compat-server.js`
- 改动前备份：`scripts/mailfarm-server.js.bak-20261014-015710`、`scripts/mail-compat-server.js.bak-20261014-015710`
- 补丁脚本：`E:\中转站测试\_ops\r144q-patch-forward-map.js`（幂等，重复执行会 SKIP）

---

## 5. 边界（诚实）

- 过滤是"包含匹配"：同一固定邮箱混放多个收件人的信时按目标地址串匹配；地址彼此不为子串时不会误判。
- **Cloudflare 是否保留原始 `To:` 头本轮未实测**（官方行为是保留原文头）。若不保留，`fwdMatch` 会退回"不过滤"模式（取该邮箱最新信）；届时可用 `Delivered-To` / `X-Forwarded-To` 兜底。
- 本次只在**隔离端口**自测，**未动**本机与线上正在运行的生产实例（本机 mailfarm/mail-compat 仍需重启才会加载新代码）。