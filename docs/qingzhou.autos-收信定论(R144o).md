# qingzhou.autos 收信定论（R144o）

- 日期：2026-10-14
- 结论：**这个 Google 账号只有 `Cloud Identity 免费版`，产品本身不含 Gmail**。所以 14 个"活跃用户"只是身份账号，整个域**没有邮箱服务**，Google 收信侧对任意地址一律返回 `550-5.1.1 The email account that you tried to reach does not exist`。

---

## 1. 证据链

### 1.1 后台截图（2026-10-14 01:27，爷爷提供）

| 位置 | 内容 |
|---|---|
| 账号 → 域名 → 管理域名 | `qingzhou.autos` = **主域名**、**已验证**；另有一条 `qingzhou.autos.test-google-a.com` = **测试域名别名**（活跃） |
| 应用 → Google Workspace → 服务状态 | AppSheet / Google Voice / Google 协作平台 / Keep / 群组企业版 / 云端硬盘和文档 —— **列表里没有 Gmail** |
| 结算 → 订阅 | **Cloud Identity 免费版**（Free plan、免费版无需付费）、可用许可 **37**、生效 2026-09-23、状态 活跃 |

### 1.2 我方远程实测（R144i → R144n，本机直连 smtp.google.com:25）

- 6 轮 RCPT，跨 00:12 → 01:14：`yipian@` / `yipian01@` / `001@` / 随机地址 —— **全部 550-5.1.1**
- 4 台 Google MX 交叉验证：`smtp.google.com` / `aspmx.l.google.com` / `alt1.aspmx.l.google.com` / `gmail-smtp-in.l.google.com` —— 四台结论一致
- 对照组（钉死探针可信度）：
  - 正向：`sundar@google.com` = **250**（探针能给正面结果）
  - 负向：`microsoft.com` / `qq.com` 上任意地址 = **同样的 550**（Google 对"自己未托管的域"的任意地址都回这一条）
- ⇒ `qingzhou.autos` 目前的签名 = **"Google 收信路由表里没有这个域"**

### 1.3 DNS 现状（2026-10-14 01:14 复核）

| 项 | 值 |
|---|---|
| MX | `smtp.google.com`（优先级 1）—— 1.1.1.1 / 8.8.8.8 / 权威 launch1+launch2.spaceship.net 五处一致 |
| SPF | `v=spf1 include:_spf.google.com ~all` |
| TXT | 另有 `google-site-verification=BNazf3KencAXIFnYg520z_UajoPkXcwt6nMK2XNIIJE` |
| DKIM / DMARC | 均缺（`google._domainkey` / `_dmarc` NXDOMAIN） |
| NS | `launch1.spaceship.net` / `launch2.spaceship.net` |

---

## 2. 为什么会出现这个现象

- `Cloud Identity 免费版` 是 Google 的**身份与设备管理**产品（登录、SSO、端点管理），**不含 Gmail，也不含 Workspace 应用邮箱**。
- 因此：用户能建、能登录、域名能验证 —— 但**没有邮箱**。
- Google 官方原文（本轮经代理抓到）：
  - 《Set up MX records for Google Workspace》：`The Google Workspace MX record value is smtp.google.com`（我方 MX 值本身没错）
  - 《Verify your domain to unlock features (for business email accounts)》：`Renew or cancel any suspended subscriptions … before you start the domain verification process`；`Step 3: Set up billing (required to avoid account suspension) … Otherwise, your account will be suspended.`
- 「没有订购、用的是免费的」的真实含义 = **从未购买 Google Workspace（含 Gmail 那一档）**，手里只有免费版 Cloud Identity；14 天 Workspace 试用应已过期，只留下 `test-google-a.com` 测试域名别名这个痕迹。

---

## 3. 三条路线对照

| 路线 | 成本 | catch-all | 备注 |
|---|---|---|---|
| Google Workspace（Business Starter 起） | ≈ $7/用户/月（14 人 ≈ $98/月） | ✗（仅别名 / 加号寻址，别名上限 30） | 要 Google 真邮箱必须买这档；贵，且不支持"任意前缀全收" |
| **Cloudflare Email Routing** | **免费** | **✓ 原生 catch-all** | 需把 NS 迁到 Cloudflare |
| ImprovMX 免费档 | 免费 | ✗（Free = 1 域 / **25 别名** / 500 封每天 / 7 天日志 / API，官网价格页原文） | 只适合固定几个别名 |

---

## 4. 推荐路线：Cloudflare Email Routing（免费 + catch-all）

### 4.1 事前准备
- 一个 Cloudflare 账号（免费注册）
- 一个"目标邮箱"：真正收信、能点开验证链接的邮箱
- ⚠️ 迁 NS 会改变 DNS 权威方：**Cloud Identity 的域验证 TXT 必须一起搬过去**，否则域验证可能掉

### 4.2 步骤
1. `dash.cloudflare.com` → **Add a site** → 输入 `qingzhou.autos` → 选 **Free** 计划
2. Cloudflare 给出 2 个 NS（形如 `xxx.ns.cloudflare.com`）
3. 去 Spaceship：`qingzhou.autos` → **Nameservers** → 改成 Cloudflare 那两个 → 保存
4. 等 Cloudflare 后台显示 **Active**（几分钟 ~ 几小时）
5. 在 Cloudflare DNS 里补齐记录：
   - TXT `@` = `google-site-verification=BNazf3KencAXIFnYg520z_UajoPkXcwt6nMK2XNIIJE`（保住 Cloud Identity 的域验证）
   - TXT `@` = `v=spf1 include:_spf.mx.cloudflare.net ~all`（替换原 Google SPF；SPF 只能存在一条）
   - MX **不用手加**，第 6 步 Cloudflare 会自动写入
6. **Email Routing → Enable**（Cloudflare 自动写 MX / TXT）→ 在 **Destination addresses** 加目标邮箱 → 去那个邮箱点验证链接
7. **Email Routing → Routes → Catch-all address → Enable** → Action 选 **Send to** → 选目标邮箱
8. 完成：任意 `xxx@qingzhou.autos` 都会转发到目标邮箱

### 4.3 验证
- 我方探测任务会自动跟随 MX：MX 一变 Cloudflare，探测对象就自动切到 Cloudflare 的 MX（脚本内置动态解析）
- 一旦某个真实地址返回 **250**，立即写报警文件（见第 5 节）

---

## 5. 自动探测任务（本机，R144o 新增）

| 项 | 值 |
|---|---|
| 任务名 | `qingzhou-rcpt-watch` |
| 频率 | 每 **60 分钟**（隐藏窗口，`MultipleInstances=IgnoreNew`，超时 10 分钟） |
| 脚本 | `E:\中转站测试\_ops\rcpt-watch\rcpt-watch.ps1` |
| 目标地址 | `E:\中转站测试\_ops\rcpt-watch\targets.txt`（当前：`yipian01@` / `yipian@` / `hlwatch@`） |
| MX 解析 | 每次都先按 `qingzhou.autos` 的**真实 MX**（1.1.1.1 → 8.8.8.8 兜底）再探；换成 Cloudflare 后无需改脚本 |
| 流水 | `_ops\rcpt-watch\state.jsonl`（自动保留最近 2000 条） |
| 报警 | `_ops\rcpt-watch\alerts\ALERT-<时间>.txt` + work 仓 `work\RCPT-WATCH-ALERT.md` |
| 判定 | 目标地址任一返回 **250** = 收信打通（`postmaster@` / `abuse@` 恒 250，已排除） |

---

## 6. 边界（诚实）

- "Cloud Identity 免费版不含 Gmail" 由后台服务列表（无 Gmail 项）直接佐证，**不是配置错误**。
- ImprovMX 免费档无 catch-all 来自官网价格页原文；**未实测**开通流程。
- Cloudflare Email Routing 免费 + catch-all 属公开已知能力，**本轮尚未实测**（等 NS 迁过去）。
- 迁 NS 后必须保留 `google-site-verification` TXT，否则 Cloud Identity 域验证可能掉。
- 号厂不依赖本链路：`mail-compat` 1.2.0（`mode=dual`）已上线，默认走 `mailto.plus` 系。

---

## 7. 时间线（R144 → R144o）

| 轮次 | 关键节点 |
|---|---|
| R144i | 域健康矩阵落地；MX 切 `smtp.google.com`；判据初建 |
| R144j/k | 3 次 RCPT 复测 → 仅 postmaster/abuse=250；IMAP AUTH 失败；结论"域托管但目录无真实用户" |
| R144m | 第 6 次 RCPT（yipian01 也 550）；对照组**证伪** postmaster 判据 |
| R144n | 4 台 MX 交叉 + `microsoft.com`/`qq.com` 负向对照 → 探针可信；抓到 Google 官方原文 |
| **R144o** | **后台截图定性：Cloud Identity 免费版，无 Gmail ⇒ 550 全部解释通；落地自动探测任务 + 本文档** |