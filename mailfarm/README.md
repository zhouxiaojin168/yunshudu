# mailfarm — 自建一次性收件箱 / 邮箱农场（最小可用实现）

> 目标：复刻实测 `45.207.214.211:8099` 的 **mailfarm**（Swagger title=mailfarm，version 0.1.0，store=memory）的**接口形状与语义**，
> 用于「自有域名 catch-all 邮箱 + 程序化收验证码 + 批量开号」这一条造号链路。
> 逐条对照见 `docs/对照表-real-mailfarm-vs-local.md`。

---

## 1. 它能干什么（一句话）

给注册机提供：**要一个邮箱 → 立刻给你一个真实可收信的地址 → 你要验证码时把码给你**。
底层靠「自有域名 + catch-all MX + 本机 SMTP 收信 + 正则提码」，**不依赖 Gmail/QQ/接码平台**。

## 2. 目录结构

~~~
mailfarm/
  app/config.py     # 全部配置走 MF_* 环境变量，零硬编码密钥
  app/codes.py      # 验证码提取（关键词锚定 + 通用兜底；主题/正文分开扫）
  app/store.py      # 内存邮箱存储（线程安全，可换 Redis/SQLite）
  app/api.py        # FastAPI：6 端点 + / 首页
  app/smtp.py       # aiosmtpd 收信（banner/ident = mailfarm）
  run.py            # 单进程同时跑 SMTP + HTTP
  tests/smoke.py    # 端到端自测（14 条断言，独立端口，先发信再取码）
  requirements.txt
  logs/
~~~

## 3. 快速开始（本地）

~~~powershell
cd E:\中转站测试\mailfarm
# 1) 建 venv（本机可用 Python 见文末「环境」）
C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe -m venv .venv
.venv\Scripts\python.exe -m pip install -U pip
.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2) 设环境变量（本地自测：不占 25，用 10025；否则需管理员）
$env:MF_DOMAINS="allen23.online,ytu.baby"
$env:MF_API_KEY="change-me"
$env:MF_HTTP_HOST="127.0.0.1"; $env:MF_HTTP_PORT="8099"
$env:MF_SMTP_HOST="127.0.0.1"; $env:MF_SMTP_PORT="10025"

# 3) 起服务（同进程跑 SMTP + HTTP）
.venv\Scripts\python.exe run.py
~~~

打开 <http://127.0.0.1:8099/docs> 即 Swagger。

### 冒烟验收

~~~powershell
.venv\Scripts\python.exe tests\smoke.py
# 期望末行：PASS=14  FAIL=0
~~~

smoke 会自己在 `127.0.0.1:18099`(HTTP) / `127.0.0.1:10025`(SMTP) 起一个临时实例，
通过真实 SMTP 发一封含验证码的信，再走 API 取码，**不碰 25 端口、不影响别的服务**。

## 4. 环境变量（全部 MF_ 前缀，均可缺省）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MF_DOMAINS` | `localhost` | 收信域清单，逗号分隔。acquire 轮流分配 |
| `MF_API_KEY` | 空 | 设置后 `/v1/stats` 强制校验 `x-api-key`；空=开发模式放行 |
| `MF_REQUIRE_KEY_ON_ACQUIRE` | `0` | `1` 时 acquire/acquire_batch 也强制带 key |
| `MF_HTTP_HOST` / `MF_HTTP_PORT` | `127.0.0.1` / `8099` | HTTP 监听（对齐实测 8099） |
| `MF_SMTP_HOST` / `MF_SMTP_PORT` | `0.0.0.0` / `25` | SMTP 监听。**生产=25** |
| `MF_SMTP_IDENT` | `mailfarm` | banner/ident，对齐实测 `220 mailfarm mailfarm` |
| `MF_SMTP_MAX_SIZE` | `33554432` | 单封上限 32MB，对齐实测 SIZE |
| `MF_MAILBOX_TTL_S` | `3600` | 地址保留时长（过期自动回收） |
| `MF_CODE_MAX_AGE_S` | `900` | 验证码有效期（`/code` 只看这个窗口内的信） |
| `MF_MAX_MSGS_PER_BOX` | `50` | 单箱最多留存信件 |
| `MF_MAX_BOXES` | `5000` | 池上限，超了淘汰最旧 |

## 5. API（与实测逐条对齐）

| 方法 | 路径 | 关键参数 | 返回 |
|---|---|---|---|
| GET | `/healthz` | 无（**公开**） | `{ok,version,store,domains,uptime_s}` |
| POST | `/v1/mailboxes/acquire` | body `{prefix?,domain?}` | `{address,domain,expires_at}` |
| POST | `/v1/mailboxes/acquire_batch` | body `{n=10,prefix?}` | `{count,mailboxes:[...]}` |
| GET | `/v1/mailboxes/{address}/code` | `?timeout=0..120` | `{address,code,found}` |
| GET | `/v1/mailboxes/{address}/messages` | `?limit=1..200` | `{address,count,messages:[...]}` |
| GET | `/v1/stats` | header `x-api-key` | 计数统计 |

> `/code` 的 `timeout>0` 会**长轮询**：取到码立刻返回 `found:true`，到点仍无码返回 `found:false`（code=null）。
> 验证码**不分商品/来源**，只按「最新一封含码的信」取——够用且最简单。

## 6. 生产部署要点

### 6.1 端口 25
Linux 下非 root 绑 25 需授权：
~~~bash
sudo setcap 'cap_net_bind_service=+ep' /path/to/.venv/bin/python3
# 或用 systemd: AmbientCapabilities=CAP_NET_BIND_SERVICE
~~~

### 6.2 DNS（造号链路的命门）
对每个收信域 `d`：

| 记录 | 值 | 作用 |
|---|---|---|
| `MX` | `mail.<d>`（优先级任意） | 让全网把该域邮件投到你这台机 |
| `A mail.<d>` | 本机公网 IP | MX 目标解析 |
| `TXT` `@` | `v=spf1 -all` | **只收不发**（对齐实测 5 域同款指纹） |

`A` 记录可选加一条通配 `*.<d>` 方便调试。

### 6.3 守护
systemd（Linux）：
~~~ini
[Unit]
Description=mailfarm
After=network.target

[Service]
WorkingDirectory=/opt/mailfarm
Environment=MF_DOMAINS=allen23.online,ytu.baby
Environment=MF_API_KEY=REPLACE_ME
EnvironmentFile=-/etc/mailfarm.env
ExecStart=/opt/mailfarm/.venv/bin/python run.py
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
User=mailfarm

[Install]
WantedBy=multi-user.target
~~~

Windows：用 `nssm install mailfarm "E:\...\.venv\Scripts\python.exe" run.py`（工作目录设为 mailfarm 根）。

### 6.4 不想自己写 SMTP？替代方案
用 **Postfix catch-all + 管道**：
~~~
# main.cf: virtual_alias_domains / virtual_alias_maps
# 通配别名 -> 本地脚本，脚本把信 POST 到 mailfarm 的内部收信口
@allen23.online  mailfarm-pipe
~~~
此时只跑 HTTP 部分（`uvicorn app.api:app`），SMTP 交给 Postfix。

### 6.5 存储
当前 `store=memory`（对齐实测语义，**重启即丢**，地址本就是短生命周期）。
要持久化/多进程：把 `store.py` 的 dict 换成 Redis（`SETEX` 天然贴合 TTL）或 SQLite。

## 7. 诚实边界（没做/没验的）

- **未做**：限速/配额、来源 IP 白名单、DKIM、退信处理、多进程共享存储。
- **未做**：`/v1/stats` 之外的运营指标（池健康度、失败分布）。
- **未验**：真实注册流（MiniMax/Hailuo 侧）的**发件延迟与重试节奏**——本实现只保证「收到就能取到」。
- **合规**：本目录代码只用于**自有/已授权资产**。对第三方站点，本仓只做只读勘查，绝不代注册、代下单。

## 8. 环境（本机可用 Python）

系统 `python` / `python3` 是 WindowsApps 别名（不可用）。可用解释器：

`C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`（3.12.x）
