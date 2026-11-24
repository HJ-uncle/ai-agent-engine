# HTTP API 使用约定

源码核对：2026-11-17。这里说明地址、身份、响应与关键协议；每个方法和路径见[源码路由目录](http-routes.md)。[openapi.json](openapi.json) 是源码生成的路由目录，仅展开可静态解析的 Fastify schema，不能当成覆盖全部业务校验的客户端生成契约。

## 地址与协议

| 入口 | 前缀与用途 |
|---|---|
| /admin/、/admin/status | 管理网页及其实例状态接口；独立于业务 API 前缀。见[后台使用](../operations/engine-admin.md) |
| /health、/meta、/metrics、/openapi.json | 根路径；健康、运行版本、指标、路由目录 |
| /api/v1/models | 模型配置、测试和能力管理；路由声明已经包含完整前缀 |
| /auth/user、/auth/account | 根路径；旧用户管理和当前账号接口 |
| /api/v1/chat | 对话及 admission、continuation、status、runs、snapshot、stream、cancel 子接口 |
| /api/v1 下的其他模块 | 会话、Agent、协作、记忆、知识、工具、插件、MCP、工作区、Git、终端、命令任务、设置、调度、浏览器等 |

完整路径由 [server.ts](../../src/api/http/server.ts) 决定，不要统一给所有接口加 /api/v1。/openapi.json 从运行 cwd 下 docs/docs/openapi.json 读取；精简打包部署未必携带该文件，可直接使用仓库构建产物。

## 身份与请求头

1. 部署设置 AETHER_INSTANCE_TOKEN 后，请求先通过 X-Aether-Instance-Token 实例门禁。健康/元信息探针、浏览器第三方回调和管理页固定的只读静态资源有明确例外；公开账号入口只免用户登录，不代表免实例令牌。
2. 业务身份优先验证 X-API-Key，其次验证 Authorization: Bearer。aether_session_ 前缀走可撤销账号 session，其他 Bearer 走 JWT。
3. tenantId 来自认证结果。X-Tenant-ID、请求体内的 userId/roles 不赋予身份或权限。设置、模型、技能管理等接口还有角色要求。
4. AUTH_ENABLED=false 允许未识别到支持凭据的请求成为 default 本地匿名身份。已识别的非空 X-API-Key 或精确 Bearer 前缀凭据验证失败仍拒绝；未知认证方案不会因此变成访问控制。账号管理、工作区授权和实例门禁仍各自生效，远端部署不要关闭用户认证。

X-Request-ID 与 X-Client-Version 可以提供，缺省时服务端补默认值，不是必须请求头。使用 JSON 请求体时才设置 Content-Type: application/json；空 GET/DELETE 不要附带一个虚假的空 JSON body。

个人主账号首次开通（含第三方首次开户）需要所在实例后台签发的单次开通码；子账号只能由其主账号创建。账号入口、刷新单飞与第三方流程见[账号机制](../account-login.md)、[第三方登录](../account-external-login.md)。独立服务 `POST /auth/user` 需要已验证的同租户管理员；只有桌面自管回环实例可在带有效实例令牌时首次登记空的默认租户。 子账号可以使用主账号设置的登录名和密码独立登录，或用自己保存的一次性密码恢复码找回。

管理入口 `/admin/` 及其静态资源允许匿名 GET/HEAD；`/admin/me`、`/admin/status`、`/admin/monitor` 和其他管理数据即使在 `AUTH_ENABLED=false` 时也要验证管理身份及已配置的实例令牌。普通 HTTP 客户端使用后台专用密钥（`X-Aether-Admin-Key`）或恢复管理员凭据。成员列表、角色、密钥、审计和监控规则按后台角色的权限逐项检查。使用默认租户的 JWT 管理时，签名载荷须明确包含 `tenantId: "default"` 和 `admin` 角色。

桌面已选身份按该身份在目标服务已有的后台权限授权。仅当桌面持有自己启动的回环引擎、未设置过个人账号且服务未强制业务认证时，独立管理窗口才可以临时使用「本机桌面管理员」；关窗、切换账号或引擎、停机后授权失效。退出或过期不会提升为本机管理员。普通 HTTP 客户端不能仅凭回环地址或实例令牌取得这份授权。详见[管理员指南](../operations/engine-admin.md)。

## 响应和错误

普通成功响应形如：

```json
{"code":200,"message":"操作成功","data":{},"timestamp":1794873600000}
```

同时判断 HTTP 状态和业务 code。认证、校验、冲突、网络及执行失败可能使用非 2xx 状态；错误体的 code/message 应保留用于诊断，不能假设 HTTP 总是 200。SSE、WebSocket、文件下载以及第三方浏览器回调不属于该 JSON 包装。

流连接可能在 HTTP 头已经成功发送后报告执行错误，因此“收到 200”不代表任务完成。轮询/重连应根据运行状态、终态事件和快照判断。

## 对话请求

POST /api/v1/chat 的主要字段如下；完整类型及实际解析见 [chat.ts](../../src/api/http/routes/chat.ts)，附件格式另见[多模态说明](../multimodal-design.md)。

| 字段 | 语义 |
|---|---|
| message、sessionId | 用户输入及所属会话；客户端应固定会话 ID 以便恢复 |
| agentId、systemPrompt、inlineAgent | 绑定 Agent 与请求级配置 |
| model、subagentModel、utilityModel | 主模型、子代理默认模型、轻任务模型 |
| modelProvider、modelBaseUrl、modelApiKey、capabilities | 请求级提供方/凭据/能力覆盖；不要把秘密写进 URL 或诊断日志 |
| thinkingMode | boolean 或 low/medium/high；是否有效由具体模型适配决定 |
| memoryScope | off/global/session；省略继承保存的会话策略 |
| toolkits | 根会话显式选择；省略继承、空数组清空 |
| workspacePaths、attachments | 授权工作区与附件；不能借路径跨租户读取 |
| skills、mcpServers、knowledgeBases、allowedTools | 请求资源选择；仍受当前注册与权限约束 |
| collaborators | 显式协作者，最多 8 个；research/executor/general、resumeRunId 等由结构化选择表达 |
| toolResponse | 带 toolCallId/name/output/requestId/runId 的交互答复，必须对应等待中的请求 |
| admission、continuation、clientCapabilities | 输入接纳、原轮继续及客户端协议；精确形状以源码契约为准 |

inlineSkills 只提供上下文能力说明，不等于安装可执行工具；其他 inline 资源也不能仅凭字段名推断完整挂载能力。请对照处理器及所需宿主接线。

| 请求头 | 当前缺省与含义 |
|---|---|
| X-Aether-Tool-Profile | general；可选 code，是工具协议差异，不是两套当前 UI |
| X-Aether-Run-Lifetime | durable；attached 将执行生命周期附着于连接 |
| X-Aether-Subagent-Protocol | 不传为 legacy 1；显式 2 才走 v2 子代理协议 |

## 运行、恢复与幂等

durable 模式关闭页面或断开观察连接不等于停止运行；用户停止应调用 POST /api/v1/chat/cancel。重连用 GET /api/v1/chat/stream?sessionId=...&lastEventId=...，先恢复快照再回放。游标过期或没有可回放流返回 HTTP 409 / 40902 snapshot_required，应读取 GET /api/v1/chat/snapshot，而不是重新 POST 用户输入。

用户主动停止时，`POST /api/v1/chat/cancel` 与原来的 `POST /api/v1/chat` 是两个请求。取消请求带 `sessionId`，已知目标时可再传 `runId` 只停止那一次运行。取消接口返回 `200` 时仍要看 `data.cancelled` 和 `data.settled`：没有匹配的活动任务时两者都是 `false`。

如果用户在模型或工具开始执行前点停止，**原对话请求**可能有两种回执：

| 接纳进度 | 原对话请求返回 | 客户端如何处理 |
|---|---|---|
| 尚未创建本次运行记录 | HTTP `499`，JSON `code: 49900`、`data: null` | 结束该请求的等待状态。没有本次 `runId` 可展示，不要附会上一次运行或自动重发。 |
| 本次运行已落库，用户停止且该次尝试的取消状态已确认 | HTTP `200`、`text/event-stream`；`run.status: "cancelled"` 的状态帧，随后是 `[DONE]` | 以 `sessionId`、`runId` 和 `attemptId` 匹配当前尝试；本次没有启动模型或执行获批工具，不生成助手答复，也不回放上一轮输出。 |

持久化出错或回执无法确认时，不应推断为用户主动取消；保留错误，必要时查询接纳收据和运行快照。已经开始执行的运行沿用正常流式停止流程，停止也不会撤销先前已经完成的操作。

当前接纳协议提供 /chat/admission/context、/chat/admission/receipt 与 /chat/continuation/receipt。requestKey、规范化 bodyDigest、namespace/generation 及前驱 run/attempt/version 共同约束重复提交和续跑。不要自行将普通 JSON.stringify 的哈希当成协议 digest；复用 [root-admission](../../src/storage/root-admission/) 中的 canonicalAdmissionBody 和 continuation 契约。

snapshot 中的显示投影与正在执行的状态可以分别返回；不能拿最新执行状态覆盖旧水位投影。子代理 v2 的摘要、水位和历史恢复要使用同一协议，不能把 v1 数据改一个版本号混用。详细客户端状态流程见[集成指南](third-party-integration.md)。

## 文件、撤回与管理

### 命令历史与输出

`GET /api/v1/command-jobs/:jobId/output?sessionId=...` 读取已存在命令，不启动进程。默认从 `cursor=0` 读取；日志面板首次只需近期内容时用 `tail=true&maxBytes=65536` 获取有界尾页。`tail` 只接受 `true`/`false`，`tail=true` 不可与 `cursor` 或 `cursorOffset` 同传，显式 0 也不能混用。尾页响应增加 `tail: true`，旧日志仍可从 0 读取，不因选择尾页而标为已丢失。后续增量请求把 `nextCursor`、`nextOffset` 原样传为 `cursor`、`cursorOffset`；偏移按 UTF-8 字节计数并保持字符边界。`maxBytes` 范围为 4–65536，默认 65536；所有请求仍校验租户和会话归属。

`POST /api/v1/command-jobs/:jobId/restart` 只接受已结束的后台任务作为原命令来源，请求体只使用 `sessionId`。手动重启是一次新启动，重新经过当前命令策略、工作区限制、环境投影与文件变化观察，并复用 `execute_cmd` 已支持的源码保护；原任务命令和参数、旧批准都不是新授权。请求体额外提供的 command/args/env/approval 字段不会改变执行内容或批准状态。允许启动时返回新的 jobId，不继承旧 run/turn/toolCall 身份；真实启动失败仍可返回失败任务快照，须检查状态和退出码。

策略或工作区拒绝返回 HTTP 403 / code 40300；需要重新确认、后台构建保护或当前任务不可重启返回 HTTP 409 / code 40900，`metadata.code` 区分具体原因。界面应显示服务端 message，不能自动确认或重新提交绕过。需要批准的命令请回到当前会话重新执行并完成正常确认；运行中任务不能通过重启端点再次启动。刷新列表、读取日志和引擎启动恢复都不会重跑历史命令。

工作区 API 的路径由服务端授权；文件上传使用 multipart，下载按响应 MIME 处理。工作区绑定改变后，刷新会话/工作区相关状态，不复用旧目录结果。历史回退、单个文件回退、撤回整轮成果是不同操作，不能在前端只删除消息或缓存来模拟成功；以服务端持久操作结果和后续快照为准。

权限模式不选择命令运行时。远程鉴权实例的 restricted-files/docker/host 边界见[安全架构](../security-architecture.md)。插件开发走[公开 HTML SDK](../../../aether-code/docs/plugin-api/dist/index.html)，不要把这里的内部宿主端点当插件稳定 API。
