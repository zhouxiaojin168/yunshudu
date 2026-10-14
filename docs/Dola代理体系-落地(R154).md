# Dola 代理体系 → H3 落地（R154）

> 本文件把 DolaMultiBrowser 的**代理相关字符串证据**、以及「1+3+4」三件套落地物（代理桥 / 取CK独立出口 / 一号一出口）写实，附实测记录。

## 一、Dola 代理体系证据（`_ops/r142-us-heap.txt` 字符串堆，原样）

| 证据字符串 | 含义 |
|---|---|
| `ShowProxyControlCenterWindow` `BtnScanProxy_Click` `BtnCheckProxy_Click` `ProxyType_Changed` `OnProxyCenterEditRequested` `instanceProxyEnabled` | **代理控制中心**：增删改查 + 按实例启用 |
| `DetectLocalProxyPorts` `ProbeRemoteProxyHosts` `ExplainLocalProxy` `DescribeSystemProxyLine` `FindMacHttpProxy` | **自动扫描本机代理端口** + 探测远端 + 解释系统代理 |
| 「未扫到本机代理端口。请打开代理软件的混合端口或系统代理；**只开 TUN 时没有端口可填**」 | 扫描失败文案（只开 TUN 扫不到） |
| 「按主机、端口、账号、密码填写，**取CK时不走左侧代理。必须开启 TUN 模式**。测试不扣额度。」 | **取CK 用独立出口**，与实例浏览代理隔离 |
| 「走科学上网地址。测试不扣额度。**不要开 TUN**。」 | 第二种模式：复用系统科学上网 |
| 「代理端口没有响应，请先打开代理软件」/「请先在 Dola 分组「取CK设置」里填写静态 IP」 | 校验逻辑 |
| 「**[代理桥] 软件内置中转，自动探测出海端口**」 | ★内置代理桥 = 自动探测本机出海口并中转 |
| `wintun` / `tunnel` / `proxy tunnel` / `meta tunnel` | 内含 wintun/TUN 隧道（mihomo 式内核） |

实例级配置实证 `E:\dola2.5\dola\Dola-0N\proxy_config.json`：
```json
{"enabled":false,"type":"http","host":"","port":0,"username":"","password":"","remark":"",
 "useLocalChain":false,"localChainHost":"127.0.0.1","localChainPort":17896,"localChainType":"http"}
```
`useLocalChain` + `localChainPort=17896` = 实例级**链式代理**开关；netstat 实测 Dola(pid 3868) 只监听 `127.0.0.1:17823`，**17896 未监听**（本地链未启用）。

## 二、落地物 1：代理桥 `scripts/h3-proxy-bridge.js`

Dola「[代理桥] 软件内置中转，自动探测出海端口」的对位物：
- 自动扫描本机候选出海口（10090/7890/1080/10809… 共 14 个，可用 `--extra` 追加），逐个真连 `ip-api` 验证，命中即作为上游；
- 本机监听 `127.0.0.1:18082`，**同端口自动识别 HTTP 与 SOCKS5**（首字节 0x05 → SOCKS5，否则 HTTP；HTTP 支持绝对 URI 与 CONNECT）；
- 上游支持 `http://[u:p@]h:p` 与 `socks5://h:p` 两类；
- 探测结果写 `state/h3-bridge.json`。

```bash
node scripts/h3-proxy-bridge.js                                   # 自动探测 + 监听 18082
node scripts/h3-proxy-bridge.js --upstream socks5://127.0.0.1:18081
```
**实测**
```
[探测] OK 127.0.0.1:10090 -> 213.218.254.4  Japan  Alice Networks LTD
[代理桥] 上游 = http://127.0.0.1:10090
[代理桥] 监听 127.0.0.1:18082
curl -x http://127.0.0.1:18082      http://ip-api.com/json  -> {"country":"Japan","query":"213.218.254.4"}
curl --socks5-hostname 127.0.0.1:18082 http://ip-api.com/json -> {"country":"Japan","query":"213.218.254.4"}
curl -x http://127.0.0.1:18082      https://hailuoai.video/zh-Intl -> 200
[log] -> ip-api.com:80  / -> ip-api.com:80 / -> hailuoai.video:443
```
> 坑（已修）：双协议 sniff 用 `sock.once('data')` 拿到首包后**必须回灌给状态机**，否则整个请求停在首包里，连接永久挂起（表现为「端口 LISTENING 但任何请求都没响应、日志无记录」）。

## 三、落地物 2：取CK / 取号 走独立出口 `scripts/h3-proxy-fetch.js` + `--login-proxy`

- `scripts/h3-proxy-fetch.js`：零依赖 Node HTTP 客户端，支持 `http://` 与 `socks5://` 代理（CONNECT + TLS + Content-Length/Chunked 解析），命令行自检：
  ```bash
  node scripts/h3-proxy-fetch.js http://ip-api.com/json/?fields=query http://127.0.0.1:18082
  ```
- `scripts/h3-batch-login.js` 新增 `--login-proxy <url>`（或账号字段 `login_proxy`）：用 Playwright `ctx.route('**/*')` 把
  `securetoken.googleapis.com` / `identitytoolkit.googleapis.com` / `/v1/api/user/login*` 三类请求**改道**到独立出口（Node 侧 `proxyFetch` 转发后 fulfillment 回填），
  其余浏览流量仍走实例自己的 `proxy_config.json` 出口。⇒ 这正是 Dola「**取CK时不走左侧代理**」的对位实现。
- 状态文件 `login_state.json` 新增 `login_proxy_used` / `ck_routes` 字段留证。

## 四、落地物 3：一号一出口（两实例两出口）实测

输入 `_ops/r154-two-exits.jsonl`：
```json
{"label":"exitA-jp10090","kind":"refresh","refreshToken":"<FB refreshToken>","site":"intl","proxy":"http://127.0.0.1:10090"}
{"label":"exitB-cn18081","kind":"refresh","refreshToken":"<FB refreshToken>","site":"intl","proxy":"socks5://127.0.0.1:18081"}
```
运行：
```bash
node scripts/h3-batch-login.js --in _ops/r154-two-exits.jsonl --concurrency 2 --login-proxy http://127.0.0.1:18082
```
结果（2/2 成功）：
| 实例 | 浏览出口 | 实测 exitIp | 取CK出口 | 取CK 命中数 | credits |
|---|---|---|---|---|---|
| H3-001 | `127.0.0.1:10090` | **213.218.254.4 / Japan / Tokyo / ALICE NETWORKS** | 18082→JP | 3 | 150 |
| H3-002 | `127.0.0.1:18081` | **China / CN（浙江宁波电信）** | 18082→JP | 3 | 150 |

日志片段：
```
[exitA-jp10090] [取CK出口] POST https://securetoken.googleapis.com/v1/token?key=... -> HTTP 200 via http://127.0.0.1:18082
[exitA-jp10090] [取CK出口] POST https://hailuoai.video/v1/api/user/login?...        -> HTTP 200 via http://127.0.0.1:18082
[exitB-cn18081] [取CK出口] POST https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=... -> HTTP 200 via http://127.0.0.1:18082
```
> 关键：H3-002 的浏览出口在**国内服务器**（到不了 Google），但 `securetoken` 仍然拿到了 200 —— 因为取CK被改道到 JP 出口。这正是「取CK 与 实例浏览出口解耦」的价值。

## 五、自建出口：明文 HTTP 代理被 IDC DPI 拦 → 改自定义 TCP 隧道（已通）

- 先验（失败）：`scripts/simple-http-proxy.js` 部署到 `114.66.16.225`，端口 18080 / 38471 均被注入「该网站暂无法访问…尚未备案或接入」拦截页 ⇒ **该 IDC 对明文 HTTP 代理做 DPI**（与端口无关）。
- 改法（成功）：`ysd-gw-server.js`（服务器侧裸 TCP 中继，私有握手 `GW1 <token> <host> <port>\n` → `GW1 OK\n`）+ `ysd-gw-client.js`（本机监听 `127.0.0.1:18081`，提供无鉴权 SOCKS5，逐连接透传）。
- 实测：`curl -x socks5h://127.0.0.1:18081 http://ip-api.com/json` → `114.66.16.225 / China Telecom`（= 服务器出口）；本机直连为 `125.64.200.169`，JP 为 `213.218.254.4` ⇒ 三条出口互相独立。

## 六、服务器（114.66.16.225）可达性实测（决定它能不能当出口）

| 目标 | 结果 |
|---|---|
| `https://hailuoai.video/`（node https.get） | **HTTP 200**（能用；PowerShell/.NET 报 TLS 错属 .NET 侧问题） |
| `https://hailuoai.com/`（node） | **HTTP 200** |
| `https://securetoken.googleapis.com/v1/token` | **TIMEOUT（不可达）** |
| `https://www.google.com/` | **TIMEOUT（不可达）** |

⇒ 国内服务器可当**海螺站点访问出口**（含生视频/生图/额度查询），但**不能**承担 Google/Firebase 换 token 那一步 —— 故取CK必须另走海外出口（本方案已实现）。

## 七、下一步（待爷爷点单）

1. **4 号** Dola 实例当浏览器池（CDP）：Dola 实例当前不开放 `--remote-debugging-port`，需研究「Dola 启动参数注入 CDP 端口」或直接用抠出的 13 条反检测脚本自建池。
2. **海外出口扩容**：目前只有 1 条海外出口（`127.0.0.1:10090` JP）。要真正「一号一海外出口」，需买海外 VPS 跑 `ysd-gw-server.js`（同样的隧道协议，DPI 不拦）。
3. 代理桥接进批量引擎：`--proxy http://127.0.0.1:18082` 即默认走桥；配合 `h3-proxy-scan.js --assign` 做自动分配。