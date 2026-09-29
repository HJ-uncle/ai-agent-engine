# 当前引擎工具、扩展、工作区及安全审计

日期：2026-09-29。对象：`D:\dev\ai-agent-engine` 当前磁盘工作树，包含未提交修改；不是某个已发布版本。此附录仅负责引擎侧证据，Claude Code 2.1.266 的实际包证据由主报告单列。

方法：静态检查注册工厂、工具实现、执行路径、权限策略、HTTP 路由、技能加载与导入、MCP 客户端、工作区与终端。未运行外部模型、未启动服务、未实施任何漏洞利用；下述可用性是“代码存在并接线”的判断，不等于已在本机逐项端到端验证。未读取环境密钥或生产业务数据。

## 结论

引擎已经形成一组相当宽的应用能力：46 个可静态枚举的内置工具定义，文件与办公格式处理、命令执行、记忆图谱、任务与定时任务、子代理、HTTP、技能、Agent 配置管理、TS/ESLint 诊断、代码图，以及动态 MCP 工具。实际暴露数量会受 OSM、Agent 白名单和 MCP 连接结果影响。

主要短板不在“有没有工具函数”，而在真实工具名与配置/说明不一致、审批与执行未统一、技能脚本与网络可绕开安全检查、MCP 仅实现工具调用子集、代码编辑和代码智能尚不完整，以及回滚范围小于产品描述。当前 `safe` 是应用层检查集合，不能等同于宿主文件系统/进程/网络隔离。

## 1. 全部工具清单

计数依据：`src/tools/registry-factory.ts:104` 的工厂以及其实际注册的工具对象，不按注释或 UI 名称计数；46 不包含动态 `mcp_<server>_<tool>`。

| 能力簇 | 实际工具名（共 46） | 实现与边界 | 源码证据 |
|---|---|---|---|
| 文件 5 | `read_file`, `write_file`, `list_files`, `delete_file`, `create_dir` | 多格式读取、全文/分页/摘要/图片/OCR；完整写入；列目录；回收站删除；建目录 | `src/tools/file/super-file-tool.ts:11,117`; `src/tools/file/basic.ts:12,72,105` |
| 命令 1 | `execute_cmd` | command+args、cwd、超时、stdout/stderr、AbortSignal、进程树终止；模型工具没有后台会话/PTY 句柄 | `src/tools/cmd/cmd-tool.ts:22,81,110,114` |
| 交互 1 | `ask_user` | 主循环会中止当前轮并发出问答/permission 帧 | `src/tools/ask-user/index.ts:4`; `src/core/agent-loop/react.ts:862` |
| 内置技能 2 | `calculate`, `get_time` | 计算及时间查询；工厂无条件注册 | `src/skills/math.ts:25`; `src/skills/time.ts:4`; `src/skills/index.ts:17` |
| 技能管理 3 | `list_skills`, `get_skill`, `run_skill_script` | 索引、按需加载 SKILL.md、宿主 bash 执行；前两者无条件注册 | `src/tools/skill/index.ts:35,56`; `src/tools/skill/run-skill-script.ts:28` |
| 搜索 2 | `glob_search`, `grep_search` | glob；ripgrep 优先、Node fallback；默认 glob 最大深度 10，grep 默认 50 条 | `src/tools/search/glob-tool.ts:11,24`; `src/tools/search/grep-tool.ts:105,120` |
| 记忆 5 | `remember`, `recall`, `list_memories`, `forget`, `link_memories` | 保存/按标签召回/列出/删除/记忆关联边；不是注释中的 `search_memory` | `src/tools/memory/memory-tool.ts:9,41,65,89,107` |
| 待办 4 | `todo_list`, `todo_create`, `todo_update`, `todo_delete` | 单条 CRUD，状态与优先级；没有文档所说 `items` 批量入参 | `src/tools/todo/todo-tool.ts:9,29,50,76` |
| 定时 4 | `cron_list`, `cron_create`, `cron_update`, `cron_delete` | 5 字段 cron 配置，到期触发 AI 对话 | `src/tools/cron/cron-tool.ts:8,24,51,78` |
| 后台任务 3 | `task_list`, `task_cancel`, `task_status` | 现有任务查询和取消；没有对应的通用 shell background 启动工具 | `src/tools/task/task-tool.ts:8,37,62` |
| 子代理 1 | `subagent` | task/role/access/maxSteps；默认只读，implementer 继承父工具，独立预算与状态；详细运行语义另见主报告 | `src/tools/subagent/subagent-tool.ts:89` |
| 网页 1 | `web_fetch` | 静态 fetch 与正则 HTML→Markdown；没有 JS 页面执行/点击/截图 | `src/tools/web-fetch/web-fetch-tool.ts:12,68,120` |
| HTTP 1 | `http_request` | GET/POST/PUT/DELETE/PATCH，basic/bearer/apikey/custom headers；AuthConfig 写了 digest/oauth2，但 buildHeaders 没有实现这两类 | `src/tools/http-request/http-request-tool.ts:5,26,188` |
| 上下文 1 | `get_current_context` | 当前时间、会话、Agent、工作区等状态信息 | `src/tools/get-context/get-context-tool.ts:31` |
| npm 2 | `install_package`, `list_packages` | 安装 npm 包；后者读取 package.json 依赖声明，不实际检查安装树；`global` 参数未改变 list_packages 执行逻辑 | `src/tools/install-package/install-package-tool.ts:15,179,196` |
| Agent 管理 8 | `agent_list`, `agent_get`, `agent_create`, `agent_do_create`, `agent_update`, `agent_do_update`, `agent_delete`, `agent_do_delete` | 预览/确认式配置 CRUD，合并客户端 inline agents；confirmed 是模型可传布尔值 | `src/tools/agent/agent-tool.ts:51,92,134,173,216,254,293,329` |
| 诊断 1 | `code_diagnose` | TypeScript/ESLint 适配器，不是通用 LSP 协议客户端 | `src/tools/lsp/lsp-tool.ts:16`; `src/lsp/index.ts:16` |
| 代码图 1 | `codegraph` | status/search/callers/callees/impact/files/index；依赖 @colbymchenry/codegraph 索引 | `src/tools/codegraph/codegraph-tool.ts:95,108,149` |

### 文件与代码编辑的真实范围

- 6 个 handler：Text、JSON、Excel（xlsx/xls/csv）、Image、PDF、Word（docx/doc）。未知后缀回落为 Text，不代表支持其结构格式。证据：`src/tools/file/handlers/registry.ts:14,40`。
- 文本读取默认行窗口 300，文件总大小默认上限 10 MiB；没有原生 `edit_file` / `apply_patch` / 精确旧文本替换工具，也没有 notebook cell 编辑器。`.ipynb` 能按文本读写，不等于 notebook 语义编辑。证据：`super-file-tool.ts:18,20,86`; `constants.ts:1`；注册工厂完整枚举。
- `write_file` 直接调用 handler 全量写入；可记录旧内容与新内容，但没有“先读后写”的一致性前置条件、版本/hash 冲突检测或多文件原子事务。证据：`super-file-tool.ts:142`。
- 图片读取支持视觉模式、OCR、无视觉主模型经视觉代理描述；图片写入明确不支持。视觉模式输出 JSON dataUrl，能否成为模型多模态输入取决于后续 adapter，不能仅凭工具函数认定端到端视觉成功。证据：`handlers/image-handler.ts:14,43,56,81,93`。
- PDF 读文本、页数和元数据，写入为 PDFKit 基础文字；不是完整 PDF 页面视觉审阅/表单/保真编辑体系。Excel/Word 提供主题、颜色、图片模板写入，属于引擎办公产物优势，但不是 Office 全功能编辑器。证据：`handlers/pdf-handler.ts:10`; `handlers/excel-handler.ts:13`; `handlers/word-handler.ts:12`。
- `read_file` 未找到路径时遍历所有工作区，按名称/包含关系选最近修改文件；方便纠错但可能选错同名文件，且大型仓库同步遍历成本高。证据：`super-file-tool.ts:36-78`。

### 搜索、代码智能与验证

- grep 使用 ripgrep，能限制返回总匹配条数并支持取消；fallback 执行 `grepDir(basePath, regex, maxResults)` 没传已声明的 `filePattern`，因此无 rg 时文件过滤语义改变。证据：`src/tools/search/grep-tool.ts:133,149`。
- glob 对 cwd 做检查，但 pattern 本身没有校验绝对路径或 `..`，搜索结果也未重新验证归属；不能把 cwd 检查当完整搜索边界。证据：`src/tools/search/glob-tool.ts:26-35`。
- code_diagnose 只有 TypeScript/ESLint，无 definition/references/hover/completion/rename/workspaceSymbol/callHierarchy 的 LSP 请求实现。TypeScript API 固定单文件 root、`strict:false` 等选项，未读取项目 tsconfig；不能替代项目真实 `tsc --noEmit`。证据：`src/lsp/adapters/typescript.ts:97-112`。
- 代码图可以查符号、调用关系与影响面，是比纯文本搜索更丰富的结构能力；动态包缺失会失败，索引缺失只是提示，查询受索引新鲜度影响。`action=index` 限当前 cwd；已经初始化时不重建，刷新需其他入口。证据：`src/tools/codegraph/codegraph-tool.ts:149-199`; `codegraph-module.ts:72`。

## 2. 扩展和产品边界

| 能力 | 已实现 | 未实现/局限 | 证据 |
|---|---|---|---|
| 技能发现 | ~/.aether/skills 与 cwd/.aether/skills 双层，项目同名覆盖；SKILLS_ROOT 单 root 模式；SKILL.md 按需读取 | root 是引擎 cwd 层，不自动随每个用户项目/会话重新扫描；frontmatter 是逐行 key:value，不是完整 YAML | `src/skills/skills-registry.ts:35,149`; `external-loader.ts:60` |
| 技能热更新 | fs.watch recursive + 500ms 防抖 | 只监听以 SKILL.md 结尾的事件，plugin.json/config 改动不会自动触发重扫 | `skills-registry.ts:88-100` |
| inline skill | 客户端传入名称/描述/正文，可展示和 get_skill | 无真实脚本文件；源码明确标为仅“能力可见” | `registry-factory.ts:52-59,216-235` |
| 技能包导入 | zip/分片续传/进度、格式和路径限制、冲突拒绝/覆盖/保留版本、staging、导入角色守卫 | 不是完整 plugin marketplace/更新/签名/来源信任体系；解压限额检查发生在 unzipSync 后 | `src/skills/import-pipeline.ts:42,134,169,185,268`; `routes/skill-imports.ts:159,315,344` |
| plugin.json | 读取 id/name/description/version/author/main/order/enabled | 此处是技能元数据，不是 command+agent+MCP+hook+LSP 的复合插件宿主 | `external-loader.ts:47,127,142` |
| MCP transport | HTTP JSON-RPC 工具查询/调用；JSON-RPC 失败 REST fallback；静态与 inline server | stdio 明确跳过；声明 sse/streamableHttp 统一走自写 HTTP 客户端；SSE 一次读完取第一个 data 行 | `src/tools/mcp/loader.ts:49,73`; `client.ts:48,96` |
| MCP protocol | `tools/list`, `tools/call`、工具 schema、AbortSignal | 未见 initialize/initialized 协商、会话头管理、分页 cursor、资源/模板/提示词、sampling、elicitation、roots、OAuth、通知动态刷新；多模态结果串化为字符串 | `src/tools/mcp/client.ts:29-170`; `types.ts:17` |
| MCP 管理 | 全局与项目配置、CRUD、启停、连接测试；失败不阻塞其他工具 | 每次建 registry 重新连接；配置没有租户隔离；不走统一 network policy | `src/tools/mcp/loader.ts:36,66`; `src/storage/mcp/mcp-config.ts`; `src/api/http/routes/mcp.ts:62` |
| hooks | 内部 runObserver、Fastify 生命周期 hook | 没有发现用户可配置的工具前后/会话生命周期 hook 注册、匹配、脚本执行体系；内部 telemetry 回调不等于扩展 hook 产品 | `src/core/agent-loop/react.ts:910,926`; `src/api/http/server.ts:55` |
| 项目说明 | 用户、项目 .aether、项目根 3 份 AE.md 顺序拼接，单份 32 Ki 字符 | 未实现目录层级动态作用域、路径规则匹配、导入语法；没有直接识别 AGENTS.md/CLAUDE.md | `src/core/project-context.ts:19,36` |
| Web Search/Browser | 可通过外部 skill/MCP/命令接入 | 内置 registry 无 web_search 或浏览器动作工具；src/skills/web-search.ts 是未注册 bridge 辅助代码。仓库 .aether/skills 当前只有 7 个 os-* 方法论 skill；用户全局 skill 未在本附录扫描 | `src/skills/index.ts:15`; `registry-factory.ts`; `.aether/skills` 文件枚举 |
| 终端 | WebSocket+node-pty、输入/输出/resize/kill、工作区 shell | 属于 UI 终端，与模型 execute_cmd 不同；没有统一 shell 会话工具协议 | `src/api/http/routes/terminal.ts:17,73,103`; `src/terminal/index.ts:31` |
| checkpoint/rollback | write/delete 小文本改动记录、diff 帧；删除进系统回收站 | WorkspaceManager.snapshot/restore 是抛错占位；二进制及 >100000 内容不能完整回退；命令/skill/MCP 任意改动不受这些记录覆盖 | `workspace/manager.ts:56,61`; `file/change-recorder.ts:6,15,33`; `file/basic.ts:84` |

本地 7 个方法论 skill：os-brainstorming、os-subagent-driven-dev、os-systematic-debugging、os-tdd、os-using-superpowers、os-verification-before-completion、os-writing-plans。它们是工作流说明，不应当把说明里提到的所有工具都算成运行能力。

## 3. 优先问题与证据

P0 指：若以多用户/不可信任务/服务暴露方式部署，先于继续增加功能解决。这里只报告静态执行路径，不判断本机当前是否公网可达。

### P0-1：safe 模式没有统一的执行安全边界

- run_skill_script 入参是模型可给的任意 shell command，描述要求“与 SKILL.md 一致”但代码不验证；直接 bash exec，继承完整 process.env，未接 policyEngine、网络策略、路径规则、审批票据、ctx.signal。它甚至没有接收 ctx。证据：`src/tools/skill/run-skill-script.ts:38-52,59,77-104`。
- install_package 的 confirm 是模型参数，没有服务端批准状态；拼接 packageName/version/targetPath 成 shell 命令后 exec；installPath 不经 WorkspaceManager；npm 生命周期脚本也在宿主权限运行。证据：`src/tools/install-package/install-package-tool.ts:26,31,39,49,91-103`。
- execute_cmd 的 `shell:false` 是改进，但 safe 默认直接允许 node/npm/npx，参数正则不是代码执行隔离；cwd 限制也不限制子进程能访问的其他路径/网络。证据：`src/security/policy-engine.ts:138-140,156`; `src/security/cmd-whitelist.ts:25-27`; `src/tools/cmd/cmd-tool.ts:110`。
- 内置终端外部命令使用 exec 并继承环境；受限 shell 启动失败会降级宿主 powershell/zsh/bash。终端帮助却声明“所有操作严格限制在工作空间内”。证据：`src/terminal/workspace-shell.mjs:462,476,483`; `src/terminal/index.ts:85-88`。

建议：执行入口都进入同一个可信权限上下文；安全模式不能由模型参数改变；按操作发不可伪造、限定参数/路径/时效的批准票据；宿主隔离另行使用真实 OS/容器机制，并明确本地受信模式与多租户模式。

### P0-2：模型可关闭网页安全检查，网络策略未覆盖所有出口

- web_fetch 的 schema 公开 `bypassSecurityCheck`，true 使 safe 模式域名开关、旧白黑名单和新版 SSRF 检查全部不执行。证据：`src/tools/web-fetch/web-fetch-tool.ts:20,25,38-65`。
- web_fetch 在 standard/full-access 也不调用 checkNetworkAccess；http_request 的 standard 仅跳过私网检测，行为不一致。MCP 三个 fetch 完全不接网络策略。证据：`web-fetch-tool.ts:38`; `network-policy.ts:239`; `mcp/client.ts:34,69,80`。
- 域名检查后 fetch 默认/显式跟随重定向，没有逐跳重新检查；DNS 检查结果未固定到连接，存在 DNS 二次解析边界。证据：`network-policy.ts:112,224,266`; `http-request-tool.ts:71,91-96`; `web-fetch-tool.ts:68`。
- network policy 返回 maxResponseBytes/timeoutMs，两个消费工具都未执行这些上限；先 response.text 后截断并不限制下载体积。web_fetch 没有自身请求超时；http_request 使用独立 controller，未合并 ctx.signal，读取响应体前就清除 timeout。证据：`network-policy.ts:161`; `web-fetch-tool.ts:68,86,92`; `http-request-tool.ts:87-114`。

建议：收敛到同一个受控 fetch/client，限制协议、固定解析目标、逐跳验证、流式字节上限、连接/正文超时、合并取消信号；移除模型可传的安全 bypass。

### P0-3：鉴权与管理面不是多租户强边界

- AUTH_ENABLED 非 false 时，无任何凭据依然返回 default 租户；外层 middleware 只拒绝 authenticate 抛错，不拒绝 method=none。证据：`src/auth/middleware.ts:27-28`; `src/api/http/middleware.ts:46-60`。
- policy/network-policy/MCP 管理路由没有 requireRoles；策略表与 MCP 配置为全局。持有有效 API key 被视为 admin，JWT 未声明 roles 也默认 admin。证据：`src/api/http/routes/security.ts:12-110`; `src/api/http/routes/mcp.ts:62`; `src/auth/middleware.ts:50,66`。相比之下 skill imports 明确用了 requireRoles，因此不能把该守卫当全服务已有保护。
- TerminalSession 存 id/pty/cwd/title/events，不存 tenant owner；WS 和 DELETE 仅按 id 操作，不验证归属。证据：`src/terminal/index.ts:100`; `src/api/http/routes/terminal.ts:79,106,126`。UUID 降低猜测概率，但不等于授权检查。

建议：服务模式无凭证 fail-closed；所有管理操作有角色与范围；全局策略变更仅宿主管理员；会话/terminal/MCP/skill 资源建立明确 owner。部署若仅个人本机，应在产品中标明此信任假设。

### P1-1：真实工具名与 allowedTools 契约不匹配

factory 判断 `run_command`/`glob`/`grep`，实际注册 `execute_cmd`/`glob_search`/`grep_search`。用户从 /tools 返回列表选择真实名称存为 allowedTools 后，三个工具会被过滤掉。证据：`src/tools/registry-factory.ts:191,249,250`; `src/tools/cmd/cmd-tool.ts:22`; `src/tools/search/glob-tool.ts:11`; `grep-tool.ts:105`; `src/api/http/routes/tools.ts:24`。

限定：默认 balanced 不过滤，全量场景仍可用；OSM off 用旧名过滤恰好会注册真实搜索工具。不能笼统写成“搜索/命令始终不可用”。OSM 自检与能力说明仍沿用旧名，会产生误报。

allowedTools=[] 的注释称无工具，但 calculate/get_time/ask_user/list_skills/get_skill 共 5 项仍无条件注册。外部技能列表也不按 allowedTools 禁用。证据：`registry-factory.ts:164-175,194,245`; `src/skills/index.ts:17`。

### P1-2：确认机制不统一，safe 命令批准后仍可能不能执行

- command 的 needsConfirmation 会让 loop 挂起，并由 chat toolResponse 读取历史参数加入审批集合；这一条有实际闭环。证据：`src/tools/cmd/cmd-tool.ts:52`; `src/core/agent-loop/react.ts:985`; `src/api/http/routes/chat.ts:966-975`。
- 但是 approve 仅使 policyEngine allow；下一步 cmd-tool safe 白名单仍拒绝未列名命令。默认命令如 git 即便用户允许，也不能通过旧名单。证据：`src/security/policy-engine.ts:272`; `src/tools/cmd/cmd-tool.ts:74`。
- install_package 的 confirm、agent_do_* 的 confirmed 由模型自己填写，未与用户回答绑定；预览文本不是可验证批准。证据：`install-package-tool.ts:49,84-87`; `agent-tool.ts:186,268,343`。
- 审批 key 仅 tenant/session/command/args.join(' ')，不含 cwd，且不同参数数组可能有相同 join 结果；后续审批需要使用结构化不可碰撞摘要，并绑定实际操作上下文。证据：`src/security/policy-engine.ts:25-34`。

### P1-3：路径检查覆盖和实际语义不足

WorkspaceManager 只做 path.resolve/path.relative 字符串包含检查，不处理真实路径、符号链接/junction；standard 和 full-access 都直接放行任意路径。证据：`src/workspace/manager.ts:43-51`。

下列入口没有统一 resolveSafePath：code_diagnose 绝对/相对路径（`src/tools/lsp/lsp-tool.ts:32`），codegraph 查询 root（`src/tools/codegraph/codegraph-tool.ts:28-36`），list_packages/install_package（`install-package-tool.ts:39,200`），Word 图片 run.path（`handlers/word-handler.ts:72`），Excel 图片 img.path（`handlers/excel-handler.ts:236`）。被嵌入文档的图片也属于读文件权限面。

建议：同时覆盖主路径、二级资源路径、glob 模式、read/write/execute 区别、符号链接与 TOCTOU；不要把“位于工作区内的字符串”当实际资源边界。

### P1-4：代码诊断可以将“没检查”显示成“检查通过”，并存在嵌套并发池等待风险

diagnoseFile 无匹配 adapter 返回空 diagnostics，不可用 adapter 也返回 []；工具仅看 length===0 就输出“诊断通过”。未知语言/未安装 ESLint 的用户会得到错误信心。证据：`src/lsp/index.ts:130-146`; `src/tools/lsp/lsp-tool.ts:42-45`。

ToolRegistry 的非 subagent 调用先拿全局池，diagnoseFile 内又拿同一全局池。若并发诊断占满全部槽位，外层等待内层、内层等槽位；这是静态可推导的等待风险，未在本次运行中复现。证据：`src/core/tool-registry/registry.ts:43-44`; `src/lsp/index.ts:143-148`。TypeScript 同步编译还可能占用事件循环。

建议：显式区分 pass/fail/unsupported/unavailable；诊断缓存同时纳入 adapter/config 版本；取消嵌套占池，保留一个资源调度层。

### P1-5：技能发现路径与脚本执行路径不一致

SkillsRegistry 可自动发现 cwd/.aether/skills 和 ~/.aether/skills；run_skill_script 却只读取 SKILLS_ROOT，否则默认 ./skills，没使用当前 skill 的实际 skillMdPath。因而默认发现成功不保证执行成功，多层技能也缺乏逐技能 cwd。inline 技能更没有文件。证据：`src/skills/skills-registry.ts:35-70`; `src/tools/skill/run-skill-script.ts:59-65`; `src/tools/registry-factory.ts:229`。

建议：执行接口传已注册 skill ID + 经过验证的 script 相对路径 + argv，由 registry 决定真实根目录，取消任意 command 字符串。

### P1-6：方法论说明宣称不存在的工具能力

`.aether/skills/os-using-superpowers/references/agent-engine-tools.md` 声称：smart_read、edit_file、web_search、memory_store/memory_recall/memory_forget、kb_search、run_command background:true、todo_create items。当前 registry/schema 不提供这些名称或参数。`SKILL.md:41` 又要求按该映射转换工具，构成直接进入模型上下文的错误能力说明。

建议：用注册对象生成工具目录/技能适配表；对所有内置技能引用的工具名与参数做静态一致性检查。知识库可能已有 RAG 注入，不等于注册了 kb_search 工具。

### P2-1：中央注册表缺少统一参数验证与执行策略

ToolRegistry.execute 只找工具并进入并发池；未按 tool.parameters 做 JSON Schema 校验，未统一执行权限、日志脱敏、取消、上限、事务/读写串行规则。各工具大量 rawArgs as any，让契约散落。证据：`src/core/tool-registry/registry.ts:32-44`。

### P2-2：技能导入限额检查晚于解压

runSkillImport 先 unzipSync 整包进内存，再检查文件数、单文件、总解压量和压缩比；这些检查能阻止落盘，却不能防止解压阶段内存/CPU 峰值。证据：`src/skills/import-pipeline.ts:169-200`。文件说明称“拒绝符号链接”，safeEntryName 实际检查的是 NUL 路径字符，并没有 ZIP 外部属性的符号链接类型判断；当前使用 Uint8Array 落盘为普通文件，不能简单据此宣称已形成符号链接写入漏洞，但文档保证不准确。

### P2-3：checkpoint 的范围尚不能保证代码任务可恢复

小文本快照有实际价值；但 `snapshot()`/`restore()` 仍抛 not implemented。shell、技能、MCP、外部编辑器做的改动不会经过 writeFileTool；多文件变更与二进制也没有完整恢复。当前不能对外表述为任意任务级 checkpoint/rewind。

## 4. 与 Claude 包能力逐项对齐时的判定规则

- 引擎实际工具名以本报告清单为准；README、历史比较报告、方法论 skill 里的名称都只是待核验声明。
- 不能将宿主 bash 能做任何事，折算成“已经有 NotebookEdit、Browser、LSP、Plugin、worktree、checkpoint 等原生产品能力”。可扩展性与产品完成度分别计分。
- Office/OCR、HTTP 通用认证、记忆图谱、管理 UI/多租户数据模型是本引擎独特方向，应单独记优势，不应仅按 CLI 编码功能表计分。
- “Claude 二进制出现字符串”“对应工具确实注册”“当前平台启用”“当前账号/flag可用”“端到端实测成功”是不同等级证据；本附录不替 Claude 版本作任何推断。
- 建议优先顺序：统一安全执行与审批 → 工具/配置契约 → 可靠编辑与恢复 → 完整 MCP 扩展/生命周期 → 多语言代码智能 → 浏览器及外部服务集成。新增工具数量不是首要指标。

