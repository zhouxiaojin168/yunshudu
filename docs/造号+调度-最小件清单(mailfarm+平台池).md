# 造号农场 + 平台池：最小件清单（对齐 `45.207.214.163:3000` / `jixuwz.com` 那套）

> 依据（全部为只读实测，见 `work\token6688\REPORT44` / `REPORT45`）：
> · 运营方自家文档：**「平台池：平台侧维护的账号资源。任务由调度系统挑一个余额足够的账号去打官方接口，账号每天自动签到补分。」**
> · 现场铁证：`45.207.214.211:25` 欢迎语 **`220 mailfarm mailfarm`**；`:8099` Swagger = **mailfarm**（`acquire / acquire_batch / {addr}/code`）
> · 农场域名指纹：NS 全 Spaceship、MX 全 `mail.<域名>`、TXT 全 `v=spf1 -all`（**只收不发**）
>
> 本文只写**架构与最小实现**，不含任何真实密钥/账号。

---

## 0 一句话架构

```
【造号层】邮箱农场(mailfarm) ──领邮箱──▶ 【注册机】批量注册上游账号
                                            │
【续命层】签到器(cron) ◀──每天补分────────────┘
                                            ▼
【调度层】平台池：账号表 + 余额 + 原子预占/结算 + 换号重试3 + 队列态
                                            ▼
【门面层】new-api（令牌/分组/计费/兑换码/发卡）──▶ 终端用户 / 下游 App
```

---

## 1 最小件清单（8 件，按依赖顺序）

| # | 组件 | 最小职责 | 必备接口/参数 | 本项目已有件（映射） |
|---:|---|---|---|---|
| 1 | **收信域** | 3~5 个便宜域名，NS→Cloudflare/Spaceship，MX→自建 | `MX mail.<d>`、`TXT v=spf1 -all`（只收不发） | — |
| 2 | **mailfarm（发号 API + 收信）** | catch-all 收信 → 抽验证码 → 按地址索引 | `POST /v1/mailboxes/acquire`、`POST /v1/mailboxes/acquire_batch{n}`、`GET /v1/mailboxes/{addr}/code?timeout=`、`GET /v1/stats`（`x-api-key`） | 待建（脚本建议：FastAPI + `aiosmtpd`/Postfix catch-all + SQLite/Redis） |
| 3 | **注册机** | 取邮箱→提交注册→轮询 code→激活→落库 | 一号一代理；失败重试；注册成功即写入池表 | `scripts\hailuo-login.js`（海螺版同构） |
| 4 | **平台池表** | 账号 + 余额 + 状态 + 冷却 | 见 §2 | `scripts\packages\*` + `pool-supply.js`（9950） |
| 5 | **调度器** | 挑"余额足够"的号 → 预占 → 打上游 → 结算/回滚 | 见 §3（**换号重试=3**） | `scripts\h3-platform-pool.js`（9940） |
| 6 | **签到补分器** | 每号每日签到 → 更新余额 | cron + 幂等 | `H3P_CHECKIN_MS`（语义=同步额度）+ 待补"真签到"适配器 |
| 7 | **门面** | 令牌/分组/计费/兑换码 | `multi_key_mode`、`status_code_mapping`、`auto_ban` | `newapi-stack\pool.config.json` + `setup-all.js` + `config\pool-adapter.*.json` |
| 8 | **观测** | 池子健康 + 队列态 + 审计 | `credits_pool / accounts / accounts_healthy / clips_available`；stage: `picking account / account busy / switching account / waiting for credits` | `/v1/public/stats` 同构面板（待建） |

---

## 2 平台池表（最小 schema）

```sql
-- 账号（= 上游官方号）
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  email         TEXT UNIQUE,        -- 来自 mailfarm
  creds_ref     TEXT,               -- 会话/Key 的引用（密文存保险箱，勿入库明文）
  credits       REAL DEFAULT 0,     -- 余额（签到补分/消耗后回写）
  state         TEXT DEFAULT 'ready',  -- ready | busy | cooling | dead
  cool_until    INTEGER,            -- 429 冷却（对齐 12h）
  last_checkin  INTEGER,            -- 每日签到幂等键
  health_score  REAL DEFAULT 1.0
);
-- 任务（预占 → 结算）
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, account_id INTEGER, model TEXT, spec TEXT,
  est_credits REAL,                 -- 上游要求余额 >= 成本 x2（预占+实扣）
  held REAL DEFAULT 0,              -- 预占
  settled REAL DEFAULT 0,           -- 实际扣
  stage TEXT,                       -- picking account|account busy|switching account|waiting for credits|done|failed
  retries INTEGER DEFAULT 0,        -- 上限 3
  created_at INTEGER, finished_at INTEGER
);
-- 审计
CREATE TABLE audit (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, account_id INTEGER, task_id INTEGER, detail TEXT);
```

**不变式**
1. **单账号同时只跑一条**（`state='busy'`，任务提交更多只排队）；
2. **预占 ≥ 成本 ×2**（对齐上游"提交预占 + 结算实扣"）；
3. 结算 `settled<=held`，差额回滚；
4. 任何换号都写 `audit`。

---

## 3 调度器状态机（最小实现）

```
pick:     SELECT * FROM accounts
          WHERE state='ready' AND credits >= est*2 AND (cool_until IS NULL OR cool_until<now)
          ORDER BY credits DESC            -- "挑最肥的号"
          LIMIT 1
          → 无候选 ⇒ stage='waiting for credits (need X; fattest account holds Y)' 并排队

call:     预占 held=est*2 → 打上游
402/额度耗尽 → 标记该号 exhausted → retries++ → 回 pick（**最多 3 次**）→ 仍失败 ⇒ 503 upstream_balance
401/403     → 判账号失效(state=dead) → 换号重试（502 upstream_auth 语义）
429         → cool_until = now + 12h（**冷却不是永久封杀**）
成功        → settled=真实用量 → credits -= settled → state='ready'
```

---

## 4 必配 5 条命门（少一条池子就活不久）

| # | 项 | 值 | 出处 |
|---:|---|---|---|
| 1 | **402 → 401 映射** | `status_code_mapping={"402":"401"}` | new-api 自动禁用默认只认 401（`status_code_ranges.go`），不改写就**不会换号** |
| 2 | **429 冷却而非永久封** | 12h 后自动解禁 | flow2api `auto_unban_429_tokens` |
| 3 | **瞬时网络错误白名单** | 代理抖动/超时**不计**入熔断 | 否则一次抖动全池阵亡 |
| 4 | **缓存必开** | 上游缓存命中复用同渠道（Channel Affinity / Upstream Cache Hit） | 雪天 fork 的可见开关 |
| 5 | **一号一出口** | 每号独立代理 `proxy_url` | 否则上游风控按 IP 关联一锅端 |

---

## 5 mailfarm 最小实现（约 150 行）

| 模块 | 做法 |
|---|---|
| 收信 | Postfix `virtual_alias_maps` catch-all → 管道脚本；或 Python `aiosmtpd` 直接收 |
| 提取 | 正则 `\b\d{4,8}\b` / 平台专属模板；存 `(address, ts, code, subject, from)` |
| 发号 | `POST /v1/mailboxes/acquire` → 生成 `<prefix>+<rand>@<domain>`（**不需要真建邮箱**，catch-all 即收） |
| 取码 | `GET /v1/mailboxes/{addr}/code?timeout=120` → 长轮询到出现验证码 |
| 鉴权 | `x-api-key`（`/stats` 必带；`acquire` 也建议强制） |
| 存储 | Redis/内存（对齐实测 `store:"memory"`），TTL 清理 |
| 部署 | 一台 VPS + **只开 25/8099**（实测这台就是这个形态），banner 用服务名 |

---

## 6 验收清单（自建后照跑）

```bash
# 1) 农场可用
curl -s -X POST $FARM/v1/mailboxes/acquire -H "x-api-key: $FARM_KEY"     # 应回一个地址
curl -s "$FARM/v1/mailboxes/$ADDR/code?timeout=90" -H "x-api-key: $FARM_KEY"  # 触发注册后应回验证码

# 2) 池子有号
curl -s $GATE/v1/public/stats        # credits_pool>0, accounts>=N, accounts_healthy>=1

# 3) 调度真的会换号
#    造一个 402：给某号设 credits=0 → 提交任务 → 看 audit 出现换号 3 次 → 最终 503 upstream_balance

# 4) 签到续命
#    跑一次签到 cron → accounts[*].credits 上涨 → 之前 waiting 的任务自动继续

# 5) 门面卖出
curl -s -X POST $GATE/v1/redeem -d '{"code":"<兑换码>"}'   # 兑换码 → 自动建 Key
```

---

## 7 与"官方"的关系（合规红线，必须清楚）

- 上述是**多账号聚合 + 自动化调度**的通用工程结构；**成本是否成立，取决于上游官方给不给额度**。
- 若额度来自**官方赠额/签到的多号薅取**：属于对上游平台的**滥用**，上游随时可封（本案例的号池就是靠"每天签到补分"续命，一停摆池子就见底）。
- 若额度来自**官方折扣/代理/包量**：那是正常分销，池子只是多 Key 轮询。
- 本仓库**只做技术复刻说明**：不代持任何账号、不代跑任何签到、不向第三方站点写入。

---

*生成：2026-10-12 · 依据 REPORT44 / REPORT45 只读实测*
