# 子代理重启续用与调度调研

日期：2026-11-06。范围：Aether 引擎、Aether Work 前端、Wuzu Code、用户提供的 Codex 桌面打包产物。此轮是只读调查与隔离验证，没有修改产品代码、重启用户应用或清理会话数据。

## 结论

Aether 已有持久化子会话与显式续跑能力，核心缺口是普通父会话「继续」时的发现与编排。引擎重启会终止当前执行并保留历史；模型收到中断结果后，没有得到足够清楚的恢复指引，转而自行执行或重新派发。相同标题不能保证复用同一个子代理。

配置 Agent 使用率还涉及另一条链：是否允许委派、是否能发现已配置 Agent、是否选择正确身份、是否具备适合并行的工作。必须分别检查，不能用增加并发数或反复强调「多用子代理」替代。

## 1. 用户记录中的真实顺序

来源：用户附件 `C:/Users/wb.xielin02/.codex/attachments/4534ad57-6ee7-4dbe-b873-209267254b10/已粘贴的文本.txt`。

1. 第 1591、1600、1609 行：三次子代理调用明确得到 `status=interrupted / stopReason=engine_restarted / errorCode=ENGINE_RESTARTED`，runId 分别为 `4b3fe28a-db2e-4e6e-bf47-dd5921e81402`、`9e488a1d-6012-481b-b44a-7a341cc6d499`、`c6c61ad5-de88-49e3-9c14-36f8909b1d53`。
2. 第 1618 行用户要求「继续」。主 Agent 随后把一次重启解释为子代理不可靠，决定改由主会话执行。记录没有证明子代理能力本身不可用。
3. 第 1859 行用户再次说明「可以使用 子代理的」。之后出现新派发，未选择旧 `resumeRunId`。
4. 截图显示三个中断记录和四个成功记录，符合重复创建子会话的表现。前端本来按 `childSessionId` 聚合，正常续跑会成为同一代理中的另一轮。

证据边界：对本机两个已知数据库路径的只读查询均未命中这三个 runId。因此本报告不声称已验证它们各自的 `continuation` 完整性，也不提供这些真实任务占用空间的估算。截图和导出证明了中断与重新派发的过程；具体数据文件归属仍需运行实例的权威诊断定位。

## 2. Aether 已有的能力及缺口

### 2.1 身份与执行分开

| 字段 | 含义 | 正确续跑行为 |
|---|---|---|
| `agentId` | 可选的用户配置 Agent 定义 | 保留角色配置；不等于运行身份 |
| `childSessionId` | 子代理历史上下文身份 | 保持不变 |
| `runId` | 一次执行 | 生成新值，旧尝试保持真实终态 |
| `resumeFromRunId` | 本次接续的旧执行 | 指向被接续记录 |
| `parentSessionId/rootSessionId` | 父会话归属与授权范围 | 必须匹配 |
| `parentConversationId/rootRunId` | 当前父轮次与执行 | 新一轮可以变化 |

`src/core/subagent/store.ts:424` 和 `:586` 在事务中验证恢复归属、保存权限及并发状态，并复用旧 `childSessionId`。`src/tools/subagent/subagent-tool.ts:164` 读取原记录及执行配置，`:284` 使用同一个子会话身份创建上下文，`:290` 从持久历史后端继续。

因此「新 runId」本身正确；造成上下文浪费的是没有 `resumeFromRunId` 关联而新建了 `childSessionId`。

### 2.2 重启中断与显式续跑

`src/core/subagent/store.ts:873` 的 `recoverInterrupted()` 把 queued/running/cancelling 标为 interrupted，并把未完成工具标为取消。启动注册调用见 `src/api/http/server.ts:76`。中断结果通过持久投影回到父会话。

这保留了事实：进程已经停止，最后工具的外部副作用可能尚未确认。恢复同一历史上下文不等于从原程序指令位置复活，也不等于无条件重放最后一次工具操作。

`src/core/subagent/types.ts:239` 将 interrupted 与 succeeded/failed/cancelled/blocked 一同视为终态，允许后续显式创建续跑尝试。恢复仍须有保存的权限配置、有效父归属和工作区范围，不能并发续跑同一个 child。

### 2.3 模型得到的信息不完整

- `src/tools/subagent/subagent-tool.ts:133` 的参数说明只写「继续已完成子代理」，没有说明中断/失败后的上下文接续。
- `src/core/subagent/types.ts:245` 的 `outcomeText()` 输出当前失败状态，却不输出「历史保留、可否继续、如何继续」的结构化线索。
- `src/api/http/routes/chat.ts:1660` 的复用提示仅在本次显式选择 collaborators 时加入。普通自然语言继续没有同等入口。
- `src/tools/subagent/async-tools.ts:83` 的 participants 查询范围是当前 root 执行，不能代替当前父会话跨轮、跨重启的子代理目录。
- `src/core/subagent/runner.ts:141` 的 waitOwned 等待当前执行拥有的内存 join。旧 run 已中断，没有仍可等待的旧进程；应发现旧记录并开始续跑，而非再次等待旧句柄完成。

### 2.4 前端已经能正确续跑，入口较深

- `D:/dev/aether-code/src/renderer/src/contrib/work/work-subagents.ts:175` 按 `childSessionId` 聚合同一子代理的多轮工作。
- `D:/dev/aether-code/src/renderer/src/contrib/work/WorkSubagentsPanel.tsx:277` 的详情继续使用原 run 身份；终态记录有 continuation 时才显示「安排下一步」。
- `D:/dev/aether-code/src/renderer/src/contrib/work/work-runtime.ts:918` 发送结构化 `collaborators: [{ resumeRunId: current.runId }]`，服务端确定性接续，不仅依赖一段自然语言。

前端不需要重建会话协议或按标题合并记录。应让可恢复中断记录的继续入口更容易发现，显示「中断，历史保留」及不可恢复的具体原因；保持现有 macOS 极简布局，不把身份字段暴露成普通用户操作步骤。

## 3. 为什么配置 Agent 使用率低

必须区分两个现象：主 Agent 很少委派，以及委派时很少选用用户配置的专长 Agent。

| 环节 | 当前证据 | 影响 |
|---|---|---|
| 执行权限 | `chat.ts:848–852` 读取 Agent allowedTools；空数组明确禁用全部业务工具，注册器按实际名单过滤 | 没有 subagent/subagent_start 的主 Agent 无法通过提示词获得委派能力 |
| 发现配置 Agent | `src/tools/tool-exposure.ts:8` 默认关闭 agent_list/agent_get | 普通会话不会自动看到用户配置的专长目录 |
| Code 工具范围 | `src/tools/tool-profile.ts` 排除 agent_* 服务工具 | Code 有通用子代理，不代表能自主枚举已配置 Agent |
| 精确身份 | `subagent-tool.ts:132` 要求 agentId 来自明确选择或真实发现 | 模型不应猜测 Agent ID；目录不可见会降低自主选用率 |
| 默认委派 | `chat.ts:59` 默认说明偏重调查，明确把写/改代码留给主会话 | 实现、验证等可分工场景受到较强抑制 |
| 显式 @Agent | collaborators 服务端预执行并注入真实结果 | 明确选择比完全交给模型挑选更确定 |
| general 模式 OSM off | `src/core/osm.ts:258` 收窄到核心工具集合 | 还可能移除委派能力；Code 的工具选择独立于此设置 |
| 子代理递归 | 子代理不具备再次创建子代理的工具 | 专长 Agent 作为 child 时不能继续派生；不能解释成主 Agent 配置无效 |

建议将「允许委派」「主动委派偏好」「可用专长 Agent 目录」「并发上限」分成不同概念。只增加并发上限不会提高模型选择概率；也不能为了提高利用率绕过已有工具白名单。

没有对用户当前真实 Agent 配置作归因：本次已知数据库未匹配截图任务，具体哪一个 Agent 未授权哪些工具需要从同一运行实例核实。

两个补充边界：

- 空 allowedTools 仍保留可信内建 plan_update；当前前端新建 Agent 表单默认选择引擎默认工具，并防止工具目录未加载时保存（`D:/dev/aether-code/src/renderer/src/contrib/work/WorkAgentManager.tsx:311`、`:464`）。不能由存储默认值推断用户当前配置为空。
- `src/tools/agent/agent-tool.ts:64` 的发现工具会返回客户端 inlineAgents，但 `subagent-tool.ts:171` 的自主 agentId 执行只查当前租户 SQLite。客户端独有配置可能可发现却不可启动；当前前端通过 `/agents` 保存的配置不属于这一情况。这是另外的协议缺口，未认定为截图的直接原因。

## 4. Wuzu Code 实际如何做

参考仓库只读，没有运行、构建或修改。

- `D:/web/wuzu-client/src/main/engine/cliProvider/SdkClaudeProvider.ts:1823` 从 SQLite 重建父会话配置；`:1865` 判断原 native session 与转录是否存在；`:3295` 传 `options.resume`。
- `.../claudeSessionRecovery.ts:7` 在原转录缺失时改为新会话，只有显式 fork 才走 fork。
- 原生 Agent/Task 创建子代理；`SdkClaudeProvider.ts:5089` 识别 `SendMessage({to:旧句柄,message})` 接续，并保留 taskId。显示名称不负责定位身份。
- 当前安装 Claude Agent SDK 0.3.309 的 `sdk.d.ts:6280` 明确：resume 保留 task_id，但新的运行生成 run_id；worker_restart 的孤儿任务报告 stopped。
- `SdkClaudeProvider.ts:1501` 的 sessionSubagentTypes 只在内存保存，未发现启动历史回填；`:4874` 适配没有传递 SDK run_id/reason，stopped 被统一映射为 killed。
- `.../history/claudeCliDb.ts:436` 持久化主要为 taskId 与 token/tool/duration 统计，不是独立持久执行队列。
- `.../history/transcriptParseCore.ts:193` 从历史 tool_result 的 agentId 尾注找回句柄；SDK尾注直接提示可用 SendMessage 继续。这是值得借鉴的模型可见恢复线索。
- 前端 `CliSubagentCard.vue:9` 只有停止与详情。父继续按钮最终发父 sessionId 和「请继续上一次未完成的输出，从中断处接着写。」（`utils/hiddenContinueResume.ts:21`），没有自动携带待恢复 child 清单。
- `agentTeamPrompts.ts:80` 鼓励主动创建 Explore/general-purpose，但没有续用优先规则。

结论：Wuzu 的父会话恢复与 SDK 稳定 child 句柄可借鉴。它没有提供「父会话点继续必然恢复原 child」的应用层保证，未找到对应跨重启执行端到端测试。卡片重新出现只证明历史展示恢复。

还需实测的边界：Wuzu 禁用后台子任务并强制同步，SDK却说明 resumed subagent 按后台注册。不能把 SDK 能力直接等同于 Wuzu 已完整集成。

## 5. Codex 本地打包代码实际证明了什么

产物版本：`E:/rea/codex-src/package.json` 为 26.1007.21434、build 13901。它是打包压缩后的桌面 JavaScript，不是含完整 Rust 引擎的原始源码仓库。本次未分析原生二进制，也未整体读取两个约 580 MB 的证据 JSON。

| 能力 | 打包代码证据 |
|---|---|
| 子代理动作独立 | `.vite/build/main-BklS_2Y2.js:1054`：collabAgentToolCall 包括 spawnAgent/sendInput/resumeAgent/wait/closeAgent，senderThreadId/receiverThreadIds |
| 身份独立于昵称 | `.vite/build/src-BJv5Mk7n.js:568`：source.subAgent.thread_spawn 的 parent_thread_id/agent_path/agent_nickname/agent_role；会话管理保留 hostId/threadId |
| 历史拓扑发现 | 同文件 `:688`：thread/list 按 ancestorThreadId/parentThreadId 查找；兼容回放历史 spawn；分页、父子归属校验、有界并发 |
| 读取与恢复分开 | `:593`：先 thread/read，再 thread/resume；已有 threadId/path/history:null；needs_resume→resuming→resumed |
| 防恢复竞争 | `:593`、`:686`：owner/follower、inFlight 恢复、generation、写入冲突、退避和超时 |
| 重连失效处理 | `:696`：清理 process sessions、文件监听、MCP流和旧pending请求；不代表执行栈原样存活 |
| 调度策略 | `:685–686` 此包普通路径为 explicitRequestOnly；不能外推到所有版本、所有客户端设置 |

Codex 最值得借鉴的是稳定 thread 身份、独立 resume 协议、持久父子目录和恢复竞争控制。不能根据这些桌面桥接代码声称它保证任意工具跨电脑重启 exactly-once 续跑，也不能证明它永远主动使用更多子代理。

补充官方文档：已实际读取 https://developers.openai.com/codex/multi-agent/ 。文档说明子代理适用于独立并行工作，支持跟进、等待与关闭；主动委派与客户端/指令配置有关，并明确多代理通常消耗更多 token。文档未承诺电脑重启后自动恢复所有在途工具。

## 6. 储存应如何处理

不可把子代理历史改放纯内存来解决重复创建，这会直接失去跨重启恢复依据。

| 数据 | 建议位置与寿命 |
|---|---|
| 稳定child身份、父归属、运行链、状态、权限快照、计费和恢复回执 | SQLite 持久化，小型事务记录 |
| 子会话正文、工具结果历史投影和最终摘要 | 当前默认 JSONL，sqlite 后端为兼容选项；子工具版本化详情仍另存 SQLite，不能把 JSONL 当作所有工具完整原文的唯一存储 |
| AbortController、进程句柄、SSE订阅、运行队列、热缓存 | 内存；重启后按持久资料重建 |
| 重复大输出、工具详情 | 保持已有详情分页/外置去重，不能每个事件复制完整转录 |
| 旧尝试历史 | 同一个 child 下归档展示；保留失败与中断事实，不改写成后来成功 |

复用 child 能减少重复调查及重复输入/输出，主要收益常常是模型成本与时间。每次续跑新增一次执行记录是正常成本；其配置快照、任务正文及后续工具记录的体积没有统一的小字节保证。已中断记录仍有审计、恢复和部分成果价值，现阶段不应按「已结束/已中断」直接删除。若以后做回收，应保护仍被父会话、发布快照、账单或恢复链引用的数据，并区分归档与删除。

本次没有测量这七个真实子代理的字节数，因此不声称可以节省某个具体比例。

## 7. 建议实施顺序与验收

### 第一阶段：修复恢复决策闭环

1. 更正 subagent/resumeRunId 说明。区分「当前执行已中断」「历史是否可接续」「最后外部动作是否未知」。
2. 增加父会话范围的持久子代理目录工具，默认返回每个 child 的最新 run、状态、目标短摘要、可恢复性及原因。分页、字段及总输出有上限；不加载全文，不跨租户，不使用名称匹配身份。
3. 普通继续时给模型提供简短恢复提示，明确优先发现并复用原子会话、保留已完成证据。当前root的participants与跨轮目录保持语义分离。
4. 恢复使用已有 resumeRunId 通道。避免按一个「继续」关键词自动重启全部历史任务；用户的新范围、已完成工作和显式取消仍须尊重。
5. 外部副作用未知的最后操作先核实结果，再决定接下来的工具调用。恢复模型上下文与重放工具必须分离。

### 第二阶段：配置Agent可见性与委派策略

1. 提供精简、只读、租户隔离的可委派 Agent 目录，避免将创建/删除等管理工具全部默认打开。
2. 配置界面明确展示主 Agent 是否具备委派权限；保存时诊断缺失，不静默扩大白名单。
3. 调度提示允许任务需要时对独立实现、验证、研究分工，主 Agent 保留整合责任；简单任务仍直接完成。
4. 使用适用任务委派率、恢复复用率、重复派发率、有效产出和成本/时延来衡量，而不是追求高调用次数。
5. 对目录条目标明真实可执行性，处理 inline-only 配置的发现/执行不一致；记录工具不可用、目录不可见、权限不符、无合适专长与模型未选择等不同原因。

### 第三阶段：前端小改

保留 childSessionId 聚合体系。中断记录区分可恢复/不可恢复，给出单个继续图标与tooltip；详情保留多轮工作，成功续跑后更新同一行。保持用户要求的macOS极简视觉。

### 必须通过的回归

- 创建子代理→写入部分工具结果→关闭并重开数据库/引擎→发现 interrupted→普通父继续获知旧任务→resume；childSessionId 不变，runId更新且关联旧run，子历史可读取。
- 两个并发resume只接纳一个；旧执行权限和旧join不能复用。新父轮可在同一parentSession/rootSession下显式resume；错租户、错归属、错工作区或扩权请求不能通过。
- 已完成子任务不重复运行；取消任务不擅自恢复；老记录缺continuation时明确不可恢复。
- 两种历史后端均验证；最后工具结果未知时不盲目重放；恢复过程再次崩溃后不重复接纳。
- 前端同一child一行多轮，旧尝试保持interrupted、新尝试显示真实状态，刷新与重启后一致。
- 工具白名单与Agent目录可见性测试，确保未授权能力不因新的调度提示被打开。

## 8. 本轮验证

已有隔离测试定向执行 5 个文件，16 passed、83 skipped（名称筛选未执行）、exit 0，耗时 8.04 秒。覆盖两种历史后端的启动中断恢复、结果投影、旧join拒绝、正常续跑保留child/history、权限及并发约束。未调用真实模型。

```text
npx vitest run src/core/subagent/__tests__/subagent-runtime.test.ts src/core/subagent/__tests__/tracked-async-runner.test.ts src/core/subagent/__tests__/collaborators.test.ts src/tools/subagent/__tests__/subagent-reviewer-access.test.ts src/core/subagent/__tests__/subagent-durable.test.ts -t "resume|continuation|reopen startup|recovers queued" --maxWorkers=1 --minWorkers=1
```

现有测试尚未覆盖「普通自然语言继续→模型选择旧child」整条行为链。由于本次没有产品代码修改，没有把上轮侧栏构建/Electron测试作为本轮修复证据。本报告记录的是可验证根因、已有能力、参考边界及实施验收方案。

另执行工具暴露/profile 隔离测试 2 个文件，35 passed、24 skipped（名称筛选未执行）、exit 0，耗时 2.68 秒。两组共 51 项通过，跳过项不计入验证结果。

```text
npx vitest run src/tools/__tests__/tool-exposure.test.ts src/tools/__tests__/tool-profile.test.ts -t "default|catalogue|legacy tools|OSM off|explicit lists|empty" --maxWorkers=1 --minWorkers=1
```
