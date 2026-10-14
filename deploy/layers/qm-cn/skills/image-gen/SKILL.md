---
name: image-gen
description: AI 图像生成（火山方舟 Seedream/豆包，国内直连）。根据文字描述生成图片：插画、配图、封面、海报、示意图、照片风格化等。需要 $ARK_API_KEY；密钥未注入时如实告知用户需管理员在后台配置。生成结果保存为 PNG/JPG。
---

# 图像生成（image-gen）

调用火山方舟 Seedream 文生图接口，国内网络直连。

## 前置检查（每次必做）

    [ -n "$ARK_API_KEY" ] && echo HAS || echo EMPTY

输出 EMPTY 时：告诉用户"图像生成密钥未配置，请联系管理员在后台 → Governance → Credentials 添加 ARK_API_KEY"，不要尝试任何请求。

## 生成

    curl -s -m 120 -X POST "https://ark.cn-beijing.volces.com/api/v3/images/generations" \
      -H "Authorization: Bearer $ARK_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{
        "model": "doubao-seedream-5-0-260128",
        "prompt": "<用户的描述，中英文均可；写清主体、风格、构图、光线>",
        "size": "2048x2048",
        "response_format": "url"
      }'

- 响应 `data[0].url` 为图片地址：`curl -s -m 60 -o 图名.png "<url>"`
- 默认模型 ID：`doubao-seedream-5-0-260128`；用户明确需要 Pro 时使用 `doubao-seedream-5-0-pro-260628`。展示名称不等于 API ID，不要省略日期后缀或自行添加 `lite`。
- 首次使用当前账号或返回模型不存在/未开通时，查询 `GET https://ark.cn-beijing.volces.com/api/v3/models?limit=200`（使用相同的 Authorization），核对接口返回的完整 ID；目录有后续页时继续查询，不要仅凭第一页判断模型不存在。也可在火山方舟控制台确认已开通模型。
- 上述 ID 仍须以当前账号的目录和权限为准。目录可见不代表已获调用权限；找不到目标模型或无权调用时，停止并请管理员确认，不猜测 ID，不按日期自动选择其他模型，不自动升级到 Pro。费用以该账号控制台为准。
- 若返回 `b64_json`，先将成功响应保存为 `response.json`，再执行：`python3 -c 'import json,base64,sys; sys.stdout.buffer.write(base64.b64decode(json.load(open("response.json"))["data"][0]["b64_json"]))' > 图名.png`
- 常用尺寸：2048x2048（方图）、2304x1728（横）、1728x2304（竖）、1280x720（横屏封面）
- 401/403 = 密钥问题，如实转告；429 = 限流，等 30 秒最多重试 1 次
- 单轮最多生成 4 张

## 交付

    cp 图名.png "$AGENT_OUTBOX/"

**群 / 频道里 outbox 不生效**：文件放普通工作区路径，发消息时在 post 的 `files` 参数里带上。命名与话术统一见 artifact-delivery 技能。并在回复中说明图片内容与文件名。需要多张不同方案时，改写 prompt 分别调用。

## 纪律

- 人物肖像类请求注意：不生成真实特定人物的逼真形象
- 生成失败不要反复轰炸，如实说明原因
