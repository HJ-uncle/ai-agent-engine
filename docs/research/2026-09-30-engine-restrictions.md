# 当前引擎限制、默认值与实现边界

核对日期：2026-09-30。范围仅为 `D:/dev/ai-agent-engine` 当前源码工作区；不将其他项目的主进程、界面或安装器能力计入引擎。基线提交为 `694a7e9`，同时检查了尚未提交的 LSP、配置和存储修正。本文是源码与历史取证，没有为本次文档修改重复执行全量测试。

后续远端验收补充：本轮修复 `/metrics` 生产路由的 Fastify 5 对象序列化错误，真实路由回归 3/3 通过并已重新构建。上段“源码与历史取证”描述原审计方式，不代表后续没有代码修复；本轮未重跑此前 714 项引擎全量。

“限制”分为三类：**硬边界**需要改代码或契约；**默认值**已有参数、环境变量或持久配置可调整；**实现缺口**没有完成相应执行路径，不能靠调大数字补齐。`full-access` 也不会自动取消文件编辑、模型窗口、后台作业等所有边界。

## 来源判定

| 标记 | 含义与证据 |
|---|---|
| E | 在 D0 实施起点 `770090d` 已经存在。`4a1a7dd`、`1fc91cd`、`1d0a46f`、`770090d` 均属于这一类，不能说是 D0–D9 新增。 |
| N·D0–D6 | `git blame` 落到 `60f13ad`，并由阶段报告区分具体阶段。该提交集中收录多个阶段，不能只从提交标题判定起源。 |
| N·D7 | `git blame` 落到 `694a7e9`，后台命令阶段新增。 |
| N·D8 / N·D9 | 当前尚未提交，但工作区差异与相应阶段报告能相互印证。 |
| U | 当前行为已从源码确认；缺少足够证据将该条行为的最初引入归到某一阶段，或工作区正在继续修正。 |

核对使用了 `git log`、逐段 `git blame` 和以下报告：[D0–D6](D:/dev/ai-agent-engine/docs/research/2026-09-29-d0-d6-implementation-status.md:1)、[D7](D:/dev/ai-agent-engine/docs/research/2026-09-29-d7-implementation-status.md:1)、[D8–D9](D:/dev/ai-agent-engine/docs/research/2026-09-29-d8-d9-implementation-status.md:1)。`git blame` 的 `^4a1a7dd` 只能证明此文件历史边界已包含行为，不代表确知它最初的设计日期。报告中的早期“未实施 D8/D9”属于当时状态，应由后续 D8/D9 报告覆盖。

## 1. 身份认证与管理权限

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 实例令牌 | `AETHER_INSTANCE_TOKEN` 未定义时不启用实例门禁；显式空字符串会拒绝受保护请求。请求头是 `x-aether-instance-token`，使用 SHA-256 后定长比较。 | 环境变量；N·D0 | [instance-token.ts](D:/dev/ai-agent-engine/src/auth/instance-token.ts:6) |
| 公共探针 | 只有 GET/HEAD 的 `/health`、`/meta` 免实例令牌，查询参数不改变判断。其他旧白名单不能绕过实例门禁。 | 路由硬规则；N·D0 | [instance-token.ts](D:/dev/ai-agent-engine/src/auth/instance-token.ts:17)、[middleware.ts](D:/dev/ai-agent-engine/src/api/http/middleware.ts:44) |
| 租户认证 | `AUTH_ENABLED=false` 使用 Noop；启用时，**未提供 API key/Bearer 仍回落 `tenantId=default, method=none`**。启用认证不等于所有请求都要求登录。 | 认证行为；E | [middleware.ts](D:/dev/ai-agent-engine/src/auth/middleware.ts:13) |
| JWT/API key 权限 | JWT secret 默认 `dev-secret-change-in-production`；有效 API key 赋 `admin`；JWT 未给非空 roles 时也赋 `admin`。 | secret 可配，角色回落是代码行为；E | [middleware.ts](D:/dev/ai-agent-engine/src/auth/middleware.ts:9) |
| 路由权限不统一 | 通用 `requireRoles` 在启用认证时拒绝 `method=none`；模型路由的本地 `requireAdmin` 却显式允许 `method=none`。技能导入使用 admin/skill-manager；所查 settings/security/MCP 路由未采用相同的严格角色守卫。 | 实现边界；E（相关认证/路由基线），不能宣传为统一 RBAC | [guards.ts](D:/dev/ai-agent-engine/src/auth/guards.ts:21)、[models.ts](D:/dev/ai-agent-engine/src/api/http/routes/models.ts:48)、[skill-imports.ts](D:/dev/ai-agent-engine/src/api/http/routes/skill-imports.ts:159) |
| 错误契约 | 租户凭据校验失败可能是 HTTP 200、业务 `code=40100`；调用方只检查 HTTP 状态会漏掉失败。 | 既有 API 契约；E | [middleware.ts](D:/dev/ai-agent-engine/src/api/http/middleware.ts:60) |

实例身份验证与租户身份验证是两层独立机制。实例令牌存在时，无凭据租户回落不等于绕过实例门禁；实例令牌未配置时，也不能假设 `AUTH_ENABLED=true` 已经关闭匿名业务访问。

## 2. 工具集合与调用并发

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| Profile | 请求头省略时使用 `general`；只接受 `general`、`code`，非法值报 400。 | 请求级选择，新增 profile 需代码；E（`770090d`） | [tool-profile.ts](D:/dev/ai-agent-engine/src/api/http/tool-profile.ts:5) |
| code 内置工具 | 当前白名单 25 项：read/write/edit/list/delete/create、glob/grep、execute_cmd、code_diagnose、codegraph、command_output、cancel_command、subagent、4 个 todo、3 个 skill、web_fetch、http_request、ask_user、get_current_context。 | 白名单硬规则；E，edit_file 为 N·D6，command_output/cancel_command 为 N·D7 | [tool-profile.ts](D:/dev/ai-agent-engine/src/tools/tool-profile.ts:20) |
| code 排除项 | 不暴露 remember/recall/search_memory/list_memories/forget/link_memories、install_package/list_packages、calculate/get_time，以及 `cron_`/`agent_`/`task_` 前缀工具和旧别名；可接受已配置的 skill 与 `mcp_` 工具。 | 硬规则；E | [tool-profile.ts](D:/dev/ai-agent-engine/src/tools/tool-profile.ts:29) |
| OSM 工具过滤 | `off` 收敛为核心工具；显式 `[]` 保持无工具。其他模式尊重显式配置。`off` 下非空白名单与核心集合交集为空时会回退为核心集合。方法论技能只在 methodology/max 可见。 | `OSM_MODE` 可配；E | [osm.ts](D:/dev/ai-agent-engine/src/core/osm.ts:246) |
| 全局工具池 | `TOOL_CONCURRENCY_LIMIT` 默认 8；池把非法值/过小值归到至少 1，未设固定最大值，settings 可调整池大小。 | 环境/设置可调；E，取消机制后有修正 | [concurrency-pool.ts](D:/dev/ai-agent-engine/src/core/utils/concurrency-pool.ts:11)、[settings.ts](D:/dev/ai-agent-engine/src/api/http/routes/settings.ts:164) |
| 并行资格 | 只读/子代理元数据允许并行；未知工具与其他副作用工具串行。工具名或 profile 不构成 OS 沙箱。 | 硬执行规则；N·D3 | [tool-policy.ts](D:/dev/ai-agent-engine/src/security/tool-policy.ts:5) |

## 3. 安全模式、工作区与回退范围

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 默认模式 | `DEFAULT_SECURITY_MODE` 未设置/非法时为 `safe`；会话模式保存在当前进程的 Map。 | 默认可配，会话状态不是跨实例共享；E | [policy-engine.ts](D:/dev/ai-agent-engine/src/security/policy-engine.ts:16) |
| safe / standard / full-access | safe 保留 deny/ask 并拒绝注入；standard 将注入降为 ask、deny 规则降为 ask、ask 规则升为 allow，路径穿越检测可 allow；full-access 跳过命令策略但仍审计。文件顶部旧注释不能代替执行代码。 | 模式可切换，映射为代码规则；E | [policy-engine.ts](D:/dev/ai-agent-engine/src/security/policy-engine.ts:261)、[policy-engine.ts](D:/dev/ai-agent-engine/src/security/policy-engine.ts:373) |
| 扩展执行 | safe 阻止不能约束的 skill/MCP 扩展，不提供“批准后就已被沙箱隔离”的假象；standard/full-access 可以执行。 | 模式控制；N·D3 | [tool-policy.ts](D:/dev/ai-agent-engine/src/security/tool-policy.ts:15) |
| 工作目录 | `WORKSPACE_ROOT` 默认 `./workspace`；scratch 为 root/tenant/session；cwd 优先级为请求 cwd、projectRoot、workspacePaths[0]、scratch。 | 路径/请求参数可配；E | [manager.ts](D:/dev/ai-agent-engine/src/workspace/manager.ts:11) |
| 路径包含关系 | safe 允许 cwd、projectRoot、绑定 workspacePaths、scratch 内路径；standard/full-access 不限制工作区包含关系。管理器本身主要做词法路径判断，具体工具另做规范化。 | 模式可调；E（`770090d`） | [manager.ts](D:/dev/ai-agent-engine/src/workspace/manager.ts:28) |
| 文件并发保护 | 规范路径、完整字节 hash、进程内锁；支持 Windows 大小写别名及符号链接目标规范化。**不是跨进程文件锁**，外部编辑器写入仍靠版本冲突检测。 | 实现边界；N·D2 | [file-version.ts](D:/dev/ai-agent-engine/src/shared/file-version.ts:10)、[file-version.ts](D:/dev/ai-agent-engine/src/shared/file-version.ts:58) |
| 工作区快照 | WorkspaceManager 的 snapshot/restore 仍直接抛 not implemented；文件 ChangeStore 回退不等于整个工作区事务回滚，shell/MCP/网络副作用没有通用回退。 | 缺口；E（`1d0a46f`） | [manager.ts](D:/dev/ai-agent-engine/src/workspace/manager.ts:55) |

## 4. 网络请求与 MCP

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 网络默认策略 | HTTP/HTTPS；阻止私有 IP；拒绝 metadata.google.internal / metadata.aws.internal；DNS 缓存 300 秒；响应 5 MiB；请求超时 30,000 ms；allowlist 默认关闭。 | 数据库策略可更新；E | [network-policy.ts](D:/dev/ai-agent-engine/src/security/network-policy.ts:29) |
| 策略作用域 | 网络策略记录使用全局 id=1；standard 只绕过私有 IP 阻止，协议/域名/CIDR 仍检查；full-access 跳过准入策略，但仍向传输层返回大小/时间上限。 | 全局配置/模式；E | [network-policy.ts](D:/dev/ai-agent-engine/src/security/network-policy.ts:119)、[network-policy.ts](D:/dev/ai-agent-engine/src/security/network-policy.ts:176)、[network-policy.ts](D:/dev/ai-agent-engine/src/security/network-policy.ts:239) |
| 地址处理范围 | 自定义 CIDR 解析针对 IPv4；IPv6 私有地址判断使用特定前缀规则，不是完整通用 IPv6 CIDR 匹配器。 | 实现边界；E | [network-policy.ts](D:/dev/ai-agent-engine/src/security/network-policy.ts:68) |
| HTTP 硬规则 | 即使 full-access 也只支持 HTTP(S)，拒绝 URL 内嵌用户名/密码；初始请求最多再跟随 5 次重定向；每跳重新准入并固定已检查的 DNS 地址。 | 协议/跳数需改代码；N·D3 | [guarded-http.ts](D:/dev/ai-agent-engine/src/security/guarded-http.ts:18) |
| 大小与超时语义 | 超时为 `min(调用者 timeout, policy timeout)`，按**每跳**计时；完整缓存响应后返回。`maxResponseBytes=0` 关闭大小限制；跨 origin 只保留 Accept、Accept-Language、Content-Type、User-Agent。 | 时间/大小可配置，缓冲与转发规则固定；N·D3 | [guarded-http.ts](D:/dev/ai-agent-engine/src/security/guarded-http.ts:29) |
| 网页正文 | web_fetch 内容长度默认 50,000 字符，另外受 HTTP 响应字节上限约束。 | webFetch 配置可调；E | [security-config.ts](D:/dev/ai-agent-engine/src/tools/web-fetch/security-config.ts:34) |
| MCP transport | 本地配置和 inline server 的 `stdio` 均被跳过；远程 HTTP/SSE/streamableHttp 进入 HTTPMCPClient。 | 缺少 stdio 生命周期；E | [loader.ts](D:/dev/ai-agent-engine/src/tools/mcp/loader.ts:51)、[loader.ts](D:/dev/ai-agent-engine/src/tools/mcp/loader.ts:74) |
| MCP 时间限制 | JSON-RPC 15 秒、REST 列工具 10 秒、REST call 30 秒，还受网络策略较小超时约束。 | 客户端调用处常量；E，统一 guarded HTTP 为 N·D3 | [client.ts](D:/dev/ai-agent-engine/src/tools/mcp/client.ts:44) |
| MCP 协议范围 | 当前主要实现 tools/list、tools/call 与 REST fallback；SSE 在完整响应文本中取首个 data 行。未形成 initialize/session、resources、prompts、OAuth、通知、分页等完整协议生命周期；工具列表缓存至断开。 | 实现缺口；E 客户端基线，具体缺口起源不另推断 | [client.ts](D:/dev/ai-agent-engine/src/tools/mcp/client.ts:53)、[client.ts](D:/dev/ai-agent-engine/src/tools/mcp/client.ts:97) |

## 5. 文件读取、精确编辑、搜索与上传

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 文件读取 | `MAX_FILE_SIZE_BYTES` 默认 10,485,760 bytes（10 MiB）；read_file 在读与锁内完整读取后均检查，适用于精确及格式处理路径。常量在模块加载时取 env。 | 环境可调但需重新加载/重启；E 默认，N·D2/D6 路径强化 | [constants.ts](D:/dev/ai-agent-engine/src/tools/file/constants.ts:1)、[super-file-tool.ts](D:/dev/ai-agent-engine/src/tools/file/super-file-tool.ts:90) |
| 可完整回退的文本 | ChangeRecorder 上限 **100,000 bytes**；二进制扩展、NUL、无效 UTF-8 不保存文本快照。ChangeStore 另有 100,000 JS 字符兜底，两个单位不同。 | 硬限制；N·D2 | [change-recorder.ts](D:/dev/ai-agent-engine/src/tools/file/change-recorder.ts:8)、[changes/index.ts](D:/dev/ai-agent-engine/src/storage/changes/index.ts:71) |
| 精确编辑 | 只支持现有 UTF-8 普通文本；必须传完整文件 expectedHash；每项 oldText 唯一、替换区间不重叠、同时针对同一原文校验、成功后一次写入。 | 硬契约；N·D6 | [edit-file.ts](D:/dev/ai-agent-engine/src/tools/file/edit-file.ts:27) |
| 精确编辑大小 | 编辑前后均不得超过 **100,000 bytes**；调大 `MAX_FILE_SIZE_BYTES` 不会放开此上限；不适用二进制/目录。 | 硬限制；N·D6 | [edit-file.ts](D:/dev/ai-agent-engine/src/tools/file/edit-file.ts:57)、[edit-file.ts](D:/dev/ai-agent-engine/src/tools/file/edit-file.ts:85) |
| 删除/回退 | 删除只支持普通文件，拒绝目录和直接符号链接；无目录快照回退；快照缺失/截断的内容不能承诺完整 undo。 | 硬边界；N·D2 | [basic.ts](D:/dev/ai-agent-engine/src/tools/file/basic.ts:95)、[D2 记录](D:/dev/ai-agent-engine/docs/research/2026-09-29-d0-d6-implementation-status.md:1) |
| REST 文本预览 | `MAX_TEXT_SIZE=500*1024`，实际按 `content.length` 与 `slice` 截断，故为 **512,000 个 JS 字符单位**，不是注释写的 500 KB 字节上限。文件格式化子进程超时 10 秒。 | 代码常量；E | [workspace.ts](D:/dev/ai-agent-engine/src/api/http/routes/workspace.ts:152)、[workspace.ts](D:/dev/ai-agent-engine/src/api/http/routes/workspace.ts:389) |
| grep | `maxResults` 默认 50，要求正安全整数，跨目录全局计数；没有固定数值最大上限。 | 调用参数可调；E（`770090d` 已有校验与全局计数修正） | [grep-tool.ts](D:/dev/ai-agent-engine/src/tools/search/grep-tool.ts:120) |
| glob | 默认 limit=100，可调用时更改；递归 `maxDepth=10` 固定。 | limit 可调，深度需改代码；E | [glob-tool.ts](D:/dev/ai-agent-engine/src/tools/search/glob-tool.ts:24) |
| Excel | 常规读取 maxRows 为 endLine 或 300；full 不设此行数上限；流式解析失败后，超过 5 MiB 不再回退全量解析。 | 模式/行数可调，fallback 阈值固定；E | [excel-handler.ts](D:/dev/ai-agent-engine/src/tools/file/handlers/excel-handler.ts:25) |
| HTTP 上传 | Fastify bodyLimit 与 multipart 单文件 fileSize 都为 100 MiB；工作区上传完整读入 buffer。这个上限与读文件 10 MiB、精确编辑 100,000 bytes 是不同入口。 | 服务器代码设置，当前未暴露专用 env；E | [server.ts](D:/dev/ai-agent-engine/src/api/http/server.ts:48)、[server.ts](D:/dev/ai-agent-engine/src/api/http/server.ts:82)、[workspace.ts](D:/dev/ai-agent-engine/src/api/http/routes/workspace.ts:255) |

## 6. 图片、附件与文档处理

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 视觉入口 | 模型无 vision 能力时显式 `mode=vision` 失败；auto 优先可配置视觉代理，失败再 OCR；OCR 默认 eng+chi_sim。 | 主模型/utilityModel/VISION_PROXY_MODEL 可配；E（视觉代理 `1fc91cd`） | [image-handler.ts](D:/dev/ai-agent-engine/src/tools/file/handlers/image-handler.ts:13)、[vision-proxy.ts](D:/dev/ai-agent-engine/src/tools/file/vision-proxy.ts:48) |
| 图片写入 | ImageHandler.write 直接报 `Writing images is not supported yet.`。拥有图片读取或文件写入工具不等于具有内置图像生成/编辑器。 | 实现缺口；E | [image-handler.ts](D:/dev/ai-agent-engine/src/tools/file/handlers/image-handler.ts:91) |
| 自动附件 | 原生视觉附件会直接完整读入并转 base64；该分支不经过 read_file 的 10 MiB 检查，也没有单独图片数量/像素上限。入口上传约束与 provider 限制仍存在；不能据此宣称“无限图片”。 | 当前边界；E 附件基线 | [attachment-auto-processor.ts](D:/dev/ai-agent-engine/src/api/http/routes/attachment-auto-processor.ts:69) |
| OCR/视觉代理取消 | 所查 OCR 的 Tesseract.recognize、视觉代理 adapter.complete 调用没有显式传递当前 AbortSignal、专用超时或 maxTokens；依赖库/provider 的行为。 | 取消/资源上限缺口；E | [ocr.ts](D:/dev/ai-agent-engine/src/tools/file/ocr.ts:44)、[vision-proxy.ts](D:/dev/ai-agent-engine/src/tools/file/vision-proxy.ts:124) |
| 文档格式 | PDF/Word/Excel 使用各自解析器/生成器；格式解析、OCR 和图片读取不是任意格式的保真编辑能力。精确编辑仍只适用于 UTF-8 文本。 | 实现边界；E | [registry.ts](D:/dev/ai-agent-engine/src/tools/file/handlers/registry.ts:1)、[pdf-handler.ts](D:/dev/ai-agent-engine/src/tools/file/handlers/pdf-handler.ts:1) |

## 7. 模型、循环、上下文与用量

**实际默认 OSM 是 balanced。** `resolveOSMMode()` 最终返回 balanced；附近部分旧注释/警告文字仍写 off。以下基础值应先乘模式倍率，再受显式请求设置与模型窗口约束。

| OSM 模式 | tokenBudget 倍率 | maxIterations / toolOutput / SQLite history 倍率 | 压缩阈值 |
|---|---:|---:|---|
| off | 1 | 1 | 使用基础值，默认 0.92 |
| balanced（默认） | 2 | 2 | 默认 0.92 |
| methodology | 2 | 2 | 默认 0.92 |
| max | 5 | 4 | 0.7 |

来源：E，[osm.ts 模式表](D:/dev/ai-agent-engine/src/core/osm.ts:109)、[实际默认](D:/dev/ai-agent-engine/src/core/osm.ts:197)。显式参数不一定经过倍率，不应只按 UI 显示的基础配置推算实际行为。

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 上下文预算 | `TOKEN_BUDGET` 基础 60,000，未覆盖的 balanced 默认 120,000；实际有效窗口为 context budget 与模型 contextWindow 的较小值。 | env/请求/model 可调；E 默认，N·D5 完整请求预检 | [factory.ts](D:/dev/ai-agent-engine/src/core/agent-context/factory.ts:42)、[react.ts](D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:441) |
| 迭代 | `MAX_ITERATIONS` 基础 50，默认 balanced 通常为 100；显式 loop option 优先。达上限进入总结/终态，不是无限循环。 | env/内部 option；E | [react.ts](D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:327) |
| 工具结果长度 | `TOOL_OUTPUT_MAX_CHARS` 基础 4,000，balanced 为 8,000；普通结果保留头尾，中间截断；有效含 dataUrl/hasDataUrl 的图片 JSON 特判不截断。 | env 动态可调；E | [react.ts](D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:24)、[react.ts](D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:88) |
| 重复/失败止损 | `MAX_CONSECUTIVE_FAILURES` 默认 8，可设置正数；调用指纹会排序键并把每个长字符串只取前 200 字符，可能把后半部分变化视为相同。 | 阈值 env 可调，指纹规则固定；E（`1fc91cd`） | [react.ts](D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:36) |
| 交互提问 | maxAskUserCount 默认 5，达到后从当轮工具列表移除 ask_user。 | loop option 可覆盖，非公开统一 env；E | [react.ts](D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:335)、[react.ts](D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:438) |
| 输出预留/压缩 | 默认输出 `min(8192,max(256,floor(effectiveBudget/4)))`；压缩先 microcompact 保留最近 10 个工具结果；摘要输出至多 min(4096,当前输出上限)。完整 history+system+tools+输出仍超窗口则明确 CONTEXT_LIMIT。 | 部分 option/env，安全检查硬规则；N·D5 | [react.ts](D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:442)、[react.ts](D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:456)、[react.ts](D:/dev/ai-agent-engine/src/core/agent-loop/react.ts:559) |
| 累计 token 预算 | `AGENT_TOTAL_TOKEN_LIMIT` / `SUBAGENT_TOKEN_LIMIT` 未设、非法、非正数均解析为 Infinity；这与单请求上下文窗口不同。有限预算按物理 provider 请求计账，上游不返回 usage 时保守记估算。 | 显式配置才启用有限累计额；E 预算模型，N·D5 记账修正 | [budget.ts](D:/dev/ai-agent-engine/src/core/subagent/budget.ts:20)、[chat.ts](D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:676) |
| retry / fallback | 默认 maxRetries=3，即最多 4 次尝试，基础延迟 1,000 ms、最大 30,000 ms；仅可重试错误适用。正文/思考/工具进度已交付后不重放、不切备用。 | retry 内部 options 可调，交付后禁重放是硬语义；E 重试默认，N·D5 流式边界 | [retry.ts](D:/dev/ai-agent-engine/src/core/llm-adapter/retry.ts:24)、[retry.ts](D:/dev/ai-agent-engine/src/core/llm-adapter/retry.ts:74) |
| 结构化输出 | 所查 OpenAI 适配器 jsonMode 采用 `response_format=json_object`；不是通用 JSON Schema 输出校验与重试框架。 | 缺口；U | [openai.ts](D:/dev/ai-agent-engine/src/core/llm-adapter/openai.ts:692) |
| 模型连接测试 | `/models/:id/test` 真正发出 “Say hello” 请求；该 route 调用没有显式 timeout/signal/maxTokens。不能因注释说 short timeout 就标成 30 秒保证。 | provider/SDK 默认控制；E 路由基线 | [models.ts](D:/dev/ai-agent-engine/src/api/http/routes/models.ts:171) |

## 8. 流式、恢复与运行身份

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 重放窗口 | StreamBus 默认保留最多 2,048 事件或 8 MiB；每订阅者队列最多 2,048 事件。 | 构造参数可改，未暴露统一运维 env；N·D4 | [stream-bus.ts](D:/dev/ai-agent-engine/src/core/stream-pipeline/stream-bus.ts:43) |
| 游标错误 | stream 身份不符、已过期或未来游标要求重新获取快照，不能承诺任意久以前都能增量补帧。 | 硬语义；N·D4 | [stream-bus.ts](D:/dev/ai-agent-engine/src/core/stream-pipeline/stream-bus.ts:89) |
| 监听器数 | `setMaxListeners(20)` 是 EventEmitter 警告阈值，**不是 20 个连接的拒绝上限**。 | 内部设置；N·D4 | [stream-bus.ts](D:/dev/ai-agent-engine/src/core/stream-pipeline/stream-bus.ts:42) |
| SSE | 15 秒心跳；raw socket timeout=0；断开消费者解绑但不等于取消 producer。 | 固定心跳与传输语义；N·D4 | [sse-sink.ts](D:/dev/ai-agent-engine/src/core/stream-pipeline/sse-sink.ts:5) |
| 根任务恢复 | 重启把 running/cancelling 标 interrupted；等待中的请求可继续回答，但不会重放已发生工具副作用；请求记录按白名单保存且不含凭据。 | 硬恢复语义；N·D3 | [root-runs/index.ts](D:/dev/ai-agent-engine/src/storage/root-runs/index.ts:45) |
| 会话准入 | 根执行以会话为单位控制，恢复使用原 model/workspace/profile；语义快照与持久历史不是可迁移的正在执行模型进程。 | 单进程执行边界；N·D3/D4 | [chat.ts](D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:410) |

## 9. 前台与后台命令

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 超时 | 前台 safe/standard 默认 30 秒、full-access 默认 120 秒；后台默认 600 秒。优先级：调用 timeoutMs > CMD_TIMEOUT_MS > 默认；最终硬上限 **600,000 ms**。 | 默认可配。E：前台默认及显式 timeoutMs 的 600 秒钳制；N·D7：后台默认，且 env 值也统一钳制 | [execute-command.ts](D:/dev/ai-agent-engine/src/tools/cmd/execute-command.ts:60) |
| 环境与 shell | safe/standard 只提供 PATH、HOME=cwd、SystemRoot、COMSPEC；full-access 继承 process.env；spawn 使用 shell=false；Windows 内置 shell 命令有明确拒绝分支。 | E：env 与 shell=false；N·D7：Windows 内建命令改为拒绝，基线旧 cmd-tool.ts 曾包装 cmd.exe /c 执行 | [execute-command.ts](D:/dev/ai-agent-engine/src/tools/cmd/execute-command.ts:68)、[manager.ts](D:/dev/ai-agent-engine/src/core/command-jobs/manager.ts:11) |
| 作业并发 | 默认最多 16 个活动命令，构造参数至少 1；不是无限后台进程。 | 管理器构造 options，未暴露对应 env；N·D7 | [manager.ts](D:/dev/ai-agent-engine/src/core/command-jobs/manager.ts:65) |
| 输出 | 每 job 默认尾部 256 KiB、单页 64 KiB；每 piece 不超过 min(pageLimit,4096) bytes；100 ms 批量持久化；请求 maxBytes 为 4..pageLimit。 | 构造 options；N·D7 | [types.ts](D:/dev/ai-agent-engine/src/core/command-jobs/types.ts:67)、[manager.ts](D:/dev/ai-agent-engine/src/core/command-jobs/manager.ts:164)、[manager.ts](D:/dev/ai-agent-engine/src/core/command-jobs/manager.ts:321) |
| 保留 | 终态默认保留 7 天、全局至多 500、每会话至多 100；活动任务不会被此清理逻辑删除。 | 构造 options；N·D7 | [manager.ts](D:/dev/ai-agent-engine/src/core/command-jobs/manager.ts:99) |
| 游标/归属 | 旧游标可返回 truncated，未来游标拒绝；按 tenant/session/owner 约束，根可管理子任务命令、子任务仅管理自身命令。 | 硬契约；N·D7 | [manager.ts](D:/dev/ai-agent-engine/src/core/command-jobs/manager.ts:47)、[manager.ts](D:/dev/ai-agent-engine/src/core/command-jobs/manager.ts:321) |
| 进程恢复 | 重启将未结束记录标 interrupted；不重新执行、不附着旧 PID。完全脱离父进程的 daemon 与系统崩溃后旧进程不承诺接管/回收；HTTP 只有查询/取消，无绕过工具策略的启动入口。 | 实现边界；N·D7 | [manager.ts](D:/dev/ai-agent-engine/src/core/command-jobs/manager.ts:83)、[D7 边界](D:/dev/ai-agent-engine/docs/research/2026-09-29-d7-implementation-status.md:1) |

后台命令当前适合数分钟的有限作业；不能把它描述为永久服务管理器，也不能通过 `full-access` 越过 10 分钟命令超时。

## 10. 子代理

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 步数 | maxSteps 默认 24，合法范围 1..64。 | 每次调用可调至 64；E（`770090d`） | [subagent-tool.ts](D:/dev/ai-agent-engine/src/tools/subagent/subagent-tool.ts:104) |
| 角色/权限 | 角色仅 implementer、spec-reviewer、code-quality-reviewer；访问模式 read-only/inherit；审查角色始终只读，默认也是只读。 | schema 硬边界；E | [subagent-tool.ts](D:/dev/ai-agent-engine/src/tools/subagent/subagent-tool.ts:29)、[subagent-tool.ts](D:/dev/ai-agent-engine/src/tools/subagent/subagent-tool.ts:119) |
| 嵌套/交互 | 所有 child registry 都移除 subagent 与 ask_user；没有递归子代理或子代理交互提问；只读集合允许 todo 维护，但不含文件写、命令、MCP、脚本。 | 硬能力过滤；E | [subagent-tool.ts](D:/dev/ai-agent-engine/src/tools/subagent/subagent-tool.ts:61) |
| 并发 | 按 tenant+parentSession 分组；`SUBAGENT_CONCURRENCY_LIMIT` 默认 3，正整数配置至多 16。并不是全引擎总共只能 3 个 child。 | env 可调至 16；E | [runner.ts](D:/dev/ai-agent-engine/src/core/subagent/runner.ts:31)、[runner.ts](D:/dev/ai-agent-engine/src/core/subagent/runner.ts:143) |
| 截止时间 | `SUBAGENT_DEADLINE_MS` 默认 600,000 ms，env 最低 1,000 ms；排队等待也计入；内部 options.deadlineMs 可覆盖，不能说 10 分钟是硬最大值。 | env/内部 option；E | [runner.ts](D:/dev/ai-agent-engine/src/core/subagent/runner.ts:76) |
| 模型与预算 | child 单次输出 maxOutputTokens=8,192；上下文受父与子模型窗口共同限制。有限父预算时单 child slice 不高于父总额 25%，父保留至少 20% 或总结预留的较大值。 | 输出/份额代码规则，累计预算可配；E | [subagent-tool.ts](D:/dev/ai-agent-engine/src/tools/subagent/subagent-tool.ts:158)、[subagent-tool.ts](D:/dev/ai-agent-engine/src/tools/subagent/subagent-tool.ts:183)、[runner.ts](D:/dev/ai-agent-engine/src/core/subagent/runner.ts:152) |
| 结果快照 | partialOutput 8,000 字符，单工具输出快照 32,000 字符，输出持久化节流 200 ms；不等于完整转录全部丢失。 | 代码常量；E | [runner.ts](D:/dev/ai-agent-engine/src/core/subagent/runner.ts:26)、[runner.ts](D:/dev/ai-agent-engine/src/core/subagent/runner.ts:96) |
| 生命周期 | `subagent` 工具 await runner.run；没有可由模型使用的 detach/attach/SendMessage 团队通信契约；重启恢复为 interrupted。 | 实现边界；E | [subagent-tool.ts](D:/dev/ai-agent-engine/src/tools/subagent/subagent-tool.ts:138)、[store.ts](D:/dev/ai-agent-engine/src/core/subagent/store.ts:195) |

## 11. LSP / 诊断

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 引擎能力范围 | 固定 TypeScript 与 ESLint 两个诊断 adapter；独立诊断池大小 4。这里的 code_diagnose 不是任意语言完整 LSP 的 Agent 工具集合。 | adapter/池需改代码；E adapter 范围，N·D1 独立池 | [index.ts](D:/dev/ai-agent-engine/src/lsp/index.ts:14) |
| 超时 | 诊断默认 30,000 ms；HTTP、诊断层与进程层均钳到 120,000 ms；总诊断信号可覆盖排队/请求期间。 | timeoutMs 可调，硬上限 120 秒；N·D8 工作区 | [index.ts](D:/dev/ai-agent-engine/src/lsp/index.ts:72)、[process.ts](D:/dev/ai-agent-engine/src/lsp/adapters/process.ts:12)、[lsp.ts](D:/dev/ai-agent-engine/src/api/http/routes/lsp.ts:53) |
| 输出/停止 | 子进程 stdout+stderr 默认上限 4 MiB；maxOutputBytes 为内部 option；终止确认还有 15 秒截止，失败明确报告。当前为可取消 CLI 子进程，不能再沿用旧“TS 只能同步不可取消”的结论。 | 输出内部可调、停止截止硬规则；N·D8 | [process.ts](D:/dev/ai-agent-engine/src/lsp/adapters/process.ts:13)、[process.ts](D:/dev/ai-agent-engine/src/lsp/adapters/process.ts:39) |
| 路径边界 | 有 sessionId 时经过工作区检查；**无 sessionId 时**相对路径按 process cwd 解析，绝对路径直接使用，未强制要求绑定工作区。 | 当前边界；N·D8 强化 session 路径，U 无 session 契约起源 | [lsp.ts](D:/dev/ai-agent-engine/src/api/http/routes/lsp.ts:21) |
| 缓存 | 当前 hash 已加入 tenant 前缀、sessionId、adapter、content 与 lsp-v3。不能再报告“当前缓存没有租户隔离”。清理默认 7 天，days 合法 1..3,650。 | days 请求可调；U 最新工作区修正 | [index.ts](D:/dev/ai-agent-engine/src/lsp/index.ts:104)、[lsp.ts](D:/dev/ai-agent-engine/src/api/http/routes/lsp.ts:64) |

## 12. Skills 与脚本

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 根目录 | 自动根目录结合 AETHER_GLOBAL_DIR；显式 SKILLS_ROOT 启用 singleRootMode。SKILLS_ROOT/MCP_CONFIG_PATH/WORKSPACE_ROOT/BASH_PATH/DATA_DIR 持久配置修改下次启动生效。 | 配置可调但需重启；E，AETHER_GLOBAL_DIR 宿主隔离修正 N·D9 | [skills-registry.ts](D:/dev/ai-agent-engine/src/skills/skills-registry.ts:21)、[system-config.ts](D:/dev/ai-agent-engine/src/storage/sqlite/system-config.ts:13)、[settings.ts](D:/dev/ai-agent-engine/src/api/http/routes/settings.ts:148) |
| 脚本 | run_skill_script 默认 60,000 ms，接受原 timeoutMs，未见固定最大钳制；依赖 bash（BASH_PATH 可配）；maxBuffer 10 MiB；继承完整 process.env，cwd 为技能根目录。 | 参数/env 可调，缓冲常量固定；E | [run-skill-script.ts](D:/dev/ai-agent-engine/src/tools/skill/run-skill-script.ts:26)、[run-skill-script.ts](D:/dev/ai-agent-engine/src/tools/skill/run-skill-script.ts:63) |
| 脚本安全 | safe 扩展策略拒绝；其他模式运行不是 OS 沙箱；不同于 execute_cmd 的 600 秒上限及受限 env，不能混写为统一命令语义。 | 模式控制，缺少统一执行容器；N·D3 门禁，E 脚本执行 | [tool-policy.ts](D:/dev/ai-agent-engine/src/security/tool-policy.ts:15)、[run-skill-script.ts](D:/dev/ai-agent-engine/src/tools/skill/run-skill-script.ts:89) |
| 手工内容 | description 1..500 字符、body 1..100,000 字符；slug 有固定小写格式校验。 | schema 硬限制；E | [skill-imports.ts](D:/dev/ai-agent-engine/src/api/http/routes/skill-imports.ts:45) |
| 压缩包 | 仅 ZIP；包大小默认 20 MiB（SKILL_IMPORT_MAX_MB）；直传上限 5 MiB；2 MiB 是目标 chunkSize，代码明确不强制单片大小，合并片数仍按 ceil(fileSize/chunkSize) 推导。 | 总包 env 可调；直传常量/分片语义固定；E | [skill-imports.ts](D:/dev/ai-agent-engine/src/api/http/routes/skill-imports.ts:38)、[skill-imports.ts](D:/dev/ai-agent-engine/src/api/http/routes/skill-imports.ts:324)、[skill-imports.ts](D:/dev/ai-agent-engine/src/api/http/routes/skill-imports.ts:436) |
| 解包限制 | 默认最多 500 个文件项、解包总量 50 MiB、单文件 10 MiB、压缩比 100；分别由 SKILL_IMPORT_MAX_ENTRIES/MAX_TOTAL_MB/MAX_FILE_MB/MAX_RATIO 配置。 | 模块加载时 env；E | [import-pipeline.ts](D:/dev/ai-agent-engine/src/skills/import-pipeline.ts:43) |
| 解包资源边界 | `unzipSync` **先解包**，随后才检查文件项数/解包体积/比例，故这些数值不是解压前的峰值内存防护。 | 实现缺口；E | [import-pipeline.ts](D:/dev/ai-agent-engine/src/skills/import-pipeline.ts:171) |
| 文件白名单 | 固定后缀 .md/.ts/.js/.mjs/.cjs/.json/.sh/.py/.html/.css/.txt/.png/.jpg/.jpeg/.svg/.gif/.webp/.yaml/.yml/.xml/.csv/.toml/.ini/.map；保留 .staging/.versions/.git。 | 需改代码扩展；E | [import-pipeline.ts](D:/dev/ai-agent-engine/src/skills/import-pipeline.ts:51) |
| 导入列表/目录 | 列表默认 20、最多 100；chunkDir 将 DATA_DIR 当目录拼接，但主 SQLite 将其定义成数据库**文件路径**，存在语义不一致。 | 分页请求可调；目录问题为实现缺口，E | [skill-imports.ts](D:/dev/ai-agent-engine/src/api/http/routes/skill-imports.ts:69)、[skill-imports.ts](D:/dev/ai-agent-engine/src/api/http/routes/skill-imports.ts:472)、[db.ts](D:/dev/ai-agent-engine/src/storage/sqlite/db.ts:61) |

## 13. 长期记忆、历史与数据库

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| code 记忆 | code profile 不注册记忆工具，聊天入口也关闭自动长期记忆，即使 ENABLE_LONG_TERM_MEMORY 开启。 | profile 硬规则；E/N·D3 当前聊天约束 | [tool-profile.ts](D:/dev/ai-agent-engine/src/tools/tool-profile.ts:29)、[chat.ts](D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:924) |
| 历史后端 | 默认 JSONL；只有 `HISTORY_BACKEND=sqlite` 选择 SQLite。JSONL 保存到 dirname(DATA_DIR)/sessions 下，租户/会话分隔。 | env/路径可配；E | [factory.ts](D:/dev/ai-agent-engine/src/storage/conversation/factory.ts:16)、[jsonl-history.ts](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:84) |
| 历史 token 限制 | SQLite 默认 HISTORY_MAX_TOKENS 基础 20,000，再乘 OSM（balanced 为 40,000）；JSONL 没有显式 maxTokens 时直接返回消息，不采用同一隐式上限。ReAct 仍做完整请求窗口检查。 | 后端/参数差异；E，不可泛称所有历史只留 20k | [history.ts](D:/dev/ai-agent-engine/src/storage/conversation/history.ts:96)、[jsonl-history.ts](D:/dev/ai-agent-engine/src/storage/conversation/jsonl-history.ts:781) |
| SQLite | DATA_DIR 默认 `./data/agent.db`；WAL、NORMAL、foreign_keys；cache_size 默认 20,000 KiB、mmap_size 268,435,456 bytes、busy_timeout 5,000 ms。 | SQLITE_CACHE_KB 等初始化配置，不是全部实时热更新；E | [db.ts](D:/dev/ai-agent-engine/src/storage/sqlite/db.ts:39)、[db.ts](D:/dev/ai-agent-engine/src/storage/sqlite/db.ts:61) |
| Memory DB | 当前记忆库位于主数据库同级 memory/memory.db；不支持 F32_BLOB 的 SQLite 环境回退 BLOB。 | 当前工作区修正；U（后续全功能验收修正） | [memory/db.ts](D:/dev/ai-agent-engine/src/storage/memory/db.ts:16)、[memory/db.ts](D:/dev/ai-agent-engine/src/storage/memory/db.ts:54) |
| 记忆查询 | list 默认 50、标签检索 30、重要记忆 50、会话记忆 100；相似查询默认 maxDistance=0.4。 | 方法参数/内部默认，非统一全局条数上限；E | [memory-manager.ts](D:/dev/ai-agent-engine/src/storage/memory/memory-manager.ts:260) |
| 记忆整理 | MEMORY_CONSOLIDATION_INTERVAL_HOURS 默认 24 小时；弱记忆筛选阈值 MEMORY_DECAY_THRESHOLD 默认 0.05，非法数值回退 0.05。它不是固定每轮衰减率，实际衰减还使用节点 decay_rate 与时间。 | 周期与阈值均可由 env 调整；E | [consolidation.ts](D:/dev/ai-agent-engine/src/storage/memory/consolidation.ts:22)、[consolidation.ts](D:/dev/ai-agent-engine/src/storage/memory/consolidation.ts:65) |
| 并发存储 | JSONL/历史串行器与路径锁主要是进程内协调；SQLite 的事务不等于 JSONL、运行 Map、外部副作用都已具备跨进程一致性。 | 单实例边界；E/N·D3 | [serialization.ts](D:/dev/ai-agent-engine/src/storage/conversation/serialization.ts:1)、[file-version.ts](D:/dev/ai-agent-engine/src/shared/file-version.ts:58) |

## 14. Flow、Cron 与持久任务队列

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| Flow 运行 | 活动 run 存在进程 Map，无重启继续执行；停止路由按 runId 查询，所查路径未验证 tenant owner。 | 实现缺口；E | [flow-routes.ts](D:/dev/ai-agent-engine/src/api/http/routes/flows/flow-routes.ts:20)、[flow-routes.ts](D:/dev/ai-agent-engine/src/api/http/routes/flows/flow-routes.ts:115) |
| Flow 上下文 | 节点默认模型 gpt-4o-mini、tenant 固定 flow-tenant、maxIterations=10；路由接受的 cwd/executionMode/securityMode，以及节点 skills/MCP/knowledge 等字段未完整传播到实际工具执行上下文。 | 部分模型可配，其余需补实现；E | [flow-routes.ts](D:/dev/ai-agent-engine/src/api/http/routes/flows/flow-routes.ts:66)、[flow-executor.ts](D:/dev/ai-agent-engine/src/api/http/routes/flows/flow-executor.ts:114) |
| Flow 调度 | 同拓扑层 Promise.all 并行，拒绝环；没有这里独立的全局节点并发上限。节点输出累积为字符串。 | 当前调度模型；E | [flow-executor.ts](D:/dev/ai-agent-engine/src/api/http/routes/flows/flow-executor.ts:1) |
| Cron 语法 | 简化 5 字段、本地时区；步进按 value % step，未按区间起点偏移；日期与星期都要求命中（AND），不能假设完整标准 cron 语义。 | 需改解析器；E | [cron-scheduler.ts](D:/dev/ai-agent-engine/src/scheduler/cron-scheduler.ts:9) |
| Cron 调度 | 每 60,000 ms 对齐分钟检查，无停机补偿；内部调用 `/chat` 超时 120,000 ms。stop 未保留并清除最初 setTimeout，checkAndRun 未靠 running 状态兜底。 | 周期/生命周期当前代码边界；E | [cron-scheduler.ts](D:/dev/ai-agent-engine/src/scheduler/cron-scheduler.ts:59)、[cron-scheduler.ts](D:/dev/ai-agent-engine/src/scheduler/cron-scheduler.ts:102) |
| Cron 身份/结果 | 内部请求只设置 Content-Type/X-Request-ID，未传实例令牌/租户凭据；配置实例门禁时会失败。只检查 HTTP ok，未完整消费业务 envelope 与 SSE 终态，日志不能等同任务成功。 | 已有调度与新实例门禁组合后的缺口；E 请求实现 + N·D0 门禁 | [cron-scheduler.ts](D:/dev/ai-agent-engine/src/scheduler/cron-scheduler.ts:100) |
| SQLite queue | pollInterval 默认 1,000 ms；重启 running→failed；取消仅 pending；每次 SELECT pending LIMIT 1。 | 构造参数可调；E | [sqlite-queue.ts](D:/dev/ai-agent-engine/src/storage/task-queue/sqlite-queue.ts:39)、[sqlite-queue.ts](D:/dev/ai-agent-engine/src/storage/task-queue/sqlite-queue.ts:91) |
| queue 可靠执行 | 选择后条件更新，但进入 handler 前未校验抢占更新 rowsAffected；异步 interval 可重叠。未建立 durable lease、重试/续跑与 exactly-once 副作用协议，不能据 LIMIT 1 宣称全局单 worker。 | 实现缺口；E，当前捕获轮询异常补丁不改变这些语义 | [sqlite-queue.ts](D:/dev/ai-agent-engine/src/storage/task-queue/sqlite-queue.ts:131) |

## 15. 部署、配置热更新与边界汇总

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| Standalone 监听 | HOST 默认 0.0.0.0、PORT 默认 12323；Fastify 创建处未配置 TLS。 | HOST/PORT 可配；E | [main.ts](D:/dev/ai-agent-engine/src/main.ts:44)、[server.ts](D:/dev/ai-agent-engine/src/api/http/server.ts:48) |
| 服务入口防护 | 所查 server 注册处未配置统一请求限流、CORS/Helmet 插件；不能从实例 token 推导完整公共互联网部署能力。此结论限所查入口，不宣称宿主/代理也没有防护。 | 部署补齐项；U | [server.ts](D:/dev/ai-agent-engine/src/api/http/server.ts:1) |
| 配置热更新 | settings 对多数字段写 DB/env，但模块级常量、已有 adapter/registry/DB 实例未必重读；BOOT_PATH_KEYS 显式下次启动生效。MANAGED_KEYS 禁止 settings 覆盖宿主管理值。 | 逐字段判定，不能泛称全部设置立即生效；E | [settings.ts](D:/dev/ai-agent-engine/src/api/http/routes/settings.ts:136)、[aether-config.ts](D:/dev/ai-agent-engine/src/core/aether-config.ts:124) |
| 状态目录 | 当前 getUserAetherDir 尊重 AETHER_GLOBAL_DIR；这修正宿主隔离路径，但不新增数据库集群/跨机器共享运行状态能力。 | 环境可调；N·D9 | [aether-config.ts](D:/dev/ai-agent-engine/src/core/aether-config.ts:1) |
| 多实例执行 | StreamBus、root admission、child active/completions、文件锁、command job 进程句柄等保留进程内状态。数据库持久化不构成多实例分布式执行协调。 | 实现边界；E/N·D3/D4/D7 | [stream-bus.ts](D:/dev/ai-agent-engine/src/core/stream-pipeline/stream-bus.ts:1)、[runner.ts](D:/dev/ai-agent-engine/src/core/subagent/runner.ts:37)、[manager.ts](D:/dev/ai-agent-engine/src/core/command-jobs/manager.ts:1) |

优先需要产品明确表达的硬边界是：精确编辑 100,000 bytes、命令至多 10 分钟、子代理无递归/团队消息、引擎诊断仅 TS/ESLint、MCP stdio/完整会话协议未实现、工作区级快照仍占位、运行重启后标 interrupted 而不自动执行。它们与“token 基础配置可调”“默认工具结果会截断”属于不同问题，不能归结为一个统一的权限开关。

优先需要修复的执行一致性缺口是：认证路由语义不统一、Cron 未携带实例身份且未核验真实终态、Flow 上下文配置没有完整生效、任务队列缺少可靠抢占，以及技能解包先分配后检查。这些是源码已能定位的行为，不应等同于已经复现全部失败路径或完成渗透测试。

本次未修改生产代码、未调整用户配置、未清理数据或读取密钥值。后续测试应将“正常功能通过”与以上边界/异常场景分别计数；不存在从若干通过的测试直接推出“全部功能无限制、全部能力已实现”的依据。

## 16. 补扫：CodeGraph 索引与查询

以下区分引擎封装与实际安装依赖。引擎封装的历史行为已用 blame 确认为 E；依赖源码来自当前安装的 `@colbymchenry/codegraph 1.6.0` / win32-x64 包，不以未跟踪的 node_modules 推断它在 D0–D9 的引入日期，标为 U·当前依赖。只阅读代码，未启动索引。

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| Agent 查询条数 | `limit` 默认 20，代码钳到 1..100；没有严格整数/finite 校验。status 的节点类型、语言分布各只展示前 12 项；签名显示截到 100 字符。 | 参数可调到 100，展示常量固定；E | [codegraph-tool.ts](D:/dev/ai-agent-engine/src/tools/codegraph/codegraph-tool.ts:198)、[签名](D:/dev/ai-agent-engine/src/tools/codegraph/codegraph-tool.ts:49) |
| 符号与图深度 | 模糊符号解析只搜索 10 个候选，多同名时要求细化/传 nodeId。impact depth 默认 3、钳到 1..10；callers/callees 未传 depth，当前依赖默认只取 1 层。 | impact 参数可调；其他封装固定；E / U·依赖默认 | [节点解析](D:/dev/ai-agent-engine/src/tools/codegraph/codegraph-tool.ts:61)、[图调用](D:/dev/ai-agent-engine/src/tools/codegraph/codegraph-tool.ts:245)、[依赖默认](D:/dev/ai-agent-engine/node_modules/@colbymchenry/codegraph-win32-x64/lib/dist/index.js:1591) |
| 索引运行 | 进程内单槽 current，已有运行时拒绝新任务；未见引擎层取消、总体超时、重启续跑、文件总数/总索引字节配额。准入检查发生在异步 loadCodeGraph 之前、登记在之后，因此不是原子并发锁保证。 | 当前实现边界；E | [index-runner.ts](D:/dev/ai-agent-engine/src/tools/codegraph/index-runner.ts:55) |
| 索引路径 | Agent 的 index action 忽略 path，只用当前工作区；只读查询的绝对 path 直接使用。REST `/codegraph/index` 的 path 只 resolve 并验证存在目录，未调用 resolveSafePath。不能将 Agent index 的限制推广成全部 CodeGraph 路径都被工作区约束。 | 入口不同；E | [codegraph-tool.ts](D:/dev/ai-agent-engine/src/tools/codegraph/codegraph-tool.ts:27)、[index action](D:/dev/ai-agent-engine/src/tools/codegraph/codegraph-tool.ts:147)、[REST](D:/dev/ai-agent-engine/src/api/http/routes/codegraph.ts:24) |
| 可索引文件大小 | 当前依赖跳过超过 **1 MiB** 的源文件；这是 CodeGraph 的 MAX_FILE_SIZE，不是引擎 read_file 的 10 MiB。依赖另按默认忽略目录与 gitignore 筛选文件。 | 当前依赖硬常量/忽略规则；U | [extraction/index.js](D:/dev/ai-agent-engine/node_modules/@colbymchenry/codegraph-win32-x64/lib/dist/extraction/index.js:115)、[执行检查](D:/dev/ai-agent-engine/node_modules/@colbymchenry/codegraph-win32-x64/lib/dist/extraction/index.js:1850) |
| 解析 worker | 依赖默认 worker 数按 cores−1、范围 1..8；当前调用把 availableParallelism 先取至少 3，所以自动分支实际至少 2。CODEGRAPH_PARSE_WORKERS 可显式取 1..16（0 也归 1）；每 worker 250 次解析后回收；最多同时冷启动 2 个，crash budget=100。 | env 可调 worker 数，其他为依赖常量；U | [parse-pool.js](D:/dev/ai-agent-engine/node_modules/@colbymchenry/codegraph-win32-x64/lib/dist/extraction/parse-pool.js:36)、[调用入口](D:/dev/ai-agent-engine/node_modules/@colbymchenry/codegraph-win32-x64/lib/dist/extraction/index.js:1581) |
| 单文件解析时间 | CODEGRAPH_PARSE_TIMEOUT_MS 默认 10,000 ms；按每 100,000 字符增加 10,000 ms，默认软预算最多 20,000 ms；硬杀等待为预算 3 倍。显式较大基础值受尊重，不能写成全局硬 20 秒。 | env 可配；U·依赖 | [parse-pool.js](D:/dev/ai-agent-engine/node_modules/@colbymchenry/codegraph-win32-x64/lib/dist/extraction/parse-pool.js:43)、[预算公式](D:/dev/ai-agent-engine/node_modules/@colbymchenry/codegraph-win32-x64/lib/dist/extraction/parse-pool.js:85) |
| Runtime 依赖 | SDK 需要对应平台 bundle；打开图需要 node:sqlite（Node ≥22.5）。嵌入 SDK 不会自动下载缺失 bundle。引擎动态加载失败时返回明确错误，不能当作图功能可用。 | 安装/runtime 条件；U·当前依赖，E 引擎动态加载 | [npm-sdk.js](D:/dev/ai-agent-engine/node_modules/@colbymchenry/codegraph/npm-sdk.js:19)、[loader](D:/dev/ai-agent-engine/src/tools/codegraph/codegraph-module.ts:74) |

## 17. 补扫：知识库、RAG 与检索配额

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 引擎入库格式 | `/knowledge/documents` 接受 text/plain 或 JSON `{filename,content}`，拒绝空白内容，mime 固定 text/plain；此路由未实现 PDF/Word 二进制上传解析流水线。受全局 body 100 MiB 限制；所查 route/repository 未另设文档数量、总字节、总 chunk 配额。 | 缺少专用 quota/二进制入口；E | [knowledge.ts](D:/dev/ai-agent-engine/src/api/http/routes/knowledge.ts:23) |
| 分块 | 默认 500 个按空白划分的词，重叠 50 词；段落达到 80% 阈值时也切分。不是 500 token/字符/字节。无空格中文长段落可能成为大块，所查函数无单块字节钳制。 | splitIntoChunks 参数可改，REST 未暴露；E | [kb-repo.ts](D:/dev/ai-agent-engine/src/storage/knowledge/kb-repo.ts:41) |
| 入库事务 | 先插文档，再逐 chunk 插正文与 FTS，所查 addDocument 未用一个完整事务包裹整次入库；中途失败可能留下部分状态，未见后台补建/索引状态机。 | 实现边界；E | [kb-repo.ts](D:/dev/ai-agent-engine/src/storage/knowledge/kb-repo.ts:93) |
| 检索算法 | ASCII 词走 FTS5/BM25，非 ASCII 词走 LIKE；FTS 无结果时也回退 LIKE。此知识库路径没有向量检索、embedding topK、reranker 配额；不要与另一套 Memory 向量能力合并描述。 | 当前实现范围；E | [kb-repo.ts](D:/dev/ai-agent-engine/src/storage/knowledge/kb-repo.ts:151) |
| 返回数量 | `/knowledge/search` 默认 limit=5，聊天 ragTopK 默认 3；所查入口/repository 未钳制正整数或固定最大值，直接传 SQL LIMIT，随后 slice。非法/负值没有统一可预测的产品契约，不能当作无穷检索开关。 | 请求可传；缺输入边界校验；E | [knowledge.ts](D:/dev/ai-agent-engine/src/api/http/routes/knowledge.ts:99)、[chat.ts](D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:454)、[kb-repo.ts](D:/dev/ai-agent-engine/src/storage/knowledge/kb-repo.ts:153) |
| 检索范围 | tenant 与绑定 documentIds 在 SQL 内过滤；code 未绑定知识库时传空数组，不默认查全库。客户端 inlineKnowledgeBases 只注入目录元数据，最多 100 项，不能代替内容检索。 | N·D3 SQL 范围收紧；E inline 100 项 | [chat.ts](D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:925)、[元数据目录](D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:688) |
| 注入长度 | ragChunks 内容整段拼进 system prompt；所查拼接处无独立 RAG 字符/token 截断值，最后受完整模型上下文预检约束。文档列表先取租户全部记录，再由通用 paginateArray 做内存分页。 | 未见独立 RAG quota；E 拼接，N·D5 全请求预检 | [chat.ts](D:/dev/ai-agent-engine/src/api/http/routes/chat.ts:937)、[listDocuments](D:/dev/ai-agent-engine/src/storage/knowledge/kb-repo.ts:234) |

## 18. 补扫：包管理与计算工具

这些工具受第 2 节 profile 控制，code 模式不暴露。以下描述 general 模式工具本身，不把它们的执行方式误写成 execute_cmd 的同一套限制。

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| npm 安装 | install_package 固定执行 npm install，可 global/saveDev；未实现统一 pip/apt 等包管理器。超时固定 **120,000 ms**，成功 stdout 只保留最后 1,000 字符、stderr 最后 500 字符。未显式设置 maxBuffer，使用 Node exec 默认。 | 2 分钟与展示长度需改代码；E | [install-package-tool.ts](D:/dev/ai-agent-engine/src/tools/install-package/install-package-tool.ts:89) |
| 确认与执行边界 | confirm 默认 false，返回提示；模型传 confirm=true 即执行，不是持久人工审批 claim。工具自身把 packageName/version/path 拼进 shell 命令，未做包名严格验证或 resolveSafePath，未显式传 AbortSignal；无法据“首次确认文案”证明实际用户已批准。 | 既有行为/缺口；E | [install-package-tool.ts](D:/dev/ai-agent-engine/src/tools/install-package/install-package-tool.ts:30)、[执行](D:/dev/ai-agent-engine/src/tools/install-package/install-package-tool.ts:89) |
| 版本/列表语义 | version 仅在 packageName 不含 `@` 时拼接，故 scoped 包名带独立 version 时不会进入该分支。list_packages 仅读指定目录 package.json 的 dependencies/devDependencies，虽接收 global 参数但不执行全局 npm ls；未见列表数上限。 | 实现边界；E | [install-package-tool.ts](D:/dev/ai-agent-engine/src/tools/install-package/install-package-tool.ts:34)、[list_packages](D:/dev/ai-agent-engine/src/tools/install-package/install-package-tool.ts:178) |
| 计算器语法 | 仅允许数字、空白与 `+ - * / ( ) . % ^`；`^` 转为 JS 幂运算；拒绝非有限结果。没有变量、三角函数、任意精度、单位运算；使用 JS Number 语义。 | 硬语法范围；E | [math.ts](D:/dev/ai-agent-engine/src/skills/math.ts:4) |
| 计算器资源界限 | 所查 calculate 实现未设表达式长度、执行时间、调用专用并发上限；仍受请求体、工具调度与模型输出约束。不能把没有专用限制写成任意计算能力。 | 未见专用 quota；E | [math.ts](D:/dev/ai-agent-engine/src/skills/math.ts:25) |

## 19. 补扫：REST 分页、WebSocket 与交互终端

`/metrics` 当前返回 JSON 标准 success 包装，数据含 totalRequests、totalTokens、toolCallStats；不是 Prometheus 文本。已记录额度与工具调用的聚合不等于所有生产请求都已埋点。正确 token 放行后的旧业务 500 已修，详见 [路由回归](D:/dev/ai-agent-engine/src/api/http/routes/__tests__/metrics.test.ts) 与 [LAN 验收结果](D:/dev/ai-agent-engine/docs/research/2026-09-30-lan-remote-chat-electron-result.json)。

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 通用分页 | paginateArray 只有 current 与 pageSize 同时提供才分页，否则返回全数组。未设统一默认页大小、正整数验证或最大 pageSize，先获得完整数组再 slice。用于 agents/sessions/history/todos/tasks/tools/MCP/knowledge 等列表。 | 请求参数；缺统一校验/数据库分页；E | [response.ts](D:/dev/ai-agent-engine/src/api/http/response.ts:45) |
| 特殊列表 | memory/list 最多先取 1,000 条再做通用分页，memory/graph 也只取 1,000 个节点；不能假设列表分页总数或图谱覆盖全库。security audit 默认 current=1/pageSize=50，所查 route 未设置固定最大 pageSize。 | memory 固定预取限制；audit 可传；E | [memory.ts](D:/dev/ai-agent-engine/src/api/http/routes/memory.ts:48)、[security.ts](D:/dev/ai-agent-engine/src/api/http/routes/security.ts:62) |
| 通用错误 | 全局 Fastify error handler 将错误封装成 HTTP 200+业务 code；部分路由又自行发 400/403/404。产品必须兼容两者，不存在全引擎统一“HTTP 2xx 必成功”契约。 | 既有错误语义；E | [server.ts](D:/dev/ai-agent-engine/src/api/http/server.ts:65) |
| WebSocket 帧大小 | 引擎注册 @fastify/websocket 时未传 options；当前安装 ws 服务端 maxPayload 默认 **100 MiB**。插件测试辅助 injectWS 中的 maxPayload=0 不代表真实服务端无限制。 | 引擎未暴露配置；E 注册，U 当前依赖默认 | [server.ts](D:/dev/ai-agent-engine/src/api/http/server.ts:81)、[websocket-server.js](D:/dev/ai-agent-engine/node_modules/ws/lib/websocket-server.js:74) |
| WS/PTY 流控 | 终端 route 未设置专门心跳、idle timeout、连接数/PTY总数上限或基于 bufferedAmount 的慢客户端背压；只是 open 状态时 send。关闭 WS 解绑监听，不自动杀 PTY，也没有输出重放缓冲。 | 所查实现未见专用 quota/恢复；E | [terminal.ts](D:/dev/ai-agent-engine/src/api/http/routes/terminal.ts:87)、[TerminalManager](D:/dev/ai-agent-engine/src/terminal/index.ts:22) |
| PTY 身份 | 全局 HTTP/实例认证仍作用于入口；但 TerminalSession 只保存 id/pty/cwd/title/events，没有 tenant/session owner。WS 与 DELETE 按 terminalId 查询，所查 route 无逐终端归属验证。 | 资源归属缺口；E | [TerminalSession](D:/dev/ai-agent-engine/src/terminal/index.ts:12)、[terminal.ts](D:/dev/ai-agent-engine/src/api/http/routes/terminal.ts:77) |
| 终端尺寸/环境 | 默认 120 列×30 行，创建 schema 只声明 number，未设最小/最大；resize 消息直接转给 PTY。PTY 继承 process.env；cwd 不存在回退 home。 | 尺寸可传，未见服务端尺寸钳制；E | [terminal.ts](D:/dev/ai-agent-engine/src/api/http/routes/terminal.ts:25)、[terminal/index.ts](D:/dev/ai-agent-engine/src/terminal/index.ts:49) |
| 工作区 shell | 内建 cd/文件操作做工作区词法限制，tree 默认深度 3，exit 被禁用；外部命令却使用 exec(cmdline)、继承 env，未设置 timeout 或 OS 沙箱。PTY 不能套用 execute_cmd 的 10 分钟、safe env、后台作业记录等契约。 | 硬内建行为/外部边界；E | [workspace-shell.mjs](D:/dev/ai-agent-engine/src/terminal/workspace-shell.mjs:64)、[tree](D:/dev/ai-agent-engine/src/terminal/workspace-shell.mjs:108)、[external](D:/dev/ai-agent-engine/src/terminal/workspace-shell.mjs:466) |
| 工具池管理入口差异 | `/performance/tool-pool` 默认 8、钳到 1..64；`PUT /settings` 与底层 pool 不使用相同 64 上限。第 2 节“无固定最大值”只针对底层/通用设置，不能覆盖所有管理入口。 | 按入口区分；E | [performance.ts](D:/dev/ai-agent-engine/src/api/http/routes/performance.ts:42)、[settings.ts](D:/dev/ai-agent-engine/src/api/http/routes/settings.ts:164) |

## 20. 补扫：模型配置校验与轻量模型接口

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| 模型保存 URL | POST/PUT 要求 HTTP(S)，并用 hostname 字符串规则拒绝 localhost、127.*、10.*、172.16–31.*、192.168.* 及部分 IPv6 前缀。没有统一经过 guardedHttp/DNS 固定校验，也没有严格要求 `/v1/chat/completions` 后缀。 | 路由硬校验；E | [models.ts](D:/dev/ai-agent-engine/src/api/http/routes/models.ts:27) |
| 保存密钥 | POST 要求非空且至少 **16 字符**；这会阻止常见本机免密模型通过该接口保存。PUT 非空新 key 少于 16 字符拒绝，以 `...` 开头视为掩码并忽略；空串不会清除旧 key。新建模型 isEnabled=false。 | 硬路由/Store 行为；E | [models.ts](D:/dev/ai-agent-engine/src/api/http/routes/models.ts:94)、[PUT](D:/dev/ai-agent-engine/src/api/http/routes/models.ts:138)、[Store](D:/dev/ai-agent-engine/src/storage/sqlite/models.ts:132) |
| 测试/保存不一致 | `/models/:id/test` 可用临时 key/url，未复用保存的私网地址/16字符校验；所以连接测试通过不能证明一定可以保存。该 route 返回 envelope success 中的 `data.success=false` 表示 provider 失败。 | 契约不一致；E | [models.ts](D:/dev/ai-agent-engine/src/api/http/routes/models.ts:172) |
| 配置数量/名称 | 所查模型 route/store 未设每租户模型数量、displayName/modelId 字符长度上限；列表不分页。虽然有 whitelists 查询表，POST 没有以该表校验 provider/modelId；实际 adapter 是否支持仍由 factory 决定。 | 未见专用 quota；E | [models.ts](D:/dev/ai-agent-engine/src/api/http/routes/models.ts:60)、[创建](D:/dev/ai-agent-engine/src/api/http/routes/models.ts:73)、[models store](D:/dev/ai-agent-engine/src/storage/sqlite/models.ts:74) |
| Capability 白名单 | 只接受 vision/video/audio/thinking/toolCalling/jsonMode/search/caching/parallelTools/streamUsage/prefix 这 11 个 boolean/null 和 contextWindow 正安全整数/null，未知键拒绝；不能同时提交 capabilities 与 capabilityOverrides。 | 硬 schema；N·D1 | [overrides.ts](D:/dev/ai-agent-engine/src/core/model-capabilities/overrides.ts:8) |
| ContextWindow 范围 | 要求正 safe integer，没有另设业务数值最大值；覆写只改变引擎的能力配置，不能使实际 provider 获得更大的窗口或原本不支持的功能。 | 可覆写，真实能力受 adapter/provider 限制；N·D1 | [overrides.ts](D:/dev/ai-agent-engine/src/core/model-capabilities/overrides.ts:19) |
| utility/chat | temperature 默认 0.3、maxTokens 默认 2,000；schema 只要求 maxTokens integer，未设正值/最大值或 temperature 范围。非空 userPrompt 必填；不经过完整 ReAct 工具循环；所查调用无专用超时/取消信号。 | 参数可调，缺统一范围/取消约束；E | [utility.ts](D:/dev/ai-agent-engine/src/api/http/routes/utility.ts:26) |
| utility 租户 | 指定模型时从 ModelsStore.getModels('default') 查找，而非请求 auth tenant；不能视为已完成与主聊天一致的多租户模型选择。 | 实现边界；E | [utility.ts](D:/dev/ai-agent-engine/src/api/http/routes/utility.ts:52) |

## 21. 补扫：Managed Settings、默认值分歧与加密格式

| 项目 | 当前精确行为 | 可调整性 / 来源 | 源码 |
|---|---|---|---|
| Managed 来源 | Windows `%PROGRAMDATA%/Aether/settings.json`（默认 C:/ProgramData/Aether）；macOS `/Library/Application Support/Aether`；其他 `/etc/aether`。启动时先用户/项目配置，再 DB 同步，最后 managed 覆盖。 | 文件级配置；E | [aether-config.ts](D:/dev/ai-agent-engine/src/core/aether-config.ts:67)、[main.ts](D:/dev/ai-agent-engine/src/main.ts:75) |
| Managed 键集合 | MANAGED_KEYS 是本次 managed 配置写过的键集合，不是固定“允许写入白名单”。预定义映射有安全模式/OSM/skills/4个 agent 数值，cfg.env 还能注入任意键；JSON 解析后主要类型断言，未见完整运行时 schema 与数值范围校验。 | 动态锁定；E | [aether-config.ts](D:/dev/ai-agent-engine/src/core/aether-config.ts:126) |
| 普通 settings 写入 | 除 managed 键跳过、OSM 冲突/合法值验证、BOOT_PATH_KEYS 延迟生效、secret 掩码保护等分支外，PUT 遍历任意其余字段转 String 后写 DB/env；所查 route 未实行固定可写键白名单和全部数值边界验证。 | 当前实现边界；E | [settings.ts](D:/dev/ai-agent-engine/src/api/http/routes/settings.ts:100)、[写入循环](D:/dev/ai-agent-engine/src/api/http/routes/settings.ts:136) |
| 读取默认值与执行分歧 | GET settings 的缺省 TOKEN_BUDGET=**80,000**、COMPRESS_THRESHOLD_RATIO=**0.5**、CMD_TIMEOUT_MS=**5,000 ms**；执行端基础默认分别是 **60,000**、**0.92**、前台 **30/120 秒**（另受 OSM/模式）。无覆盖时设置界面展示值不能代表真实执行默认，若保存回去会变为显式配置。 | 实现不一致；E settings 默认，执行端见第 7/9 节 | [settings.ts](D:/dev/ai-agent-engine/src/api/http/routes/settings.ts:53) |
| 读取 managed 优先级 | GET settings 的 getStr 先 DB、再 env；启动时 managed 却覆盖 env。因此 DB 仍留旧值时，读取展示可能与 managed 生效值不同。managedKeys 列表只是告诉前端哪些键锁定，未自动修正 getStr 优先级。 | 当前实现边界；E | [settings.ts](D:/dev/ai-agent-engine/src/api/http/routes/settings.ts:20)、[managed 应用](D:/dev/ai-agent-engine/src/main.ts:88) |
| Secret 白名单/遮罩 | SystemConfigStore 的 SECRET_KEYS 仅 OPENAI_API_KEY、ANTHROPIC_API_KEY、DEEPSEEK_API_KEY 三项；不是按任意 TOKEN/KEY 名自动加密。settings mask 长度不足 8 时原样返回，其他保留前三/后四字符；模型 API 则保留末四位。 | 固定集合/展示规则；E | [system-config.ts](D:/dev/ai-agent-engine/src/storage/sqlite/system-config.ts:5)、[settings.ts](D:/dev/ai-agent-engine/src/api/http/routes/settings.ts:26)、[models.ts](D:/dev/ai-agent-engine/src/api/http/routes/models.ts:19) |
| ENCRYPTION_KEY | 模块加载时读取 env；未设/空值使用源码固定开发密钥并警告，不会自动生成随机持久 key。代码实际检查 `Buffer.from(value,'hex').length===32`；预期为 64 hex 字符，但没有先做完整 64-hex 正则，不能把错误文案等同严格格式解析。 | env 必须在模块初始化前生效；E | [encryption.ts](D:/dev/ai-agent-engine/src/utils/encryption.ts:6) |
| 密文格式 | AES-256-GCM，随机 IV 12 bytes，密文保存 `ivHex:authTagHex:ciphertextHex` 三段。decode 先要求恰好 3 段，余下由 crypto 校验。无 key version 字段/多 key keyring；改变 key 后旧密文不会自动变换。 | 固定格式；E | [encryption.ts](D:/dev/ai-agent-engine/src/utils/encryption.ts:24) |
| 解密失败/迁移 | SystemConfigStore 解密失败返回 null；模型 Store 解密失败把 apiKey 设空串；不是已完成自动 key rotation。D0 的开发迁移是另一路显式迁移逻辑，应单独验证，不能把配置热改 key 当迁移。 | E 解密回落，N·D0 开发迁移 | [system-config.ts](D:/dev/ai-agent-engine/src/storage/sqlite/system-config.ts:32)、[models.ts](D:/dev/ai-agent-engine/src/storage/sqlite/models.ts:39)、[dev-migration.ts](D:/dev/ai-agent-engine/src/storage/dev-migration.ts:1) |

以上补扫涉及的引擎源文件数值通过 `git blame` 逐段复核：CodeGraph 封装、知识库分块、通用分页、包安装超时、计算器、终端、models 保存限制、managed 注入与加密均在 `4a1a7dd` 基线已存在；capabilityOverrides 校验来自 `60f13ad` 的 D1；RAG 文档范围来自 D3。当前依赖的内部参数独立标 U，未据此推断历史。

补扫仍是代码审计，不是对依赖包全部内部算法、所有输入组合或前端行为的穷尽证明；前端限制应以对应消费者报告为准。本文已明确补上这些领域的实际入口和检查范围，不能再用前 15 节的概括标题替代它们的独立核查。
