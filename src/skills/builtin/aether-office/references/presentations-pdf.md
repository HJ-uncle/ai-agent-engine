# Aether 内置演示与 PDF

这些写入使用引擎自带库，不调用 WPS、Office COM、LibreOffice、Python或外部服务。文件直接在 Aether 资源预览查看。

## PPTX

```json
{"operation":"create","path":"经营评审.pptx","expectedHash":"missing","title":"经营评审","presentation":{"slides":[{"title":"本月经营结果","bullets":["依据已提供资料填入事实，不把预测写成已实现"],"notes":"写明数据来源与月份"},{"title":"行动计划","table":{"headers":["事项","负责人","截止日"],"rows":[["核对应收","待补充","2026-11-28"]]}}]}}
```

每页使用清晰标题及简短要点或表格。标题单行不超过47个中文字符；最多6条要点，每条不超过70个中文字符。同页有表格时最多2条要点、5行数据；没有要点时表格最多8行。表格最多6列，每行与表头列数一致，单元格英文字符宽度上限为100/列数（中文按2计）。长内容拆分页面，不缩小字体。需要修改时先inspect，再用同文件hash及唯一 `oldText/newText` 定点edit，未匹配或重复文本会拒绝，保留其他包部件。不要假称复杂图表/动画/母版编辑已经支持。

相同数字或文字出现在多个位置时，先用 `office_inspect` 读取 `[slide=2 textRun=7 editable=true]` 标记，再在同一项 edit 中成对提供 `slide:2,textRun:7`。编号从 1 开始：slide 是实际显示顺序，textRun 是该页所有已提取文本节点的顺序（包含不可编辑字段）。只支持 `editable=true` 的普通文本节点；`oldText` 仍须在指定节点内唯一匹配。示例：`{"operation":"edit","path":"经营评审.pptx","expectedHash":"<该文件 inspect 返回的 sha256>","edits":[{"slide":2,"textRun":7,"oldText":"127200","newText":"128400"}]}`。不得猜测编号；过期 hash、越界编号、缺少配对参数或字段节点都会拒绝且不发布。定位参数仅适用于 PPTX，不能用于 DOCX。inspect 仍是有界分页预览，需要时继续获取 `contentPage.nextOffset`。

## PDF

用 `create`、`.pdf` 路径、`expectedHash:"missing"` 与 `markdown` 创建，支持中文、标题、段落、列表和简单表格的分页排版。可选title/author必须来自已知信息。中文字体不可用会明确失败，不能交付乱码。

PDF是独立排版文件，不是从另一份DOCX/PPTX逐像素转换。PDF任意文字定点编辑尚未提供；修改时根据已核实源内容新建版本，不覆盖或假称保留旧版式。inspect/office_inspect提供实际PDF文本及页数，不证明视觉效果。交付时在Aether预览真实文件，核对分页、内容、字体和表格。

## 验收

所有操作遵守文件版本hash和原子发布；仅成功回执才算落盘。结构检查、文本读回、视觉验证分别记录。源格式预览不保证与外部办公应用逐像素一致；不要用另绘图片冒充实际文档渲染。
