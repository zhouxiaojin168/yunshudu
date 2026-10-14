# Dola 代理「怎么走」实测铁证 + 移植到海螺 H3 海外（R157）

> 本篇是 R156 的**实测补完**：R156 用字符串取证得出「Dola 只做本机中转」，本篇用**进程命令行 + 桥日志 + H3 实跑**把整条链路钉死。

## 一、铁证：Dola 实例的代理是注入到 WebView2 的 `--proxy-server`

实验步骤（可复现）：
1. 备份并改写 `E:\dola2.5\dola\Dola-01\proxy_config.json`：
   ```json
   {"enabled":true,"type":"http","host":"127.0.0.1","port":17896,"username":"","password":"",
    "remark":"r157-bridge17896","useLocalChain":false,"localChainHost":"127.0.0.1","localChainPort":17896,"localChainType":"http"}
   ```
2. **只重启该实例（kill 它的 msedgewebview2 后用 `/api/instance/ensure` 拉起）→ 命令行里没有 `--proxy-server`**（说明单改文件+重开实例不够，主程序内存态优先）。
3. **重启整个 DolaMultiBrowser**（`taskkill /PID <主> /T /F` + 重新启动 exe）→ 再 `ensure` 拉起实例 → **命令行出现**：
   ```
   msedgewebview2.exe --embedded-browser-webview=1 --webview-exe-name=DolaMultiBrowser.exe
     --webview-exe-version=2.6.3.0
     --user-data-dir="E:\dola2.5\dola\Dola-01\EBWebView\EBWebView"
     --proxy-server=http://127.0.0.1:17896        ← ★★★
     --silent-debugger-extension-api --lang=zh-CN
   ```
   （未启用代理时对应参数是 `--no-proxy-server`，即字符串里的 `[本机网络] 国内实例直接使用本机网络`。）
4. **端到端流量证明**（我们的桥 17896 日志，全部来自 Dola-01 实例）：
   ```
   -> www.dola.com:443 / -> mcs-nontt.dola.com:443 / -> wss-normal-i18n.dola.com:443
   -> mon-sg.byteintlapi.com:443 / -> vmweb-sg.ciciai.com:443 / -> vcs.zijieapi.com:443
   -> p16-flow-image-sign.ibyteimg.com:443 / -> www.google-analytics.com:443 / -> www.google.com:443
   ```

### ⇒ Dola 代理「怎么走」的完整链路
```
Dola-0N/proxy_config.json  (enabled / type / host / port / user / pass)
        │  ← 主程序启动时读取（改文件需重启主程序；UI 保存走内存态）
        ▼
实例 WebView2 启动参数 --proxy-server=http://<host>:<port>   (+Proxy-Authorization: Basic)
        ▼
流量 → 该端点（本机机场混合口 / 自建 VPS 隧道 / 静态 ISP / 免费公共）
        ▼
出口校验：api.ipify.org + ipwho.is → 记录 出口IP / 国家 / 延迟
```
补充事实：本次实验顺带观察到 **Dola 自动升级 2.6.1 → 2.6.3**（WebView2 runtime 154.0.4258.62 → **155.0.4283.45**）。

## 二、「节点」是什么样、怎么来的

| 维度 | Dola 认的形态 | 来源 | 成本 |
|---|---|---|---|
| 协议 | `http`（含 CONNECT，**首选**）/ `socks5`/混合口；「静态 ISP」明确提示**必须选 HTTP** | 你自备 | — |
| 地址 | `host` + `port`（本机 `127.0.0.1:7897/17896/17897` 或远端 IP:端口） | 本机代理软件 / 你买的代理 | — |
| 认证 | `username` + `password` → 下游用 `Proxy-Authorization: Basic` 转发 | 同上 | — |
| 链式 | `useLocalChain` + `localChainHost/Port/Type`（默认 `127.0.0.1:17896`, http） | 本机已有出口再套一层 | ￥0 |
| 分组 | Clash 的 proxy-group 名称映射：`Clash默认 / 直连 / 韩国 / 日本 / 德国 / 英国 / 新加坡 / 自定义分组` | **你 Clash 里的分组**，Dola 不提供节点 | 你机场的钱 |
| 静态 ISP | 主/端口/账号/密码，推荐 HTTP 类型（住宅 IP） | 要自己买（原文：`ISP代理只配置了功能，自行研究使用`） | $0.7~3/IP·月 |
| 探针 | `api.ipify.org` / `ipwho.is`，识别 `403 源IP被拒` / `407 认证` / `隧道失败` / `大陆IP被代理商屏蔽` | — | — |

**结论**：Dola **节点来源 = 你已有的出口**（本机机场最典型），Dola 自己 **0 成本**；它只提供「填写 + 转发 + 探测 + 校验」。

## 三、移植到海螺 H3 海外（同款链路，已实测）

把 Dola 的形态照搬到 H3：**本地桥（Dola 认的端口） → 已有出口 → H3 实例**。

```bash
# 桥A：Dola 认的 17896，上游 = 本机机场（JP）
node scripts/h3-proxy-bridge.js --port 17896 --upstream http://127.0.0.1:10090
# 桥B：Dola 次选 17897，上游 = 自建 VPS 隧道（CN）
node scripts/h3-proxy-bridge.js --port 17897 --upstream socks5://127.0.0.1:18081
# H3 海外批量登录：实例分别走两条桥，取CK另走独立出口
node scripts/h3-batch-login.js --in _ops/r157-h3-two-bridges.jsonl --concurrency 2 --login-proxy http://127.0.0.1:18082
```
实测结果（2/2 成功，海外站 hailuoai.video）：

| 账号 | 实例 | 实例出口（Dola 同款链路） | 实测 exitIp | 取CK出口 | credits |
|---|---|---|---|---|---|
| H3via17896-JP | H3-001 | `127.0.0.1:17896` → 机场 | **213.218.254.4 / Japan / Tokyo / ALICE NETWORKS** | 18082 → JP | 150 |
| H3via17897-CN | H3-002 | `127.0.0.1:17897` → 自建隧道 | **114.66.16.225 / China（浙江宁波电信）** | 18082 → JP | 150 |

⇒ **H3 海外站已经跑在「Dola 同款代理形态」上**：实例级 `--proxy-server` 等效（Playwright `proxy:` 参数）、桥端口与 Dola 认的端口一致、取CK独立出口、一号一出口。

## 四、现状（本机正在跑的进程）

| 进程 | 端口 | 上游 | 说明 |
|---|---|---|---|
| bridge | `127.0.0.1:17896` | http://127.0.0.1:10090 | ★Dola-01 实例正在用（已写入 proxy_config.json） |
| bridge | `127.0.0.1:17897` | socks5://127.0.0.1:18081 | 第二出口（CN 自建隧道） |
| bridge | `127.0.0.1:18082` | 自动探测(JP) | H3 取CK 独立出口 |
| ysd-gw-client | `127.0.0.1:18081` | TCP 隧道 → 114.66.16.225:38472 | 自建出口（DPI 安全） |

回滚 Dola 配置：`E:\dola2.5\dola\Dola-01\proxy_config.json.bak-r157`（原始为 `enabled:false`）。

## 五、下一步

1. Dola-02 / Dola-03 也指向 17896（或分别指向 17897 做一号一出口）
2. 把桥做成开机自启（计划任务）+ 上游切换脚本（JP/CN/静态ISP 一键切）
3. 海外 VPS 上跑 `ysd-gw-server.js` 扩海外出口（真正「一号一海外出口」）