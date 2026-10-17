# R1190 —— 丙方案落地：只认真实业务请求才唤醒 + 端到端实测

时间：2026-10-17T16:02:22+08:00

## 1. 目标（爷爷选「丙」）
让「零调用零成本、有调用才开机」真正成立：渠道探活绝不能叫醒机器。

## 2. 判定规则（relay: scripts/h3-local-relay.js）
- 默认：方法 ∈ {POST, PUT} + 头 \Authorization: Bearer ...\ + 路径不在 {/v1/models,/v1/health,/healthz,/self,/wake,/v1/internal}
- 全部可配：\H3R_WAKE_METHODS\ / \H3R_WAKE_REQUIRE_AUTH\ / \H3R_WAKE_DENY_PREFIX\ / \H3R_LOG_REQ\
- 非业务请求返回 \{"fired":false,"reason":"not-business","skip":"method:GET"}\，并记一行日志
- 新增 \iz_idle_s\ / \last_biz_at\ / \iz_count\（真实业务指标），/healthz 暴露

## 3. 看门狗（scripts/power/h3-power.js）
- 睡/醒判断改用 \iz_idle_s\（业务空闲），探活不再让机器永远不睡
- **必须有业务证据才唤醒**：\iz_count===0\（从未有业务）时探活绝不唤醒；老版 relay（无 biz 字段）退回 idle_s 保持兼容
- 开机失败（AutoDL 报 \机器空闲GPU不足\）→ 5 分钟快速重试（\wake_retry_minutes\），唤醒窗口放宽到 30 分钟（\wake_window_sec\）

## 4. 自测（服务器真实环境）
| 用例 | 结果 |
|---|---|
| wake-policy selftest | **11/11 PASS**（GET 探活不唤醒、带 Bearer 的 GET 也不唤醒、无 auth 的 POST 不唤醒、POST+Bearer 才唤醒、二次被节流）|
| h3-power selftest | **10/10 PASS**（含 h 只有探活不唤醒 / h2 从未有业务不唤醒 / i 真实业务才唤醒）|

## 5. 线上实测
- relay 启动日志：\唤醒判定=POST/PUT+Bearer 忽略=/v1/models,...\
- 模拟渠道测活：\GET /v1/models (Bearer)\ → \502\ + \iz=no(method:GET)\ + \wake 跳过(proxy-failed) -> 非业务请求: method:GET\，\iz_count=0\ ✅
- 静默观察 6 分钟：**零请求**（说明之前那次「关机被自己开回来」是我自己的测试打的，不是 new-api 周期探活）
- 真业务 POST /v1/chat/completions（Bearer）→ \wake.fired=true\ → h3-power \on\ 执行 ✅

## 6. ★ 真问题：AutoDL 开不了机
`
power_on 未确认 :: http=200 code=BadRequest msg=机器空闲GPU不足
status=shutdown  gpu_all_num=10  gpu_idle_num=0
`
- 按量实例关机后 **GPU 不预留**（官方规则），该机（418机/北京B区）10 张卡全被占满 → 开不回来
- 4 小时前（06:27）当时 gpu_idle_num=1，所以能开；现在 0
- 对照：这不是代码问题，是物理资源问题

## 7. API 到底能不能调（实测）
| 项 | 结果 |
|---|---|
| \GET https://api.qingzhou.autos/v1/models\（真 key） | **200**，返回 H3-Max / Hailuo-2.3 / MiniMax-H3 / MiniMax-Image … |
| \GET http://127.0.0.1:3000/v1/models\ | **200** |
| 渠道 #7 平台池 9940 /healthz | **200** \{"ok":true,"pool":"platform","inflight":0,"max_inflight":20}\ |
| 平台池账号 | **1 个，healthy=1，credits=80**（H3 一条约 30 点 → 约 2 条）|
| 渠道 #9 自建 relay | healthz 200，但 upstream_health=ERR（机器关着）|
| 渠道配置 | #7 priority=110 auto_ban=1；#9 priority=120 auto_ban=1（#9 优先，失败兜底 #7）|

## 8. 提交
`
8d40d32 R1190 relay唤醒判定+业务指标+selftest
d9cc088 R1190b 修 biz_idle_s 回落坑（从未有业务不得唤醒）
5486296 R1190c 开机失败5分钟重试 + 唤醒窗口30分钟
`
全部已 push + 服务器 deployed-sha 对齐。
