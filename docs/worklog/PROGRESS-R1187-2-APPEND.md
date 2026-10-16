### R1187-2 电源线「实弹」收尾：两次真开关机 + 三个真 bug 修掉（2026-10-17 06:24:21）
**token 到位**：爷爷给 AutoDL 控制台 token（ES256 JWT，uid 572189，exp 1797368400≈2026-12-15）→ 写入 C:\yunshudu\secrets\autodl-token.txt（402B，不进仓库）。
**验证**：h3-power.js status -> ok=true，拿到实例真 JSON（uuid bede4a8dde-6e7609ea / status running / payg_price 2930 / gpu_all_num 10 / gpu_idle_num 0 / data_disk 50G 用 46.6G / **disk_expand_available=0** / rent_deadline 2027-07-01）。

#### ★ 写方向参数名钉死（只测"开机"方向，绝不拿关机做实验）
| 探测 | 结果 | 结论 |
|---|---|---|
| GET api/v1/instance/detail?instance_uuid= | **Success** | 参数名 = instance_uuid |
| GET api/v1/instance/detail?uuid= | RequestParameterIsWrong | 反证 |
| POST api/v1/instance/power_on {instance_uuid} | BadRequest「当前实例状态无法进行开机操作」 | 参数被接受，仅因已在运行而拒 |

#### ★★ 实弹测试 1（受控，我盯着跑）
`
power_off  -> {"code":"Success"}   状态 10s 内变 shutdown
power_on   -> {"code":"Success"}   状态 10s 内回 running（同主机、同 SSH 30009，gpu_idle 0→1→0 卡被自己放掉又立刻拿回）
`

#### ★★ 暴露并修掉 3 个真 bug（都是实测才看得见的）
1. **关机后服务全不自启**：容器重启只起 sshd+jupyter，**cron 都没起** → h3api/ComfyUI/cloudflared 全死。
   修法：用 AutoDL 官方开机钩子 —— /init/bin/customer.cmd.sh 每次开机都会 ash /etc/autodl.sh（该文件原本不存在，我们自己创建）。
   - 新增 /etc/autodl.sh（301B）：
ohup bash /root/h3api/boot-all.sh &
   - 新增 /root/h3api/boot-all.sh（1296B）：cron -> ComfyUI(8188) -> 等就绪 -> keepalive(h3api 6006 + cloudflared + 上报新地址)
   - **实测**：05:57:30 开机 → boot-all 跑完 05:58:02，**32 秒**全绿：cron 837 / comfy 839 / h3api=200 / cloudflared 新隧道
2. **relay 把 cloudflare 530 错误页当"正常响应"**：隧道死了 CF 返回 530 HTML（HTTP 层面算成功），旧逻辑直接透传 → **唤醒永远触发不了**（这次 E2E 就卡在这）。
   修法：relay 里 status 520~530 -> 拦成 503 + 触发 maybeWake；新增 _ops/relay-530-selftest.js 4 项全 PASS。
3. **武装开关被部署冲掉**：pp\ 目录每次 deploy 都 robocopy /MIR → 我直接改服务器的 config/autodl.json 被还原成 enabled=false（看门狗自己又变干跑）。
   修法：h3-power 支持 secrets\autodl.local.json 覆盖（路径跟 token_file 同级，部署范围外）。
   现网：C:\yunshudu\secrets\autodl.local.json = {"enabled":true,"dry_run":false}
   → 启动日志：enabled=true dry_run=false localCfg=C:\yunshudu\secrets\autodl.local.json token=set

#### ★★ 实弹测试 2（终极端到端，走真实生产路径）
`
步骤1 power_off                    -> Success，8s 变 shutdown
步骤2 打 relay /v1/models          -> HTTP 503 {"ok":false,"error":"upstream tunnel error 530…","wake":{"fired":true,"reason":"upstream-tunnel-error-530"}}
      h3-power 日志                -> === 手动 on === / power_on 成功 :: code=Success
步骤3 机器 25s 内回 running；boot-all 自动拉起全套；cloudflared 又换新隧道 margin-tagged-foods-travis
最终复核 relay /healthz            -> ready=true upstream_health=200 idle_s=7 req_count=2
     /v1/models（带真 key）        -> HTTP 200 {"data":[{"id":"minimax-h3",…modes:[t2v,i2v,flf2v]…]}
     三端外网                     -> api.qingzhou.autos 200 / portal.qingzhou.autos 200 / h3.qingzhou.autos/healthz 200
     端口                         -> 3000,8080,8899,9123,9940,9950 全 LISTEN
`
→ **「没人用就关机 + 有人调用自动开机」整条活了**。关机→服务完全可用 ≈ **30~60 秒**（开机 10s + boot-all 32s + 隧道上报，relay 自动跟随）。

#### 提交
7a56f1f / 5358a6a / c83c370 / ae201af（GitHub main = ae201af1e16915f3af82195e84c38b1fa87c1df7）
⚠ 发现 push.ps1 每次都报假的 schannel SEC_E_NO_CREDENTIALS，但提交其实已上远端（用 -c http.sslBackend=openssl 可静默；git ls-remote 已核对）。另：本机存在 auto-sync 任务会周期性自动 commit+push。

#### 待办/风险
- **disk_expand_available=0**：这台主机当前不支持在线扩数据盘（R1185 的扩容计划受阻）→ 需迁移实例或另开
- 每次开机 cloudflared 出新随机域名 → relay 靠 keepalive 上报跟随（最长 3 分钟窗口）；后续可上 **named tunnel（固定域名）** 把唤醒延迟压到秒级并去掉 trycloudflare 依赖
- 按量实例关机 GPU 不预留：实测这次抢回了同一台同一卡，但不保证
- 成本：关机停收 ¥2.93/h；数据盘按天计费（≈0.0066 元/日/GB，50GB 免费）