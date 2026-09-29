# Claude Code 2.1.266 本地证据能力完整目录

2026-09-29；仅使用已采集本地证据。未登录调用、未启动付费或远程服务；列出接口和入口，不等于全部当前可用。

## 统计与口径

- **45个Input接口**：按export interface *Input计数；ToolInputSchemas联合还混入ToolOutputSchemas，不能直接数联合成员。
- **51份help**：主1 + 子50；主help **65组参数声明**，别名同组计数。
- **115条静态命令定义 / 94个name**：按name归并，重复终端/非交互变体分别留证；不是账号/help实际可见数量。
- **33个hook事件名**：来自同一运行时枚举。

证据H=本版help；T=随包schema；S=静态定义/枚举；K=仅字符串/局部代码线索（属于主报告S的低置信子类）。offset为原binary字节位置。动态gate、账号权益、企业策略与环境条件未求值。

## 一、45个Input接口

字段?为可选，其余必需；全部顶层字段如下，嵌套类型以链接源码为准。**schema存在不等于默认注册或启用**。

| # | 接口T | 全部顶层字段 | 中文释义/边界 | 证据 |
|---:|---|---|---|---|
| 1 | `AgentInput` | `description`、`prompt`、`subagent_type?`、`model?`、`run_in_background?`、`name?`、`team_name?`、`mode?`、`isolation?` | 创建专门/独立子代理；默认后台并在完成通知；name供SendMessage寻址；fork继承父模型。worktree或remote隔离（remote受门控）；team_name与mode已弃用且忽略，session为单一隐式team。 | [sdk-tools.d.ts:683](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:683) |
| 2 | `BashInput` | `command`、`timeout?`、`description?`、`run_in_background?`、`dangerouslyDisableSandbox?` | 执行shell命令，最长600000ms；可后台执行及显式请求绕过沙箱；该请求的批准与策略条件未动态验收。 | [sdk-tools.d.ts:721](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:721) |
| 3 | `TaskOutputInput` | `task_id`、`block`、`timeout` | 读取后台任务输出，block控制等待，timeout设置时限。 | [sdk-tools.d.ts:753](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:753) |
| 4 | `ExitPlanModeInput` | `allowedPrompts?`；`[k: string]: unknown` | 退出计划模式；allowedPrompts注明Deprecated/no longer used，不能把它算为现行Bash语义授权机制。 | [sdk-tools.d.ts:767](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:767) |
| 5 | `FileEditInput` | `file_path`、`old_string`、`new_string`、`replace_all?` | 按old_string/new_string替换文本，replace_all全量替换。 | [sdk-tools.d.ts:783](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:783) |
| 6 | `FileReadInput` | `file_path`、`offset?`、`limit?`、`pages?` | 按offset/limit读取文件；PDF支持pages范围。 | [sdk-tools.d.ts:801](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:801) |
| 7 | `FileWriteInput` | `file_path`、`content` | 写入指定路径完整内容。 | [sdk-tools.d.ts:819](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:819) |
| 8 | `GlobInput` | `pattern`、`path?` | 按glob模式查找路径。 | [sdk-tools.d.ts:829](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:829) |
| 9 | `GrepInput` | `pattern`、`path?`、`glob?`、`output_mode?`、`"-B"?`、`"-A"?`、`"-C"?`、`context?`、`"-n"?`、`"-i"?`、`"-o"?`、`type?`、`head_limit?`、`offset?`、`multiline?` | grep搜索；content/files_with_matches/count；前后文、大小写、仅匹配、类型、分页、多行。 | [sdk-tools.d.ts:839](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:839) |
| 10 | `TaskStopInput` | `task_id?`、`shell_id?` | 停止后台任务；shell_id为兼容旧字段。 | [sdk-tools.d.ts:901](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:901) |
| 11 | `ListMcpResourcesInput` | `server?` | 列MCP资源，可指定server。 | [sdk-tools.d.ts:911](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:911) |
| 12 | `RefreshMcpToolsInput` | `server?` | 刷新MCP工具目录。 | [sdk-tools.d.ts:917](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:917) |
| 13 | `McpInput` | `[k: string]: unknown` | 通用开放MCP输入，非固定业务工具。 | [sdk-tools.d.ts:923](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:923) |
| 14 | `NotebookEditInput` | `notebook_path`、`cell_id?`、`new_source`、`cell_type?`、`edit_mode?` | Notebook单元replace/insert/delete；code或markdown。 | [sdk-tools.d.ts:926](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:926) |
| 15 | `ReadMcpResourceDirInput` | `server`、`uri` | 读取MCP资源目录。 | [sdk-tools.d.ts:948](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:948) |
| 16 | `ReadMcpResourceInput` | `server`、`uri` | 读取MCP资源。 | [sdk-tools.d.ts:958](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:958) |
| 17 | `ReportFindingsInput` | `level?`、`findings` | 结构化缺陷报告；file/line/summary/short_summary/failure_scenario/category；verdict为CONFIRMED或PLAUSIBLE，outcome为fixed/skipped/no_change_needed。 | [sdk-tools.d.ts:968](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:968) |
| 18 | `TodoWriteInput` | `todos` | 整体写待办列表；content/status/activeForm。 | [sdk-tools.d.ts:1013](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:1013) |
| 19 | `WebFetchInput` | `url`、`prompt` | 抓取URL并按prompt处理。 | [sdk-tools.d.ts:1023](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:1023) |
| 20 | `WebSearchInput` | `query`、`allowed_domains?`、`blocked_domains?` | 搜索网页；允许/排除域名。 | [sdk-tools.d.ts:1033](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:1033) |
| 21 | `AskUserQuestionInput` | `questions`、`answers?`、`annotations?`、`metadata?` | 1–4个问题，每题2–4个选项，可多选和preview；附答案、annotations、metadata。 | [sdk-tools.d.ts:1047](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:1047) |
| 22 | `SendFeedbackInput` | `type`、`title`、`details`、`area?`、`failure_mode?`、`task_category?` | 报告bug/idea/missing_capability，附失败模式和任务类别。 | [sdk-tools.d.ts:2624](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2624) |
| 23 | `ClaudeDesignInput` | `operation`、`arguments` | Design操作动态分发；先list发现操作及参数schema，arguments服务器验证。 | [sdk-tools.d.ts:2666](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2666) |
| 24 | `ProjectsInput` | `method`、`path?`、`content?`、`local_path?`、`present_to_user?`、`query?`、`n?` | 项目info/read/search/write/delete及memory_list/memory_read；支持上传本地文件并标present_to_user。 | [sdk-tools.d.ts:2678](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2678) |
| 25 | `EnterPlanModeInput` | 无字段 | 进入计划模式，无字段。 | [sdk-tools.d.ts:2712](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2712) |
| 26 | `TaskCreateInput` | `subject`、`description`、`activeForm?`、`metadata?` | 创建任务：subject/description、进行态文案及元数据。 | [sdk-tools.d.ts:2713](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2713) |
| 27 | `TaskGetInput` | `taskId` | 按taskId读任务。 | [sdk-tools.d.ts:2733](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2733) |
| 28 | `TaskUpdateInput` | `taskId`、`subject?`、`description?`、`activeForm?`、`status?`、`addBlocks?`、`addBlockedBy?`、`owner?`、`metadata?` | 更新任务及pending/in_progress/completed/deleted状态；依赖关系addBlocks/addBlockedBy、owner、metadata。 | [sdk-tools.d.ts:2739](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2739) |
| 29 | `TaskListInput` | 无字段 | 列任务，无字段。 | [sdk-tools.d.ts:2779](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2779) |
| 30 | `REPLInput` | `code`、`description?`、`timeout?` | 持久JavaScript REPL，顶层await；默认30秒、最长600秒。 | [sdk-tools.d.ts:2780](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2780) |
| 31 | `WorkflowInput` | `script?`、`name?`、`description?`、`title?`、`args?`、`scriptPath?`、`resumeFromRunId?` | 脚本/命名工作流；meta包含name/description/phases，支持agent/parallel/pipeline/phase；scriptPath优先；同会话resumeFromRunId复用未变agent结果。 | [sdk-tools.d.ts:2794](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2794) |
| 32 | `CronCreateInput` | `cron`、`prompt`、`recurring?`、`durable?` | 本地时区5字段cron；默认重复且7天到期；durable=true落盘scheduled_tasks.json跨重启。 | [sdk-tools.d.ts:2826](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2826) |
| 33 | `CronDeleteInput` | `id` | 删除cron任务。 | [sdk-tools.d.ts:2844](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2844) |
| 34 | `CronListInput` | 无字段 | 列cron任务，无字段。 | [sdk-tools.d.ts:2850](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2850) |
| 35 | `ScheduleWakeupInput` | `delaySeconds?`、`reason?`、`prompt?`、`stop?`、`noop?` | 动态唤醒：delaySeconds夹在60–3600秒；stop结束；noop标无变化、可折叠连续无变化显示。 | [sdk-tools.d.ts:2851](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2851) |
| 36 | `RemoteTriggerInput` | `action`、`trigger_id?`、`session_id?`、`cursor?`、`body?` | 远程触发器list/get/create/update/run/create_webhook_trigger/list_runs/get_run_log，cursor分页。 | [sdk-tools.d.ts:2873](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2873) |
| 37 | `ShowOnboardingRolePickerInput` | 无字段 | 入门角色选择UI，无字段。 | [sdk-tools.d.ts:2894](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2894) |
| 38 | `ReadNotificationsInput` | 无字段 | 读取通知，无字段。 | [sdk-tools.d.ts:2895](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2895) |
| 39 | `MonitorInput` | `description`、`timeout_ms`、`persistent`、`command?`、`ws?` | 监控shell逐行stdout或WebSocket帧，二者互斥；persistent持续整个会话，可TaskStop。 | [sdk-tools.d.ts:2896](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2896) |
| 40 | `ProposeSkillsInput` | `proposals` | 提出1–3个技能方案new/improvement，含完整SKILL.md和证据；改进指定target。 | [sdk-tools.d.ts:2921](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:2921) |
| 41 | `ProposeGoalInput` | `condition`、`ask_user?` | 提出目标完成条件，可ask_user确认。 | [sdk-tools.d.ts:3072](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:3072) |
| 42 | `ArtifactInput` | `action?`、`file_path?`、`favicon?`、`limit?`、`scope?`、`title?`、`description?`、`label?`、`url?`、`prompt?`、`force?`、`out_dir?`、`asset_id?`、`after?`、`capabilities?`、`contract?` | 作品publish/list/read/list_types/watch/unwatch/status；资源upload/list/read/delete；能力和contract声明。注释明确其描述的会话不提供watch更新通知，不能按action枚举宣称通知已可用。 | [sdk-tools.d.ts:3082](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:3082) |
| 43 | `PushNotificationInput` | `message`、`status` | 推送通知，status固定proactive。 | [sdk-tools.d.ts:3161](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:3161) |
| 44 | `EnterWorktreeInput` | `name?`、`path?` | 进入新worktree或指定path。 | [sdk-tools.d.ts:3168](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:3168) |
| 45 | `ExitWorktreeInput` | `action`、`discard_changes?` | 退出worktree，action=keep/remove，可显式discard_changes。 | [sdk-tools.d.ts:3178](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/sdk-tools.d.ts:3178) |

AgentInput明文说明team_name已弃用且忽略，session只有一个implicit team；mode也弃用且忽略，子代理继承父权限，agent frontmatter可能覆盖。这与旧式TeamCreate/TeamDelete建队说法不同。

## 二、CLI主参数（65组）

保留别名和参数占位符；条件限制以原help为准。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--add-dir <directories...>` | 增加工具可访问目录 | [main-help.txt:10](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:10) |
| `--agent <agent>` | 选择会话Agent | [main-help.txt:12](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:12) |
| `--agents <json>` | JSON定义自定义Agents | [main-help.txt:14](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:14) |
| `--allow-dangerously-skip-permissions` | 允许选择绕过权限，默认不开启 | [main-help.txt:18](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:18) |
| `--allowedTools, --allowed-tools <tools...>` | 允许工具名/规则 | [main-help.txt:22](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:22) |
| `--append-system-prompt <prompt>` | 追加系统提示词 | [main-help.txt:25](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:25) |
| `--autocompact <auto\|tokens>` | 自动压缩窗口：auto或100k–1M tokens | [main-help.txt:27](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:27) |
| `--ax-screen-reader` | 屏幕阅读器友好输出 | [main-help.txt:29](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:29) |
| `--bg, --background` | 后台启动，返回attach/logs/stop/rm用的ID | [main-help.txt:32](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:32) |
| `--bare` | 最小模式，跳过hooks/LSP/自动记忆等；显式配置仍适用 | [main-help.txt:40](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:40) |
| `--betas <betas...>` | API key模式附加Beta请求头 | [main-help.txt:55](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:55) |
| `--brief` | 启用SendUserMessage与用户通信 | [main-help.txt:57](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:57) |
| `--chrome` | 开启Chrome集成 | [main-help.txt:59](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:59) |
| `--cloud [description\|session_id\|url]` | 创建或连接云会话 | [main-help.txt:60](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:60) |
| `-c, --continue` | 继续当前目录最近会话 | [main-help.txt:63](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:63) |
| `--dangerously-skip-permissions` | 绕过权限检查 | [main-help.txt:65](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:65) |
| `-d, --debug [filter]` | 启用调试与分类过滤 | [main-help.txt:68](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:68) |
| `--debug-file <path>` | 调试日志文件 | [main-help.txt:71](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:71) |
| `--disable-slash-commands` | 禁用全部技能 | [main-help.txt:73](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:73) |
| `--disallowedTools, --disallowed-tools <tools...>` | 拒绝工具名/规则 | [main-help.txt:74](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:74) |
| `--effort <level>` | low/medium/high/xhigh/max努力级别 | [main-help.txt:77](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:77) |
| `--environment <environment_id>` | 指定自托管云环境 | [main-help.txt:79](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:79) |
| `--exclude-dynamic-system-prompt-sections` | 动态cwd/env/git等移入首条用户消息以共享缓存 | [main-help.txt:82](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:82) |
| `--fallback-model <model>` | 逗号顺序fallback，每用户轮重新尝试主模型 | [main-help.txt:87](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:87) |
| `--file <specs...>` | 启动下载file_id:relative_path资源 | [main-help.txt:93](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:93) |
| `--fork-session` | 恢复时创建新会话ID | [main-help.txt:97](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:97) |
| `--forward-subagent-text` | stream-json转发子代理正文/思考，附parent_tool_use_id | [main-help.txt:100](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:100) |
| `--from-pr [value]` | 按PR恢复会话或筛选 | [main-help.txt:104](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:104) |
| `-h, --help` | 帮助 | [main-help.txt:107](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:107) |
| `--ide` | 唯一可用IDE时自动连接 | [main-help.txt:108](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:108) |
| `--include-hook-events` | stream-json包含hook生命周期事件 | [main-help.txt:110](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:110) |
| `--include-partial-messages` | 实时输出partial消息 | [main-help.txt:113](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:113) |
| `--input-format <format>` | print输入text/stream-json | [main-help.txt:116](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:116) |
| `--json-schema <schema>` | 验证结构化输出schema | [main-help.txt:120](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:120) |
| `--max-budget-usd <amount>` | print模式API美元支出上限 | [main-help.txt:123](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:123) |
| `--mcp-config <configs...>` | 加载MCP JSON文件/字符串 | [main-help.txt:125](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:125) |
| `--model <model>` | 模型别名/完整名 | [main-help.txt:127](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:127) |
| `-n, --name <name>` | 会话展示名 | [main-help.txt:132](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:132) |
| `--no-chrome` | 关闭Chrome | [main-help.txt:135](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:135) |
| `--no-session-persistence` | print不落盘，不能恢复 | [main-help.txt:136](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:136) |
| `--output-format <format>` | print输出text/json/stream-json | [main-help.txt:139](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:139) |
| `--permission-mode <mode>` | acceptEdits/auto/bypassPermissions/manual/dontAsk/plan权限模式 | [main-help.txt:144](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:144) |
| `--permission-prompts <target>` | print权限由host回答或none自动拒需询问操作 | [main-help.txt:148](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:148) |
| `--plugin-dir <path>` | 本会话从目录或zip加载插件，可重复 | [main-help.txt:156](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:156) |
| `--plugin-url <url>` | 本会话下载zip插件，可重复 | [main-help.txt:161](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:161) |
| `-p, --print` | 非交互输出并退出 | [main-help.txt:164](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:164) |
| `--prompt-suggestions [value]` | 输出预测后续用户提示 | [main-help.txt:174](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:174) |
| `--remote-control [name]` | 开启Remote Control | [main-help.txt:180](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:180) |
| `--remote-control-session-name-prefix <prefix>` | Remote Control会话名前缀 | [main-help.txt:182](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:182) |
| `--replay-user-messages` | 流式回送输入用户消息确认 | [main-help.txt:184](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:184) |
| `--restricted` | 限制工具、设置来源、工作目录；禁止bypass | [main-help.txt:188](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:188) |
| `-r, --resume [value]` | 恢复指定会话或选择器 | [main-help.txt:203](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:203) |
| `--safe-mode` | 禁用自定义组件，保留管理策略/内置能力 | [main-help.txt:206](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:206) |
| `--session-id <uuid>` | 指定UUID会话ID | [main-help.txt:217](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:217) |
| `--setting-sources <sources>` | 选择user/project/local设置来源 | [main-help.txt:219](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:219) |
| `--settings <file-or-json>` | 加载设置文件/JSON | [main-help.txt:221](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:221) |
| `--strict-mcp-config` | 仅用显式MCP配置 | [main-help.txt:223](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:223) |
| `--system-prompt <prompt>` | 替换系统提示词 | [main-help.txt:225](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:225) |
| `--system-prompt-snapshot <on\|off>` | 首轮提示词快照复用至compact；off逐次渲染；环境尚未开启记录时无效 | [main-help.txt:226](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:226) |
| `--teleport [session]` | 恢复teleport会话 | [main-help.txt:242](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:242) |
| `--tmux` | worktree配套tmux，可classic | [main-help.txt:244](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:244) |
| `--tools <tools...>` | 选择内置工具，空字符串禁用、default全量 | [main-help.txt:248](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:248) |
| `--verbose` | 详细输出 | [main-help.txt:253](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:253) |
| `-v, --version` | 版本 | [main-help.txt:255](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:255) |
| `-w, --worktree [name]` | 创建git worktree | [main-help.txt:256](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:256) |

CLI公开manual，底层schema枚举使用default；binary-landmarks的hooks片段后出现manual→default归一化。不能误数为七种独立权限模式。

边界补充：`--autocompact`改变自动压缩触发窗口，不改变模型实际上下文容量。`--restricted`默认移除代码执行工具及WebFetch，但`--tools`可以显式重开；还需`--strict-mcp-config`才跳过其它MCP来源。`WorkflowInput.description/title`字段被忽略，描述应写入脚本meta；`RemoteTriggerInput.action`没有delete，不能称完整CRUD。

## 三、全部50份子help

各表完整列出Options；仅在父help声明、没有独立采集help的子入口在末尾另记。

### `claude agents [options]`

后台Agent/会话管理和派发默认配置。[agents-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--add-dir <directory>` | 增加工具可访问目录 | [agents-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:6) |
| `--agent <agent>` | 选择会话Agent | [agents-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:9) |
| `--all` | 包含/操作全部对象，范围见当前help | [agents-help.txt:12](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:12) |
| `--allow-dangerously-skip-permissions` | 允许选择绕过权限，默认不开启 | [agents-help.txt:14](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:14) |
| `--cwd <path>` | 按启动目录筛后台会话 | [agents-help.txt:17](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:17) |
| `--dangerously-skip-permissions` | 绕过权限检查 | [agents-help.txt:19](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:19) |
| `--effort <level>` | low/medium/high/xhigh/max努力级别 | [agents-help.txt:21](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:21) |
| `-h, --help` | 帮助 | [agents-help.txt:23](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:23) |
| `--json` | JSON输出，eval可指定路径 | [agents-help.txt:24](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:24) |
| `--mcp-config <config>` | 加载MCP JSON文件/字符串 | [agents-help.txt:27](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:27) |
| `--model <model>` | 模型别名/完整名 | [agents-help.txt:29](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:29) |
| `--permission-mode <mode>` | acceptEdits/auto/bypassPermissions/manual/dontAsk/plan权限模式 | [agents-help.txt:31](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:31) |
| `--plugin-dir <path>` | 本会话从目录或zip加载插件，可重复 | [agents-help.txt:33](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:33) |
| `--restricted` | 限制工具、设置来源、工作目录；禁止bypass | [agents-help.txt:37](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:37) |
| `--setting-sources <sources>` | 选择user/project/local设置来源 | [agents-help.txt:39](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:39) |
| `--settings <file-or-json>` | 加载设置文件/JSON | [agents-help.txt:41](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:41) |
| `--strict-mcp-config` | 仅用显式MCP配置 | [agents-help.txt:43](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/agents-help.txt:43) |

### `claude attach <id>`

接入后台终端，离开视图继续运行。[attach-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/attach-help.txt:1)。

无单独Options列表；位置参数与行为见help。

### `claude auth [options] [command]`

认证login/logout/status。[auth-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [auth-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-help.txt:6) |

### `claude auth login [options]`

订阅/Console/SSO登录。[auth-login-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-login-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--claudeai` | Claude订阅认证/托管市场（依命令） | [auth-login-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-login-help.txt:6) |
| `--console` | Console API计费认证 | [auth-login-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-login-help.txt:7) |
| `--email <email>` | 预填邮箱 | [auth-login-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-login-help.txt:9) |
| `-h, --help` | 帮助 | [auth-login-help.txt:10](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-login-help.txt:10) |
| `--sso` | 强制SSO | [auth-login-help.txt:11](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-login-help.txt:11) |

### `claude auth status [options]`

认证状态。[auth-status-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-status-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [auth-status-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-status-help.txt:6) |
| `--json` | JSON输出，eval可指定路径 | [auth-status-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-status-help.txt:7) |
| `--text` | 人类可读文本 | [auth-status-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-status-help.txt:8) |

### `claude auto-mode critique [options]`

AI评议规则。[auto-mode-critique-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auto-mode-critique-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [auto-mode-critique-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auto-mode-critique-help.txt:6) |
| `--model <model>` | 模型别名/完整名 | [auto-mode-critique-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auto-mode-critique-help.txt:7) |

### `claude auto-mode defaults [options]`

出厂环境/allow/soft_deny规则。[auto-mode-defaults-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auto-mode-defaults-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [auto-mode-defaults-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auto-mode-defaults-help.txt:7) |
| `--label <prefix>` | 规则标签前缀 | [auto-mode-defaults-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auto-mode-defaults-help.txt:8) |

### `claude auto-mode [options] [command]`

自动审批config/critique/defaults/reset。[auto-mode-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auto-mode-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [auto-mode-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auto-mode-help.txt:6) |

### `claude auto-mode reset [options]`

重置规则。[auto-mode-reset-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auto-mode-reset-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [auto-mode-reset-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auto-mode-reset-help.txt:7) |
| `-y, --yes` | 跳过确认或接受展示命令（依命令） | [auto-mode-reset-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auto-mode-reset-help.txt:8) |

### `claude doctor [options]`

安装健康检查。[doctor-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/doctor-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [doctor-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/doctor-help.txt:8) |

### `claude gateway [options]`

企业认证/遥测网关。[gateway-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/gateway-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--config <path>` | 网关YAML或插件配置键值（依命令） | [gateway-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/gateway-help.txt:6) |
| `-h, --help` | 帮助 | [gateway-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/gateway-help.txt:7) |

### `claude import [options] [source]`

导入codex/gemini/cursor配置。[import-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/import-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--dry-run` | 只预演，不修改 | [import-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/import-help.txt:9) |
| `-h, --help` | 帮助 | [import-help.txt:10](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/import-help.txt:10) |
| `--yes` | 跳过确认或接受展示命令（依命令） | [import-help.txt:11](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/import-help.txt:11) |

### `claude install [options] [target]`

安装stable/latest/指定版本。[install-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/install-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--force` | 强制执行/覆盖；范围见help | [install-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/install-help.txt:7) |
| `-h, --help` | 帮助 | [install-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/install-help.txt:8) |

### `claude logs <id>`

后台终端近期日志。[logs-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/logs-help.txt:1)。

无单独Options列表；位置参数与行为见help。

### `claude mcp add-from-claude-desktop [options]`

导入Desktop MCP。[mcp-add-from-claude-desktop-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-from-claude-desktop-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [mcp-add-from-claude-desktop-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-from-claude-desktop-help.txt:6) |
| `-s, --scope <scope>` | user/project/local等配置范围 | [mcp-add-from-claude-desktop-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-from-claude-desktop-help.txt:7) |

### `claude mcp add [options] <name> <commandOrUrl> [args...]`

添加stdio/SSE/HTTP MCP。[mcp-add-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--callback-port <port>` | OAuth回调端口 | [mcp-add-help.txt:20](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-help.txt:20) |
| `--client-id <clientId>` | OAuth客户端ID | [mcp-add-help.txt:22](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-help.txt:22) |
| `--client-secret` | 输入OAuth secret或环境提供 | [mcp-add-help.txt:23](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-help.txt:23) |
| `-e, --env <env...>` | MCP环境变量 | [mcp-add-help.txt:25](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-help.txt:25) |
| `-H, --header <header...>` | HTTP/SSE headers | [mcp-add-help.txt:26](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-help.txt:26) |
| `-h, --help` | 帮助 | [mcp-add-help.txt:28](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-help.txt:28) |
| `-s, --scope <scope>` | user/project/local等配置范围 | [mcp-add-help.txt:29](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-help.txt:29) |
| `-t, --transport <transport>` | stdio/sse/http传输 | [mcp-add-help.txt:31](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-help.txt:31) |

### `claude mcp add-json [options] <name> <json>`

JSON添加MCP。[mcp-add-json-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-json-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--client-secret` | 输入OAuth secret或环境提供 | [mcp-add-json-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-json-help.txt:6) |
| `-h, --help` | 帮助 | [mcp-add-json-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-json-help.txt:8) |
| `-s, --scope <scope>` | user/project/local等配置范围 | [mcp-add-json-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-add-json-help.txt:9) |

### `claude mcp get [options] <name>`

服务器详情。[mcp-get-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-get-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [mcp-get-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-get-help.txt:8) |

### `claude mcp [options] [command]`

MCP配置/认证/导入/服务命令族。[mcp-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [mcp-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-help.txt:6) |

### `claude mcp list [options]`

服务器列表。[mcp-list-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-list-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [mcp-list-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-list-help.txt:8) |

### `claude mcp login [options] <name>`

服务器OAuth。[mcp-login-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-login-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [mcp-login-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-login-help.txt:6) |
| `--no-browser` | 只打印授权URL | [mcp-login-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-login-help.txt:7) |

### `claude mcp remove [options] <name>`

移除MCP。[mcp-remove-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-remove-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [mcp-remove-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-remove-help.txt:6) |
| `-s, --scope <scope>` | user/project/local等配置范围 | [mcp-remove-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-remove-help.txt:7) |

### `claude mcp reset-project-choices [options]`

重置项目MCP决策。[mcp-reset-project-choices-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-reset-project-choices-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [mcp-reset-project-choices-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-reset-project-choices-help.txt:7) |

### `claude mcp serve [options]`

Claude Code作为MCP服务。[mcp-serve-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-serve-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-d, --debug` | 启用调试与分类过滤 | [mcp-serve-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-serve-help.txt:6) |
| `-h, --help` | 帮助 | [mcp-serve-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-serve-help.txt:7) |
| `--verbose` | 详细输出 | [mcp-serve-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-serve-help.txt:8) |

### `claude plugin details [options] <name>`

组件清单。[plugin-details-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-details-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [plugin-details-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-details-help.txt:6) |

### `claude plugin disable [options] [plugin]`

禁用插件。[plugin-disable-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-disable-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-a, --all` | 包含/操作全部对象，范围见当前help | [plugin-disable-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-disable-help.txt:6) |
| `-h, --help` | 帮助 | [plugin-disable-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-disable-help.txt:7) |
| `-s, --scope <scope>` | user/project/local等配置范围 | [plugin-disable-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-disable-help.txt:8) |

### `claude plugin enable [options] <plugin>`

启用插件。[plugin-enable-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-enable-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [plugin-enable-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-enable-help.txt:6) |
| `-s, --scope <scope>` | user/project/local等配置范围 | [plugin-enable-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-enable-help.txt:7) |

### `claude plugin eval [options] [command] [target]`

案例评测/基线/mock/成本/HTML报告。[plugin-eval-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--ablation <mode>` | 无插件基线对照 | [plugin-eval-help.txt:10](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:10) |
| `--allow-tools <tools...>` | 评测者授予门控工具 | [plugin-eval-help.txt:17](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:17) |
| `--case <glob>` | 案例名glob | [plugin-eval-help.txt:19](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:19) |
| `--eval-dir <dir>` | 评测案例目录 | [plugin-eval-help.txt:20](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:20) |
| `-h, --help` | 帮助 | [plugin-eval-help.txt:26](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:26) |
| `--json [path]` | JSON输出，eval可指定路径 | [plugin-eval-help.txt:27](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:27) |
| `--judge-model <model>` | LLM评判模型 | [plugin-eval-help.txt:30](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:30) |
| `--keep-temp` | 保留临时脚手架 | [plugin-eval-help.txt:31](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:31) |
| `--max-cost-usd <usd>` | 评测硬成本上限与部分结果 | [plugin-eval-help.txt:32](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:32) |
| `--mocks <mode>` | MCP模拟替身模式 | [plugin-eval-help.txt:39](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:39) |
| `--model <model>` | 模型别名/完整名 | [plugin-eval-help.txt:43](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:43) |
| `--no-publish` | 评测报告只保留本地 | [plugin-eval-help.txt:44](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:44) |
| `--no-scaffold` | 跳过scaffold脚本 | [plugin-eval-help.txt:46](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:46) |
| `--output-dir <dir>` | 结果目录 | [plugin-eval-help.txt:47](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:47) |
| `--publish-report` | 要求发布报告 | [plugin-eval-help.txt:49](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:49) |
| `--report <path>` | 自包含HTML报告 | [plugin-eval-help.txt:52](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:52) |
| `--runs <n>` | 每案例运行次数 | [plugin-eval-help.txt:55](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:55) |
| `--scaffold` | 执行脚手架脚本 | [plugin-eval-help.txt:56](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:56) |
| `--tag <tag...>` | 按标签筛案例 | [plugin-eval-help.txt:59](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:59) |
| `--threshold <0..1>` | 低分阈值退出1 | [plugin-eval-help.txt:60](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:60) |
| `--verbose` | 详细输出 | [plugin-eval-help.txt:62](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:62) |

### `claude plugin\|plugins [options] [command]`

插件管理命令族。[plugin-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [plugin-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-help.txt:6) |

### `claude plugin init\|new [options] <name>`

插件脚手架。[plugin-init-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-init-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--author <name>` | 插件作者 | [plugin-init-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-init-help.txt:7) |
| `--author-email <email>` | 作者邮箱 | [plugin-init-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-init-help.txt:8) |
| `--description <text>` | manifest描述 | [plugin-init-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-init-help.txt:9) |
| `-f, --force` | 强制执行/覆盖；范围见help | [plugin-init-help.txt:10](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-init-help.txt:10) |
| `-h, --help` | 帮助 | [plugin-init-help.txt:11](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-init-help.txt:11) |
| `--with <components...>` | 生成skills/agents/hooks/mcp/lsp等组件 | [plugin-init-help.txt:12](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-init-help.txt:12) |

### `claude plugin install\|i [options] <plugin>`

安装插件与userConfig。[plugin-install-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-install-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--config <key=value>` | 网关YAML或插件配置键值（依命令） | [plugin-install-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-install-help.txt:7) |
| `-h, --help` | 帮助 | [plugin-install-help.txt:11](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-install-help.txt:11) |
| `-s, --scope <scope>` | user/project/local等配置范围 | [plugin-install-help.txt:12](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-install-help.txt:12) |
| `-y, --yes` | 跳过确认或接受展示命令（依命令） | [plugin-install-help.txt:14](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-install-help.txt:14) |

### `claude plugin list [options]`

插件列表。[plugin-list-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-list-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--available` | 包含市场可用插件 | [plugin-list-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-list-help.txt:6) |
| `-h, --help` | 帮助 | [plugin-list-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-list-help.txt:7) |
| `--json` | JSON输出，eval可指定路径 | [plugin-list-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-list-help.txt:8) |

### `claude plugin marketplace add [options] <source>`

添加市场。[plugin-marketplace-add-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-add-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--claudeai` | Claude订阅认证/托管市场（依命令） | [plugin-marketplace-add-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-add-help.txt:6) |
| `-h, --help` | 帮助 | [plugin-marketplace-add-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-add-help.txt:9) |
| `--scope <scope>` | user/project/local等配置范围 | [plugin-marketplace-add-help.txt:10](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-add-help.txt:10) |
| `--sparse <paths...>` | Git稀疏检出路径 | [plugin-marketplace-add-help.txt:12](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-add-help.txt:12) |

### `claude plugin marketplace [options] [command]`

市场管理命令族。[plugin-marketplace-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [plugin-marketplace-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-help.txt:6) |

### `claude plugin marketplace list [options]`

市场列表。[plugin-marketplace-list-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-list-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [plugin-marketplace-list-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-list-help.txt:6) |
| `--json` | JSON输出，eval可指定路径 | [plugin-marketplace-list-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-list-help.txt:7) |

### `claude plugin marketplace remove\|rm [options] <name>`

删除市场声明。[plugin-marketplace-remove-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-remove-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [plugin-marketplace-remove-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-remove-help.txt:6) |
| `--scope <scope>` | user/project/local等配置范围 | [plugin-marketplace-remove-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-remove-help.txt:7) |

### `claude plugin marketplace update [options] [name]`

更新市场索引。[plugin-marketplace-update-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-update-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [plugin-marketplace-update-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-marketplace-update-help.txt:6) |

### `claude plugin prune\|autoremove [options]`

依赖清理。[plugin-prune-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-prune-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--dry-run` | 只预演，不修改 | [plugin-prune-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-prune-help.txt:6) |
| `-h, --help` | 帮助 | [plugin-prune-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-prune-help.txt:7) |
| `-s, --scope <scope>` | user/project/local等配置范围 | [plugin-prune-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-prune-help.txt:8) |
| `-y, --yes` | 跳过确认或接受展示命令（依命令） | [plugin-prune-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-prune-help.txt:9) |

### `claude plugin tag [options] [path]`

版本Git tag。[plugin-tag-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-tag-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--dry-run` | 只预演，不修改 | [plugin-tag-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-tag-help.txt:7) |
| `-f, --force` | 强制执行/覆盖；范围见help | [plugin-tag-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-tag-help.txt:8) |
| `-h, --help` | 帮助 | [plugin-tag-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-tag-help.txt:9) |
| `-m, --message <msg>` | tag注释模板 | [plugin-tag-help.txt:10](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-tag-help.txt:10) |
| `--push` | 创建后推远程 | [plugin-tag-help.txt:11](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-tag-help.txt:11) |
| `--remote <name>` | 推送remote | [plugin-tag-help.txt:12](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-tag-help.txt:12) |

### `claude plugin uninstall\|remove [options] <plugin>`

卸载插件。[plugin-uninstall-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-uninstall-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [plugin-uninstall-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-uninstall-help.txt:6) |
| `--keep-data` | 卸载保留数据 | [plugin-uninstall-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-uninstall-help.txt:7) |
| `--prune` | 清理自动安装依赖 | [plugin-uninstall-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-uninstall-help.txt:9) |
| `-s, --scope <scope>` | user/project/local等配置范围 | [plugin-uninstall-help.txt:11](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-uninstall-help.txt:11) |
| `-y, --yes` | 跳过确认或接受展示命令（依命令） | [plugin-uninstall-help.txt:13](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-uninstall-help.txt:13) |

### `claude plugin update [options] <plugin>`

更新插件。[plugin-update-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-update-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [plugin-update-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-update-help.txt:6) |
| `-s, --scope <scope>` | user/project/local等配置范围 | [plugin-update-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-update-help.txt:7) |
| `-y, --yes` | 跳过确认或接受展示命令（依命令） | [plugin-update-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-update-help.txt:9) |

### `claude plugin validate [options] <path>`

清单验证/CI。[plugin-validate-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-validate-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [plugin-validate-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-validate-help.txt:7) |
| `--json` | JSON输出，eval可指定路径 | [plugin-validate-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-validate-help.txt:8) |
| `--strict` | warning视为error | [plugin-validate-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-validate-help.txt:9) |

### `claude project [options] [command]`

项目状态管理。[project-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/project-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [project-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/project-help.txt:6) |

### `claude project purge [options] [path]`

清除一个/全部项目状态。[project-purge-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/project-purge-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--all` | 包含/操作全部对象，范围见当前help | [project-purge-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/project-purge-help.txt:7) |
| `--dry-run` | 只预演，不修改 | [project-purge-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/project-purge-help.txt:9) |
| `-h, --help` | 帮助 | [project-purge-help.txt:10](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/project-purge-help.txt:10) |
| `-i, --interactive` | 逐项确认删除 | [project-purge-help.txt:11](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/project-purge-help.txt:11) |
| `-y, --yes` | 跳过确认或接受展示命令（依命令） | [project-purge-help.txt:12](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/project-purge-help.txt:12) |

### `claude respawn <id>\|--all`

重启后台会话使用新版binary。[respawn-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/respawn-help.txt:1)。

无单独Options列表；位置参数与行为见help。

### `claude rm <id> [--discard-unpushed <commit>@<worktree-id>]`

删除会话/worktree，精确确认未推送丢弃。[rm-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/rm-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `--discard-unpushed <commit>@<worktree-id>` | 按commit@worktree-id精确确认丢弃未推送和未提交改动 | [rm-help.txt:4](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/rm-help.txt:4) |

### `claude setup-token [options]`

长期认证token，help注明需订阅。[setup-token-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/setup-token-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [setup-token-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/setup-token-help.txt:6) |

### `claude stop <id>`

停止后台会话并保留对话。[stop-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/stop-help.txt:1)。

无单独Options列表；位置参数与行为见help。

### `claude ultrareview [options] [target]`

云端多Agent审查，默认不贴PR。[ultrareview-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/ultrareview-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [ultrareview-help.txt:7](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/ultrareview-help.txt:7) |
| `--json` | JSON输出，eval可指定路径 | [ultrareview-help.txt:8](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/ultrareview-help.txt:8) |
| `--no-post` | 不发PR审查评论（默认） | [ultrareview-help.txt:10](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/ultrareview-help.txt:10) |
| `--post` | 以用户身份发布PR审查结果 | [ultrareview-help.txt:13](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/ultrareview-help.txt:13) |
| `--timeout <minutes>` | 等待审查的分钟数 | [ultrareview-help.txt:15](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/ultrareview-help.txt:15) |

### `claude update\|upgrade [options]`

检查并安装更新。[update-help.txt:1](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/update-help.txt:1)。

| 参数 | 中文释义 | H证据 |
|---|---|---|
| `-h, --help` | 帮助 | [update-help.txt:6](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/update-help.txt:6) |

父help额外声明：auth logout（退出，[auth-help.txt:11](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auth-help.txt:11)）；auto-mode config（有效配置JSON，[auto-mode-help.txt:9](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/auto-mode-help.txt:9)）；mcp logout（清OAuth，[mcp-help.txt:40](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/mcp-help.txt:40)）；plugin eval init（创建套件，[plugin-eval-help.txt:66](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/plugin-eval-help.txt:66)）。不将它们冒充额外已采集子help。

## 四、全部静态命令定义（115条/94个name）

按name归并，各变体type、gate、byte offset完整保留；没有isEnabled只表示局部定义未写，不能推出默认启用。Re()等压缩符号不猜测。

| name | 中文释义 | 变体type / gate / offset |
|---|---|---|
| `/__remote-workflow` | 服务器投递工作流，隐藏 | `local；@192009632；hidden=!0` |
| `/add-dir` | 增加工作目录 | `local；@188219145；enabled=()=>Re()&&mgr()；动态get:isHidden`<br>`local-jsx；@188219404` |
| `/advisor` | 关键节点咨询强模型 | `local-jsx；@192006139；enabled=()=>Bv()；动态get:argumentHint,isHidden`<br>`local；@192006452；enabled=()=>Re()&&Bv()；动态get:argumentHint,isHidden` |
| `/agents` | 旧斜杠入口已removed，提示通过Agent/.claude/agents管理，非CLI agents | `local；@191986797` |
| `/artifacts` | 作品浏览 | `local-jsx；@191901166；enabled=()=>aC()&&Xd()===null；aliases=[]` |
| `/auto-mode-setup` | 自动审批环境/规则设置 | `local；@191900572；enabled=()=>UEt()&&Re()；动态get:isHidden`<br>`local-jsx；@191900970；enabled=()=>WEt()&&!Re()` |
| `/autocompact` | 压缩窗口 | `local-jsx；@191909844；enabled=()=>!Re()；hidden=!1`<br>`local；@191910068；动态get:isHidden` |
| `/autofix-pr` | 监测并自动修PR | `local-jsx；@191901387；enabled=()=>hpr()&&!Re()；动态get:isHidden` |
| `/branch` | 对话分支 | `local-jsx；@191985652` |
| `/btw` | 不打断主任务的旁路提问 | `local-jsx；@191901622` |
| `/bug` | 报告问题/分享对话 | `local-jsx；@191902041；aliases=["share"]` |
| `/cd` | 切换会话工作目录 | `local-jsx；@191902214` |
| `/chrome` | Chrome设置 | `local-jsx；@192005577；enabled=()=>!Re()&&JD()` |
| `/clear` | 新空上下文，旧会话保留 | `local；@191902340；aliases=["reset","new"]` |
| `/cloud-plugins` | 云端插件转发选择 | `local-jsx；@188219593；enabled=()=>Tet()&&!a.CLAUDE_CODE_DISABLE_PLUGIN_FORWARDING` |
| `/color` | 提示条颜色 | `local-jsx；@191902647`<br>`local；@191902888；enabled=()=>Re()；动态get:isHidden` |
| `/compact` | 总结释放上下文 | `local；@191909515；enabled=()=>!Oe(process.env.DISABLE_COMPACT)` |
| `/config` | 设置 | `local-jsx；@191910405；aliases=["settings"]`<br>`local；@191910703；enabled=()=>Re()；动态get:isHidden；aliases=["settings"]` |
| `/context` | 上下文占用 | `local-jsx；@191911266；enabled=()=>!Re()`<br>`local；@191911446；动态get:isHidden` |
| `/copy` | 复制回答 | `local-jsx；@191903179` |
| `/design-consent` | Design访问授权 | `local；@191939352；enabled=()=>cF()；hidden=!0` |
| `/design-login` | Design登录 | `local-jsx；@191939815；enabled=()=>cF()` |
| `/design-revoke` | 撤销Design访问 | `local；@191939579；enabled=()=>cF()；hidden=!0` |
| `/desktop` | 转桌面继续 | `local-jsx；@191903390；enabled=FTe；动态get:isHidden；aliases=["app"]` |
| `/diff` | 差异查看（动态描述） | `local-jsx；@191911801；动态get:description` |
| `/effort` | 努力级别 | `local-jsx；@192014289；动态get:argumentHint`<br>`local；@192014481；enabled=()=>Re()；动态get:argumentHint,isHidden` |
| `/exit` | 退出 | `local-jsx；@192008199；动态get:description；aliases=["quit"]`<br>`local；@192008369；动态get:description` |
| `/export` | 导出对话 | `local-jsx；@192008817` |
| `/extra-usage` | usage-credits旧名 | `local-jsx；@192010844；enabled=()=>qS()&&!Re()；hidden=!0`<br>`local；@192010982；enabled=()=>qS()&&Re()；hidden=!0` |
| `/fast` | 快速模式（动态描述/隐藏） | `local-jsx；@191980068；动态get:description,isHidden`<br>`local；@191980277；enabled=()=>Re()；动态get:description,isHidden` |
| `/feedback` | 反馈 | `local-jsx；@191901878` |
| `/focus` | 提示/摘要/回答焦点视图 | `local-jsx；@192014955` |
| `/fork` | 完整对话后台代理/副本，有两个定义 | `local-jsx；@191985845；enabled=()=>!Pi()`<br>`local-jsx；@191986056；enabled=()=>!Pi()` |
| `/heapdump` | 堆转储，策略门控 | `local；@191988450；enabled=()=>Ht("allow_heap_dump")；hidden=!0` |
| `/help` | 帮助 | `local-jsx；@191912543` |
| `/hooks` | hook配置 | `local-jsx；@191985382` |
| `/ide` | IDE集成 | `local-jsx；@191912689` |
| `/import` | 导入其他工具配置 | `local-jsx；@191913727；enabled=V7；动态get:isHidden`<br>`local；@191913924；enabled=()=>V7()&&Re()；动态get:isHidden` |
| `/init` | 初始化说明（prompt命令，动态描述） | `prompt；@191938742；动态get:description` |
| `/insights` | 会话分析报告 | `prompt；@192017840` |
| `/install-github-app` | GitHub Actions配置 | `local-jsx；@191940446；enabled=()=>!a.DISABLE_INSTALL_GITHUB_APP_COMMAND` |
| `/install-slack-app` | Slack应用安装 | `local；@191940656` |
| `/keybindings` | 快捷键文件 | `local；@191939135；enabled=()=>sF()` |
| `/login` | 登录 | `local-jsx；@191939992；enabled=()=>!a.DISABLE_LOGIN_COMMAND；动态get:description` |
| `/logout` | 退出账号 | `local-jsx；@191940206；enabled=()=>!a.DISABLE_LOGOUT_COMMAND` |
| `/loops` | 循环管理入口，明确禁用 | `local-jsx；@191985529；enabled=()=>!1` |
| `/mcp` | MCP管理 | `local；@191940909；enabled=()=>Re()；动态get:isHidden`<br>`local-jsx；@191941183` |
| `/memory` | CLAUDE.md与记忆设置 | `local-jsx；@191912087` |
| `/mobile` | 移动下载码 | `local-jsx；@191941367；aliases=["ios","android"]` |
| `/model` | 模型选择 | `local；@192008979；enabled=()=>Re()；动态get:isHidden`<br>`local-jsx；@192009204；动态get:description` |
| `/passes` | 动态描述入口，不推断具体业务 | `local-jsx；@191984954；动态get:description,isHidden` |
| `/pause-memory` | 暂停自动记忆，明确禁用 | `local；@191912228；enabled=()=>!1；hidden=!1；aliases=["memory-pause","toggle-memory"]` |
| `/permissions` | allow/deny规则 | `local-jsx；@191979715；aliases=["allowed-tools"]` |
| `/plan` | 计划模式/计划查看 | `local-jsx；@191979903` |
| `/plugin` | 插件管理 | `local-jsx；@191987023；aliases=["plugins","marketplace"]` |
| `/plugin-types` | 导出插件/MCP TypeScript声明 | `local；@191987327` |
| `/powerup` | 功能入门课程 | `local-jsx；@191942091` |
| `/privacy-settings` | 隐私 | `local-jsx；@191985234；enabled=()=>LW()` |
| `/pro-trial-expired` | 试用到期，隐藏 | `local-jsx；@192011177；hidden=!0` |
| `/radio` | Claude FM音乐 | `local；@192005973` |
| `/rate-limit-options` | 限流后选项，隐藏 | `local-jsx；@192011323；enabled=()=>gt()\|\|!1；hidden=!0` |
| `/release-notes` | 发行说明 | `local-jsx；@191942229` |
| `/reload-plugins` | 生效插件修改 | `local；@191987662` |
| `/reload-skills` | 重载磁盘技能 | `local；@191987942` |
| `/remote-env` | 云环境选择 | `local-jsx；@192009419；enabled=()=>gt()&&Ht("allow_remote_sessions")；动态get:isHidden` |
| `/rename` | 改会话名 | `local-jsx；@191942336；aliases=["name"]`<br>`local；@191942539；enabled=()=>Re()；动态get:isHidden；aliases=["name"]` |
| `/resume` | 恢复会话 | `local-jsx；@191942792；aliases=["continue"]` |
| `/rewind` | 恢复代码/对话；checkpoint/undo别名 | `local；@191988175；aliases=["checkpoint","undo"]` |
| `/sandbox` | 沙箱设置，动态条件 | `local-jsx；@191991377；动态get:description,argumentHint,isHidden` |
| `/scroll-speed` | 滚轮速度 | `local-jsx；@191944128；enabled=()=>{if(!Aa())return!1;let e=hl();return!(e?OG.includes(e.terminal??""):fb.isJetBrainsIdeTerminal())}` |
| `/session` | 云URL/二维码 | `local-jsx；@191943835；enabled=()=>Nn()；动态get:isHidden；aliases=["remote"]` |
| `/setup-bedrock` | Bedrock认证/区域/模型配置 | `local-jsx；@191942955；动态get:isHidden` |
| `/setup-vertex` | Vertex认证/项目/区域/模型配置 | `local-jsx；@191943131；动态get:isHidden` |
| `/skill-doctor` | 闲置技能上下文开销 | `local-jsx；@191979017`<br>`local；@191979169；enabled=()=>Re()；动态get:isHidden` |
| `/skills` | 技能列表 | `local-jsx；@191944341` |
| `/status` | 版本/账号/模型/API/工具状态 | `local-jsx；@191944476` |
| `/statusline` | 状态行 | `prompt；@192013228；aliases=[]` |
| `/stickers` | 贴纸订购 | `local；@192005809` |
| `/subtask` | 完整上下文委派 | `local-jsx；@191986228；enabled=()=>!Pi()` |
| `/tasks` | 后台任务 | `local-jsx；@191944665；aliases=["bashes"]` |
| `/teleport` | 云/本地迁移或恢复 | `local-jsx；@191944849；enabled=()=>gt()&&Ht("allow_remote_sessions")；动态get:isHidden；aliases=["tp"]` |
| `/terminal-setup` | 终端设置 | `local-jsx；@191957450；动态get:description` |
| `/theme` | 主题 | `local-jsx；@191979436` |
| `/tui` | default/fullscreen渲染 | `local-jsx；@191979567` |
| `/ultraplan` | 高级规划入口，动态描述与门控 | `local-jsx；@191978266；enabled=()=>rL()；动态get:description` |
| `/ultrareview` | 云审查，门控 | `local-jsx；@191943539；enabled=()=>RT()；动态get:description`<br>`local；@191943632；enabled=()=>Re()&&RT()；动态get:description,isHidden` |
| `/update` | 会话内更新，禁用；非CLI update | `local；@192008540；enabled=()=>!1；hidden=!0；aliases=["restart"]` |
| `/upgrade` | 升级Max | `local-jsx；@192010232；enabled=oV` |
| `/usage` | 成本/套餐/活动 | `local-jsx；@191978505；aliases=["cost","stats"]`<br>`local；@191978698；enabled=()=>Re()；动态get:isHidden；aliases=["cost","stats"]` |
| `/usage-credits` | 额度配置/申请 | `local-jsx；@192010405；enabled=()=>qS()&&!Re()`<br>`local；@192010584；enabled=()=>qS()&&Re()；动态get:isHidden` |
| `/version` | 会话内版本，禁用；非CLI --version | `local-jsx；@191989055；enabled=()=>!1`<br>`local；@191990733；enabled=()=>!1；动态get:isHidden` |
| `/voice` | 语音hold/tap/off，availability与动态条件 | `local；@191941853；动态get:isHidden` |
| `/wellbeing` | 休息/安静时段提醒，禁用 | `local-jsx；@192014736；enabled=()=>!1；aliases=["breaks","break-reminder","downtime"]` |
| `/workflow-launch-exec` | 服务器工作流交接，隐藏 | `local；@192009937；hidden=!0` |

明确isEnabled=false：**6条定义 / 5个name**：`pause-memory@191912228`、`loops@191985529`、`version@191989055`、`version@191990733`、`update@192008540`、`wellbeing@192014736`。loops/wellbeing/version不可写成当前公开可用；斜杠update禁用不否定CLI update。

## 五、33个hook事件

来源枚举起点`@182375699`；下面offset按同一片段UTF-8精确计算到带引号事件名开头。中文名称释义不额外断言所有事件均可阻塞或异步恢复。

| # | 事件 | 中文释义 | S offset |
|---:|---|---|---:|
| 1 | `PreToolUse` | 工具执行前 | 182375700 |
| 2 | `PostToolUse` | 工具成功后 | 182375713 |
| 3 | `PostToolUseFailure` | 工具失败后 | 182375727 |
| 4 | `PostToolBatch` | 批次工具结束后 | 182375748 |
| 5 | `Notification` | 通知 | 182375764 |
| 6 | `UserPromptSubmit` | 用户提交提示 | 182375779 |
| 7 | `UserPromptExpansion` | 提示扩展阶段 | 182375798 |
| 8 | `SessionStart` | 会话开始 | 182375820 |
| 9 | `SessionEnd` | 会话结束 | 182375835 |
| 10 | `Stop` | 代理停止 | 182375848 |
| 11 | `StopFailure` | 停止失败 | 182375855 |
| 12 | `SubagentStart` | 子代理开始 | 182375869 |
| 13 | `SubagentStop` | 子代理停止 | 182375885 |
| 14 | `PreCompact` | 压缩前 | 182375900 |
| 15 | `PostCompact` | 压缩后 | 182375913 |
| 16 | `PreModelSwitch` | 切模型前 | 182375927 |
| 17 | `PostModelSwitch` | 切模型后 | 182375944 |
| 18 | `PermissionRequest` | 请求权限 | 182375962 |
| 19 | `PermissionDenied` | 权限拒绝 | 182375982 |
| 20 | `Setup` | 初始化 | 182376001 |
| 21 | `TeammateIdle` | 队友空闲 | 182376009 |
| 22 | `TaskCreated` | 任务创建 | 182376024 |
| 23 | `TaskCompleted` | 任务完成 | 182376038 |
| 24 | `Elicitation` | 外部交互询问 | 182376054 |
| 25 | `ElicitationResult` | 询问结果 | 182376068 |
| 26 | `ConfigChange` | 配置变更 | 182376088 |
| 27 | `WorktreeCreate` | 创建worktree | 182376103 |
| 28 | `WorktreeRemove` | 移除worktree | 182376120 |
| 29 | `InstructionsLoaded` | 加载说明 | 182376137 |
| 30 | `CwdChanged` | 工作目录改变 | 182376158 |
| 31 | `FileChanged` | 文件改变 | 182376171 |
| 32 | `DirectoryAdded` | 增加目录 | 182376185 |
| 33 | `MessageDisplay` | 消息展示 | 182376202 |

枚举数量不等于hook类型数量。command/prompt/agent/http为处理方式线索；内嵌说明对prompt/agent限定特定tool事件，不能推定33种事件全部支持全部处理方式。

## 六、隐藏/条件开关与协议治理线索

K层只证明局部字符串/代码。无正命中明确标记；不能把搜索词当功能。

| 项 | 局部释义/限制 | K/S offset |
|---|---|---|
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | 实验多Agent开关；邻近还有其它条件/服务端门控，变量不保证启用 | `@182788921`、`@183160170`、`@186612807`、`@201776805` |
| `SendMessage` | 团队与跨会话通信；peer machine审批、crossSessionInbound accept/hold/refuse | `@98978428`、`@101702587`、`@183341620`、`@183341984` |
| `TeamCreate` | 只有残余集合名；45个Input中无此Input，非现行公开建队证明 | `@189502562` |
| `TeamDelete` | 只有残余集合名；45个Input中无此Input，非现行公开删队证明 | `@189502575` |
| `PowerShell` | restricted主help明示代码执行工具包含PowerShell；采集到的早期binary同名片段可能来自Bun基础设施，不单独算工具实现证据 | [main-help.txt:188](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:188) |
| `ToolSearch` | 按需工具发现；未在45个Input中不等于不存在 | `@99762534`、`@99762573`、`@99762654`、`@99762768` |
| `SendUserMessage` | 向用户发消息，主help --brief明确启用 | `@183079171`、`@183261190`、`@183898412`、`@183898481` |
| `LSP` | LSP集成线索，不等于全部语言服务器默认安装 | `@89904867`、`@102767769`、`@103380374`、`@182793782` |
| `ENABLE_TOOL_SEARCH` | 工具搜索开关，force/管理策略优先；代理和网关有条件 | `@103766251`、`@103766291`、`@182794017`、`@183160916` |
| `defer_loading` | MCP工具延迟加载；always-loaded声明可取消defer并阻塞启动等连接 | `@102252101`、`@184404458`、`@184405494`、`@184406140` |
| `tool_reference` | 工具检索引用block与Beta抑制例外 | `@102342506`、`@103766084`、`@184396655`、`@184500065` |
| `isConcurrencySafe` | 工具并发安全元数据，局部默认false；另有只读/破坏性标志 | `@185053179`、`@186171446`、`@188857910`、`@188892384` |
| `CLAUDE_CODE_USE_BEDROCK` | Bedrock路由 | `@182758627`、`@182823017`、`@183150601`、`@183151018` |
| `CLAUDE_CODE_USE_VERTEX` | Vertex路由 | `@182758668`、`@182823140`、`@183150627`、`@183151771` |
| `CLAUDE_CODE_USE_FOUNDRY` | Foundry路由 | `@182758708`、`@182823048`、`@183150652`、`@183152952` |
| `DISABLE_NONESSENTIAL_TRAFFIC` | 实际CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC；另有DISABLE_TELEMETRY/DO_NOT_TRACK | `@182756843`、`@182757147`、`@182757195`、`@182757279` |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | 遥测开关，不推定当前开启 | `@183160139`、`@185602573`、`@196402324`、`@196402465` |
| `OTEL_EXPORTER` | OpenTelemetry导出配置 | `@182781029`、`@182781068`、`@182781106`、`@182782318` |
| `allowManagedHooksOnly` | 仅受管hooks的限制性策略 | `@183142140`、`@183146497`、`@183147704`、`@183309348` |
| `allowManagedPermissionRulesOnly` | 仅受管权限规则 | `@183142082`、`@183310233`、`@183433628`、`@183433667` |
| `allowManagedMcpServersOnly` | 仅受管MCP | `@183142188`、`@183147650`、`@183310612`、`@183345148` |
| `disableAllHooks` | 禁全部hooks策略 | `@183142290`、`@183145962`、`@183146474`、`@183305948` |
| `disableBypassPermissionsMode` | 禁bypass企业策略 | `@183143036`、`@183146195`、`@183270614`、`@183434652` |
| `strictKnownMarketplaces` | 市场来源约束，与sideload治理交叉 | `@102709564`、`@102710483`、`@102774646`、`@102774844` |
| `allowedMcpServers` | MCP允许列表 | `@102696611`、`@102702993`、`@102703281`、`@102709599` |
| `deniedMcpServers` | MCP拒绝列表 | `@102696562`、`@183147631`、`@183302965`、`@183303840` |
| `forceLoginMethod` | 固定登录方式 | `@102713038`、`@183317976`、`@183318349`、`@183320210` |
| `forceLoginOrgUUID` | 固定登录组织 | `@102713019`、`@183276616`、`@183320191`、`@183320759` |
| `autoMemoryEnabled` | 自动记忆读写开关 | `@183334852`、`@184759152`、`@184759188`、`@185305108` |
| `autoMemoryDirectory` | 自定义记忆目录；projectSettings配置被忽略以免仓库改变存储路径 | `@183335011`、`@184760493`、`@208448590`、`@208448675` |
| `claudeMdExcludes` | 排除CLAUDE.md；不能排除受管说明 | `@183337525`、`@192229035`、`@194731206`、`@196519940` |
| `CLAUDE.local.md` | 本地说明约定 | `@184816700`、`@188845147`、`@190382685`、`@191919610` |
| `.claude/rules` | 目录规则线索 | `@102727348`、`@183337886`、`@191921128`、`@191921975` |
| `.claude-plugin` | 插件清单约定 | `@97088653`、`@97088842`、`@97088877`、`@183236486` |
| `lspServers` | LSP声明 | `@183206984`、`@183207133`、`@183232846`、`@184958022` |
| `worktree.sparsePaths` | 大仓库worktree稀疏检出 | `@208115258` |
| `allowedDomains` | 沙箱网络域名 | `@183119388`、`@183119515`、`@183119568`、`@183119768` |
| `excludedCommands` | 沙箱排除命令，权限另验 | `@183141199`、`@188045518`、`@188050073`、`@188050139` |
| `enableWeakerNestedSandbox` | 弱嵌套沙箱兼容 | `@183140136`、`@183144718`、`@183158454`、`@187888690` |
| `bubblewrap` | Linux沙箱实现线索 | `@183141669`、`@187875708`、`@187875787`、`@188040640` |
| `sandbox-exec` | macOS沙箱实现线索 | `@187907794` |
| `Windows sandbox` | Windows沙箱说明线索，不断言可运行 | `@187925255`、`@187925553`、`@187933829`、`@187963018` |
| `rewindFiles` | 检查点恢复文件 | `@184439271`、`@184600128`、`@196115319`、`@196115386` |
| `cache_control` | 提示缓存协议 | `@184395223`、`@184396059`、`@184396321`、`@184396442` |
| `asyncRewake` | 异步hook唤醒 | `@183198830`、`@183199091`、`@183199291`、`@192140007` |
| `type: "http"` | 仅通用类型字符串命中；片段不足以归属hook，不据此认定HTTP hook类型 | `@90019854`、`@90065365` |
| `type: "command"` | 仅通用类型字符串命中；片段不足以归属hook，不据此认定command hook类型 | `@91116652` |
| `type: "prompt"` | 待核实的prompt hook候选；无已采集正证据，不据搜索词认定存在 | 未命中/无片段 |
| `type: "agent"` | 待核实的agent hook候选；无已采集正证据，不据搜索词认定存在 | 未命中/无片段 |

直接公开模式：--safe-mode→CLAUDE_CODE_SAFE_MODE=1（[main-help.txt:206](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:206)）；--bare→CLAUDE_CODE_SIMPLE=1（[main-help.txt:40](/D:/dev/ai-agent-engine/docs/research/claude-2.1.266-evidence/main-help.txt:40)）；cloud-plugins启用表达式含!CLAUDE_CODE_DISABLE_PLUGIN_FORWARDING（S @188219593）。

## 七、限制与不能下的结论

- 115条定义是既有抽取范围内的完整枚举，不保证覆盖binary所有动态生成/远程下发入口；94个name不是某账号实际菜单数。
- 45个Input只为随包schema。SendMessage/PowerShell/ToolSearch/LSP有额外线索；ClaudeDesign/Projects/Artifact/RemoteTrigger有schema也不代表当前已注册或可调用。
- TeamCreate/TeamDelete现有证据只是残余名；AgentInput明确team_name废弃且忽略、session使用隐式team，不应套用历史版本公开团队API。
- loops/wellbeing/pause-memory/version和会话内update显式禁用；Cron/ScheduleWakeup、/loop字符串存在也不能抹掉这些具体入口禁用事实。
- 本次没有登录执行验证，**无法断言云审查、云代理、Design、Projects、Artifacts、远程隔离或其它付费/feature-gated服务对当前账号、套餐、平台、企业策略可用**。
