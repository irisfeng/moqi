---
name: popular-web-designs
description: 54 套真实世界的设计系统(Stripe、Linear、Vercel、Notion、Apple…),以可直接粘贴的 HTML/CSS 形式提供 — 精确的颜色、字体排印、组件和间距,用于仿照某个知名品牌来设计页面样式。
---

# Popular Web Designs

54 套真实世界的设计系统,可在生成 HTML/CSS 时直接使用。每个模板都涵盖一个
网站完整的视觉语言:配色、字体层级、组件样式、间距
体系、阴影、响应式行为,以及带有精确 CSS 取值的实用智能体提示词。

## 默认风格优先

本技能用于用户希望页面仿照**某个特定知名品牌**的样式时。如果用户
没有指明品牌,请使用你所在部署的内部风格技能(已安装时,即技能索引中的 `*-design` 技能),
而不是从这个目录中挑选。

## 相关的设计技能

- **内部风格技能**(`*-design`,已安装时)— 组织的默认外观,以
  可直接套用的设计令牌形式提供。除非用户要求下面的某个特定品牌,否则使用它。
- **`taste-skill`** — 用于设计的_流程与品味_(阅读需求说明、
  产出多个变体、验证结果、避免 AI 设计的粗制滥造)。
  当用户希望得到一个精心设计、并仿照某个知名品牌样式的页面时,与本技能搭配使用:
  `taste-skill` 主导工作流程,本技能提供
  视觉词汇。

## 使用方法

1. 从下面的目录中选择一套设计
2. 阅读它:`skills({ action: "read", name: "popular-web-designs", path: "templates/<site>.md" })`
3. 生成 HTML 时使用其中的设计令牌和组件规范
4. 用 `files` 动作 `write` 构建,然后用 `publish` 技能提供生成的结果

每个模板的顶部都有一个**实现说明**块,其中包含:

- CDN 字体替代方案以及可直接粘贴的 Google Fonts `<link>` 标签
- 主字体和等宽字体的 CSS font-family 栈
- 提醒:创建 HTML 时使用 `files` 动作 `write`,并用本地无头 Chromium 进行验证

## HTML 生成模式

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Page Title</title>

    <link href="https://fonts.googleapis.com/css2?family=..." rel="stylesheet" />
    <style>
      :root {
        --color-bg: #ffffff;
        --color-text: #171717;
        --color-accent: #533afd;
      }

      body {
        font-family: "Inter", system-ui, sans-serif;
        color: var(--color-text);
        background: var(--color-bg);
      }
    </style>
  </head>
  <body></body>
</html>
```

用 `files` 动作 `write` 写入文件;写入、构建、预览和发布都使用同一个明确的 `sandbox_id`。
用 `execute` 运行 `curl -fsS http://localhost:<port>` 在本地验证,然后在
需要检查渲染效果时运行
`chromium --headless --no-sandbox --disable-gpu --screenshot=/tmp/page.png http://localhost:<port>`。
使用 `publish` 技能交付一个稳定的链接。

## 字体替代参考

大多数网站使用的专有字体无法通过 CDN 获得。每个模板都对应一个 Google Fonts
替代字体,以保留该设计的特色。常见的对应关系:

| 专有字体                  | CDN 替代字体                 | 特色                     |
| ------------------------- | ---------------------------- | ------------------------ |
| Geist / Geist Sans        | Geist (on Google Fonts)      | 几何感,紧凑的字距        |
| Geist Mono                | Geist Mono (on Google Fonts) | 简洁的等宽字体,带连字    |
| sohne-var (Stripe)        | Source Sans 3                | 轻盈优雅的字重           |
| Berkeley Mono             | JetBrains Mono               | 技术感的等宽字体         |
| Airbnb Cereal VF          | DM Sans                      | 圆润、友好的几何感       |
| Circular (Spotify)        | DM Sans                      | 几何感,温暖              |
| figmaSans                 | Inter                        | 干净的人文主义风格       |
| Pin Sans (Pinterest)      | DM Sans                      | 友好、圆润               |
| NVIDIA-EMEA               | Inter (or Arial system)      | 工业感,干净              |
| CoinbaseDisplay/Sans      | DM Sans                      | 几何感,值得信赖          |
| UberMove                  | DM Sans                      | 粗壮、紧凑               |
| HashiCorp Sans            | Inter                        | 企业风格,中性            |
| waldenburgNormal (Sanity) | Space Grotesk                | 几何感,略微收窄          |
| IBM Plex Sans/Mono        | IBM Plex Sans/Mono           | 可在 Google Fonts 上获得 |
| Rubik (Sentry)            | Rubik                        | 可在 Google Fonts 上获得 |

当模板的 CDN 字体与原字体一致时(Inter、IBM Plex、Rubik、Geist),不会
有替代带来的损失。当使用了替代字体时(用 DM Sans 替代 Circular,用 Source Sans 3
替代 sohne-var),请严格遵循模板中的字重、字号和字间距取值 —
它们比具体的字体字形更能体现视觉辨识度。

## 设计目录

### AI 与机器学习

| 模板             | 网站             | 风格                                 |
| ---------------- | ---------------- | ------------------------------------ |
| `claude.md`      | Anthropic Claude | 温暖的赤陶色强调色,干净的编辑式版面  |
| `cohere.md`      | Cohere           | 鲜艳的渐变,数据丰富的仪表盘美学      |
| `elevenlabs.md`  | ElevenLabs       | 深色电影感界面,音频波形美学          |
| `minimax.md`     | Minimax          | 大胆的深色界面,配霓虹强调色          |
| `mistral.ai.md`  | Mistral AI       | 法式工程化的极简主义,紫色调          |
| `ollama.md`      | Ollama           | 终端优先,单色的简洁                  |
| `opencode.ai.md` | OpenCode AI      | 以开发者为中心的深色主题,全等宽字体  |
| `replicate.md`   | Replicate        | 干净的白色画布,以代码为先            |
| `runwayml.md`    | RunwayML         | 电影感深色界面,媒体丰富的版面        |
| `together.ai.md` | Together AI      | 技术感,蓝图式设计                    |
| `voltagent.md`   | VoltAgent        | 虚空黑画布,翠绿色强调色,终端原生风格 |
| `x.ai.md`        | xAI              | 冷峻的单色,未来感极简主义,全等宽字体 |

### 开发者工具与平台

| 模板            | 网站       | 风格                                  |
| --------------- | ---------- | ------------------------------------- |
| `cursor.md`     | Cursor     | 流畅的深色界面,渐变强调色             |
| `expo.md`       | Expo       | 深色主题,紧凑的字距,以代码为中心      |
| `linear.app.md` | Linear     | 极致简约的深色模式,精准,紫色强调色    |
| `lovable.md`    | Lovable    | 俏皮的渐变,友好的开发者美学           |
| `mintlify.md`   | Mintlify   | 干净,绿色强调色,为阅读优化            |
| `posthog.md`    | PostHog    | 俏皮的品牌形象,对开发者友好的深色界面 |
| `raycast.md`    | Raycast    | 流畅的深色外框,鲜艳的渐变强调色       |
| `resend.md`     | Resend     | 极简深色主题,等宽字体点缀             |
| `sentry.md`     | Sentry     | 深色仪表盘,数据密集,粉紫色强调色      |
| `supabase.md`   | Supabase   | 深色翠绿主题,代码优先的开发者工具     |
| `superhuman.md` | Superhuman | 高端深色界面,键盘优先,紫色辉光        |
| `vercel.md`     | Vercel     | 黑白分明的精准,Geist 字体体系         |
| `warp.md`       | Warp       | 类 IDE 的深色界面,基于块的命令界面    |
| `zapier.md`     | Zapier     | 温暖的橙色,友好,由插画驱动            |

### 基础设施与云

| 模板            | 网站       | 风格                            |
| --------------- | ---------- | ------------------------------- |
| `clickhouse.md` | ClickHouse | 黄色强调色,技术文档风格         |
| `composio.md`   | Composio   | 现代深色,配彩色的集成图标       |
| `hashicorp.md`  | HashiCorp  | 企业级的简洁,黑白               |
| `mongodb.md`    | MongoDB    | 绿叶品牌形象,侧重开发者文档     |
| `sanity.md`     | Sanity     | 红色强调色,内容优先的编辑式版面 |
| `stripe.md`     | Stripe     | 标志性的紫色渐变,300 字重的优雅 |

### 设计与效率

| 模板           | 网站      | 风格                                   |
| -------------- | --------- | -------------------------------------- |
| `airtable.md`  | Airtable  | 多彩、友好,结构化数据的美学            |
| `cal.md`       | Cal.com   | 干净中性的界面,面向开发者的简洁        |
| `clay.md`      | Clay      | 有机的形状,柔和的渐变,艺术指导式的版面 |
| `figma.md`     | Figma     | 鲜艳的多色,俏皮而不失专业              |
| `framer.md`    | Framer    | 大胆的黑与蓝,动效优先,以设计为导向     |
| `intercom.md`  | Intercom  | 友好的蓝色调,对话式的界面模式          |
| `miro.md`      | Miro      | 明亮的黄色强调色,无限画布美学          |
| `notion.md`    | Notion    | 温暖的极简主义,衬线标题,柔和的表面     |
| `pinterest.md` | Pinterest | 红色强调色,瀑布流网格,图片优先的版面   |
| `webflow.md`   | Webflow   | 蓝色强调色,精致的营销网站美学          |

### 金融科技与加密货币

| 模板          | 网站     | 风格                                   |
| ------------- | -------- | -------------------------------------- |
| `coinbase.md` | Coinbase | 干净的蓝色形象,注重信任,机构气质       |
| `kraken.md`   | Kraken   | 紫色强调的深色界面,数据密集的仪表盘    |
| `revolut.md`  | Revolut  | 流畅的深色界面,渐变卡片,金融科技的精准 |
| `wise.md`     | Wise     | 明亮的绿色强调色,友好而清晰            |

### 企业与消费品

| 模板         | 网站    | 风格                                         |
| ------------ | ------- | -------------------------------------------- |
| `airbnb.md`  | Airbnb  | 温暖的珊瑚色强调色,摄影驱动,圆润的界面       |
| `apple.md`   | Apple   | 高端的留白,SF Pro,电影感的图像               |
| `bmw.md`     | BMW     | 深色的高端质感,精密工程美学                  |
| `ibm.md`     | IBM     | Carbon 设计系统,结构化的蓝色调色板           |
| `nvidia.md`  | NVIDIA  | 绿黑相间的能量感,技术力量美学                |
| `spacex.md`  | SpaceX  | 冷峻的黑白,满版图像,未来感                   |
| `spotify.md` | Spotify | 深色底上的鲜艳绿色,醒目的字体,由专辑封面驱动 |
| `uber.md`    | Uber    | 大胆的黑白,紧凑的字体,都市活力               |

## 选择设计

让设计与内容相匹配:

- **开发者工具 / 仪表盘:**Linear、Vercel、Supabase、Raycast、Sentry
- **文档 / 内容网站:**Mintlify、Notion、Sanity、MongoDB
- **营销 / 落地页:**Stripe、Framer、Apple、SpaceX
- **深色模式界面:**Linear、Cursor、ElevenLabs、Warp、Superhuman
- **浅色 / 简洁界面:**Vercel、Stripe、Notion、Cal.com、Replicate
- **俏皮 / 友好:**PostHog、Figma、Lovable、Zapier、Miro
- **高端 / 奢华:**Apple、BMW、Stripe、Superhuman、Revolut
- **数据密集 / 仪表盘:**Sentry、Kraken、Cohere、ClickHouse
- **等宽字体 / 终端美学:**Ollama、OpenCode、x.ai、VoltAgent
