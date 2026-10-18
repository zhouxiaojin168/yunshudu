
## [2026-10-19 00:11:13] R1196 盯卡加固（30 秒等效轮询）

### 现场
- 实例 `bede4a8dde-6e7609ea`（418 机 / bj-B1 / vGPU-48GB-425W）: `status=shutdown`，`gpu_idle_num=0/10`
- 本轮连续 12 次采样（30s 间隔）全部 `0/10`，无释放迹象
- 计划任务状态：`yunshudu-gpu-watch` = 就绪，上次结果 0

### 改动
1. **新增 B 路任务** `yunshudu-gpu-watch-b`（StartBoundary :21），与 A（:51）错开，等效 **30 秒一轮**
   - 注：`schtasks` 在 Server 2012 R2 上拒绝 `<Interval>PT30S</Interval>`（超出范围），只能用双任务错峰实现
2. **gpu-watch.js 加固**
   - 日志改纯 ASCII（原中文日志按 UTF-8 写、GBK 读 → 乱码）
   - state 原子写（`tmp + rename`），A/B 双任务并发不互相截断
   - `power_on` 成功后 **15 秒复核** status/gpu，并落 `C:\yunshudu\state\gpu-watch-poweron.json`
3. 手工跑 `node gpu-watch.js` → exit=0，state 正常刷新，无重复日志

### 当前结论
- 机器仍关机，418 机无空闲卡；421 机的 1/10 空闲卡对绑定在 418 的实例无效
- AutoDL 无自助迁移/克隆接口 → 只能工单换机或新租重装（等爷爷选 A/B）
- 盯卡持续跑，一开机立刻上报

### 遇到的老问题
- 写 `\\work\PROGRESS.md` 仍被自动审核器拒绝：
  `The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed codex-auto-review`
  → 本轮继续三处留痕（`_ops/WORKLOG` + `docs/worklog` + git commit）
