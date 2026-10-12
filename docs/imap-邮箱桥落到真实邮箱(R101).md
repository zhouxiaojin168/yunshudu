# imap-mail-bridge —— 真实邮箱 → mailfarm 同款契约（R101）

## 一句话
把**任何一个标准 IMAP 邮箱**（Spacemail / Gmail / QQ企业邮 / 自建 IMAP）包装成和自建 mailfarm
**完全一致的 HTTP 接口**，于是 `pool-supply` 只改一个 `SUPP_MAIL_API` 就能切换，**注册流程代码一行不改**。

## 为什么需要它
本机/服务器的 **入站 25 端口被机房白名单封死**（实测：防火墙全关、本机 LISTEN 正常，外网仍 ECONNREFUSED）。
而海螺 H3 注册要收邮件验证码。两条出路：
1. 自建收信（要 25 端口）→ **不可行**；
2. **别人代收 + 我们主动去拉**（出站 993/143）→ 本桥走的就是这条。

以 Spaceship 的 **Spacemail** 为例：域名在 Spaceship，买邮箱后 MX 自动配好；
IMAP `mail.spacemail.com:993`（SSL），官方知识库确认 **IMAP/SMTP/POP3 默认开启**。

## 契约（与 mailfarm-server.js 逐字对齐）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康/状态（免鉴权） |
| GET | `/v1/stats` | 同 healthz（需 key） |
| POST | `/v1/mailboxes/acquire` | body `{prefix?}` → `{address, domain}` |
| POST | `/v1/mailboxes/acquire_batch` | body `{n, prefix?}` → `{count, mailboxes}` |
| GET | `/v1/mailboxes/{address}/code?timeout=N` | → `{address, code, found}` |
| GET | `/v1/mailboxes/{address}/messages?limit=N` | → `{address, count, messages}` |

鉴权：请求头 `x-api-key`（`IMB_API_KEY` 为空则不校验）。

## 接进现有流程（零代码改动）
```
# pool-supply 侧只要改这两个环境变量：
SUPP_MAIL_API=http://127.0.0.1:8098
SUPP_MAIL_KEY=<与 IMB_API_KEY 相同>
```
`config/pool-register.mailfarm.json` 里的 `mail-acquire` / `mail-wait` 步骤**原样可用**。

## 本地自测（不需要真邮箱）
```
node scripts/imap-mail-bridge-selftest.js
```
自测会起一个**假 IMAP 服务器**（明文 TCP 18143），喂两封带验证码的邮件（单段 base64 / multipart+QP），
再把桥指向它，按契约打 25 条断言。当前：**PASS=25 FAIL=0**。

## 真实邮箱怎么跑
```
# 1) 填环境变量（照 config/imap-bridge.env.example）
# 2) 起服务
node scripts/imap-mail-bridge.js
# 3) 冒烟
curl -H "x-api-key: <KEY>" "http://127.0.0.1:8098/v1/mailboxes/hl1@qingzhou.autos/code?timeout=5"
```

## 已知边界（诚实清单）
- 本桥**只读**邮箱（默认用 `BODY.PEEK[]`，不改服务器已读状态；`IMB_MARK_SEEN=1` 才标记已读）。
- 依赖邮箱侧 IMAP 可用；若对方关掉 IMAP（Spacemail 可在后台关），本桥立刻失效。
- 收件人匹配按 `Delivered-To` / `X-Original-To` / `To` / `Cc` 头做子串匹配；
  若上游服务商把 To 改写掉，需要 `IMB_ALLOW_ANY=1` 兜底（会变成「只要有新信就算命中」，多别名并发时不安全）。
- 未做 IMAP IDLE：靠轮询（默认 3s）。够用，但不是毫秒级。
- 明文模式（`IMB_TLS=0`）**只给自测用**；生产必须 `IMB_TLS=1`。

## 修掉的一个真 bug
首轮自测 18/25：单段（非 multipart）邮件的正文没有解码，因为 `collectText` 只拿到了「已剥掉头的 body」，
看不到 `Content-Transfer-Encoding: base64`。修法：改为对**整封原文**调用 `collectText`，让头参与解码判断。
（同样的坑在 mailfarm-server.js 的 raw 解析路径里也在，后续可一并修。）
