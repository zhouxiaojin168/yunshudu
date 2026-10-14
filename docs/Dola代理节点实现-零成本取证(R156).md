# Dola 的「代理节点」到底怎么来的（R156 取证）

> **结论先行**：Dola **不自带任何节点，也不卖代理**。它的「代理节点」= **复用你本机已有的代理软件**（Clash / mihomo / sing-box / v2rayN / xray / nekoray / outline / wireguard / TAP / 系统代理），
> 或**你自己买的静态 ISP 代理**。Dola 侧的成本 = **0**，真正的成本在你已有的机场/科学上网工具上。
> 字符串原文就有自认：「**ISP代理只配置了功能，自行研究使用**」「账号登录都存储在本地，云端无调用」。

## 一、取证（`_ops/r142-us-heap.txt` / `_ops/r142-dll-strings.txt`）

| 行号 | 原文 | 含义 |
|---|---|---|
| 2125 | `[代理桥] 软件内置中转，自动探测出海端口` | ★「代理桥」= 本地中转，不是节点服务 |
| 4935 | `未开启，也未找到 17896/17897/7897 等可用端口。请先启动 Clash/OpenBrowser` | ★探测端口集合 = 17896 / 17897 / 7897；找不到就叫你**先启动 Clash** |
| 2152 | `中转未开(试17896)` | 17896 是首选「本地中转」端口 |
| 881 | `http://127.0.0.1:7897` | 取CK 默认「本机代理」地址（Clash Verge 默认混合口） |
| 4928 | `HTTP/1.1 200 Connection Established\nProxy-Agent: DolaMultiBrowser\n\n` | Dola 自己**就是一个 HTTP CONNECT 代理服务端**（桥） |
| 2127-2128 | `Proxy-Authorization: Basic` / `Proxy-Connection: Keep-Alive` | 桥对上游用 Basic 认证 + Keep-Alive |
| 1835-1847 | `clash` `mihomo` `wintun` `tunnel` `sing-box` `singbox` `wireguard` `v2ray` `xray` `nekoray` `outline` `tap-windows` `vpn` | 只是**识别/探测**这些代理软件，不是内置它们 |
| 2830-2837 | `Clash默认 / 直连 / 韩国 / 日本 / 德国 / 英国 / 新加坡 / 自定义分组` | **Clash 的 proxy-group 名称映射**（你 Clash 里得有这些组），不是自带节点 |
| 1848-1849 | `[本机网络] 国内实例直接使用本机网络，不经过代理` + `direct://` | 国内实例直连模式 |
| 1325 | `ISP代理只配置了功能，自行研究使用` | ★静态 ISP 要自己买，Dola 只给填写框 |
| 2824 | `远程静态 ISP 代理请选 HTTP，当前为 HTTPS 可能导致连接失败` | 静态 ISP 规格建议 |
| 2857-2859 | `系统代理 127.0.0.1:… 只指向这台虚拟机，Mac 上也没打开。请在 Clash 打开允许局域网` | 会去探 Parallels/VM 的 Mac 侧 Clash（`10.211.55.1/2`、`10.37.129.1/2`） |
| 2873-2890 | `ProxyEnable` / `ProxyServer` / `AutoConfigURL`（注册表 Internet Settings） | 读系统代理 |
| 2158-2163 | `ipify` / `ipwho` / `https://api.ipify.org?format=json` / `https://ipwho.is/` | 桥的出口校验探针（与本仓库实现一致） |
| 1882-1883 | `--no-proxy-server` / `--proxy-server=` | 实例按代理开关注入 Chrome 参数 |
| 4065 | `未扫到本机代理端口。请打开代理软件的混合端口或系统代理；只开 TUN 时没有端口可填` | 「只开 TUN 扫不到端口」的根因说明 |

**没有找到**：`vless/trojan/vmess/ss:///subscribe?token/*.yaml/机场/节点订阅` 之类的内置节点或订阅痕迹 ⇒ **Dola 无内置免费节点**。

## 二、代理桥的实际行为（拼出来的流程）

```
实例 Chrome --proxy-server=http://127.0.0.1:<桥端口>
        │
        ▼
[Dola 代理桥（自己是 CONNECT 代理，Proxy-Agent: DolaMultiBrowser）]
        ├─ 模式A 静态ISP：CONNECT 你填的主机:端口（Basic 认证）→ 取CK 用（要求 HTTP 类型；必须开 TUN）
        └─ 模式B 本地中转：自动探测本机端口（17896 → 17897 → 7897 → 系统代理 …）
                 └─ 命中即转发；命中不了就报「请先启动 Clash/OpenBrowser」
出口校验：api.ipify.org / ipwho.is  → 记录 出口IP / 国家 / 延迟 / 协议
```

失败语义（可用于排障）：`403 代理403(源IP被拒)` / `407 认证407` / `隧道失败` / `连接中断(请改选HTTP类型)` /
`大陆IP被代理商屏蔽，请在代理商后台加白名单或换海外网络`。

## 三、本机实测：Dola 的默认端口在本机是「空的」

```
17896 -   17897 -   7897 -   7890 -   2801 -   1080 -      ← 全部未监听
10090 LISTEN（mihomo 混合口，本机真实出口 JP 213.218.254.4）
```
⇒ Dola 用默认列表探测这台机器会**扫不到**（它的列表里没有 10090）—— 这就是「为什么 Dola 里代理桥老是说没端口」。

## 四、零成本落地（本机已实测通过）

**思路反过来用**：不是让 Dola 去找到 10090，而是**把我们自己的代理桥挂在 Dola 认的端口 17896 上**。

```bash
# ① 扫描本机出海口（含 Dola 的 17896/17897/7897 全清单）
node scripts/h3-proxy-scan.js --extra 17896
#   OK 127.0.0.1:10090  -> 213.218.254.4 Japan  (真实出口)
#   OK 127.0.0.1:17896  -> 213.218.254.4 Japan  (我们的桥)

# ② 把桥挂到 Dola 认的 17896，上游=真实出口
node scripts/h3-proxy-bridge.js --port 17896 --upstream http://127.0.0.1:10090
```
实测：
```
curl -x http://127.0.0.1:17896 http://ip-api.com/json   -> {"country":"Japan","query":"213.218.254.4"}
curl -x http://127.0.0.1:17896 https://hailuoai.video   -> 200
[代理桥] -> ip-api.com:80 (#live=1) / -> hailuoai.video:443 (#live=2)
```
⇒ 此时 Dola 的「本地中转」端口 17896 **就有进程应答了**，Dola 代理桥/实例填 `127.0.0.1:17896` 即可直接用；而且它同时是 HTTP + SOCKS5（Dola 挑混合口也行）。

## 五、成本对比（爷爷关心的「一定要低成本/没成本」）

| 方案 | 成本 | 稳定性 | 说明 |
|---|---|---|---|
| **A. 复用本机已有机场**（桥到 17896/18082） | **￥0（已有成本）** | 高 | ★本次落地；Dola/H3 共用一条或按实例分流 |
| **B. 自建 VPS 隧道**（`ysd-gw-server.js`） | 海外 VPS 约 $3~5/月 | 高 | 已跑通国内节点；海外节点需再买 1 台（当前国内那台到不了 Google） |
| **C. 免费公共代理/免费机场** | ￥0 | **极低** | 公共免费代理寿命以小时计、且大量已被封/被投毒，Dola 场景会直接 403/超时；不建议 |
| **D. 便宜静态 ISP 代理** | 约 $0.7~3/IP·月（或按流量） | 高 | 取CK/养号场景值；Dola 只提供填写，要自己买 |
| **E. 直连（`[本机网络]`/`direct://`）** | ￥0 | — | 国内实例（豆包）用；海外站不行 |

**一句话**：Dola 的代理节点「怎么实现」= **它不实现节点，只做本机中转**；
想让 Dola 有出口、又不花钱，就用 **A**（本机已有出口 → 桥到 17896）。

## 六、可复现命令（本仓库）

```bash
node scripts/h3-proxy-scan.js --extra 17896                    # ① 找出口（已含 Dola 端口清单）
node scripts/h3-proxy-bridge.js --port 17896 --upstream http://127.0.0.1:10090   # ② 桥到 Dola 端口
node scripts/h3-proxy-bridge.js --port 18082                   # 或桥到通用端口给 H3 用（自动探测上游）
node scripts/dola-pool.js list                                 # ③ Dola 实例池健康
```