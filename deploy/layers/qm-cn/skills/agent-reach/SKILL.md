---
name: agent-reach
description: >
  让你的 AI 助手拥有看遍整个互联网的眼睛。
  通过 CLI、MCP、curl 和 Python 脚本覆盖 17 个平台。
  8 个通道零配置。

  【路由方式】SKILL.md 包含路由表和常用命令，复杂场景需按需阅读对应分类的 references/*.md。
  分类：search / social (小红书/抖音/微博/推特/B站/V2EX/Reddit) / career(LinkedIn) / dev(github) / web(网页/文章/公众号/RSS) / video(YouTube/B站/播客).

  当用户要求在任何受支持的平台搜索、阅读或互动，
  分享某个 URL，或要求搜索网页时使用。
triggers:
  - search: 搜/查/找/search/搜索/查一下/帮我搜
  - social:
      - 小红书: xiaohongshu/xhs/小红书/红书
      - 抖音: douyin/抖音
      - Twitter: twitter/推特/x.com/推文
      - 微博: weibo/微博
      - B站: bilibili/b站/哔哩哔哩
      - V2EX: v2ex
      - Reddit: reddit
  - career: 招聘/职位/求职/linkedin/领英/找工作
  - dev: github/代码/仓库/gh/issue/pr/分支/commit
  - web: 网页/链接/文章/公众号/微信文章/rss/读一下/打开这个
  - video: youtube/视频/播客/字幕/小宇宙/转录/yt
  - finance: 雪球/股票/stock/xueqiu/行情/基金
metadata:
  openclaw:
    homepage: https://github.com/Panniantong/Agent-Reach
---

# Agent Reach — 路由器

17 平台工具集合。根据用户意图选择对应分类。

## 当前部署网络边界（先读这段）

本部署运行在国内网络，无法访问 GitHub / Twitter / Reddit / YouTube / LinkedIn，
也没有 Exa MCP。选择通道前先对照：

- **可用（国内直连）**：V2EX、抖音、B站、微信公众号文章、微博、小宇宙播客、雪球
- **可能可用但不稳**：r.jina.ai 阅读代理（失败时改用下方兜底）
- **不可用，不要尝试**：github(gh)、twitter/x、reddit、youtube、linkedin、exa/mcporter
- **通用网页搜索兜底**：用 `web-search` 技能（必应中国/百度/博查），不要用本技能的 search 分类
- 用户要求访问"不可用"通道时，如实说明网络限制，不要反复重试

## 路由表

| 用户意图                              | 分类   | 详细文档                                     |
| ------------------------------------- | ------ | -------------------------------------------- |
| 网页搜索/代码搜索                     | search | [references/search.md](references/search.md) |
| 小红书/抖音/微博/推特/B站/V2EX/Reddit | social | [references/social.md](references/social.md) |
| 招聘/职位/LinkedIn                    | career | [references/career.md](references/career.md) |
| GitHub/代码                           | dev    | [references/dev.md](references/dev.md)       |
| 网页/文章/公众号/RSS                  | web    | [references/web.md](references/web.md)       |
| YouTube/B站/播客字幕                  | video  | [references/video.md](references/video.md)   |

## 零配置快速命令

```bash
# Exa 网页搜索
mcporter call 'exa.web_search_exa(query: "query", numResults: 5)'

# 通用网页阅读
curl -s "https://r.jina.ai/URL"

# GitHub 搜索
gh search repos "query" --sort stars --limit 10

# Twitter 搜索
twitter search "query" --limit 10

# YouTube/B站字幕
yt-dlp --write-sub --skip-download -o "/tmp/%(id)s" "URL"

# Reddit 搜索
rdt search "query" --limit 10

# Reddit 读帖 + 评论
rdt read POST_ID

# V2EX 热门
curl -s "https://www.v2ex.com/api/topics/hot.json" -H "User-Agent: agent-reach/1.0"
```

## 环境检查

```bash
# 检查可用 channel
agent-reach doctor

# 查看所有 MCP 服务
mcporter_list_servers()
```

## 工作区规则

**不要在 agent workspace 创建文件。** 使用 `/tmp/` 存放临时输出，`~/.agent-reach/` 存放持久数据。

## 详细文档

根据用户需求，阅读对应的详细文档：

- [搜索工具](references/search.md) — Exa AI 搜索
- [社交媒体](references/social.md) — 小红书, 抖音, Twitter, B站, V2EX, Reddit
- [职场招聘](references/career.md) — LinkedIn
- [开发工具](references/dev.md) — GitHub CLI
- [网页阅读](references/web.md) — Jina Reader, 微信公众号, RSS
- [视频播客](references/video.md) — YouTube, B站, 小宇宙

## 配置渠道

如果某个 channel 需要配置，获取安装指南：
https://raw.githubusercontent.com/Panniantong/agent-reach/main/docs/install.md

用户只需提供 cookies，其他配置由 agent 完成。
