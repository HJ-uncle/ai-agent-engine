# 会话存储调研：API、身份、生命周期与控制台

审计日期：2026-11-05。对象为当前工作树，不代表所有结论均已发布。只读调研产品代码；测试使用合成数据和临时数据库；未读取真实凭据、数据库或用户聊天内容。以下路径均相对 `D:/dev/ai-agent-engine/`。`事实` 表示已由实现直接确认；`推断` 表示尚未做专门故障注入或端到端复现。

## 1. 会话不是 sessions 表中的单一实体

| 名称 | 实际职责 | 身份/证据 |
|---|---|---|
| `sessionId` | 长期交互、历史、工作区等资源的逻辑容器 | 请求提供，`/chat` 未提供时生成 UUID；`src/api/http/routes/chat.ts:659` |
| `tenantId` | 请求数据隔离单元 | 由受信任的 `authContext` 获取；`src/api/http/routes/chat.ts:789` |
| `userId` | 鉴权主体标识 | `AuthContext` 有此字段，但会话历史路由只使用 tenantId；`src/auth/types.ts:1`、`src/api/http/routes/conversation.ts:23` |
| `sessions` 表 | 会话第一次选择的 Agent 与初始 metadata | 复合主键 `(session_id, tenant_id)`；不包含完整会话状态/标题/最后消息；`src/storage/sqlite/migrations/009_add_sessions.ts:12` |
| `conversationId` / `turnId` | 一轮请求的分组标识 | root run 的 turnId 回写 context；`src/api/http/routes/chat.ts:1481` |
| `messageId` | 用户、助手、工具行的标识 | 轮次与消息可分别查询/删除；`src/api/http/routes/conversation.ts:301` |
| `runId` / `attemptId` | 执行实例与执行尝试 | pending 回答要求匹配运行、请求、工具；`src/api/http/routes/chat.ts:721` |
| 鉴权 session | 账号登录态，和聊天会话是不同概念 | `AuthContext.sessionId` 属账号会话，聊天 sessionId 仍取请求参数；`src/auth/types.ts:5`、`src/auth/accounts.ts:158` |

**事实：** 会话列表从 `history.listSessions(tenantId)` 生成，未从 `sessions` 表查询（`src/api/http/routes/conversation.ts:143`）。所以“列表可见”“存在 Agent 绑定”“有执行记录”“有私有工作目录”是四个独立事实。清空历史后 Agent 仍锁定，但列表可能不再列出该会话；从未发言的前端新会话只是本地状态。

## 2. 身份与安全边界

### 2.1 认证模式

- 认证代码默认 `AUTH_ENABLED !== 'false'`，匿名请求被拒绝；仅显式关闭认证才进入 `default` 租户。启动时冻结判定，后续设置写入不能切换既有服务的边界（`src/auth/middleware.ts:10`、`:32`）。
- **部署默认不同：** `docker-compose.yml:15` 显式使用 `${AUTH_ENABLED:-false}`。因此不能以代码默认值推断 Compose 实例已开启认证。
- API Key 优先于 Bearer，API Key 的 SHA-256 与 users 表匹配；返回该用户 tenantId、userId，当前模型把该 Key 视为 admin（`src/auth/middleware.ts:19`、`:40`）。JWT 租户取 `payload.tenantId ?? payload.sub ?? 'default'`（`:63`）。
- 账号注册创建独立的 `account_<UUID>` 租户（`src/auth/accounts.ts:110`）；鉴权 session 解析回同一租户（`:158`）。这解释了当前“一用户一租户”的设计假设。
- 实例令牌门禁先于业务登录状态和 `AUTH_ENABLED`，白名单不能绕过已配置实例门禁（`src/api/http/middleware.ts:105`）。
- `/auth/user` 已非任意匿名用户同步入口：只允许当前租户 admin，或关闭认证时为 `default` 做本地 bootstrap；禁止跨租户管理（`src/api/http/routes/auth.ts:54`）。README 中的旧说明不能作为当前行为依据。

### 2.2 隔离单位是 tenant，不是 tenant + user

**事实：** conversation/session 路由只提取 tenantId，不检查 session owner、userId 或会话级 ACL。`metadata.userId` 是业务透传内容，不是访问控制条件。创建绑定时保存 metadata，后续忽略新 metadata 的绑定更新（`src/storage/session/index.ts:45`、`src/api/http/routes/chat.ts:812`）。

**影响：** 当前“一用户一租户”时符合预期；若未来同 tenant 下放入多个真实用户，他们默认共享该租户的全部历史读取和删除权限。此结论不等于跨租户越权。要支持团队私有会话，必须显式增加 owner/member ACL，而不能依赖客户端隐藏列表或 metadata。

**路径防护事实：** `WorkspaceManager.validateId` 限制长度、路径分隔符、控制字符、Windows 保留设备名等（`src/workspace/manager.ts:165`）。但 HTTP 各入口 schema 不统一：chat 的 sessionId 仅声明 string（`src/api/http/routes/chat.ts:607`），admission 接口上限 256（`src/api/http/routes/chat-admission.ts:17`），工作区 ID 上限 128。不同入口可能接受随后无法用于工作区的 ID，需统一契约，而不是把所有 storage selector 都当成安全文件路径。

## 3. 创建、首次绑定和运行受理

流程：客户端生成或服务端补 sessionId → 解析记忆设置 → 读取/首次写入 Agent 绑定 → 解析模型和资源 → durable root admission → 持久化消息和执行过程 → 对外流式发布。

`SessionStore.getBinding()` 的三种值有不同含义：

| 返回 | 含义 |
|---|---|
| `undefined` | 尚无绑定记录，可以首次绑定 |
| `{ agentId: null }` | 已绑定为裸会话，后续也不能切换 Agent |
| `{ agentId: '...' }` | 锁定该 Agent；若请求携带不同 Agent，服务端警告并使用原 Agent |

证据：`src/storage/session/index.ts:17`、`src/api/http/routes/sessions.ts:24`、`src/api/http/routes/chat.ts:807`。Agent 已被删除时 binding 接口仍返回 started=true，agent详情可能 null（`src/api/http/routes/sessions.ts:36`）；chat 找不到 Agent 则回退默认配置（`src/api/http/routes/chat.ts:836`）。因此持久化的 agentId 并不是完整 Agent 配置快照。

**推断：首次并发绑定存在窗口。** 实现先 SELECT，再 `INSERT OR IGNORE`，插入后不重读获胜绑定（`src/storage/session/index.ts:45`、`src/api/http/routes/chat.ts:812`）。两个首次请求若同时读到 undefined，各自可能继续使用自己选择的 Agent，即使数据库只保存其中一个。后续 root admission 能限制执行，但在此之前已经发生绑定/配置决定；尚未专门注入并发首请求验证实际执行结果。应让首次绑定返回最终获胜值，并把绑定决定纳入受理事务。

**事实：绑定早于最终受理。** 首次模型解析、权限、执行受理等后续步骤失败，也可能留下“已开始”的绑定。UI 的 `started` 实际表示绑定记录存在，不保证已经产生一条消息。

## 4. 对外读取并非一个接口的一种视图

| 接口（省略 `/api/v1`） | 数据语义 | 关键边界 |
|---|---|---|
| `GET /conversation/sessions` | 后端可见会话汇总 | 整体 listSessions 后内存分页；`:143` |
| `GET /sessions/:id/binding` | Agent 绑定与初始metadata | 不存在也 HTTP 200、started=false；`sessions.ts:20` |
| `GET /conversation/history` | 当前可用历史投影 | 读取后附加子代理、command job、usage、runs；`:152` |
| `GET /conversation/archive` | 显式查看压缩前的可用归档 | 后端能力不同；分页参数可下推 getArchive；`:182` |
| `GET /conversations/:conversationId` | 同一租户内某轮次的消息 | 不要求 sessionId，未做公共投影过滤；`:283` |
| `GET /chat/snapshot` | UI 恢复所需的组合快照 | history + run + todos + changes + jobs + subagents + usage，分 live/persisted；`chat.ts:1901` |
| `GET /chat/runs` | durable 运行记录 | 从 rootRunStore 读取；`chat.ts:2087` |
| `GET /chat/status` | 轻量状态 | 检查最新 durable run 与当前 StreamBus 是否对应；`chat.ts:2093` |
| `GET /chat/stream` | 有界 SSE 续读 | bus不存在、游标过期/不匹配则 409 snapshot_required；`chat.ts:2121` |
| `GET /chat/admission/context` | 幂等受理命名空间和前驱 | 当前身份由鉴权决定，拒绝任意 query 字段；`chat-admission.ts:16` |
| `POST /chat/admission/receipt` | 查询某请求是否已受理及用户/助手投影状态 | requestKey + bodyDigest + namespace；`chat-admission.ts:25` |

此表中的 `:行号` 默认指 `src/api/http/routes/conversation.ts`，其他简写文件均位于同目录。

### 4.1 GET 也可能产生内部写入

history/archive 会先 `projectPendingSubagents(history, tenantId)`；snapshot 会 `projectTerminalAdmissionUsers`。因此读取路径会补齐持久化投影，不是严格意义的只读 SQL。证据：`conversation.ts:158`、`:202`，`chat.ts:2030`。为实现快照或列表而频繁轮询时，需要考虑补投影工作、锁竞争和错误行为。

### 4.2 历史展示与原始模型输入分离，但有接口不一致

`publicHistoryMessages` 仅剔除 `modelInputContent`，其余字段原样返回（`src/api/http/history-projection.ts:3`）。history、archive、snapshot 使用此函数。

**事实：** `/conversations/:conversationId` 直接 `paginateArray(messages)`，不经过此过滤（`src/api/http/routes/conversation.ts:292`）。JSONL 的 `getByConversationId` 直接返回当前投影中的消息对象（`src/storage/conversation/jsonl-history.ts:1491`），这些对象可含 modelInputContent（同文件 `:615`）。因此至少 JSONL 路径存在公共返回口径不一致，可能向 UI 输出本来仅供 provider 重放/search_history 的完整内容。不是未授权用户泄露，但扩大了已授权接口的内容/体积边界。SQLite 查询本身不显式选择 modelInputContent列，需按实际 rowToMessage/metadata编码判断，不能泛化为两后端同样暴露。

`getByConversationId` 还会扫描租户内全部 JSONL 文件、只查当前投影（`:1495`）；历史轮次被 summary 覆盖后，归档仍存在也不保证该接口能找回它。旧数据若跨 session 复用同一 conversationId，同租户结果可合并多个 session；该行为不同于新的 session 验证删除接口。

### 4.3 status 的 finished 不等于业务成功

无匹配 StreamBus 时，`/chat/status` 返回 `running:false, finished:Boolean(run), run`（`chat.ts:2108`）；持久化 snapshot 返回 `finished:true` 并附 run（`:2072`）。因此 waiting/cancelled/interrupted 都需查看 `run.status`，客户端不能只根据 finished 把任务标成成功。

live snapshot 特意把“已发布前缀的 run/projection”与实际执行进度 `executionRun` 分开（`chat.ts:2064`）。数据库已经更进一步，不代表客户端已收到那些事件；计费也按已发布 watermark 校正。现代 child recovery 有额外协商与注册开关，是否开启需以主报告的生产注册链分析为准。

## 5. 删除、清空、截断与一致性

新的 conversation 修改入口通过 `mutateHistory`：取得 mutation lease → 锁内验证目标 → invalidate generation/abort → 锁外等待 root、child、command job停止 → 再进锁重读目标 → 再 invalidate → 实际删除。证据：`src/api/http/routes/conversation.ts:108`。它解决旧 producer 回写、子代理结算死锁、目标快照过期、新 root 趁删除空隙受理等问题。

| 操作 | 明确清理 | 明确保留或未在该路由处理 |
|---|---|---|
| 清空历史 | 父历史、直接子运行历史及子运行记录、root turns | Agent绑定、私有工作区；`:234` |
| 硬删 session | 上述全部 + Agent绑定 + 默认删除私有工作区 | `keepWorkspace=true` 时留工作区；未显式清理记忆、todo、changes、工作区binding、审批审计等；`:251` |
| 删一轮 | session内验证该轮所有行、相应子记录、root turn | 其他轮次；`:301` |
| 删单条 | 目标消息、关联子记录，同时删除该消息所在整个 root turn记录 | 同轮其他消息可能保留，需调用者处理 tool配对；`:321` |
| 截断 | 目标消息及之后消息、相应子运行、目标及之后/被中断root记录 | 截断点以前消息；`:340` |

**事实：硬删除不会通过 getPath 删除用户绑定的外部项目根。** `WorkspaceManager.getPath` 固定返回私有 `root/tenant/session`（`src/workspace/manager.ts:182`）；绑定项目目录从另一函数 `getWorkingDirectory` 读取（`:193`）。已专门核对此点，排除了初步怀疑。

**事实：清理不等于彻底数据擦除。** 此路由没有统一跨表/跨文件级 cascade；`rootRunStore.deleteTurns` 只显式 DELETE root_runs（`src/storage/root-runs/index.ts:456`）。其他关联资源的独立保留/清理策略应见生态分报告。调用硬删除不能宣称删除了“所有与会话有关的数据”。

**推断：中途失败可能形成部分删除。** history.clear、child清理、root删除、binding删除、文件系统删除是顺序 await，不是一个覆盖全介质的事务。工作区 rm 错误仅记录日志，API仍返回 success（`conversation.ts:269`）。客户端无法从成功响应区分私有目录是否真正删除；需要删除收据或可重试的清理作业。

### 5.1 旧 messages API 是另一条语义较弱的修改链路

`DELETE /messages/:messageId` 会按消息所属 conversationId 删除整轮；找不到消息时把参数当 conversationId再删一轮，最后仍幂等成功（`src/api/http/routes/messages.ts:75`）。它没有上面的 `mutateHistory`、停止root、取消child、generation失效步骤。

Code tool profile 被拒绝并要求使用新接口（同文件 `:84`），但 general profile仍可走旧链路。**推断：** general会话正在写入时可能发生删除后回写/执行记录残留；同租户跨session重复conversationId时，旧按轮删除范围也较广。内置旧console仍调用这个旧消息删除接口（`multi-agent-console/src/core/api/index.ts:155`），不能只因新接口有并发保护就认为所有删除入口均已统一。

**默认JSONL兼容缺口：** 旧编辑/重生成首先通过history查消息，然后直接 `SELECT session_id FROM conversations`（`messages.ts:381`、`:428`）。如果消息仅存在JSONL、SQLite没有对应旧行，就返回 `Session not found for message`；后端接口抽象在这里被绕过。重生成还有直接DELETE conversations的分支（`:439`），无法同步移除JSONL里的同轮中间消息。Code profile在入口拒绝这两路（`:361`、`:408`），因此主要影响仍使用旧API的general客户端。需要后端统一返回消息所属session，并统一通过history进行更新和删除，不能只修改客户端提示。

## 6. 工作区改名与会话改名是明显的割裂点

`POST /workspace/rename`：先 renameSync 私有目录，再独立 UPDATE `conversations.session_id`、`memories.session_id`，最后 success。没有迁移 JSONL 文件、sessions绑定、root/subagent记录、其他会话作用域数据，也没有跨文件/SQL事务、mutation lease或运行取消。证据：`src/api/http/routes/workspace.ts:315`。

- **JSONL模式事实：** 主历史文件未搬到新 sessionId；前端却 `renameSessionId(oldId,newId)`（`multi-agent-console/src/web/components/explorer/index.tsx:131`）。新session可以看不到旧历史，原历史仍以旧ID存在；这不是字面“标题改名”。
- **SQLite模式事实：** conversations被迁移但绑定和运行记录没有迁移，形成新ID有消息、旧ID有执行/Agent关联的拆分。
- **故障推断：** 目录改名成功后任一 UPDATE失败，会返回失败但已搬目录，且无回滚。运行期间改名也可能使旧producer继续写旧作用域。
- **另一个旧查询：** `/workspace/recent` 的 `hasSession` 只 SELECT conversations，不能可靠反映 JSONL会话存在；`src/api/http/routes/workspace.ts:147`。

建议 sessionId 永久不变，标题与 workspace display name独立保存；若保留迁移操作，则必须用完整资源清单、暂停执行、事务/日志与可恢复步骤实现。

## 7. 控制台的“会话存储”边界

此节只覆盖仓库内 `multi-agent-console`；不代表独立 `aether-code` 客户端。

### 7.1 localStorage 和内存各存什么

Zustand persist键固定为 `mac-session-store`，保存 sessions、activeSessionId、usageMap、maxAskUserCount、thinkingMode；**不保存 messageMap 和 runningSessions**（`multi-agent-console/src/core/store/session.ts:357`）。未显式指定storage时使用Zustand默认localStorage。

- 新建会话只生成前端ID、默认标题、createdAt和内存空消息，没有发服务端创建API（同文件 `:85`、`:144`）。
- 手工改标题只修改本地 sessions，不调用服务端（`multi-agent-console/src/web/components/SessionList.tsx:105`）。换浏览器、清站点缓存后无法恢复手工标题。
- 本地 sessions含 lastMessage预览及会话选项（session.ts `:248`），所以“不持久化 messageMap”并不等于浏览器完全不保留聊天内容。
- 草稿 chatInputValues虽在内存，partialize没有保存它（`:359`）；刷新后不能以当前实现保证草稿恢复。
- `usageMap` 本地累计，但重新读历史时会被服务器的 sessionUsage解析结果覆盖（`multi-agent-console/src/web/hooks/useChat.ts:371`）。

### 7.2 多设备与身份切换

启动时仅把远端不存在于本地的 session补入；不会移除远端已删除的本地条目，也不会刷新既有条目的自定义标题。远端返回空数组直接return（`multi-agent-console/src/web/App.tsx:261`，移动端同逻辑 `src/mobile/App.tsx:24`）。

**推断：** 同设备切换API凭据时，固定localStorage键没有 tenant/server命名空间，旧会话标题、预览、usage会继续显示；若同名sessionId出现在新身份，也可能被本地缓存合并误认。此为UI缓存/隐私边界问题，不意味着服务端跨租户数据读取成功。需要以 `serverIdentity + authenticatedTenant + sessionId` 分区，并在身份切换时清理内存流与游标。

### 7.3 刷新恢复能力落后于服务端

游标写入 `sessionStorage['sse_last_'+sid]`（`useChat.ts:103`）。但 resume既要求游标，也要求当前messageMap中存在 streaming助手行（`:392`）；页面初始化已经不持久化messageMap，ChatArea只有“streaming行 + 游标”时才resume（`ChatArea.tsx:2388`）。

**代码路径推断：** 整页刷新后通常只有游标、没有streaming行，走 getHistory而非服务端snapshot/status恢复。服务端已经具备更完整恢复API，并不表示该旧console实现了等价恢复。切会话时仍在内存的活跃流会用 runningSessions保护，避免历史请求覆盖流式内容（`useChat.ts:357`）。

### 7.4 导出不是完整备份

`getSessionMessages` 优先返回内存缓存，否则请求 `/conversation/history`；不请求archive（`multi-agent-console/src/web/utils/sessionExport.ts:17`）。导出仅由展示消息转换成Markdown，再浏览器Blob下载（`:171`）；按轮导出是按用户消息切分并收集assistant，过滤system（`:158`）。

所以压缩后旧原文、二进制附件、存储原始事件、子代理完整轨迹、运行配置、授权状态等不能从此Markdown可靠恢复。即使函数注释称“完整对话”，其实际完整性只到当前展示投影。需要明确区分“阅读导出”和“可恢复备份”。

## 8. SDK 契约

`sdk/client.ts:928` 的 conversation namespace提供 getSessions/getHistory/clearHistory/getConversation；sessions namespace提供 getBinding/delete（`:969`）。这一层没有 archive/snapshot/runs/truncate等同等级方法，具体上层调用可能自行fetch；不能假定SDK已封装完整服务端能力。

`getSessions` 声明 `firstMessageAt/lastMessageAt` 字符串（`:932`），而console和存储使用 lastAt等字段；类型与实际payload口径有漂移。**已确认**这些方法使用的通用fetch默认解包路径只返回 `sr.data`（`sdk/client.ts:744`）；虽有 `opts.raw` 旁路（`:736`），这组方法未使用。因此这组接口会丢弃HTTP响应的pagination和metadata，getHistory无法直接取得sessionUsage/runs等恢复信息。应提供一致的分页Envelope与SessionSummary，并进行跨后端契约测试。

## 9. 本轮验证与可信度

执行：`npx vitest run src/api/http/routes/__tests__/conversation-destructive.test.ts src/api/http/routes/__tests__/chat-recovery.test.ts src/auth/__tests__/boundary.test.ts src/api/http/__tests__/history-projection.test.ts --maxWorkers=1 --minWorkers=1`

结果：**4文件、37测试全部通过，11.24秒**。其中 recovery 22项，destructive 12项，auth boundary 2项，history projection 1项。覆盖真实HTTP快照与续流、错误游标、身份隔离、waiting恢复、删除后不重放旧流、压缩后计费、子代理精确watermark、修改lease与无效目标等。

测试基础设施 `vitest.setup.ts:7` 在测试模块导入前重定向DATA_DIR、WORKSPACE_ROOT、MEMORY_DB_PATH；被执行文件也建立独立临时fixture。未启动真实模型推理或读取真实会话。测试通过不证明所有本文推断已复现：首次绑定竞态、workspace rename完整迁移、多设备缓存、旧messages并发删除，仍应增加专门的验证。

## 10. 优先级建议

| 优先级 | 建议 | 原因 |
|---|---|---|
| 高 | 废弃“workspace改名=迁移sessionId”，或补完整可恢复迁移 | 默认JSONL历史与大量关联状态未迁移，身份易割裂 |
| 高 | 所有消息删除/重生成入口统一执行租约与generation边界 | 新旧路由并存，general仍走较弱链路 |
| 高 | 定义硬删除资源清单与可核验删除结果 | 现有success无法证明目录删除，且不代表所有关联数据清理 |
| 中 | 公共消息出口统一projection | `/conversations/:id` 与 history/archive/snapshot不一致 |
| 中 | 首次Agent绑定原子返回最终值，避免提前“已开始” | INSERT OR IGNORE不能保证本地配置就是获胜绑定 |
| 中 | console存储按server+tenant分区并用snapshot恢复 | 换账号残留、刷新恢复、删除同步存在口径缺口 |
| 中 | 单独提供原始archive导出/恢复清单 | 展示Markdown不能承担备份职责 |
| 中 | 若引入团队租户，增加session ACL | 当前tenant即访问控制边界，不按userId隔离 |
| 低 | 对齐SDK类型、ID校验、HTTP状态码与分页契约 | 部分校验错误用HTTP200业务码，客户端需额外适配 |
