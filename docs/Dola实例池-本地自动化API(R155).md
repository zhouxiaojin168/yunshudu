# Dola 实例池：本地自动化 API（R155）

> 结论先行：**Dola 实例不需要 CDP 就能当「浏览器池」** —— 它自带本地 HTTP 自动化服务（默认 `127.0.0.1:17823`，端口写在 `dola_port.json` / `config.json.automationPort`），
> 由内嵌插件 `zizi-plugin/dola_browser_bridge`（Python，仅标准库）驱动，走 `/api/*`。

## 一、接口清单（实测）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 实例清单：`{ok,version,instances:[{id,name,platform,running,current}]}` |
| POST | `/api/instance/ensure` | 未启动实例自动拉起；body `{instance_id, instance_name}` |
| POST | `/api/panel/sync` | 粘贴文案/参考图；body 见下；未启动实例也会自启 |
| POST | `/api/panel/generate` | 同上但 `auto_send=true`，发送后等待生成（并可选下载 mp4） |
| POST | `/api/task/wait-video` | 等待生成完成/回传 mp4；body `{instance_id, timeout_seconds, output_dir}` |

**请求体字段名（以 `dola_browser_bridge/main.py` 为准，**snake_case**）**
```json
{
  "instance_id": "Dola-01",
  "instance_name": "Dola-01",
  "text": "视频提示词…",
  "image_paths": ["D:\\ref\\a.png"],
  "auto_send": false,
  "use_30s": false,
  "clear_first": false,
  "timeout_seconds": 600,
  "output_dir": ""
}
```
> 坑：最初按 camelCase（`instanceId` / `autoSend`）POST，接口**不报错但静默落到 current 实例**（返回 `Dola-03`）。
> 改用 `instance_id` 后定向正确（返回 `Dola-01`）。

实测返回样例：
```
GET  /api/health            -> {"ok":true,"version":"2.6.1","instances":[{"id":"Dola-01",...,"running":true},...]}
POST /api/instance/ensure   -> {"ok":true,"instanceId":"Dola-01","name":"Dola-01","running":true,"current":true}
POST /api/panel/sync {}     -> {"ok":true,"instanceId":"Dola-01","images":0,"textChars":0,"autoSend":false,"use30s":false}
POST /api/panel/generate {} -> {"ok":false,"message":"panel/generate 需要 auto_send=true（发送后才会等待生成）"}
POST /api/paste /api/instances -> 404 {"ok":false,"message":"未知接口"}
```

## 二、本仓库交付：`scripts/dola-pool.js`

```
node scripts/dola-pool.js list                                          # 实例清单（platform/running/current）
node scripts/dola-pool.js ensure --instances Dola-01,Dola-02            # 未启动就拉起
node scripts/dola-pool.js send --text "一只猫在雪地奔跑" --instances Dola-01,Dola-02 \
     [--image D:\ref\a.png] [--auto-send] [--clear-first] [--use-30s] [--wait --timeout-seconds 600 --output-dir D:\videos]
node scripts/dola-pool.js distribute --in prompts.jsonl [--field text] [--auto-send] [--instances Dola-01,Dola-02]
```
- `distribute` 遵循 Dola 插件规则：**每实例最多一条**，按顺序一一对应；分镜多于实例时提示剩余条数。
- 环境变量：`DOLA_HOST`（默认 127.0.0.1）、`DOLA_PORT`（默认 17823）。

## 三、与「代理」的关系（R154 联动）

- 实例级出口在 `Dola-0N/proxy_config.json`（`enabled/type/host/port/username/password/useLocalChain/localChainPort`），
  本仓库 `scripts/h3-proxy-scan.js --assign` 就是按这个文件结构写回（Dola 同构字段）。
- 代理桥 `scripts/h3-proxy-bridge.js` 产出的 `127.0.0.1:18082` 可直接填进 Dola 实例代理，或给 H3 实例用。
- 于是三件事串成一条线：**出口探测/桥（1）→ 取CK独立出口（3）→ 一号一出口（4）**，Dola 侧与 H3 侧字段同构，可直接互搬。

## 四、下一步

1. 用 `dola-pool.js distribute` 真跑一轮「分镜 → 多实例 → 等成片 → 下载 mp4」（会消耗 Dola 额度，需爷爷点单）。
2. 把 Dola 实例池做成 H3 号池的**冗余算力**（同一提示词双跑）或**并行加速**（一分镜一实例）。