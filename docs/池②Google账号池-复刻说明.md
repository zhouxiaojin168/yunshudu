# 池②：Google / Flow 账号池（源码级复刻说明）

> 对象：雪天 `xuetianai.com` 的账号池引擎 = 开源 **TheSmallHanCat/flow2api**（MIT）
> 本次工作：把它的**账号池状态机**逐条抄下来，用 Node 1:1 复刻并跑通验收。
> 复刻时间：2026-10-11 · 本机 Node v24.21.0（无 Python / 无 Docker）

## 0. 一句话结论

账号池的核心**不是**「怎么弄到很多账号」，而是**拿到 N 个账号之后怎么活下去**：
AT 到期自动刷新、撞限流只冷却不判死、瞬时网络错误不杀号、按负载挑号、额度用尽自动换号。
这五条就是全部秘密，flow2api 全都写在明面上，我们照抄。

## 1. 源码级依据（逐条对应 flow2api 文件）

| # | 规则 | 源码位置 | 关键代码 |
|---|---|---|---|
| 1 | 凭据模型 | `src/core/models.py` `class Token` | `st`(会话票) / `at`+`at_expires`(访问票) / `credits` / `user_paygate_tier` / `image_enabled`·`video_enabled` / `image_concurrency`·`video_concurrency` / `proxy_url`(一号一代理) / `ban_reason` / `banned_at` |
| 2 | AT 自动刷新 | `src/services/token_manager.py` `_should_refresh_at()` | `if time_until_expiry.total_seconds() < 3600: return True` |
| 3 | 429 熔断 | 同文件 `ban_token_for_429()` | `is_active=False, ban_reason='429_rate_limit', banned_at=now` |
| 4 | 冷却自动解禁 | 同文件 `auto_unban_429_tokens()` | `if time_since_ban.total_seconds() >= 12 * 3600:` → `is_active=True` + 清空 ban + 清零错误 |
| 5 | 连续错误熔断 | 同文件 `record_error()` | `consecutive_error_count >= admin_config.error_ban_threshold` → disable；`record_success()` 清零 |
| 6 | 瞬时错误白名单 | 同文件 `_is_transient_network_failure()` | 关键词 `timed out / timeout / connection / curl: ( / proxy / network / …504` → **不算账号故障** |
| 7 | 调度排序 | `src/services/load_balancer.py` | 见下方排序键（原文注释：最低 in-flight 优先；有并发上限时剩余槽位更多的优先；最后随机打散） |
| 8 | DB 层兜底 | `src/core/database.py` | `SELECT * FROM tokens WHERE is_active = 1 ORDER BY last_used_at ASC` |

调度排序键（照抄原文）：

```python
available_tokens.sort(
    key=lambda item: (
        1 if item['needs_refresh'] else 0,          # 需要刷新的排后面
        item['inflight'],                          # 在途少的优先
        0 if item['remaining'] is None else 1,     # 无并发上限的优先
        -(item['remaining'] or 0),                 # 剩余槽位多的优先
        item['random'],                            # 随机打散
    )
)
# 之后再 ready_candidates + refresh_candidates，把「待刷新」整批压到最后
```

## 2. 本机复刻产物

| 文件 | 作用 |
|---|---|
| `scripts/flow-pool.js` | **池② 引擎本体**（约 16KB）：SQLite 账号表 + 上述 1~8 条规则 + OpenAI 兼容 `/v1/images/generations`·`/v1/chat/completions` |
| `scripts/mock-flow.js` | 模拟「Google Flow 网页端」上游（ST换AT / 查额度 / 出图 / 可造 402·429·401）|
| `scripts/start-flow-pool.js` | 一键起停这两个进程：`start` / `stop` / `status` |
| `scripts/flow-pool-test.js` | 状态机验收（10 项打靶） |
| `scripts/pool2-e2e.js` | 全链路 E2E（客户端→new-api→池②→上游） |
| `scripts/setup-pool2-channel.js` | 把池② 接成 new-api 的一条渠道（含配价） |

## 3. 与「池①：多 Key 渠道池」的对照

| | 池① 多 Key 渠道池 | 池② 账号池 |
|---|---|---|
| 凭据类型 | **API Key / 兑换码**（一把 key 一份额度） | **账号 OAuth**（st/at 会话票） |
| 池子在哪 | **new-api 内部**：一条渠道的 key 字段用换行拼 N 把 | **独立服务里**：flow-pool 自己管 N 个账号 |
| 关键开关 | `mode=multi_to_single`、`multi_key_mode=polling/random`、`status_code_mapping=402→401`、`auto_ban=1` | AT 刷新阈值、429 冷却 12h、并发闸门、调度排序 |
| 换号触发 | 上游返 402 → 映射成 401 → new-api 只踢这把 key | 上游返 429 → 熔断该账号 → 内部换号 |
| 要不要额外服务 | 不要，纯配置 | 要，得跑得起来账号池 |
| 复杂度 | 低 | 高（浏览器登录 + 打码 + 代理出口） |

## 4. 四条规则被「时间压缩」后的实测结果

测试用 `--ban 20 --at-ttl 60 --at-refresh 30` 把 12h / 1h 压缩成秒级，方便观察；**默认值仍照抄源码**。

```
[场景A] 402 额度耗尽 -> 自动换号
  [PASS] A1 六连发全部 200  ok=6/6
  [PASS] A2 额度真实扣减（6 次 = 6 credit）  剩余合计=8（初值 14，用掉 6）
  [PASS] A3 前面的号用尽后切到 a3 继续  a3 使用次数=6
[场景B] 429 熔断 -> 换号；冷却到期 -> 自动解禁
  [PASS] B1 撞 429 的号被熔断，整请求仍成功  落点=c2@mock  c1.is_active=false
  [PASS] B2 ban_reason=429_rate_limit（照抄源码常量）
  [PASS] B3 冷却倒计时可见  will_unban_in_s=19s（生产值 43200s=12h）
  [PASS] B4 冷却到期自动解禁  is_active=true  ban_reason=null
[场景C] AT 剩余 < 阈值 -> 自动刷新（照抄 <3600s）
  [PASS] C1 首次调用换到 AT，剩余 59s > 阈值 30s（不刷新）
  [PASS] C2 等 35s 后 AT 剩余 24s < 阈值 30s
  [PASS] C3 刷新后 AT 剩余被拉长回 TTL 59s
===== 汇总: 10/10 PASS =====
```

全链路（new-api 3300 → 池② 9930 → 上游 9931）：

```
起始账号: g1(3)  g2(3)  g3(10)
#1  HTTP 200  计费账号=g2     #5  HTTP 200  计费账号=g3   >>> 第5发前把 g2 打成 429 限流号
#2  HTTP 200  计费账号=g1     #6  HTTP 200  计费账号=g3
#3  HTTP 200  计费账号=g1     #7  HTTP 200  计费账号=g3
#4  HTTP 200  计费账号=g1     #8  HTTP 200  计费账号=g3
落点统计: {g2:1, g1:3, g3:4}
  g2@gmail.mock credits=2 is_active=false ban=429_rate_limit   <-- 被熔断，但客户端 8/8 全 200
===== E2E 全部通过 =====
```

## 5. 怎么跑

```powershell
# 起池②（默认=生产值：429 冷却 12h / AT 阈值 3600s）
D:\node-v\node.exe scripts\start-flow-pool.js start
# 验收（会等 ~60s 观察冷却解禁与 AT 刷新）
D:\node-v\node.exe scripts\flow-pool-test.js
# 接进 new-api 当一条渠道
D:\node-v\node.exe scripts\setup-pool2-channel.js
# 全链路
D:\node-v\node.exe scripts\pool2-e2e.js
# 看池内账号实时状态：GET http://127.0.0.1:9930/pool/stats （请求头 x-pool-admin）
```

## 6. 诚实边界

- 本机**无法真机出图**：原版 flow2api 需要 Python3 + Docker + 真 Google 账号 + 打码服务 + 代理出口，本机全缺；
  且 `www.google.com:443` / `flow.google.com:443` 直连超时。所以这里复刻的是**状态机与调度**，上游用 mock 顶替。
- 要真跑通需要四样：(a) 能访问 Google 的机器或代理出口，(b) Python3 或 Docker，(c) YesCaptcha / CapSolver 打码 key，
  (d) 一批 Google 账号。缺一条就只能停在状态机验证这一步。
- 池② 的 `POOL_KEY` 是本地演示值；上线务必换掉，并且**不要**把池② 直接暴露公网（它带管理接口）。
