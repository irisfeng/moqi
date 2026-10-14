---
name: office-docs
description: 用 python-docx / python-pptx / openpyxl 生成和修改 Office 文档（Word .docx、PPT .pptx、Excel .xlsx）。凡是要"写一份 Word/PPT/Excel""做汇报材料/纪要/名单模板/表格"的任务都用它。沙箱镜像已内置这三个库。
---

# 办公文档生成（Word / PPT / Excel）

写一段 python 脚本在沙箱里生成文档，文件放当前工作区，回复里给出文件名和一行内容概要。
**不要**把文件内容整段贴进回复，除非对方明确要求。

## 选库

| 目标  | 库          | 要点                       |
| ----- | ----------- | -------------------------- |
| Word  | python-docx | 纪要、方案、通知、报告     |
| PPT   | python-pptx | 汇报、框架、评审材料       |
| Excel | openpyxl    | 名单、模板、带公式的小工具 |

## 中文排版约定

- 正文字体统一设 **宋体**，标题用 **微软雅黑**：python-docx 里对每个 run 设
  `run.font.name` 并 `run._element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')`；
  python-pptx 设 `font.name` 即可。
- 标题层级：文档题目一级，章节二级，不再更深。
- Word 页边距默认即可；段落 `space_after = Pt(6)` 比较接近中文办公习惯。
- PPT 每页一个观点，标题 ≤ 18 字，正文 ≤ 6 条；用 `Presentation()` 默认 16:9。
- Excel 表头加粗、冻结首行（`ws.freeze_panes = "A2"`），列宽按内容估（中文一字约 2 个宽度单位）。

## 生成后

1. 文件写到当前工作区相对路径（如 `项目例会纪要.docx`）。
2. 用 `ls -la` 确认生成成功、大小正常（.docx 通常 >6KB，明显小于此多为空文档）。
3. **交付给用户（按会话类型）**：一对一 `cp 文件名 "$AGENT_OUTBOX/"`，回合结束自动作为附件出现在聊天里；**群 / 频道里 outbox 不生效**——文件放普通工作区路径，发消息时在 post 的 `files` 参数里带上。修改已有文件的场景同样要重新交付新版本。命名与话术统一见 artifact-delivery 技能。
4. 回复一句话：文件名 + 里面有什么（几个章节/几页/几个 sheet）。

**不要**用 `write` 工具的 `share` 参数把文件"发给"当前用户——那只会出现在对方的「文件」页，聊天里没有任何提示，对方会以为没收到。`share` 只用于把文件共享给别的范围（如项目/组织）。

## 常见坑

- `openpyxl` 公式写入用英文等号开头（`=SUM(B2:B10)`），保存后首次打开才计算。
- 修改已有 .docx：`Document(path)` 打开改完原路保存；不要试图"追加写"二进制。
- 需要"再改一版"时，基于工作区里的上一个版本改，不要凭记忆重写全文。
