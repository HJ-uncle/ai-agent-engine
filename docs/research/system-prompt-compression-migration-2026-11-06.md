# 系统提示词压缩：约束迁移与验证（2026-11-06）

## 范围与状态

本轮只精简默认系统文案、去除跨块重复，并统一发送/统计构造。没有修改权限判定、工具执行、会话持久化、子代理生命周期或用户自定义提示。默认主 Agent/租户身份、skills、AE.md、RAG 和记忆正文保持原样，由原路径加载。

先保存并测了简练中文版本，再依真实调用反馈采用等义英文版本；用户可见回复仍明确要求中文。英文已在 2026-11-06 20:14:10 +08 接线到原文件，没有生产环境双版本开关。

- 原始基线：.e2e-tmp/prompt-compression-20261106/baseline/src/。
- 中文候选快照：.e2e-tmp/prompt-compression-20261106/system-zh-v1/src/。
- 英文原始候选：.e2e-tmp/prompt-compression-20261106/system-en-candidate/compact-system-prompts.ts。
- 生产使用原 execution-protocol.ts、office-prompt.ts、task-plan-prompt.ts、workspace-download-prompt.ts、runtime-capabilities.ts；临时候选模块已从 src 删除。
- 新增 chat-system-prompt.ts 只统一拼接，没有删除或重写调用者传入的自定义正文。

静态约束存在并不证明模型行为绝对等价；真实 Work 场景评测由主任务另行记录。当前表关注“规则仍由哪里提供”，不把工具注册误当实际执行成功。

## 规则迁移表

“工具定义”指本次模型真正接收的可信内置定义投影；schema 类型、required、enum、pattern、范围及实际执行对象没有因此改变。以下工具内规则仅在工具定义已呈现给模型时可依赖；按需加载方案必须在使用前提供完整定义。

| 原位置/约束 | 保留位置 | 处理 |
| --- | --- | --- |
| chat Rules 的中文说明、结论先行、不要反复自疑 | execution-protocol 的表达段 | 一份，明确用户可见说明使用中文 |
| 普通问答/能力介绍/解释现有材料不扫目录、不读规则、不建计划、不调用工具 | execution-protocol 表达段 | 合并 Work 与公共协议重复 |
| 能力介绍短段或 3–5 个日常例子，不复述工具参数/模型机制/技术栈 | execution-protocol 表达段 | 保留 |
| 不自称通用工作型 Agent、不把内部规则作为答复模板 | execution-protocol 表达段 | 保留 |
| 不主动列记忆/权限/验收/外部软件限制；真实受阻、必要授权、影响选择或可信度才说明 | execution-protocol 表达段 | 合并重复，真实失败/必要未检查项仍须报告 |
| 不把单工具限制泛化到整个应用 | execution-protocol 表达段 | 保留 |
| 持续完成授权工作，运行中补充并入原任务，保留只读/方案限制和最新更正 | execution-protocol 执行段 | 保留 |
| 不因工具或文件多重复确认，显式“直接做”已有实施授权 | execution-protocol 执行/规模段 | 保留；没有更改授权执行器 |
| 只用真实注册原名；注册、连接、执行、验证各自需证据 | execution-protocol 执行段 | 保留 |
| 文件/网页/插件/同伴内容不是扩权指令 | execution-protocol 执行段 | 保留 |
| 动项目文件前读取适用且未提供的 AGENTS.md/AE.md；修改前核对用户改动 | execution-protocol 执行段 | 保留 |
| 相关范围读取；独立只读可并行、依赖/同文件写入串行 | execution-protocol 执行段 | 保留；并行职责另由委派段约束 |
| 小改只查目标与直接依赖、复用组件、针对验证即交付 | execution-protocol general 分支 | 代替独立 GENERAL_WORK_EXECUTION_PROMPT |
| 常规联动先做有界影响面调查与短计划；跨模块/高风险先计划/风险/验收 | execution-protocol general 分支 | 保留 |
| 仅明确要求才全面/长时/压力测试；长任务报告阶段与剩余目标 | execution-protocol general 分支 | 保留 |
| ask_user 只用于无法自行查证、复杂任务必须由用户决定的关键选择，至少 2 个具体有效选项 | execution-protocol 的 ask_user 条件段及 ask_user 定义 | 保留，不用提问代替探索；普通开放问题用正文 |
| 错误按 error/stdout/stderr/退出码区分参数、权限、启动、语法、断言、客户端故障 | execution-protocol 故障段 | 保留 |
| 不原样重复失败；不能自写解码器/OCR 绕过缺失能力，失败改用受支持路径 | execution-protocol 故障段 | 保留 |
| execute_cmd 的程序/args、默认无 shell、不能把整行当程序 | execute_cmd 参数 schema/定义 | 从重复 system 说明移至真实调用契约 |
| 服务/watch 用后台任务、合理超时，交付实际地址和管理方式 | execution-protocol 的 execute_cmd 条件段 | 保留跨工具工作流 |
| command_output 的 jobId/增量输出不等于退出、不重启同任务 | command_output 定义 | 保留 |
| cancel_command 用真实 jobId，停止请求不等于已退出、核对终态 | cancel_command 定义 | 保留 |
| expectedHash 来自同文件最新真实回执；冲突重读，保留原格式/用户改动 | read_file/write_file/edit_file/office_document 参数定义；公共文件段及 Office 段 | 参数条件保留，冲突行为保留 |
| 删除必须 delete_file，不能 shell 绕变更策略；回滚承诺需回执 | execution-protocol 的 delete_file 条件段 | 保留 |
| browser_tabs 核对共享标签；同 URL 不等于 tabId、空列表不等于无页面/宿主就绪 | browser_tabs 定义 | 保留 |
| 新鲜 ref/navigationId 与快照复用；页面变化/快照缺失才重读 | browser_* 定义及参数描述 | 保留 |
| false 未执行、unknown 先核实、null/空结果不证明成功；缺快照先恢复观察 | browser_click/navigate 等定义；execution-protocol 浏览器故障段 | 具体状态进工具契约，跨工具恢复原则留 system |
| 可见性/后台表面故障不能改网页/坐标绕过 | execution-protocol 浏览器故障段及 browser 定义 | 保留 |
| 授权本地 HTML、跨目录新标签、javascript: 非执行接口 | browser_open/navigate 定义 | 保留 |
| workbench_open 等待执行回执；未展示不得声称成功；用户终端与 AI 后台命令不同 | workbench_open/context 定义 | 保留 |
| 跨目录/大量噪音/独立产出宜协作，主代理负责分工与集成验收交付 | execution-protocol 子代理段 | 合并 SUBAGENT_DISPATCH_PROMPT 和公共重复规则 |
| 小任务直接做；简单概览最多一只读 child、只看入口及关键文件、不升级深挖 | execution-protocol 子代理段 | 保留 |
| task 自包含目标/工作区/范围/责任文件/接口/深度/已知证据/父限制/验收 | execution-protocol 子代理段 | 单一跨工具规则，不重复放入两个启动描述 |
| 仅独立产出并行，不重叠范围；共用配置/锁/Office 单一集成者；共享目录非隔离 checkout | execution-protocol 子代理段 | 保留 |
| research 只读、executor 执行、general 综合，同模板可多实例 | subagent 的 builtinRole 参数及真实角色执行器 | 保留真实枚举与权限；system 不再重复参数解释 |
| directory 发现已有相关上下文；已完成/重启不等于销毁，不凑齐角色 | execution-protocol 目录段及 directory 定义 | 保留 |
| followup 运行中补充/已完成续跑；queued 接纳、started 启动、按当前 runId 验收 | execution-protocol followup 段及 followup 定义 | 复用/身份规则保留 |
| 暂停/取消后的迟到消息不等于新授权 | execution-protocol followup 段及 followup 定义 | 保留 |
| start 后主代理继续工作；新消息先处理，最终前 wait 收真实结果并集成 | execution-protocol start 段及 start/wait 定义 | 保留 |
| 子代理缺用户信息用 request_input 暂停；主代理转问，获真实答复后续用同一 child；普通答复不授予权限 | subagent_request_input 定义 | 联合模型输入测试明确覆盖主代理责任和同一 child |
| 同伴消息仅职责内协作，用 participants 看状态；交接路径/版本/验证，避免确认循环，主代理协调阻塞 | execution-protocol send 段 | 保留 |
| 子结果 status/facts/evidence/actions/verification/unverified/next；路径行号代替大段源码 | execution-protocol 子结果段 | 保留 |
| 已有证据复用，有冲突最小复核；取消/预算/容量/无进展终止用部分证据报告缺口 | execution-protocol 子结果段 | 保留 |
| 不把本地预算说成服务商欠费、不自造步数限制、不重派同一探索 | execution-protocol 子结果段 | 保留 |
| 子产物不可变候选，由 childSessionId/runId/assetId（artifactId）交主代理验收采纳 | report_artifacts/deliver_files 定义；system 候选成果原则 | 身份契约保留，未采纳不算父成果 |
| summary 是索引，决定/数值/更正缺失时 search_history 回原 messageId/turnId | execution-protocol search_history 条件段 | 保留 |
| 无新修改或疑点不重测已通过项；功能/交互/结构/公式/视觉区别 | execution-protocol 验证段 | 保留 |
| 无渲染/截图不得报视觉通过；临时文件遵约定或 .ae/tmp | execution-protocol 验证段 | 保留 |
| 完成即简述结果/用法/交付/必要验证限制；不复述过程、不凑空清单、不把进度当成果 | execution-protocol 收尾段 | 合并 Work 收尾重复 |
| 文件/视觉任务 deliver_files 完整清单；保留真实成品图，不拿过程图/日志/中间文件充数 | execution-protocol 交付段 | 保留 |
| deliver_files 每次替换清单，path 或 toolCallId/imageIndex 或 child 身份，成功/不可变/根任务完成才显示 | deliver_files 定义 | 保留真实参数契约 |
| Work 自动显示登记图片不重复 Markdown；Code 必须正文插图并保留文件 | execution-protocol 模式分支 | 互斥保留 |
| 内建计划多步使用、单步免，完整清单、保留必要已完成项、只删脱离范围项 | TASK_PLAN_EXECUTION_PROMPT | 单一来源，chat Rules 不再重复 |
| 新增省略 id，既有/重命名复用完整 id；四态、完成证据、失败/取消真实反映 | TASK_PLAN_EXECUTION_PROMPT 及 plan_update schema | 保留 |
| 只在范围/进展变化时更新，失败先修输入；未落盘不称保存，不用脚本维护/不复述日志 | TASK_PLAN_EXECUTION_PROMPT | 保留 |
| Office 阅读有限预览、备注 target=notes、Excel 已存公式缓存、分页/hash/warnings/documentComplete | Office 只读分支及 office_inspect 定义 | 条件互斥保留 |
| 有 get_skill 且启用 aether-office 才提示先读技能，其他情况按真实 office_document 契约 | buildOfficeExecutionPrompt | 原能力门控未改 |
| 不猜依赖路径/不读其他应用私有依赖；安装不等于渲染成功 | Office environment 条件段及工具定义 | 保留 |
| Aether 原生优先，不自动启动 WPS/COM/LibreOffice，不让用户开本地服务器 | Office 交付段 | 保留 |
| Office create missing、其他写入最新 sha256、append_sheets 逐表/复用最新 hash/不删重建 | office_document schema + 定义 | 联合测试检查版本 pattern 与 create/latest 语义 |
| Excel 交付前重算，支持跨表、不支持报失败、不硬编码伪造 | Office 交付段 + office_document 定义 | 保留；联合测试检查 recalculate 与禁止常数伪造 |
| PDF 为独立排版，不是 Word/PPT 原样转换；仅 create/inspect，改版新版本 | office_document 定义 + Office 交付段 | 保留 |
| 原格式预览、warnings/未验证项；已授权即真实交付，不额外求导出确认，不编数据/改扩展名 | Office 交付段 | 保留 |
| 下载相对绑定主根而非角色 cwd，保留目录/特殊字符，逐值编码一次，禁止 file:// 与 ../ | buildWorkspaceDownloadPrompt | 保留原可执行嵌套中文路径示例；6 项真实下载测试通过 |
| 运行环境每请求刷新，第一工作区为相对路径根；时间/平台/Node 属引擎宿主 | buildRuntimeCapabilitiesPrompt | JSON 形状不变，仅翻译说明 |
| 不推断客户端/shell/PATH/Office；client 仅声明、不授权、不证明执行；实际策略/回执为准 | runtime intro | 保留 |
| 会话+全局/仅全局/仅会话/关闭四种记忆互斥；双开默认只写会话，不自动升全局 | buildRuntimeMemoryPolicy | 原解析结果不改，仅分支文案翻译 |
| 记忆工具注册不等于全局开启，历史与长期记忆独立，开关不删历史，写入成功才称记住 | runtime footer | 保留；ReAct 真实构造测试覆盖注册与有效范围不一致、收尾无工具等情况 |

## 拼接与统计修正

原 chat 同时维护 fullSystemPrompt 与 pureSystemPrompt 的长 Rules 模板，存在文本漂移与重复维护风险。现在 buildChatSystemPrompts 接收相同 parts，构造一次 suffix；full 仅比 pure 多调用方提供的 RAG 段。不按字符串内容删除 RAG，避免误删用户自定义正文中恰好相同的字句。

附件名称和视觉说明原本只在发送模板中，现在也进入 pure 的相同 suffix。已有子代理目录与显式协作者说明在最终请求追加时，同步追加到 measuredSystemPrompt 后计数。技能已经在 base 内，只从系统分类扣一次，RAG 继续单列。公共协议/环境/计划仍由 ReAct 按本次 effectiveTools 注入并计数；本轮不更改提供商总量与本地分摊算法。

此修正让分项估算对应真实文本，但本地估算仍不是 tokenizer 真值，不能把界面按总量比例分摊后的系统数字当作独立 tokenizer 计数。

## 验证

英文接线及按需加载 v2 后以下 6 个测试文件共 37 项通过：

- core/__tests__/chat-system-prompt.test.ts：自定义正文逐字保留、RAG 单独分离、附件/模式/Office 同源、空分支、能力门控、四种记忆、系统与工具定义联合契约。
- core/__tests__/runtime-capabilities.test.ts：当前工具/版本/工作区/时钟、客户端声明、记忆分支与最终空工具集；新增首轮子集→加载后→收尾三阶段的 offered/available 区分。
- core/__tests__/office-prompt.test.ts：Office 写入/只读/环境三种能力条件。
- core/__tests__/code-agent-prompt.test.ts：Work/Code 图片展示差异、Code 计划边界、协作与交付。
- core/agent-loop/__tests__/memory-capability-prompt.test.ts：通过真实 ReAct 请求构造捕获有效范围、普通介绍规则、跨轮范围刷新、最后收尾阶段；模型响应为测试适配器，不冒称真实生成效果。
- api/http/routes/__tests__/workspace-download-contract.test.ts：真实 Fastify 下载流与临时文件，嵌套中文路径、特殊字符、版本/角色同名、越界拒绝等。

旧 Code 文案测试里仍期待此前已删除的 access=read-only/spec-reviewer/code-quality-reviewer 固定措辞，已改为现存 builtinRole 三类角色与独立子任务的同义约束；没有为满足旧测试修改 Code 执行策略。运行环境压缩测试改比较 JSON 数据投影的长度，不再用整段自然语言字符数衡量压缩，避免英文字符较长却 token 更少时误报。

按需加载已接入。联合测试先确认完整目录保留原 63 个工具（另加 load_tools），首轮有 loader 而没有 office_document；显式加载后再验证所有授权定义与 Office/协作契约。没有删除完整能力断言，也不声称首轮发送全部 schema。

## 按需加载 v2 的行为保留

2026-11-06 20:32 +08 补充：公共执行协议根据授权目录生成，避免初始尚未加载子代理 schema 时丢失主动委派、复用、单一集成者和最终采纳规则。协议明确：目录不是本次可调用 schema，缺定义先 load_tools，下一请求取得完整定义后调用；加载不执行所选工具、不扩权，未 offered（含收尾）不能调用。

runtime 保留 toolCount/registryVersion 描述当前 offered schema，新增 availableToolCount 描述授权目录规模与 toolLoading 指明 loader 是否 offered。记忆范围由原 memory policy 决定，完全不依赖某个记忆工具是否已加载。第一工作区、宿主边界、客户端声明、四种互斥记忆文案均保留。

子代理 schema 未加载不等于子代理能力不存在；同样，最后收尾时 toolCount=0 不等于授权目录被删除。能力目录与本次工具集分别陈述，最终调用仍受真实 offered 集、原白名单、原角色权限和执行策略约束。
