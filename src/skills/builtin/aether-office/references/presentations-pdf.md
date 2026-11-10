# Aether 内置演示与 PDF

这些写入使用引擎自带库，不调用 WPS、Office COM、LibreOffice、Python或外部服务。文件直接在 Aether 资源预览查看。

## PPTX

### 先组织信息，再设计页面

先从用户给出的受众、用途和视觉参考确定叙事及风格；未指定时按主题选择合适的字体、颜色和留白。每页只承担一个明确目的，标题表达结论，正文提供依据。把补充说明放进 `notes`，不要把长文逐段塞进幻灯片。缺失数据明确待补，不编造图表数值或来源。

使用 `office_document operation="create"`、`.pptx` 路径、`expectedHash="missing"` 和 `presentation:{theme,slides}`。`theme` 统一字体、前景/背景、强调色及可选页脚/页码；布局随内容变化，不让整份演示都成为同样的标题加要点。参数和容量以实际工具 schema 为准。

- 用封面/章节页组织节奏，`columns` 展示对照，`timeline` 展示阶段，`quote` 突出关键引述；需要条列时才使用 `bullets`。
- 数字关系用原生 `chart`（柱状/折线/饼图），精确数值用原生 `table`。正文、表格、图表保持可编辑，不用整页截图代替。
- `image` 使用已授权工作区内的 PNG/JPEG；按用途选择 contain 或 cover，检查裁切是否损失关键信息。图片本身仍是位图，不能声称图内文字可编辑。
- 特殊构图用 `custom` 的原生文本、形状和图片元素；坐标为英寸，画布为 13.333×7.5。此布局的 `title` 只作元信息，需要可见标题时添加文本元素。

全篇统一标题/正文层级、对齐和边距，保证文字与背景的对比；优先删减、分组或拆页，避免为容纳长内容持续缩小字号。用户提供参考时借鉴其视觉规则；当前工具不提供任意母版导入、动画或完整模板复刻，不把相似风格称为保真复用。

### 已有文件的修订

先 inspect，再用同文件 hash 及唯一 `oldText/newText` 定点 edit；未匹配或重复文本会拒绝，其他包部件保留。`edit` 仅修改已有正文/备注文本节点，不等于可以重排版式或编辑图表数据。需要新布局时基于已核实内容新建版本，不覆盖原件，不声称重建保留了原母版和全部效果。

相同数字或文字出现在多个位置时，先用 `office_inspect` 读取 `[slide=2 textRun=7 editable=true]` 标记，再在同一项 edit 中成对提供 `slide:2,textRun:7`。编号从 1 开始：slide 是实际显示顺序，textRun 是该页所有已提取文本节点的顺序（包含不可编辑字段）。只支持 `editable=true` 的普通文本节点；`oldText` 仍须在指定节点内唯一匹配。示例：`{"operation":"edit","path":"经营评审.pptx","expectedHash":"<该文件 inspect 返回的 sha256>","edits":[{"slide":2,"textRun":7,"oldText":"127200","newText":"128400"}]}`。不得猜测编号；过期 hash、越界编号、缺少配对参数或字段节点都会拒绝且不发布。定位参数仅适用于 PPTX，不能用于 DOCX。inspect 仍是有界分页预览，需要时继续获取 `contentPage.nextOffset`。

备注也由 inspect 提取，标为 `[target=notes slide=2 textRun=1 editable=true]`；正文和备注的 textRun 各自从 1 编号。修改已有备注使用 `edits:[{"target":"notes","slide":2,"textRun":1,"oldText":"旧路径.xlsx","newText":"修订路径.xlsx"}]` 并复用同文件最新 expectedHash。省略 target 只匹配正文，不会改备注；指定 notes 不会回退匹配正文。页码等字段不可编辑，不支持新建备注部件、插入段落或跨文本段替换。不得用 shell 手改 ZIP 绕过定位与版本保护。

### 逐页看实际画面

生成后先复用同版本结构/内容回执，再调用 `workbench_render({path,page,expectedHash})` 查看实际 PPTX 的画面；按返回的 `pageCount` 检查全部最终页面，后续页沿用同一文件的 `sha256`。hash 冲突时重新确认版本，不能混合不同版本验收。

逐页看标题与正文层级、文字裁切/溢出、元素重叠、图表标签、图片裁切及整体一致性；核对图表与内容来源。发现具体问题才修正，并重新渲染受影响页。实际返回图片必须可见且已检查；工具成功截图、文本读回或 `structure-checked` 都不等于视觉验收。

此渲染是 Aether 的 HTML 预览转换器绘制原 PPTX，不保证与 PowerPoint 原生渲染逐像素一致。未提供 `workbench_render`、模型无视觉能力、客户端未连接或渲染失败时，明确记录“视觉验收未完成”及原因；不以另画的示意图、结构检查或自动截图成功冒充已看过成品。

## PDF

用 `create`、`.pdf` 路径、`expectedHash:"missing"` 与 `markdown` 创建，支持中文、标题、段落、列表和简单表格的分页排版。可选title/author必须来自已知信息。中文字体不可用会明确失败，不能交付乱码。

PDF是独立排版文件，不是从另一份DOCX/PPTX逐像素转换。PDF任意文字定点编辑尚未提供；修改时根据已核实源内容新建版本，不覆盖或假称保留旧版式。inspect/office_inspect提供实际PDF文本及页数，不证明视觉效果。交付时在Aether预览真实文件，核对分页、内容、字体和表格。

## 验收

所有操作遵守文件版本hash和原子发布；仅成功回执才算落盘。结构检查、文本读回、视觉验证分别记录。源格式预览不保证与外部办公应用逐像素一致；不要用另绘图片冒充实际文档渲染。
