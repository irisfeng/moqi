---
name: ppt-master
description: 生成可编辑的原生 PPTX 演示文稿与课件：从文档/主题/模板生成带原生形状、连接线、动画、演讲者备注的 PowerPoint，或对已有 PPT 做美化、重构、套用模板、转场与旁白。中文触发词：做PPT、生成PPT、做课件、幻灯片、汇报PPT、美化PPT、PPT模板。
---

# PPT Master（原生 PPTX 工作流）

完整工具包已安装在沙箱的 `/opt/skills/ppt-master`（模板库、形状定义、工作流与脚本齐备）。

先读 `/opt/skills/ppt-master/SKILL.md` 并遵循其路由。其文档中的 `${SKILL_DIR}`
一律展开为 `/opt/skills/ppt-master`，不要 `cd`，不要猜测路径。

本环境约束：

- 没有外部图像生成 API：跳过一切 Gemini / GPT 图像生成步骤；配图只用用户上传的文件或程序化绘制（形状/图表/SVG）。
- 网图搜索 API（Pexels / Pixabay）未配置：跳过相关步骤，不要尝试调用。
- 生成的 .pptx 统一用 `cp 文件名 "$AGENT_OUTBOX/"` 交付到聊天；群 / 频道会话里改用 post 的 `files` 参数（outbox 不生效）。命名与话术统一见 artifact-delivery 技能。
