# Aether Engine 与 Claude Code 2.1.266 深度能力对比

审计日期：2026-09-29。引擎对象：`D:\dev\ai-agent-engine` 的**当前工作树，包含未提交修改**。竞品对象：用户指定目录 `C:\Users\wb.xielin02\AppData\Roaming\Wuzu Client Dev\cli-binaries\claude\2.1.266` 中的实际安装包。

引擎基线 HEAD：`14ea05bcaf912b0c778224c3d46c3332fdbc2fc8`；结论以工作树而非该提交单独内容为准。[源码文件指纹清单](engine-source-manifest.json)保存本次审计末尾的逐文件 SHA-256，便于后续代码变更时复核。

## 1. 核心判断

**当前引擎已经具备相当宽的 Agent 平台基础，但与这份 Claude CLI 的主要差距是执行正确性、权限一致性、编码工作流和可恢复运行的完成度。工具数量接近不能说明能力接近。**

引擎有真实的 ReAct、多模型、文件/办公文档工具、长期图记忆、RAG、HTTP API、网页/移动控制台、Flow、Cron，以及最近加入的子代理持久状态、事件/outbox、预算和取消。这些不是空壳，应继续保留。

然而，若直接用它代替成熟的编码代理，当前会遇到几类实质问题：压缩后的摘要在部分 adapter 中丢失；主聊天未接上 fallback；正文整段生成后才模拟流式；同批工具副作用与审批/终态记录可能脱节；若干安全检查可被另一执行入口绕开；任务队列、指标、Flow 配置、知识库绑定等存在“接口有了但执行链未接齐”的情况。

**Claude 2.1.266 的范围也远超过“终端聊天 + Bash + Edit”。** 本地包可核验的表面包含：后台会话管理、工作树、会话分叉/恢复、IDE/Chrome、云会话、远程控制、企业网关、插件市场和插件评测、MCP OAuth/多传输、结构化输出与预算。类型和静态实现还显示 REPL、Workflow、监视器、持久定时任务、远程触发、Artifacts、Projects、目标提议、语音等方向；其中不少是条件能力，不能直接算为本机账号默认可用。

因此建议：**先修复已经承诺的运行契约，再补编码协作能力，最后扩展云和生态。** 不建议先复制更多工具名称或方法论提示词。

## 2. 证据范围与可信度

### 本次真正检查了什么

| 项目 | 证据与范围 |
|---|---|
| 包身份 | package.json 自报 `@anthropic-ai/claude-code@2.1.266`；执行 `--version` 返回 `2.1.266 (Claude Code)` |
| 文件形态 | 原生 `bin/claude.exe`，218,971,808 字节；启动器、安装脚本、README、工具类型定义 |
| SHA-256 | `d2c5f7b3b6a12819097ceb6efbce2a390157166003fcaee32dbde0e6d7b45ef7` |
| 帮助采集 | 51 次本地 `--help` 均退出 0，保存主命令和子命令输出；主帮助含65组参数声明 |
| 工具协议 | 45 个导出的 `*Input` interface，逐项提取字段与行号 |
| 静态命令 | 从可读命令模块提取 115 处命令定义、94 个不同name；同名可有交互/非交互两个实现，不能当 115 个功能 |
| 静态线索 | 156 个定位关键词的短片段、字节偏移；729 个环境变量名字，仅为检索索引 |
| 引擎 | 跟踪 API → 上下文 → loop → registry → 工具/adapter → 存储/事件，以及控制台、SDK、部署和测试 |
| 验证 | 类型检查通过；全量测试的实际结果见第 11 节 |

**H**：实际帮助显示的公开入口。**T**：随包类型声明。**S**：二进制可读实现/配置/命令定义。**E**：引擎源码中可追到的实现。**V**：本次动态验证。H/T/S 都不能替代模型任务的端到端验收；S 的字符串还可能来自旧兼容代码或未启用分支。

本次未登录 Claude、未读取账号凭据、未请求付费模型、未启动云任务、未执行插件评测、未验证远程控制/沙箱/IDE/Chrome 服务是否在本机可用。没有对两边作同模型同任务性能竞赛，不能给出“完成率差多少”“快几倍”“省多少成本”等数字。包的自报版本和本地 hash 也不等于已与官方发布校验值核对。

“全部”在本报告指**本地可观察能力面尽量完整盘点**，不指服务端、账号授权、灰度开关及所有动态插件组合已被穷尽。

### 阅读与追溯入口

- [Claude 能力全目录](2026-09-29-claude-capability-catalog.md)：工具接口、CLI 参数/子命令、静态命令、Hooks。
- [引擎核心运行时审计](2026-09-29-runtime-audit.md)：完整主循环、模型、上下文、并发、子代理与预算证据。
- [引擎工具与安全审计](2026-09-29-tools-security-audit.md)：46 个工具完整清单，以及扩展/路径/网络/审批边界。
- [引擎平台与产品审计](2026-09-29-platform-audit.md)：API/SDK/会话/记忆/Flow/Cron/UI/治理。
- [采集清单](claude-2.1.266-evidence/manifest.json)、[主帮助](claude-2.1.266-evidence/main-help.txt)、[工具类型原件](claude-2.1.266-evidence/sdk-tools.d.ts)、[工具字段索引](claude-2.1.266-evidence/tool-input-index.json)、[命令定义索引](claude-2.1.266-evidence/embedded-command-index.json)、[静态片段](claude-2.1.266-evidence/binary-excerpts.json)。

仓库旧的 `ai-agent-engine_vs_claude-code_compare_report.md` 对比的是另一个路径中的公开样例/生态仓库，明确没有 Claude 核心运行时。旧报告“Claude 没有后端/模型/存储源码，所以 Aether 领先”的口径，**不能用于本次实物产品比较**。本报告保留旧文档，不覆盖其历史结论。

## 3. 能力总览：逐项判断差距

以下“已有”指 E 级接线证据，不代表每个外部依赖都已动态验证。“未见”限定当前仓库；外部宿主 Wuzu 的功能不自动记到引擎名下。Claude 的“有入口/有定义”始终保留 H/T/S 等级。

### 3.1 模型、推理与上下文

| 能力 | Claude 2.1.266 | 当前引擎 | 判断 |
|---|---|---|---|
| 自主工具推理循环 | Bash/文件/Agent 等 T；实际循环有 S | ReAct 多轮工具循环、终态和失败刹车 | 基础已具备，可靠性仍有差距 |
| 模型选择/推理深度 | H `--model`、`--effort low…max`；模型家族/账号限制另验 | OpenAI-compatible、Anthropic、DeepSeek、Qwen、Ollama 等 | 引擎的跨供应商定位更开放；各 adapter 完整度不一 |
| 第三方云供应商 | H `--bare` 明示 Bedrock/Vertex/Foundry 凭据；S 对应配置 | 通用认证字段及兼容 HTTP；未见同等原生云协议 adapter | 认证字段不等于服务原生支持 |
| 模型失败降级 | H `--fallback-model` 支持列表、顺序尝试、每用户轮重试主模型 | complete 有备用；stream 只转 primary | 主路径缺陷，优先修 |
| 真正流式正文 | H partial messages/stream-json；内部有 S streaming | adapter 流式，loop 缓存正文后再每 20 字输出 | 用户体验差距明确，不作 TTFT 数值推断 |
| 思考和工具参数增量 | H/S 多消息流，T tool 协议 | reasoning 实时；OpenAI 参数增量；Anthropic 部分 | 已有基础，事件语义需统一 |
| 系统提示词替换/追加 | H system/append/system-prompt-snapshot | systemPrompt 与 AE.md/记忆/RAG 注入 | 缺会话级 prompt 快照、缓存友好边界 |
| 自动压缩 | H `--autocompact auto/100k–1M`；S compact/context | 自动/手动压缩、工具结果清理、摘要模型 | 已有但 Anthropic/Ollama 会丢摘要 |
| 总上下文容量 | H 压缩触发窗口可配；模型实际容量由模型/服务条件决定；内部策略仅部分 S | 检查主要依赖 history；未完整计 system/tools/输出预留 | 引擎需完整请求级预算；不能声称无损无限上下文 |
| 提示词缓存 | H 动态段搬移选项；S cache_control | 有缓存计量；Anthropic 未见标准缓存块构造 | 统计字段不能代替缓存控制 |
| 结构化输出 | H `--json-schema` | JSON object 模式，未见通用 Schema 终态验证 | 缺契约与验证/修复闭环 |
| 成本/Token 上限 | H `--max-budget-usd`；plugin eval 独立成本上限 | 父子物理请求预算、预留/结算；默认无限 | 已有好基础，美元上限及辅助模型调用覆盖不足 |
| 工具按需加载 | S ToolSearch、defer_loading/tool_reference | 每轮发送全部工具 schema | 大 MCP 集合的上下文与延迟差距 |
| 项目说明与规则 | H CLAUDE.md 自动发现开关；S rules/local/excludes | 3 层 AE.md 拼接，每份限长 | 缺目录作用域、路径规则、导入及互操作 |
| 持久自动记忆 | H bare 明示 auto-memory；S memory 设置 | 图节点/边/embedding/强度/来源、自动抽取/召回 | 引擎结构化记忆是独立价值，勿按文档数量比较 |
| 多模态 | T FileReadOutput 图片/PDF等；具体模型支持另验 | 图片/OCR/视觉代理，办公格式解析 | 引擎偏数据处理；adapter 实际多模态语义需逐个验收 |
| Ollama 本地代理 | 本包未发现任意 Ollama provider 产品入口 | 可文本聊天，能力表宣称工具/视觉但协议未实现 | 开放性优势暂未全部兑现 |

证据：Claude main-help、sdk-tools；引擎详细路径见运行时附录。最关键位置：`react.ts:493/500/555`、`retry.ts:120`、`jsonl-history.ts:235`、`anthropic.ts:153/329`、`ollama.ts:28/39/75`。

### 3.2 文件、代码、命令与联网

| 能力 | Claude 2.1.266 | 当前引擎 | 判断 |
|---|---|---|---|
| 文本分段读取 | T Read offset/limit/pages | read_file 行窗口/格式路由/摘要 | 基础已有 |
| 精确编辑 | T Edit old_string/new_string/replace_all | write_file 全量写 | 原生精确编辑缺失，编码任务高优先级 |
| Notebook cell 编辑 | T NotebookEdit cell_id/type/mode | 只能按 JSON/文本处理 | 缺语义工具 |
| Glob/Grep | T 多过滤/上下文/分页/多行选项 | rg 优先、Node fallback、glob 深度限制 | 基础已有；选项/回退一致性有差距 |
| LSP 导航 | S definition/references/hover/symbol/implementation/callHierarchy | TS/ESLint 诊断包装 | 与完整 LSP 的能力差距较大 |
| 代码图谱 | 未从本包确认同等内置图索引产品 | codegraph 搜索/调用/影响面/索引 | 引擎已有有价值的补充；依赖索引新鲜度 |
| 诊断可信状态 | 未做同口径动态验证 | 不支持语言/adapter 不可用也可能显示“通过” | 应区分通过、失败、不支持、不可用 |
| Shell 执行 | T Bash timeout/background；H restricted 明示 PowerShell | execute_cmd argv、超时、取消、终止进程树 | 同步执行基础已有 |
| 后台 Shell 生命周期 | T TaskOutput/TaskStop、Bash background | 模型工具无后台句柄/输出读取；UI PTY 另有 | 缺 Agent 可操作后台任务协议 |
| 持久 JS REPL | T REPL 顶层 await/跨调用状态 | 无同等原生工具 | 可做工具组合与减少往返；优先级低于正确性 |
| Web 搜索 | T WebSearch 域允许/阻止 | registry 无原生 web_search | 需 provider/MCP/搜索服务；通用 HTTP 不等价 |
| 网页获取 | T WebFetch url+prompt | fetch + 简化 HTML→Markdown | 基础已有；引擎网络边界有严重断链 |
| 浏览器交互 | H --chrome；S Chrome 延迟工具 | 无原生点击/DOM/截图/标签页工具 | 外部 MCP 可扩展，当前不算内置 |
| 任意 HTTP API | MCP/脚本可扩展；未确认同等通用工具 | http_request 方法/headers/basic/bearer/apikey | 引擎可直接做业务 API 集成；OAuth/digest 标签不代表已实现 |
| Office 文档生成 | 通过脚本/插件可能提供；本包不等价确认 | Excel/Word/PDF handler、模板/样式/图片 | 引擎直接集成价值明确，非完整 Office 编辑器 |
| OCR | 未确认同等本地内置处理器 | Tesseract + 图像 handler | 引擎直接集成优势之一 |
| npm 包管理 | Bash/插件可间接执行 | install_package/list_packages | 有入口，但批准与路径执行边界需整改 |
| 外部编辑冲突 | 未作全面动态验证 | 全量写与 revert 无统一版本/hash 比对 | 需避免覆盖用户较新的修改 |

Claude 工具类型的字段清单见目录附录。引擎工具清单包含 46 个定义，而 Claude 的 45 是 Input interface 数，**统计单位不同，不应计算工具覆盖率**。

### 3.3 权限、安全与企业治理

| 能力 | Claude 2.1.266 | 当前引擎 | 判断 |
|---|---|---|---|
| 权限模式 | H acceptEdits/auto/bypassPermissions/manual/dontAsk/plan | safe/standard/full-access | 模式数量不是安全度；引擎执行检查未统一 |
| 工具 allow/deny 规则 | H allowedTools/disallowedTools/--tools | allowedTools、OSM 过滤 | 名称错配；空数组仍注册基础工具；语义需收敛 |
| 用户审批通道 | H permission-prompts host/none | cmd 真实 toolResponse 审批；其他工具 Boolean 确认 | 模型可填 confirmed 不等于人类批准 |
| 自动策略分类 | H auto-mode defaults/config/critique；S policy | 规则policy engine；LLM_REVIEW_MODEL仅发现设置/UI，未见安全决策消费 | 规则基础已有；模型审查不能算已接通，需统一覆盖执行入口 |
| 限制模式 | H --restricted 默认移除代码工具/WebFetch、限制目录/设置修改；--tools可重开，MCP须另用--strict-mcp-config限制 | safe 主要应用层白名单和路径/网络检查 | 两边均需核对具体配置，不能把模式名当完整隔离证明 |
| 宿主沙箱 | S macOS sandbox-exec、Linux/WSL bubblewrap、Windows sandbox 路径 | DevContainer 配置；普通工具宿主进程执行 | Claude 有平台实现线索，未实测安装/启用；引擎默认运行不能称 OS 沙箱 |
| 网络出口控制 | H/S sandbox 网络配置 | network-policy、SSRF 检查 | web bypass/MCP/重定向等边界不一致 |
| 工作区信任 | H -p 说明跳过 trust dialog；S project approval | 未发现同等首次项目内容执行信任门 | 应区分项目文本、配置、可执行 hooks/skills |
| 受管配置 | S managed-only hooks/MCP/permissions/marketplaces | 系统目录 managed settings；settings API后端跳过受管键覆盖 | 有真实后端保护；独立mode/policy及工具入口仍需统一约束 |
| 管理员插件来源控制 | S strictKnownMarketplaces、sideload restrictions | 技能导入 RBAC、zip 验证 | 缺生态来源/依赖/更新与多组件权限治理 |
| 凭据/云认证 | H auth/setup-token/gateway；S apiKeyHelper 等 | API key/JWT/外部用户同步、加密配置 | 引擎服务端无凭证降级 default 需按部署模式整改 |
| 企业认证/遥测网关 | H gateway --config | 业务服务 API；未见同等网关产品 | 不同产品职责，可列后期能力 |
| 强制租户隔离 | CLI 本地信任模型，不等同多租户服务 | tenant 数据模型；部分路由有 owner 检查 | 引擎自身承诺需兑现，不能拿 CLI 没租户作为免责 |
| 日志/审计 | H debug/debug-file；S OTel 与配置 | Pino、审计、QA 转录 | 引擎指标写端未接齐；隐私保留策略需独立设计 |

**优先处理的是当前代码中可定位的授权和隔离缺口，不是据此宣称 Claude 绝对安全。** 没有对任何一方做渗透测试。

### 3.4 扩展与生态

| 能力 | Claude 2.1.266 | 当前引擎 | 判断 |
|---|---|---|---|
| 技能发现/调用 | H /skill-name、plugin-dir；S skills/reload | 全局/项目 SKILL.md、索引、按需正文 | 基础已有，元数据解析与按项目作用域较浅 |
| 技能脚本执行 | 通过权限/工具/插件路径 | run_skill_script 宿主 bash | 发现目录与执行目录不一致，且未统一 policy |
| 复合插件宿主 | H plugin details/install/validate；S agents/hooks/MCP/LSP | plugin.json 主要是技能元数据 | 同名格式不等价于同一生态协议 |
| 市场/版本/依赖 | H marketplace、update/tag/prune | zip 导入、版本备份 | 缺依赖图、来源策略、升级/回滚链 |
| 插件评测 | H plugin eval：baseline、grader、mock、阈值、预算、HTML报告 | 未见等价功能 | 生态质量能力差距 |
| Hooks | S 33 个事件枚举及执行器、匹配器；H include-hook-events | 内部回调，不是用户可配置生命周期机制 | 明显缺口；引入前先完成统一权限 |
| MCP stdio | H mcp add 示例 | loader 明确跳过 stdio | 常见本地 MCP 无法原生接入 |
| MCP HTTP/SSE/WebSocket | H add/add-json；OAuth login | HTTP 自写 JSON-RPC；声明 SSE/streamableHttp 但简化处理 | 不应宣称完整 MCP 兼容 |
| MCP 资源/目录/刷新 | T List/Read/ReadDir/Refresh | 只有 tools/list、tools/call | 资源和动态生命周期缺失 |
| MCP OAuth | H mcp login/client-id/callback/client-secret | 静态 headers；未见 OAuth 握手/刷新 | 远程企业连接器差距 |
| MCP 协商/通知/elicitation | S 协议结构/事件/处理器 | 未见 initialize/session/cursor/通知等完整协议 | 宜采用标准 SDK 并建兼容测试 |
| 作为 MCP server | H mcp serve | 当前是 MCP client + HTTP API | 缺原生对外 MCP 服务入口 |
| 从其他 Agent 导入配置 | H import codex/gemini/cursor/dry-run | 未见等价入口 | 可后补，不是眼前瓶颈 |
| 故障排除模式 | H safe-mode、bare、doctor | 健康接口、配置页 | 缺禁用自定义组件的诊断启动模式 |

### 3.5 子代理、后台运行与自动化

| 能力 | Claude 2.1.266 | 当前引擎 | 判断 |
|---|---|---|---|
| 专业子代理 | H --agent/--agents；T Agent prompt/type/model | subagent role/access/model/maxSteps | 已有真实实现 |
| 子代理后台化 | T 默认 background；H forward-subagent-text | 父工具等待完成；同批可并行 | 并发委派不等于后台解耦 |
| 子代理通信 | T Agent.name 注释明确 SendMessage；S 通信工具线索 | 无邮箱/send/followup/resume 工具 | 团队协作层差距 |
| 子代理持久状态 | 具体实现未全量重建；H 背景管理 | SQLite run/event/outbox、父 transcript 幂等投影 | 引擎已有设计值得保留 |
| 崩溃恢复 | H 背景会话 attach/resume/respawn 等 | 子任务重启标 interrupted，根 SSE 内存 | 未形成根/子统一可恢复执行契约 |
| 共享任务板/依赖 | T TaskCreate/Get/Update/List，blocks/blockedBy/owner | Todo CRUD + 独立 task 查询 | 缺 Agent 团队依赖/领取/通知协议 |
| 子代理隔离 | T Agent isolation worktree/remote（remote 明示 gated） | 与父使用同项目根/CWD | 多代理写文件缺隔离和冲突治理 |
| 用户会话后台进程 | H --bg/agents/attach/logs/stop/rm/respawn | HTTP 服务本身常驻，根运行内存管理 | 缺会话生命周期产品 |
| 明确目标与持续工作 | T ProposeGoal 可验证 condition/批准控制 | 步数/token 预算和 OSM 提示词 | 未见目标验收状态机与跨轮持续调度 |
| Plan 进入/退出 | H plan 权限；T Enter/ExitPlanMode；S /plan | os-writing-plans 等方法论 skill | 文本计划不等于强制只读计划态 |
| 确定性 DAG | T Workflow agent/parallel/pipeline/phase | Flow DAG 拓扑分层/同层并发 | 引擎已实现，但请求约束传递与持久化不足 |
| Workflow 增量重跑 | T resumeFromRunId 缓存未变 agent 调用，同会话 | 无 durable Flow/resume | 明显差距，Claude 本机启用仍待验 |
| 周期任务 | T CronCreate recurring/durable/7天自动过期规则 | Cron DB CRUD + 每分钟调度 | 两边都有定义；引擎执行身份/终态判定未闭合 |
| 动态唤醒 | T ScheduleWakeup 60–3600秒、noop、stop | 无等价自适应会话唤醒 | 缺持续任务体验 |
| 事件监控 | T Monitor shell stdout/WebSocket、TaskStop | 可用 shell/MCP自行拼装 | 无原生事件→运行唤醒闭环 |
| 远程触发/Webhook | T RemoteTrigger 查询/创建/更新/run/log/webhook，未声明删除 | 通用 HTTP API，无同等托管触发器 | 服务端能力，需另建控制面 |
| 通知 | T ReadNotifications/PushNotification | SSE/UI事件；未见移动推送产品 | 条件云能力差距 |
| 通用后台任务队列 | 未确认同等外部任务 API | queue 有存储，但生产未 registerHandler | 引擎已有命名功能未接通 |

### 3.6 会话、开发体验与产品平台

| 能力 | Claude 2.1.266 | 当前引擎 | 判断 |
|---|---|---|---|
| 会话恢复/继续/命名 | H continue/resume/session-id/name | 历史/会话 CRUD、再发新轮 | 基础有，根执行恢复需区分 |
| 会话 fork | H --fork-session；S /fork、/branch | 未见普通会话 fork API | 缺分支探索产品 |
| 文件 rewind | S rewind/checkpoint/undo、rewindFiles/fileHistory | 小文本 write/delete 快照与 revert | 引擎 Workspace snapshot/restore 占位；两边均不能默认撤销所有外部副作用 |
| Git worktree | H --worktree/--tmux；T Enter/ExitWorktree | 通用 shell 可执行 git | 缺原生管理/清理/变更保全 |
| PR 关联恢复 | H --from-pr | 未见对应元数据/入口 | 缺编码工作流整合 |
| 云多代理代码审查 | H ultrareview，JSON/no-post/post/timeout | reviewer 子角色，没有托管审查流程 | 可先做本地评审闭环，再考虑云服务 |
| IDE | H --ide；S /ide | Monaco 工作台 | 自有编辑器不等于 VS Code/JetBrains 集成 |
| 终端交互与无障碍 | H ax-screen-reader；S TUI/keybindings/theme/statusline | Web/mobile UI、xterm、Monaco | 引擎适合嵌入产品，TUI 不是必选追赶目标 |
| 语音输入 | S voice 定义、hold/tap/off、claude-ai 可用性条件 | 未见原生语音 | 条件体验能力；优先级低 |
| 不中断主任务的旁问 | S /btw | 未见独立支线交互 | 长任务体验差距 |
| 云/桌面/远程切换 | H cloud/environment/teleport/remote-control；S desktop/session | Remote SDK 可连接服务；SSH 设置 UI 占位 | 不应把 remote SDK 记为完整远程执行平台 |
| Artifacts | T 发布/读/版本冲突/资产/共享等 | 工作区文件下载/预览 | 未见发布服务和并发版本协议；Claude 属条件服务 |
| Projects | T project_info/read/search/write/delete、project_memory_list/read | workspace + KB + 项目配置 | 产品模型不同，不宜按同名“项目”判等价 |
| Design | T ClaudeDesign operation/arguments；S 登录/同意命令 | 无对应原生服务 | schema 可见，不代表能独立生成设计/已授权服务 |
| 自托管业务 API | H print/stream-json/MCP serve，CLI面 | Fastify REST/SSE/WS、约150路由注册点 | 引擎重点优势方向，但需补安全/契约 |
| typed SDK | 本包工具声明+H SDK流选项；未审查外部Agent SDK发布包 | 源码client完整、发布SDK主要生命周期 | 发布能力与源代码能力不一致 |
| 可视化 Agent/知识/记忆管理 | 本地CLI未证明同等后台 | Web/mobile 管理面板 | 引擎直接产品价值 |
| 知识检索 | T Projects search；未推断其后端算法 | FTS5 BM25/中文LIKE，chat RAG | 引擎 KB 非向量检索；绑定白名单未生效 |
| 监控与成本面板 | H/S debug/usage/OTel/gateway | usage落会话；metric表与UI的记录函数未接主链 | 引擎可观测性完成度不足 |
| 安装/升级/诊断 | H install/update/doctor；多平台native包 | npm/Docker/SDK打包、CI | 引擎缺跨平台发布验收/升级回滚闭环 |

## 4. Claude 包里容易漏掉的能力和误读

1. **Workflow、REPL、Monitor、Cron durable 已在本包类型中出现。** 用早期 Claude 的功能印象断言“Claude 没有编排/定时任务”会得出错误结论。但这些类型也不能证明每个账号都启用了工具。
2. **原生 Windows 沙箱有代码线索。** 静态片段含 Windows sandbox argv、受管配置和本机辅助机制；不能直接沿用旧版本“只支持 Linux/macOS 沙箱”的说法。本次没有验证 Windows 机制安装/驱动/权限是否满足。
3. **插件有 eval 产品。** 包括无插件 baseline、grader、MCP mocks、成本限制和报告，不只是安装技能；这是一项生态质量机制。
4. **后台代理已形成 CLI 生命周期。** --bg/agents/attach/logs/stop/rm/respawn 与孤立的一个 subagent 函数不同。
5. **TeamCreate/TeamDelete 不宜当默认功能。** 类型的 team_name/mode 已标 deprecated/ignored，TeamCreate/Delete 的字符串还出现在一个遗留名集合；当前以 Agent 的隐式团队及 SendMessage 证据描述，不按旧工具名推断可用。
6. **一些静态命令明确关闭。** 提取到 loops、wellbeing、version 等定义具有 `isEnabled:()=>!1`，而其他命令有账号/平台/策略 gate。它们列入全目录，但不参与“已交付功能领先”的结论。
7. **环境变量数量不能当功能数。** 729 个名字包含遥测/调试/实验/禁用开关，甚至兼容项；不建议照搬内部变量接口。

## 5. 当前引擎最需要处理的具体问题

P0 表示数据/权限/执行正确性的前置问题；面向多人或不可信任务部署时优先级最高。下面都给出了可达代码依据，但除测试结果外，未执行攻击或逐项故障复现。

| 编号 | 优先级 | 具体触发与后果 | 关键位置 | 验收目标 |
|---|---|---|---|---|
| G01 | P0 | JSONL摘要转system；Anthropic/Ollama过滤历史system，压缩后模型看不到旧摘要 | jsonl-history:235；anthropic:153/329；ollama:28 | 所有provider最终请求保留关键旧约束与摘要 |
| G02 | P0 | 无凭证落default；默认0.0.0.0；全局设置/策略缺统一角色守卫 | auth/middleware:27；main:44；routes/security/settings | 共享部署无凭证拒绝；管理员/租户权限逐操作验证 |
| G03 | P0 | 技能脚本宿主exec、npm模型confirm、web bypass、MCP独立fetch | tools/skill/run-skill-script:77；install-package:49/91；web-fetch:38 | 所有副作用入口走统一策略与不可伪造批准记录 |
| G04 | P0 | 同批工具先全部执行，遇审批/失败阈值提前return，后续结果可能丢记录 | react:934/979/1076 | 所有已执行调用有持久终态；审批前屏障、写冲突锁 |
| G05 | P0 | Flow接受cwd/权限/技能等字段却未传节点，且固定flow-tenant | flows/flow-types:22/46；flow-executor:104/114 | 身份和全部执行限制真实继承，跨租户停止不可达 |
| G06 | P0/P1 | KB绑定两个分支相同，可能检索同租户未绑定文档；terminal/task owner校验不全 | chat:863；terminal:79；tasks:32 | KB SQL层过滤；每资源读写/取消验证归属 |
| G07 | P1 | 总容量检查遗漏system/tools/output，默认JSONL无滑窗兜底 | react:409；chat:602；jsonl-history:765 | 构造完整请求预算并覆盖压缩失败恢复 |
| G08 | P1 | fallback.stream仅primary，配置备用后主聊天仍不降级 | retry:120；react:493 | 流前失败可降级，流后失败不重复已提交输出/副作用 |
| G09 | P1 | 正文完整缓存后模拟分片，长回答迟迟无正文 | react:500/555 | 实际delta即时送出，重连与落库内容一致 |
| G10 | P1 | allowedTools真实名与factory旧名错配；批准又被旧白名单拒绝 | registry-factory:191/249；cmd-tool:74 | 工具枚举、过滤、审批、技能文档由一个契约生成 |
| G11 | P1 | LSP外层与内层拿同一限流池，满池时可能等待自身释放 | registry:45；lsp/index:143 | 并发诊断可完成/取消；unsupported不能标pass |
| G12 | P1 | Ollama声明工具/视觉，实际无tools/images/tool_calls | model-capabilities:201；ollama:39/75 | 能力求交集：模型支持∩adapter实现∩环境允许 |
| G13 | P1 | queue未注册handler；Cron丢tenant/auth且仅看HTTP状态 | sqlite-queue:95/123；cron-scheduler:98/104 | 入队实际完成；Cron身份正确且业务失败记failed |
| G14 | P1 | 指标函数只有定义/导出，面板不能反映真实调用 | observability/metrics:17/32；instrument-tool:4 | 每次模型/工具调用能关联run并计成功/失败/取消/成本 |
| G15 | P1 | 发布SDK未导出完整client，API key头和业务错误解包语义不一致 | sdk-package/src/index:87；httpClient:90/202 | 仅使用正式npm产物完成聊天/取消/审批/恢复 |
| G16 | P1 | JSONL锁仅实例内；同session多instance写入/压缩/删除可能竞争 | jsonl-history:79；chat:602；conversation:17 | session级唯一写入序列/租约，删除后迟到写入不复活 |
| G17 | P1 | 记忆只调度default，按last_accessed反复扣历史时间 | main:73；memory/consolidation:57 | 按增量时间衰减，多租户调度一致 |
| G18 | P1/P2 | 全工作区快照抛未实现；revert可能覆盖用户后续编辑 | workspace/manager:56/61；changes:52 | 版本冲突检测和明确覆盖范围；后续再做完整checkpoint |

以上简写均相对于 `src/`，精确完整路径及更细调用链见三个引擎附录。P0/P1 的划分是基于产品目标的工程优先级，不是 CVSS 漏洞评级。

## 6. 哪些能力值得保留和放大

- **多模型和可自运营后端。** 适合 Wuzu 这样的宿主；修复 adapter 契约后能形成独立价值，不必模仿 Claude 的商业账号体系。
- **显式长期记忆模型。** 节点、关系、来源、重要性、强度、embedding、图遍历均有实际实现；它是平台能力，不应退化成一个普通摘要文件。
- **办公文件/OCR/通用业务HTTP。** 覆盖编码以外任务，适合业务自动化。应加产物正确性验收，勿宣传为完整 Office 编辑器。
- **Flow 与 Agent 的组合。** 确定流程用 DAG，不确定步骤用 ReAct；先接齐身份/资源/运行状态，再做版本化工作流。
- **子代理状态/outbox/预算设计。** 当前比根运行更完整，可抽成统一 RunStore/InvocationStore，保留稳定关系、明确终态和幂等投影。
- **已有 Web/mobile 管理界面与源码 SDK。** 能支撑自有产品；发布包和后端契约必须与这些源码能力一致。

这些是引擎的真实价值点；由于未审查 Claude 的全部云服务，不能把“本地未见同等后台”写成它绝对没有。

## 7. 推荐追赶顺序

### 第一阶段：兑现当前运行承诺

目标：一轮任务的身份、预算、上下文、工具执行、审批和终态保持一致。

先做 G01–G07，以及工具统一命名/参数校验、统一ExecutionContext、统一受控网络出口；把根任务、子任务、Flow 和 Cron 的 tenant/cwd/permissions/model/budget/cancellation 全部贯穿。任何“需要确认”的操作在真实批准前都不能产生该副作用。此阶段不要大量新增工具。

验收：受限路径/网络不能从skill/MCP/npm绕开；A租户不能读/取消B运行；压缩后约束不丢；同批遇批准或中止仍有完整终态；进程重启不自动重复未知副作用。

### 第二阶段：让编码任务可靠完成

补精确edit/patch与冲突检测、工具读写分类与资源锁、真实流式、正确fallback、后台命令句柄、完整取消、有效diagnose状态、Git/worktree与文件回退范围。将技能工具映射从真实schema生成。

验收：同文件并行编辑不互相覆盖；用户修改后回退提示冲突；长命令可后台运行/取输出/中止；LSP不可用不报通过；输出重连不重复消息。

### 第三阶段：补生态和可恢复编排

采用完整 MCP SDK/协议，支持 stdio、初始化、OAuth、资源、分页、刷新/通知；再加入受控Hooks和复合插件生命周期。统一持久RunStore后做子代理detach/wait/mailbox/followup、Flow resume、Cron运行日志/幂等/时区，以及正式SDK。

验收：常见本地与远程MCP服务器可通过同一兼容矩阵；退出/重启恢复关系清晰；后台结果只交付一次；插件有来源与生命周期治理。

### 第四阶段：按产品需求扩展

浏览器、外部IDE、远程执行、云审查、Artifacts发布、Webhook/移动推送、语音、插件市场/评测。是否建设取决于 Wuzu 产品目标和运维成本；无需为了表格齐全而复制所有商业服务。

不提供未经估算的“几周追平”承诺。可用阶段验收与真实任务集来衡量进展。

## 8. 建议的公平验收任务集

本节是后续评测设计，不是已经测出的结果。对比必须固定仓库提交、任务描述、模型、预算、权限、网络、工具依赖和人工批准规则；跨供应商表现另设产品整体对比，不混为引擎差距。

| 场景 | 最重要的度量 |
|---|---|
| 多文件修复 + 单测 | 任务成功率、错误文件改动、测试真实性、人工返工 |
| 长历史 + 多次压缩 | 关键约束保留、证据回取、压缩成本、最终成功率 |
| 故障与限流 | 首字/总时长、实际请求次数、降级成功、预算遵守 |
| 并行代码修改 | 冲突数、丢失更新、结果记录完整性、可恢复性 |
| 长命令与取消 | 后台可见性、取消后残留进程、跨重启状态 |
| 权限变更与混合工具批次 | 批准前副作用数应为0，工具终态无遗漏 |
| MCP真实服务器兼容 | stdio/HTTP/OAuth/resources/pagination/notifications通过率 |
| 多租户 Flow/Cron/知识 | tenant/cwd/工具/知识范围继承，越界请求均拒绝 |
| 正式SDK与UI恢复 | 流重连/审批/取消/会话恢复，错误码和事件一致性 |
| 长期自主任务 | 完成条件达成、无效循环、重启续接、成本和用户打断次数 |

优先补这些跨模块契约与情景验收；不要只增加镜像实现的单元测试，也不要用模型回答“看起来正确”代替运行结果。

## 9. 本轮未验证的边界

Claude 的各项云服务、插件/MCP 真实连接、语音、浏览器、IDE、sandbox平台安装和功能开关均未做在线验收；二进制静态内容只说明该发行包带有相应定义/实现线索。服务端逻辑、模型训练效果与账号配额不在本地包审计范围。

引擎的远端供应商、私有MCP、生产部署、用户全局skills、外部Wuzu客户端实现未纳入逐项在线验证。未读取生产业务内容来判断记忆/知识检索实际质量。静态竞态/死锁/越界风险明确标为推断，未进行漏洞利用。

## 10. 研究文件与复核方式

主报告提供比较结论；三个引擎附录给出可定位证据，Claude目录附录保留所有已采集接口及隐藏状态。采集脚本：`collect-claude-evidence.cjs`、`collect-command-index.cjs`，只读指定包并执行帮助命令，不执行功能子命令。

主报告和附录均为本次新增研究文件。未修改引擎业务代码、用户既有改动，也未据此实施修复。

## 11. 本轮实际验证结果

`npm run typecheck`：**通过**。

`npm run test -- --run`：**退出码 1**，耗时 7.66 秒。

- 测试文件：36 passed / 2 failed / 2 skipped，共 40。
- 测试用例：342 passed / 1 failed / 16 skipped，共 359；另一个失败文件因导入失败没有收集出用例。
- 失败用例：sandbox 路径越界被正确拒绝，但错误消息由 `Path traversal detected` 变为 `outside any bound workspace`，断言不匹配；**不能把它解释成越界已成功**。
- 失败文件：前端 explorer 测试缺少 `@testing-library/react`，在加载阶段失败。
- 原始记录：[engine-verification.txt](engine-verification.txt)。本次未为研究任务安装依赖或改测试。

这些测试证明已有一批运行时/存储/子代理路径受到验证，但不足以否定上文跨模块接线问题。旧报告中的239 passed / 19 failed不代表当前工作树。
