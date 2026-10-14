# 国产模型供应商预设（qm-cn）

五家供应商的 custom provider 注册模板。每个 `<slug>.json` 就是 `PUT /v1/admin/custom-providers/<slug>` 的请求体
（apiKey 由导入脚本注入，不落文件）。模型卡镜像自 pi-ai 0.82 内置目录（`@earendil-works/pi-ai/dist/providers/*.models.js`），
compat 旗标、思考档位映射、价格与官方目录逐字段一致。

## 导入

key 放在 `../.env`（复制 `../.env.example`，已被 `*.env` ignore 规则忽略，永不入库）：

```bash
cp ../.env.example ../.env    # 填入 DEEPSEEK_API_KEY 等
node --env-file=../.env import.mjs deepseek    # 或省略参数导入全部；导入需同时设置 CORE_URL/CORE_SIGNING_SECRET
```

或在 admin 面板的 custom-providers 页面手工粘贴模板内容（粘贴前补上 apiKey）。

## 供应商速览

| 模板                   | baseUrl                                             | 计费                                               | validate                                           | 备注                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deepseek.json`        | `https://api.deepseek.com`                          | 按量，USD 已填（官网高峰价，核对日期 2026-10-11）  | ✅ `/models` 可用                                  | **默认推荐**：主力 `deepseek-v4-pro`，省钱且能看图 `deepseek-flash`（旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 已由它承接）                                                                                                |
| `qwen.json`            | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 按量（百炼价格页填入 `input`/`output`，模板暂 0）  | ✅                                                 | `qwen3.8-max-preview` 为预览模型，需百炼控制台开通（未开通返回 403 `access_denied`，2026-08-21 实测）；`qwen3.7-max`/`qwen3.6-flash` 开箱可用。套餐制可换 baseUrl 为 `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` |
| `zhipu-glm.json`       | `https://open.bigmodel.cn/api/coding/paas/v4`       | 编码套餐月费（token 不计量，模板 0）               | ❌ 端点无 `/models` 列表，已设 `"validate": false` | 主力 `glm-5.3-flash`（多模态，1M 上下文）。同一把 key 两端点通用，coding 端点优先扣套餐；标准按量端点改为 `https://open.bigmodel.cn/api/paas/v4`（**没有** `/v1` 后缀）并恢复 validate                                                    |
| `moonshot-kimi.json`   | `https://api.moonshot.cn/v1`                        | 按量，USD 已填（pi-ai 卡价，核对日期 2026-08-21）  | ✅                                                 | `kimi-k3` 旗舰，`kimi-k2.7-code` 编码特化                                                                                                                                                                                                 |
| `volcengine-ark.json`  | `https://ark.cn-beijing.volces.com/api/v3`          | 按量（价格以方舟控制台为准）                       | ❌ 已设 `"validate": false`                        | 模型 id 是推理接入点 `ep-xxxx`（或模型名），**必须先替换占位符**再导入                                                                                                                                                                    |
| `openrouter-free.json` | `https://openrouter.ai/api/v1`                      | 按量，USD 已填（OpenRouter 卡价，核对 2026-08-27） | ✅                                                 | `z-ai/glm-5.3-flash`（Ox Alpha 匿名周免的后继）。可选的备用模板；key 走 `OPENROUTER_TEST_KEY`                                                                                                                                             |

## 字段说明

- `input`/`output`/`cacheRead`/`cacheWrite`：每百万 token 的 **USD** 单价（预算与成本面板按此计量）。
- `reasoning` + `compat.thinkingFormat`：思考链模型的开关与线格式（`deepseek`/`zai`/`qwen` 均为 pi-ai 一等格式）。
- `thinkingLevelMap`：pi 的思考档位到供应商参数值的映射。
- `modalities`：模型接受的模态（输出时映射为 pi 的 `input` 字段；与成本字段 `input` 重名故在模板侧改名）。

## 注册后验证

跑冒烟矩阵：`node ../scripts/provider-smoke.mjs <模板.json>`。
