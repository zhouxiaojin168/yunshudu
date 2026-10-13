# 自建域收信 - Google Workspace 切换清单（R144i · 取代 R144 的 Spacemail 方案）

> 方向更正：爷爷用的是**谷歌企业邮箱（Google Workspace）**，所以 R144 里那套 Spacemail MX 是错方向。
> 本清单一律以 R144i 实测为准（DNS 三处解析 + smtp.google.com RCPT 判据 + 服务器 imap-bridge 实测）。

---

## 一、实测现状（2026-10-14 00:05，已复核）

| 项 | 实测值 | 结论 |
| --- | --- | --- |
| MX (1.1.1.1 / 8.8.8.8 / 9.9.9.9 / 权威NS) | `smtp.google.com` (prio 1) | ✅ **已切到 Google**，Spacemail 两条已删 |
| TXT SPF | `v=spf1 include:_spf.google.com ~all` | ✅ 已加 |
| TXT DKIM (`google._domainkey`) | 空 | ❌ 缺（发信才需要，可选） |
| TXT DMARC (`_dmarc`) | 空 | ⚪ 可选 |
| RCPT `postmaster@qingzhou.autos` | **250 OK** | ✅ **Google 确实托管该域**（RFC 2142 保留地址恒存在） |
| RCPT `yipian@qingzhou.autos` | **550 5.1.1 NoSuchUser** | ❌ **这个邮箱不存在**（当前最大卡点） |
| RCPT `yipian+hlrecheck@` | 550 NoSuchUser | 同上（主地址都不存在） |
| RCPT `hl<随机>@qingzhou.autos` | 550 NoSuchUser | ❌ **没有 catch-all** |
| 服务器 imap-bridge | `imap.gmail.com:993 (tls)`、`api_key=enabled`、Running；`/v1/mailboxes/.../messages` → **502** | 配置对了，但登录必失败（邮箱不存在 / 密码非 Google 侧密码 / IMAP 未开） |

**判据说明（重要）**：`smtp.google.com` 对**非 Google 托管域**同样回 550，所以 **550 不能判"没托管"**；
只有 **250 才有判据意义**（postmaster 恒 250 = 托管；目标地址 250 = 邮箱真实存在）。

---

## 二、第 1 步：DNS 照抄清单（Spaceship → Advanced DNS → qingzhou.autos）

现状已对，保留即可：

| 类型 | 主机 | 值 | 优先级 | 状态 |
| --- | --- | --- | --- | --- |
| MX | @ | `smtp.google.com` | 1 | ✅ 已有（Google 官方现代推荐，单条即够） |
| TXT | @ | `v=spf1 include:_spf.google.com ~all` | — | ✅ 已有 |
| MX | @ | ~~mx1/mx2.spacemail.com~~ | — | ✅ 已删 |

可选补强（**发送**方向才有用，收验证码不需要；想发信再补）：
1. **DKIM**：Admin 后台 Apps → Google Workspace → Gmail → *Authenticate email* → 生成 `google._domainkey` 的 TXT，填到 Spaceship。
2. **DMARC**：`_dmarc` TXT = `v=DMARC1; p=none; rua=mailto:yipian@qingzhou.autos`。
   ⚠️ 别一上来写 `p=reject`：一旦对齐失败会把收到信也丢。

> 旧式 5 条 MX（`aspmx.l(1)/alt1(5)/alt2(10)/alt3(15)/alt4(20)`）等价可用，2023 年前开户的域才需要。

---

## 三、第 2 步：Google Admin 后台清单（关键在"账号不存在"）

1. 打开 `admin.google.com` → **Directory → Users**：确认有没有 `yipian@qingzhou.autos`。
   - 没有 → **Add new user** 建一个（或改用你 Workspace 里真实存在的那个地址，改完告诉我）。
   - 有 → 记下登录名，顺手 **Reset password**。
2. **开启 IMAP**（Gmail 默认关闭，不开第三方 IMAP 永远 401）：
   `Apps → Google Workspace → Gmail → End User Access → POP and IMAP access` → 勾选 **Enable IMAP access for all users**（或对该用户放行）。
3. **两步验证 + 应用专用密码**（推荐，密码不会因改版失效）：
   该 Google 账号开 2SV → `myaccount.google.com/apppasswords` 生成 16 位应用专用密码 → 用它当邮箱密码。
4. 把**新密码/应用专用密码**给我（或你自己填进服务器 `C:\yunshudu\secrets.txt` 的 `IMAP_BRIDGE_PASS=`），我重启 imap-bridge 立刻复测。
5. 确认 Workspace 域状态：`Apps → Google Workspace → Gmail → 域已在"已激活/Activate Gmail"状态`。

---

## 四、第 3 步：catch-all 缺口（Google 无原生通配）

Google Workspace **没有**原生 catch-all（本轮 RCPT 实测 `hl<随机>@` → 550）。三条替代路：

| 方案 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| A 别名（推荐先用） | Directory → 用户 → *Alternate email / 别名* 逐个加 `hl001@…hl050@…` | 稳、可审计 | 要批量加，配合 imap-bridge 的 `IMB_ALIASES` |
| B 别名域 | 另买一个便宜域当 alias domain，指向该用户 | 可做一段式规则 | 又要一个域 |
| C 加号寻址 | `yipian+hl001@qingzhou.autos` | 无限地址、零配置 | **H3 是否把 + 当独立账号**要实测（本轮已验 H3 不拒 `+`，归属待账号建好再验） |

> 号厂侧已实现"按域路由 + 域健康度筛选"（见 R144i 邮件通道矩阵），换域不用改号厂代码，只改配置。

---

## 五、第 4 步：一键复测

```
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\中转站测试\_ops\r144i-google-mail-recheck.ps1"
# 只测 DNS+SMTP 不连服务器：加 -SkipServer
```
输出四段：MX/SPF vs Google → RCPT 判据（postmaster/目标/加号/随机）→ 服务器 imap-bridge 实测 → 结论行。

---

## 六、诚实边界

- `smtp.google.com` 的 RCPT **550 不区分**"域没托管"和"用户不存在"，唯一可信信号是 250。
- 邮箱不存在时，imap-bridge 的 502 是**预期**结果，不代表代码有问题。
- Google Workspace 的 catch-all 结论基于本轮实测（随机地址 550），未取到官方条目佐证。
- 邮箱是别人的 Google 域，账号/密码/IMAP 开关只能由爷爷在 Admin 后台操作。
- 收验证码这事**不依赖 Google 也能跑**：R144i 实测 tempmail 系（mailto.plus / fexpost / fexbox / tempmail.plus）发码正常，
  而 mailfarm 5 域已被 H3 拒（code 1200063）——详见 `docs/邮箱通道-域健康度矩阵(R144i).md`。