---
name: drawio
description: 画图规范——直接手写 draw.io 的 XML（.drawio 文件）画流程图/架构图/时序图/组织结构图，不用任何外部工具。触发词：画图、流程图、架构图、时序图、拓扑图、drawio、图。
---

# 画图规范（直接写 XML）

不调用任何 drawio 工具——直接用文件写入能力手写 .drawio 文件。

## 格式要点

```xml
<mxfile host="app.diagrams.net">
  <diagram id="d1" name="页面1">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" pageWidth="1169" pageHeight="826">
      <root>
        <mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="n1" value="节点文字" style="rounded=1;whiteSpace=wrap;fillColor=#dae8fc;" vertex="1" parent="1">
          <mxGeometry x="80" y="120" width="160" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="n1" target="n2">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

- 每个节点一个 `vertex="1"` 的 mxCell，横向流程 x 每个节点 +240；连线 `edge="1"` 用 source/target 引用节点 id。
- 样式速查：圆角矩形 `rounded=1`；菱形判断 `rhombus`；分组容器一个大的 `vertex`，子元素 `parent` 指向它；泳道用宽矩形分组。
- 配色（淡色系可编辑）：蓝 #dae8fc、绿 #d5e8d4、橙 #ffe6cc、黄 #fff2cc、紫 #e1d5e7。
- 时序图：竖直生命线（细高矩形），水平箭头连接。

## 交付

```bash
cp <文件>.drawio "$AGENT_OUTBOX/"
```

仅口头说明路径不算交付。**群 / 频道里 outbox 不生效**：文件放普通工作区路径，发消息时在 post 的 `files` 参数里带上。命名与话术统一见 artifact-delivery 技能。用户用桌面 draw.io / diagrams.net / WPS 打开即可继续编辑。
