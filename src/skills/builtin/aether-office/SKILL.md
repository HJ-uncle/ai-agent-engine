---
name: aether-office
description: 创建和定点编辑真实 Word 与 Excel 文件，用于周报、会议纪要、通知、方案、台账、统计与排期表；包含结构排版、版本保护、产物校验，以及可用办公运行环境与转换候选的统一诊断。普通文字回复或只读附件时无需使用。
---

# Aether 办公文档

使用可用的 `office_document` 原生工具创建、检查和编辑 `.docx` / `.xlsx`；只读审查优先使用 `office_inspect`，参数仅为 `path`、可选 `expectedHash/contentOffset/contentLimit`，不传 `operation` 或写入字段。只读子代理可在获授权时使用该工具，不需要开放写入权限。这些原生操作不依赖其他技能、Python、shell、pip 或下载运行时。已有 `read_file` 继续负责 PDF、旧版 Office、CSV 等受支持资料的读取。额外的 Python 写入、公式重算和源格式渲染按真实环境能力选择，不能推断为内置能力。

## 按需选择

- **Word**：使用 `get_skill`，参数 `name="aether-office", resource="references/documents.md"`，读取文体、排版与编辑指南。
- **Excel**：使用 `get_skill`，参数 `name="aether-office", resource="references/spreadsheets.md"`，读取类型、公式与保真编辑指南。
- **环境、公式重算、PPT/PDF 或源格式渲染**：先用可用的 `office_environment({})`，再用 `get_skill` 读取 `name="aether-office", resource="references/environment.md"`。工具缓存 2 分钟，并发任务共享有界探测；不要循环探测或遍历其他任务目录。工具未被本会话授权时明确说明，不借扩展绕过权限。
- 只需聊天文字时直接回答，不强行生成文件。PPT、PDF 写入与复杂设计超出 `office_document` 能力；根据环境回执选择确实可用的途径，不能承诺未提供的格式或渲染器。

## 多任务环境与转换

不要执行全局或 `--user` 安装，不升级或卸载共享 Python 包；并行角色会发生文件锁和版本串扰。缺依赖时仅在本角色工作区创建独立 venv，或报告平台缺项；不能借用其他任务或 Codex 私有运行时。Office/WPS COM 注册、库可导入和文件存在均不证明转换成功。

环境与 COM 命令必须显式设置有限 `timeoutMs`（短探测不超过 15000，单份文档转换通常不超过 60000）；超时即停止重试同一命令并检查已有回执/产物。需要更久的转换必须根据文档规模设置明确有限上限。只能取消当前任务持有的命令或关闭自己创建的文档；禁止 `taskkill /IM`、`Stop-Process -Name` 等全局终止用户 WPS/Office，也不能对无法证明由当前任务独占创建的 COM 应用调用 `Quit`。不得用挂起的 COM 关闭调用阻塞已完成的导出交付。

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
