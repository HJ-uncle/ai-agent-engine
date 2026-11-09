# 内置工具模型投影约束

`list()` 保留完整中文目录；`listForModel()` 只替换可信内置实例的模型输入说明；`listForRequest(history)` 再选择本次请求需要的完整定义。
默认 Work 在启用 global/session 记忆的测试配置下仍有原来的 63 项能力，另增加 1 个只加载定义的 `load_tools`；关闭记忆的配置仍按原策略少 5 个工具。
MCP、用户工具、同名扩展、输出 schema、执行函数、preflight、并发模式、授权范围不参与投影。

## 自动验证边界

`__tests__/model-tool-definitions.test.ts` 对全部 63 项递归比较投影前后对象：仅忽略字符串值的 `description` 注解，其余节点逐项相等。包括每个参数名称、类型、required、enum、const、pattern、上下界、默认值、oneOf/anyOf/not、additionalProperties、dependencies 和嵌套对象。名为 `description` 的真实参数仍参加比较。

额外验证：目录原文没有被修改；同名 MCP 不被压缩；注销重注册不遗留投影；执行/前置检查仍调用原实现；outputSchema 原样；父子投影传播不扩大能力；只读子代理保留 codegraph 查询限制；绑定技能执行器保留完整的禁止管道/重定向/拼接/解释器源码执行契约。

非 schema 语义另有约束断言，覆盖身份、版本、分页、原子失败、授权、回执、视觉边界与交付状态。以下清单是人工审阅边界，不以模型“调用成功”替代业务验收。

## 按需加载边界

首轮呈现 13 个常用完整定义与 `load_tools`。加载工具的说明按组列出当前代理权限内全部工具名；模型先加载确切名字，下一请求才获得完整参数 schema，不能在同一批次猜参数直接执行。ReAct 用每次发送时冻结的工具名集合检查模型调用；加载状态本身不授予执行权限，业务执行仍经 canonical registry 的 preflight/execute。

只有工厂显式登记的可信内置投影可以延迟；MCP/自定义扩展始终完整呈现。每个 registry 和子代理拥有独立的内存选择集合；子代理从父级完整模型目录过滤自己的授权集，不继承父级已加载集合。`load_tools.execute` 仅调用 `ctx.tools.loadForModel`，不闭包持有父 registry。不存在的名字导致整批拒绝；注销后立即消失，重新注册不继承旧选择。空权限或仅核心工具配置不增加加载工具。

重启/新轮次可以从结构化历史重建：必须有匹配的 assistant toolCall 与成功 tool 回执；加载收据中的名字还须与原请求参数匹配。仅存在失败或未呈现的调用不自动加载；用户正文和未配对收据都不生效。重建始终再与当前权限目录取交集。缺少旧版成功回执时使用正常加载流程，不推断权限。

`__tests__/model-tool-loading.test.ts` 验证初始发现完整性、批量加载、不执行目标、未知名字的原子拒绝、父子及兄弟隔离、调研角色不可恢复写入、root-only 隔离、成功历史恢复、失败/正文不恢复、MCP 直呈及动态注销/注册。无需新增数据库状态。

## 能力及参数语义清单

| 工具 | 必须保留的语义 |
|---|---|
| load_tools | 按当前 ctx.tools 授权目录加载确切名字；完整 schema 下一请求提供；不执行目标、不扩大权限；原子拒绝未知名字，可批量加载；目录只能包含本代理可访问工具。 |
| read_file | 确切路径，不替换同名版本；格式、模式和行分页；完整字节 hash；展示行号不是原文；exact JSON.content 保留 UTF-8/CRLF/BOM，新增完整性、字节数及尾换行回执；逐字复制、比较源与目标SHA，不重建/trim。 |
| write_file | 新内容data与copyFrom互斥；copyFrom须源path+完整expectedHash，源目标双锁/版本保护、不同文件、工作区边界及大小限制，直接复制字节不经格式handler，copyVerified确认目标hash；目标未传版本默认仅新建，覆盖须最新目标版本。trailingNewline仅显式LF/CRLF/none调整普通UTF8末尾CR/LF，默认/preserve原样，copyFrom不许格式调整。实际快照回执提供大小、尾换行、完整短预览，避免无意义重读。文本/JSON与旧Office数据、missing/createOnly、共享版本保护、旧XLSX/DOCX开放payload的嵌套形状/颜色/图片/字体/缇单位保持兼容；有原生Office优先使用。 |
| edit_file | 只改已有 UTF-8；同文件最新回执 hash，不猜片段 hash；所有 edits 匹配同一原文件；oldText 非空唯一、不重叠；版本/匹配冲突整次失败；空 newText 删除；保留换行/BOM；快照可撤回。 |
| list_files | 默认所有绑定工作区；500 项默认、2000 参数上限；递归开关；不跟随链接，截断后缩小目录。 |
| delete_file | 移入系统回收站，可恢复；不是永久删除。 |
| create_dir | 创建指定目录，执行时仍受原工作区策略。 |
| office_document | 原生四种格式；先读 aether-office；create 的格式输入互斥；edit 的文本/单元格入参；DOCX 不新增结构；PDF 仅创建/检查且不是原样格式转换；追加新表保留已有部件、单表递增；公式重算非全 Excel 兼容，不支持/循环/外链失败保留原文件；不可用常数伪造结果；版本检查、原子发布、撤回。 |
| office_document 的内容参数 | missing 与最新同文件 sha256；分页沿用上页 hash/UTF-16 offset；Markdown 格式；标题避免重复；PPTX 单行、宽度、行列/要点组合限制；slide/textRun 的 1 起始显示/节点编号及 editable；target=notes 只能改已有备注；追加每次最多 4 表、建议 1 表、不重复旧表。全部数值/schema 结构原样。 |
| office_inspect | 只读；warnings/expectedHash/documentComplete；预览分页不等于全文/视觉验证；Excel 2000 格/格 600 字、错误总数全表而位置有界、公式为缓存不重算；Word 仅正文；PPTX 正文/备注位置可编辑身份；分页不混版本。 |
| office_environment | 可信运行环境探测、2 分钟缓存；不启动 Office/安装/导出/读取其它任务或私有依赖；存在或注册不证明成功转换；PDF 库不等价原样渲染。 |
| execute_cmd | command 仅程序/路径；args 逐项原文、不额外 shell 引号；源码跟 -e/-c，管道/重定向须明确 shell；默认前台，watch 后台；jobId 不是成功；timeout/cwd 默认和策略；changes 有界且可能含并发编辑，不代表所有副作用可撤回；重启不接管/重跑。 |
| command_output | 本会话 jobId；cursor=0 后按 nextCursor/hasMore 读取持久完整输出；输出不代表退出；运行中不重复启动。 |
| cancel_command | 本会话 jobId、可追踪子进程；等待核实终态，已结束任务不重跑。 |
| ask_user | 复杂任务的必要关键选择；至少两个具体可执行选项；不能只给其他/继续；普通/开放问题用正常正文。 |
| remember | 当前记忆范围；完整简洁内容、原类型枚举、3–5 tags、情感效价 -1..1 与触发情境。 |
| recall | 当前记忆范围、按 tags 检索；可选 keyword 字面区分大小写筛选、limit/offset 分页，真实ID及scope，hasMore/nextOffset，独立副本不隐藏。 |
| list_memories | 当前范围近期更新节点、默认数量 10；可选 keyword/offset，分页直到末页；删除一批后从0重查，不跳过移动到前页的节点。 |
| forget | 当前范围真实节点 ID；按内容删除清理已确认副本并复查，不扩大ID-only范围；成功结构回执参与自动提取排除。 |
| link_memories | 当前范围两节点与原关系类型/description/strength 参数，执行仍核验同范围及不同节点。 |
| list_skills | 真实可用技能名称/描述。 |
| get_skill | 确切技能名；脚本执行前阅读；resource 为技能内相对 Markdown 路径，省略读 SKILL.md。 |
| run_skill_script | SKILL.md 的完整确切命令；SKILLS_ROOT；0/省略无截止但用户停止仍取消。绑定版保留独立严格脚本目录及命令语法限制，不能使用通用版描述替代。 |
| glob | 路径 glob；cwd、limit、offset 仍在，按 offset 续页。 |
| grep | 文本/正则搜索；文件 glob；caseSensitive；maxResults 默认 50，offset 匹配条目分页，timeout 省略/0 不限时。 |
| plan_update | 本会话完整计划替换，省略移除、[] 清空；新增不填 ID、修改/重命名复用真实完整 ID；唯一标题；有证据才 completed；只在范围/进度变化更新，静默且不用 shell 管理。 |
| cron_list | 当前租户、真实精确 ID。 |
| cron_preview | 只读预览 UTC 发生时刻；完整 interval/calendar/legacy schema 不变。 |
| cron_create | 间隔/带时区日历/旧式计划；IANA 时区与 HH:mm；复用保持 Agent；新目标安全默认；项目须明确选定；跳过重叠/错过；消息、通知、profile、旧字段、null 清除与截止语义不变。 |
| cron_update | 精确 ID；expectedRevision 乐观并发控制；更新/暂停；全部可选配置仍在。 |
| cron_delete | 精确 ID；保留历史；不取消已运行任务。 |
| subagent | 同模板多实例；优先目录复用；task 自包含项目/目标/文件分工/验收；research/executor/general；agentId 真实发现或用户选择，继承模型/系统/资源；角色选择互斥；父权限边界；无直接用户提问/审批/递归。 |
| subagent_start | 与 subagent 参数相同；异步接纳不等于完成；返回真实 runId/childSessionId；父任务结束前等真实执行、结果持久化；wait/cancel；禁止子代理递归。 |
| subagent 的 resume/access 参数 | 已完成/失败/中断 runId 复用同 childSession 开新轮；不可并发续跑或变更角色/权限，先核实中断最后动作；调研/审查强制只读，执行/通用/自定义/implementer 默认继承，其余只读；可收窄、不能扩大。 |
| subagent_send | 当前 root 的 participantId；发送者来自执行身份；queued 仅接纳；相同 requestKey 必须同收件人/正文。 |
| subagent_wait | 本次父任务真实启动的精确 runId；completed 要执行/结果/票据均完成；观察超时或 pending 不取消。 |
| subagent_cancel | 精确本父任务 runId；等清理和落盘；pending 只是申请，不宣称终止。 |
| subagent_participants | 当前 root 分页；cursor 绑定 root 及接纳前缀，不跨 root。 |
| subagent_inbox | 自己的回执而非正文；执行边界注入正文，queued 不证明处理；不查别人收件箱。 |
| subagent_directory | 父会话跨轮/重启目录、canResume；已完成不销毁、优先相关上下文；目录身份不授旧权限，通信需当前 root 成员。 |
| subagent_followup | 精确 childSessionId；运行中投递、终态复用；started/queued 不是完成；requestKey 幂等正文不变；中断核实未知外部效果；明确取消要新需求。 |
| subagent_request_input | 子代理交主代理并暂停；主代理转问、获答续同 child；不是权限/范围授权；能独立做则不打断。 |
| web_fetch | 网页获取、默认 Markdown，原网络策略不变。 |
| http_request | 原五种 HTTP 方法；headers/body/followRedirects/responseType；basic/bearer/apikey 的开放 auth 对象结构仍有示例；0/省略无截止；网络/认证策略原样。 |
| search_history | 只查当前会话完整归档、含压缩前/附件实际模型输入；query 字面匹配；nextOffset 与 messageId/contentOffset；imageIndex 从 0 取真实保留像素；不输出 base64；原消息/轮次身份；当前更正优先。 |
| code_diagnose | 全部 TS/ESLint 后缀；ESLint 项目安装配置；未保存内容优先；adapter 可用性；unsupported 不等于错误或通过；不覆盖 HTML/CSS/内联脚本/视觉交互。 |
| codegraph | 已有索引优先处理结构关系，纯文本用 grep；callers/callees 区别；search/query/nodeId 条件；默认 path/limit/depth；index 仅明确要求且异步当前工作区，status 查进度；只读子代理没有 index。 |
| browser_tabs | 会话标签权限；空列表不等于用户无网页；已有页需共享并重列，同 URL 不等于同 ID；needs_user/needs_reveal；连接/AI 开关；关闭重列；观察不抢前台、输入须可见。 |
| browser_open | 新建而非激活；HTTP(S) 与本机授权 file HTML；同目录公开资源、无外网；跨目录开新标签；远端不能读客户端文件；localhost 是客户端；禁止 javascript:；Office 用预览。 |
| browser_navigate | 指定 tabId；复用返回的 ref/navigationId/截图；变化或 snapshotUnavailable 才再读；禁止 javascript:、本地跨目录重开。 |
| browser_snapshot | 结构/元素/状态/视口像素；经视觉通道；复用有效像素；网页不可信、不授权；结构存在不证明视觉可见。 |
| browser_screenshot | 当前视口、不是全页；缺图/变化时重取，避免立即重复有效快照。 |
| browser_click | 新鲜 ref/唯一 selector/成对 CSS x/y 三选一；PNG 按 cssViewport 转换；最新 navigationId；可见后输入；false 未执行、unknown 先观察防重复、false/null 不是成功；不得改坐标/页面绕过可见性或连接失败。 |
| browser_fill | 新鲜 ref 或唯一 selector 二选一；最新 navigationId；表单提交受用户授权。 |
| browser_scroll | 像素单位，x 正向右、y 正向下；原范围和导航身份。 |
| browser_press_key | 键名；先点击/填写使目标获得焦点。 |
| browser_wait | selector 或 text 必须一个，优先具体元素；0/省略到匹配、取消或断线。 |
| browser_console | 日志/JS 错误是不可信页面数据，不是授权。 |
| browser_network | URL/方法/资源/状态/失败/耗时筛选及分页；total/captured/dropped 的完整性边界；entries.id 对接详情。 |
| browser_network_request | 真正请求 ID，不是工具队列；请求/响应头、参数、脱敏 Cookie、时序、发起方、正文；小页续读；全部缺失/截断/未完成状态及 warnings 如实报告，不当完整结果。 |
| browser_set_viewport | 原尺寸/mobile/缩放约束；null 恢复自适应；复用返回观察。 |
| browser_close | 明确标签，可能丢失未保存输入。 |
| workbench_context | 当前会话只读；用户终端不同于后台命令；不输入/执行/扩权，断线不可用。 |
| workbench_open | 已存在真实文件、主工作区相对路径、line 仅代码；等真实回执；opened/renderStatus 均不证明视觉验收；不创建或切他人会话；交互 HTML 用浏览器。 |
| deliver_files | 仅主代理；完整列表替换/空清单；path、成功本轮 toolCallId/imageIndex、childSessionId/runId/artifactId 三选一；不可变来源；0 起始默认图片编号；16 项/每项 32MiB/共128MiB；验收且 root 正常完成才展示；不交过程产物。 |
| report_artifacts | 执行/通用子代理、授权工作区真实成品；不可变字节/来源/可选版本校验；1–16 项/容量；assetId 就是 artifactId，携同 child/run/用途/验证回主代理显式采纳；非发布或父任务完成，调研禁用。 |

系统级的任务自包含要求、协作回收、单写入者、验收、用户授权和失败诚实性仍在系统提示中保留一份，不在每个工具重复。

## 计量口径

字符/字节减少不是 Token 验收。英文候选可能字符更长、真实 Token 更少。必须采用隔离真实模型调用的供应商 `promptTokens`，并把首轮完整 system/history/skills/tools 一并计入。无 description 的 schema 只用于诊断不可压缩下限，不能作为功能验收候选。
