# API 调取说明（R140）

## 0. 谁提供 API
| 层 | 地址 | 作用 |
|---|---|---|
| 平台池（本命） | `http://127.0.0.1:9940`（本机）/ `http://114.66.16.225:9940`（服务器） | N 个海螺号汇成池，对签发 `sk-hl-` Key 供算力 |
| new-api（对外的老门面） | `http://127.0.0.1:3000` / `http://114.66.16.225:3000` | 渠道 #15 指向池子，OpenAI 兼容 `/v1/...` |

→ **推荐直连池子**（少一跳、计费口径清楚）；要跟别家模型混着卖就走 new-api。

## 1. 拿一个池子 Key（管理员操作）
```bash
curl -s -X POST http://127.0.0.1:9940/pool/keys \
  -H "x-admin-key: <H3P_ADMIN_KEY>" \
  -H "content-type: application/json" \
  -d "{\"label\":\"customer-001\",\"credits\":100}"
# -> {"ok":true,"key":"sk-hl-xxxxxxxx..."}
```
兑换码两连（给用户自助换 Key）：
```bash
# 铸码：
curl -s -X POST .../v1/redeem-codes/mint -H "x-admin-key: <KEY>" -d "{\"count\":10,\"credits\":120}"
# 用户兑换：
curl -s -X POST .../v1/redeem -d "{\"code\":\"HL-XXXXXX-YYYYYY\"}"
```

## 2. 出图（已实测跑通）
```bash
curl -s -X POST http://127.0.0.1:9940/v1/images/generations \
  -H "Authorization: Bearer sk-hl-xxxx" -H "content-type: application/json" \
  -d "{\"model\":\"all-in-one-image-pro\",\"prompt\":\"a samurai cat on a rooftop at sunset\",\"n\":1}"
# -> {"task_id":"task_7410f7ca8205","status":"processing","credits_charged":6,...}

# 轮询（异步，通常 20~40s）
curl -s http://127.0.0.1:9940/v1/video/generations/task_7410f7ca8205 \
  -H "Authorization: Bearer sk-hl-xxxx"
# -> {"status":"succeeded","video_url":"http://.../media/task_7410f7ca8205.jpg"}
```
> 生图结果统一叫 `video_url` 字段（历史命名，别被名字骗），图片就在里面。
> 打开 `H3P_DEWATERMARK=1`（默认开）时，`video_url` 指向**我们托管、已去水印**的成品图。

## 3. 可用模型名
**A. 上游真名（推荐，直接决定出什么图）**
| 传这个 model | 说明 | 成本 |
|---|---|---|
| `all-in-one-image-pro` | = 海外 nano-banana2 同款，1K/2K = 6 credit，4K = 10 | 6 |
| `seedream-4.5` | 2K | 4 |
| `gpt-image-1.5` | Medium | 8 |
| `image-01` | 1 credit（⚠ 上游对 body 挑剔，实测常 HTTP 400 code=2） | 1 |
**B. 站牌名（给新号池/展示用，`GET /v1/models` 返回的就是这批）**
`MiniMax-H3` / `H3-Max` / `Hailuo-2.3` / `MiniMax-Image` / `MiniMax-Speech` / `MiniMax-Music` / `MiniMax-M3` / `describe_images` / `search_images` / `reverse_image_search` / `listen_audio` / `videos_understand` / `audios_understand`

## 4. 其它只读接口
| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/v1/models` | Key | 模型列表 |
| GET | `/v1/models/<id>` | Key | 单个模型详情 |
| GET | `/v1/credits` | Key | 这个 Key 还剩多少 |
| GET | `/v1/quota` | Key | 剩多少 + 各模型还能跑几次 |
| GET | `/v1/public/stats` | 无 | 池子总览（额度/可出图数/24h 成功率） |
| GET | `/v1/public/models` | 无 | 模型 + 单价 |
| POST | `/v1/videos/query` | Key | 按 task_id 查 |
| GET | `/media/<file>.jpg` | 无 | 去水印成品图直链 |
| GET | `/healthz` | 无 | 存活探针 |

## 5. 管理接口（`x-admin-key: <H3P_ADMIN_KEY>`）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/pool/stats` | 账号明细 + `hours_left` + `expiry.expiring_soon` 到期预警 + `auto_prune` |
| POST | `/pool/accounts` | 加号 `{label,token,credits}` |
| POST | `/pool/accounts/bulk` | 批量加号 |
| POST | `/pool/accounts/delete` | 删号 `{id}` |
| POST | `/pool/accounts/prune` | 清 0 额度死号 |
| POST | `/pool/accounts/revive` | 复活被误判的号 |
| POST | `/pool/checkin` | 立刻全池探活/对齐余额 |
| POST | `/pool/keys` | 签 Key |

补号守护（`pool-supply`，默认 `:9950`，`x-admin-key` 同管理密钥）：
`GET /supply/stats`、`POST /supply/register {n}`、`POST /supply/import {accounts:[...]}`、`POST /supply/guard {force}`、`POST /supply/checkin`

## 6. 号池台账
```bash
node scripts/pool-ledger.js
node scripts/pool-ledger.js --pool http://114.66.16.225:9940 --key <admin-key>
node scripts/pool-ledger.js --json
```
输出每个号的 `credits / 可出图数 / 健康 / 到期时间 / 还剩几小时`，并汇总「合计额度、可出图数、每张图上游成本」。


## 3.1 模型名解析规则（R140b 修正，重要）

池子**按账号所在站的适配器模型表**查 `model`（`h3-platform-pool.js` -> `modelsOf(site)[model]`），查不到就回退到内置站牌价（`MiniMax-H3`=1000 credit/条）。

| 服务器/本地实际用的适配器 | 表里原本的键 | 现象 |
|---|---|---|
| `pool-adapter.hailuo-multi.json`（服务器在用，多站 cn+intl） | `MiniMax-Image` / `seedream-4.5` / `gpt-image-1.5` / `image-01` | 传上游真名 `all-in-one-image-pro` **查不到** -> 按 1000 credit 报价 -> `402 insufficient_quota: need 1000` |
| `pool-adapter.hailuo-web.json`（单站国内） | `all-in-one-image-pro` / ... | 传 `MiniMax-Image` 原本查不到 |

**R140b 已修**：三份适配器互相加别名，现在这些名字等价、都能用：

- 国内站：`MiniMax-Image` == `all-in-one-image-pro`（6 credit，1K/2K）
- 海外站：`MiniMax-Image` == `nano-banana2`（6 credit）
- 另有 `seedream-4.5`(4) / `gpt-image-1.5`(8) / `image-01`(1)

> 排查口诀：**402 报 need 1000 = 模型名没落到适配器表里**，不是额度不够、也不是上游挂了。
