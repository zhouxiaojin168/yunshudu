# Cloudflare Email Routing → Worker → 我方 /v1/ingest 接入（R144z）

- 日期：2026-10-14
- 前置结论：R144y 已把 5 个**外来域**剔除；mailfarm 自有收信域默认留空 `MF_DOMAINS=""`（因为没有一个是「MX 真指向我方」的）
- 目标：给爷爷一个**零成本、可批量、无需 25 端口、无需 destination 邮箱验证**的收信面，把「任意 xxx@自有域」的信落到我方 mailfarm

---

## 1 链路（唯一投产形态）

```
任意 xxx@自有域
  → Cloudflare Email Routing（catch-all，MX = route1/2/3.mx.cloudflare.net）
  → Email Worker（deploy/cf-email-worker-ingest.js）
  → POST http://114.66.16.225:8099/v1/ingest （header: x-ingest-key）
  → mailfarm 落库 state/mailfarm/mailfarm.jsonl
  → GET /v1/mailboxes/{addr}/code 或 /api/mails?email=  取码
```

**为什么走 Worker 而不是转发到固定邮箱**：CF 的 destination=邮箱必须**点验证链接**；邮箱不是自己的就永远验不过（或被别人点掉 → 你域全部邮件静默转发给他）。Worker 路线不需要 destination。

---

## 2 生产侧最后一段：**已实测通过**（本轮，公网路径）

从本机打公网 `http://114.66.16.225:8099`（等同 Worker 的视角）：

| 用例 | 结果 |
|---|---|
| `POST /v1/ingest` 带正确 `x-ingest-key`，`to=hlcf144y@localhost` | `200 {"ok":true,"address":"hlcf144y@localhost","codes":["135790"]}` ✅ |
| `GET /v1/mailboxes/hlcf144y@localhost/code` | `{"code":"135790","found":true}` ✅ |
| `GET /v1/mailboxes/hlcf144y@localhost/messages` | `count=1`，含 `to` / `delivered_to`（R144q 加的原始收件人字段）✅ |
| `POST /v1/ingest` 错 key | `401` ✅ |
| `POST /v1/ingest` 域不在 `MF_DOMAINS` | `400 domain not served (add it to MF_DOMAINS)` ✅（**这是设计闸门，不是 bug**）|

脚本：`E:\中转站测试\_ops\r144z-live-ingest-e2e.ps1`

⚠️ **关键约束**：`/v1/ingest` 只接受 `MF_DOMAINS` 里列出的域。所以 **CF 路由的每个域/子域都必须写进 `MF_DOMAINS`**（用 `scripts/add-maildomain.js --write` 一条命令搞定）。

---

## 2.5 ★ 重要更正（R144z 复查 CF 官方文档）

> 原计划里的「CF 转发挂子域」——**这条是错的**，必须更正。

CF 官方《Email routing rules and addresses》原文：

> Each entry is either a literal recipient address (for example, `support@example.com`), which creates a routing rule for that address, or a `*@domain` catch-all (for example, `*@example.com`), which configures the catch-all rule for that domain. **Catch-all entries support apex domains only.** To route mail sent to an Email Routing subdomain, list each literal recipient address, such as `support@mail.example.com`.

即：**catch-all（任意地址）只能挂在 apex 域上**；子域虽然能收，但必须逐个列出**字面地址**。
号池要的是「随机 `hlxxxx@域` 都能收」⇒ **子域路线不可行**。

于是只剩三条正确路线：

| 路线 | 做法 | 成本 | 代价 |
|---|---|---|---|
| **1（0 成本，最快）** | 把 **apex `qingzhou.autos` 的 MX 从 Google 换成 CF** → 开 Email Routing catch-all → Worker | 0 | Google 侧收信停（实测 RCPT 全 550，**当前无任何在用信箱**，实际无损失）；`COMPAT_BRIDGE_DOMAINS` 里的 `qingzhou.autos` 要摘掉，改走 mailfarm 通道 |
| **2（推荐，可批量）** | **新买域**，apex 直接交给 CF → 每域一个 catch-all → Worker | 每域 $1~11/年 | 这才是上游那套「5 个域」的真正原因：**一个域 = 一个 catch-all**，多域还能分摊风控 |
| **3（保留 Google）** | apex 保持 Google，另用新域做 CF 路由 | 同 2 | `qingzhou.autos` 不出现在 catch-all 里 |

> 结论修正：**「用子域省钱」作废**；要扩收信域就得买域（或把 apex 交出去）。

---

## 3 爷爷要做的事（二选一）

### 路线 甲：给 token，全自动（推荐）
Cloudflare Dashboard → My Profile → API Tokens → Create Token → **Custom token**，权限：
- `Zone → DNS → Edit`（限 `qingzhou.autos`）
- `Zone → Email Routing Rules → Edit`
- `Account → Workers Scripts → Edit`（要自动部署 Worker 才需要）
拿到后发我，我用 `scripts/add-maildomain.js --cf-token … --cf-routing --cf-worker yunshudu-ingest --cf-apply` 一把配好并留证。

### 路线 乙：自己在面板点（我给准值）
1. **建 Worker**：Workers & Pages → Create Worker → 名字 `yunshudu-ingest` → 粘贴 `deploy/cf-email-worker-ingest.js` → Deploy
2. **配变量**：该 Worker → Settings → Variables：
   - `INGEST_URL` = `http://114.66.16.225:8099/v1/ingest`
   - `INGEST_KEY` = 服务器 `C:\yunshudu\secrets.txt` 里的 `MAILFARM_INGEST_KEY`（点 Encrypt）
3. **开 Email Routing**：CF → 域名 `qingzhou.autos` → Email → Email Routing → Enable（会提示加 MX，**别在 apex 上做**，见下）
4. **决定吃哪个 apex**（见 §2.5）：
   - 路线 1：把 `qingzhou.autos` 的 MX 整体换成 CF 的（删 `smtp.google.com(1)`，加 `route1/route2/route3.mx.cloudflare.net` 10/21/31）——**先确认 Google 侧没有在用信箱**（本轮实测：`yipian@` / `yipian01@` / 随机地址全 550，仅 `postmaster@` 250）
   - 路线 2：新买域，按 CF 提示加 MX
5. **开 Catch-all**：Email Routing → Routing Rules → **Catch-all** → Action = `Send to a Worker` → 选 `yunshudu-ingest`（**只对 apex 生效**）
5. **回我一句**「m1 好了」→ 我执行：`node scripts\add-maildomain.js --domain m1.qingzhou.autos --write` + 部署 + 发一封真信验通

---

## 4 我这边接到域之后做什么（固化流程）

1. `node scripts\add-maildomain.js --domain <域>` 体检（NS/MX/SPF/DMARC/健康探针）
2. 补 DMARC（缺则加 `_dmarc`，**不动**已有 SPF）
3. `--write` 写进 `services.json` 的 `MF_DOMAINS` + `COMPAT_DOMAINS`（幂等、自动备份）
4. commit → push GitHub → 服务器 `yunshudu-deploy` 自动部署 → `poke-deploy.ps1 -ExpectSha` 等 SHA 对齐
5. 发一封真信（或 CF 面板 Send test）→ 用 `/v1/mailboxes/{addr}/code` 读码确认全通
6. 跑 `mail-domain-health.js --domains <域>` 确认 H3 侧返回 `ok`（1200019），进入可用域池

---

## 5 边界（诚实）

- 本轮**只实测了**「公网 → /v1/ingest → 取码」这一段；**Cloudflare 侧的 Worker/Email Routing 未实测**（没有 token，也没在面板点）
- `MF_DOMAINS` 为空时 mailfarm 会退回默认 `localhost`（代码内置 fallback），所以 ingest 只认 `localhost`——这是当前 400 的原因，属预期；配好真域即恢复
- 本轮 e2e 在服务器 state 里留了一条测试信箱 `hlcf144y@localhost`（TTL 3600s，自动过期；不影响业务）
- 机房**封 25**（services.json note 已注明），所以「MX 直指 114.66.16.225」这条路不可用，别再试
- 子域在 DNS 上没有独立 NS（属主域 zone 内的记录），工具报 `NO_NS` 是预期
