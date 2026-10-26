---
name: aether-office
description: 在Aether内创建和检查真实DOCX、XLSX、PPTX、PDF，编辑Word/Excel/演示文本，执行内置公式重算与版本保护。用于报告、方案、台账、演示和经营分析，不依赖WPS或其他办公应用。
---

# Aether 办公文档

使用 `office_document` 原生创建和检查 `.docx` / `.xlsx` / `.pptx` / `.pdf`；Word、Excel及PPTX支持定点编辑，XLSX支持内置 `recalculate`。只读审查优先 `office_inspect`，参数仅为 `path`、可选 `expectedHash/contentOffset/contentLimit`。不传 `operation` 或写入字段；只读子代理也可使用。这些操作使用随引擎发布的库，不需要Python、shell、pip、WPS、Office COM、LibreOffice或外部办公应用。已有 `read_file` 继续读取其他支持的资料。

原格式文件直接在Aether资源标签预览；本地HTML使用内置浏览器打开，不启动本地HTTP服务。遇到缺项明确记录平台能力限制，不能转而驱动用户的办公应用。环境诊断发现已安装软件不构成调用授权。PDF为Aether独立排版生成，不得称为Word/PPT原版式导出；复杂原文档转换尚未提供时如实说明。

## 按需选择

- **Word**：使用 `get_skill`，参数 `name="aether-office", resource="references/documents.md"`，读取文体、排版与编辑指南。
- **Excel**：使用 `get_skill`，参数 `name="aether-office", resource="references/spreadsheets.md"`，读取类型、公式与保真编辑指南。
- **PPT/PDF**：用 `get_skill` 读取 `name="aether-office", resource="references/presentations-pdf.md"`。PPTX用 `presentation.slides`；PDF用 `markdown`。结构化内容与有限页容量优先，长内容拆页，不缩成无法阅读的小字。
- **Excel计算**：生成/编辑后用同文件最新hash执行 `office_document operation="recalculate"`，再inspect核对真实缓存和错误。支持常用公式与跨表引用；不支持的公式、循环、外链明确拒绝，不能硬填结果假冒计算。
- **环境诊断**：`office_environment({})`仅供只读诊断，不是调用外部程序的建议。需要解释回执时读 `references/environment.md`；内置办公路径不需要先探测Python或COM。
- 只需聊天文字时直接回答，不强行生成文件；不承诺尚未提供的复杂编辑和转换能力。

## 多任务环境与转换

各角色只写分配给自己的文件，其他角色与公共输入只读；修订保留旧版本，交接记录来源hash和差异。内置重算在有时间/内存上限的工作线程执行；超过范围时保留原文件并报告限制。禁止为绕过工具限制安装共享依赖、启动外部办公应用或读取其他任务私有运行时。不得终止用户的WPS/Office进程。

## 文件合同

1. 新建时按用户素材直接完成内容与排版，调用 `office_document operation="create"`，`expectedHash="missing"`。保留用户文件名或在当前工作区选用有意义的文件名；没有授权时不覆盖其他文件。
2. 编辑已有文件先 `inspect`，确认正文/表格和 `warnings`，再用同文件最近一次工具返回的完整 `expectedHash` 调用 `edit`。Excel 分批添加新表使用 `append_sheets`，复用同一版本合同，每次只发新增的 1-4 张表（优先一张），不重发旧表。已经有可信同版本内容时不重复读取。不猜 hash，不根据文件名推断内容。
3. 哈希不一致代表其他任务或用户已修改。重新检查并基于实际内容调整，不盲目覆盖；多人协作分配不同文件或不同明确片段，仍遵守同一版本合同。
4. create/edit/append_sheets 成功才代表文件真实发布。工具会做内存生成、ZIP/XML/数据结构检查与原子发布，返回文件路径、大小、版本及改动回执。失败时依据 `fileMutationApplied` 如实说明；参数过长或新表不存在时改为小批 `append_sheets`，禁止为补表删除重建、循环整包重发或绕过 expectedHash。不要把聊天文本、CSV 或 Markdown 改扩展名冒充 Office。
5. 交付前再次 `inspect` 核对要求是否落实、数字与表格结构是否正确，并披露 warnings。`structure-checked` 只证明结构检查；没有实际打开或渲染不能声称做过视觉检查，没有缓存的公式不能声称已算好。
6. `contentTruncated=true`、`summary.previewTruncated=true` 或外层工具消息中的 `[truncated …]` 都表示只收到部分预览，不能据此声称已读完全文或验完整本工作簿；即使某个内部标记为 false，也必须遵守外层截断提示。定点编辑使用本次实际观察到的唯一文本片段/单元格与同文件版本 hash，不猜测被省略部分。需要验证全貌时，使用现有读取工具实际支持的分段读取或转换方式补齐；没有可用路径就明确披露未完成全貌验证，不忽略截断、不用反复读取同一份预览冒充完整检查。
7. `office_inspect` 与 `office_document inspect` 使用相同检查合同：Excel 全工作簿最多预览 2000 单元格、单格 600 字符；分页只继续这份预览。已保存错误计数覆盖全部工作表（含隐藏表和预览之外），错误位置只有限列举；没有错误缓存不代表公式已重算或业务正确。不要用 `read_file` 的首表预览推断其他表；目标表内容未出现在预览中时，明确说明未读到，不能以全表诊断替代逐表内容审查。

## 内容与交互

用户给出生成或修改指令即按该范围完成，不额外等待“确认导出”。缺失的日期、人名、数据用明确的待补充标记或空单元格，并在交付时指出；关键业务选择无法合理推断时才询问。保留用户表达与所需文体，不编造事实、指标或来源。

交付链接指向工具成功回执的真实文件，遵守当前客户端提供的文件链接规则；附简短结构/修改摘要及尚待补充的信息。
