
===== [2026-10-17 05:37:29] 爷爷: 2+1,还有能不能不用的时候，你给我自动关机，需要释放镜像吗？没数据跑就关机，有数据调用，自动开机可以实现吗？ =====
### R1187 电源管理线：空闲自动关机看门狗 + 「有调用自动开机」（2026-10-17 05:37:29 完结合龙）
**背景**：1/2/3/4/5 号线已闭环（R1176~R1186，commit 4ae7705 已部署）。爷爷本轮：「2+1，还有能不能不用的时候，你给我自动关机，需要释放镜像吗？没数据跑就关机，有数据调用，自动开机可以实现吗？」。
**注意**：R1187 的实例取证/看门狗/唤醒钩子由上一轮执行但**未写入 PROGRESS**，本轮补记并做完加固。

#### (a) 实例侧电源能力取证（/root/probe_power.sh）
PID1 = bash /init/boot/boot.sh（容器化，非裸机）；shutdown/poweroff/halt/reboot/systemctl 都在；autodl/auto CLI => MISSING（无官方关机 CLI）；AutoDL 环境变量 => 无；169.254.169.254 => 000（无元数据服务）；www.autodl.com => 200（★实例内可出网）；已有 crontab: */3 * * * * keepalive.sh

#### (b) ★★ 关键突破：AutoDL「开机/关机」入口挖到了（真端点，非猜）
方法：实例内 curl 抓控制台 SPA → /assets/index.f9af57aa.js → chunk instance.4daa8be5.js 全文
\\\js
// 源码原文（instance.4daa8be5.js）
const t={ findAll:"api/v1/instance", initInstance:"api/v1/instance/init",
  stop:"api/v1/instance/power_off", start:"api/v1/instance/power_on",
  recreate:"api/v1/instance/recreate", release:"api/v1/instance/release",
  restartInstance:"api/v1/instance/restart", getDetail:"api/v1/instance/detail",
  getSnapshot:"api/v1/instance/snapshot", monitor:"api/v1/instance/monitor",
  timedShutdown:"api/v1/instance/timed/shutdown", changeDataDisk:"api/v1/order/data_disk/change", ...}
// 请求拦截器（service-code.30826265.js）
headers:{ Authorization: getToken(), AppVersion: ... }
// getToken = () => localStorage.getItem("token")   （www.autodl.com 登录态）
\\\
实测（无 token）：\POST https://www.autodl.com/api/v1/instance/power_on\ → HTTP 200 \{"code":"AuthorizeFailed","msg":"登录超时，请重新登录"}\（=端点存在只差鉴权；404 的才是不存在，已用 404 对照）
→ **结论：AutoDL 没有公开开放 API（/docs/api/ 404 /docs/openapi/ 404），但控制台内部 API 可用；只需一个浏览器 localStorage.token。**

#### (c) ★ AutoDL 三条硬规则（官方文档实读，影响方案）
1. docs/instance_data：「实例在数据在，开关机以及包年包月到期均不影响数据。但释放规则是**连续关机 15 天释放实例**，届时实例所有数据将被清空，释放后无法恢复。」→ 自动关机**必须**配保活
2. docs/local_disk：数据盘按当天最大容量 24 点计费（约 **0.0066 元/日/GB**，**50GB 免费**），**无论当天是否关机**；关机不省数据盘钱
3. docs/qa：包年包月关机 GPU 预留；**按量计费关机后 GPU 不预留**，开机要重新调度（原主机有卡秒开，无卡则等/迁移）

#### (d) 本轮交付物（已部署 commit 7a56f1f / 5358a6a）
| 文件 | 作用 |
|---|---|
| scripts/power/autodl-api.js | AutoDL 控制台 API 客户端（真端点 + Authorization=localStorage.token），status/list/powerOn/powerOff |
| scripts/power/h3-power.js | 电源看门狗：\status/list/on/off/watchdog[--once]/selftest\；闲够 idle_minutes→关机；上游不可达+最近有调用→开机；**max_off_days=13 保活开机** |
| scripts/power/idle-poweroff.sh | 实例内备用看门狗（已上传 /root/h3api，默认 DRY-RUN，未挂 cron） |
| config/autodl.json(.example) | 实配 + 规则注释；enabled=false / dry_run=true **安全默认** |
| services.json | 新增服务 h3-power（端口无 / managed auto / restartOnDeploy）；relay env 增 H3R_WAKE_CMD + H3R_WAKE_MIN_INTERVAL=600 |
| scripts/h3-local-relay.js | ① maybeWake 加固（exec 包 try/catch + child error 监听，不再崩）② /healthz 增 idle_s / last_req_at / req_count |

#### (e) 实测证据（全部真跑）
1. **relay /wake 自测 8 项全 PASS**（node E:\中转站测试\_ops\wake-selftest.js，EXIT=0）
   c) 对 key → \{"ok":true,"configured":true,"fired":true,"reason":"manual-api","spawn_error":"spawn EPERM"}\（沙箱禁 spawn 也不崩）
2. **h3-power 自测 7 项全 PASS**（a 闲够→关机分支 / b 在算→不关 / c 不可达+有调用→开机 / f 连关14天→保活开机 / g 关2天无调用→不动 / d dry-run 留痕 / e 状态落盘）
3. **生产端到端**：POST http://127.0.0.1:9123/wake → \{"ok":true,"fired":true,"spawn_error":null}\ → h3-power 日志出现
   \[..] === 手动 on === enabled=false dry_run=true token=EMPTY\ + \!! 没有 token -> 什么都不会发生\（**链路真通，只差 token**）
4. **服务器复核**：9123 \eady=true idle_s=1 req_count=1 wake.configured=true\；h3-power 服务 Running(PID 4228)；config 解析 OK(enabled=False dry_run=True max_off_days=13)；端口 3000/8080/8899/9123/9940/9950 LISTEN
5. 部署：commit 7a56f1f → 5358a6a，服务器 deployed-sha = 5358a6a4c6c66ab05d42c2f02c15ccb25326c430

#### (f) 一句话结论（回答爷爷三问）
- **要释放镜像吗？→ 不要。** 关机只停实例，系统盘/数据盘/镜像都在；「实例在数据在」。真正要防的是**连续关机 15 天会被 AutoDL 释放**（已加 max_off_days=13 保活）。
- **没数据跑就关机 → 已实现**（h3-power 看门狗，默认 dry-run 只记日志；放好 token + enabled=true/dry_run=false 即真执行）。
- **有数据调用自动开机 → 已实现链路**（relay 503/502 → 执行 H3R_WAKE_CMD → h3-power.js on），**只差一个 AutoDL token**。
- 唯一非 100% 保证项：按量实例关机后 GPU 不预留，开机偶发抢不到卡（官方规则，非本方案缺陷）。

#### (g) 待爷爷给的一件东西
www.autodl.com 登录后 F12 Console 执行 \copy(localStorage.getItem('token'))\，把值发我 → 我写进 C:\yunshudu\secrets\autodl-token.txt → 跑 \h3-power.js status\ 验证 → 再放开 enabled/dry_run。