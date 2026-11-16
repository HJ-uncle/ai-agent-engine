# 插件 Agent 执行上下文审计

维护者记录；公开插件接口以 `../aether-code/docs/plugin-api/content/` 的 HTML 内容为准。本记录解释实现边界，不是第二份公开 API 参考。

## 当前实现（后续审计已完成接入）

本文后半部分保留的是接入前的发现和方案。当前源码已完成以下链路，正式结果以本轮测试回执为准：

- 每个插件 Agent 在独立 `childSessionId` 中创建真实 RootRun、服务端种子与 collaboration owner，安装生产历史投影；不借用主会话的执行身份。
- 服务端 WeakMap 标记在 root 创建事务中固化 `pluginAgentOwner`，普通聊天回答在修改 pending 前拒绝接管。
- 原生子代理可运行，重建注册表的 configured Agent 也继承实时插件授权、用户工具禁用和工作区委托。
- 浏览器 authority、principal、controller subject 来自认证宿主；工作台通过活跃 owner 委托到绑定会话，保留实际执行身份和精确回执。
- `pending` 使用公共展示投影；许可/问答由宿主用户答复。**没有公开 `$AE.agents.respond` 方法**，专用回应入口不在插件 SDK 调度中。
- 页面 `agents.stream` 跨等待与续跑保留同一个 Promise；宿主答复后更新运行 ID。Node 流返回 `blocked` 和待答复快照，不伪装为成功。
- 生成、Node 工具、页面和流不再附加插件专属时限、输出量、并发和 V8 内存配额；逐事件等待下游消费，Node 日志先写磁盘。

SDK 的身份、系统提示词、Skill/MCP 挂载、`agents.tools`、`disabledTools` 与引用本插件清单工具的 `customTools` 都已有对应实现和公开 HTML。原生工具保持平台自己的策略与资源依赖。

## 已实现与验证

插件 Agent 使用真实 ReAct、SubagentRunner、会话历史和平台 general ToolRegistry。`engine.tools` 明确授权后复用原生文件、命令、搜索、Office 等实现及原生 preflight，不复制工具对象的可信身份，不重新实现同名工具。模型可通过原生 `load_tools` 加载当前作用域的完整定义。

`agentDisabledTools` 与单次配置 `disabledTools` 取并集，从可执行注册表删除；用户运行期间新增禁用项和撤销授权，会在原生工具进入全局池前、等待全局池后重新检查。精确工具开关不是副作用沙箱：另行授权的命令、Node 或工作区能力可能具有相同文件操作能力。当前插件 Node 工具引用冻结清单中的本地工具名，不能通过 Agent 参数选择其他插件、代码字符串或任意入口路径。

工具发现不创建运行、不请求模型、不执行发现到的业务工具。未授权定义保留 `available: false` 与原因。显式 MCP 发现仍遵循普通平台 MCP 配置、授权和安全模式；连接 stdio MCP 本身可能启动服务器，与平台的发现行为一致。

续跑复用旧 child session 和历史，但显式提供的新身份、提示词、挂载与禁用项会重新解析、实时授权、保存。`SubagentStore` 普通续跑继续冻结原权限；插件宿主经实时验证后通过进程内 WeakMap 授权当前 admission 的配置更新，模型 JSON 不能伪造这份授权。

## 接入前发现：交互能力缺口（历史记录）

当前插件运行拥有独立的 subagent 历史与异步句柄，没有普通聊天的 canonical root owner、浏览器宿主身份和 pending 回答传输。因此子代理协作工具、浏览器工具、`ask_user` 与 workbench 交互工具从可执行注册表移除，发现目录明确返回不可用原因。原生命令保留政策检查；需要用户确认的命令会进入真实 blocked 状态，不会自动批准，但尚无插件内批准后恢复通道。

不能仅复制主会话的 owner 或构造相同字段来开放这些工具：

1. `core/subagent/runner.ts` 验证 parent 的 root owner 与 tenant/session/rootRun/turn 必须完全一致。插件子会话不能借用主会话身份。
2. `core/collaboration/jsonl-react-boundary.ts` 和 SQLite 对应实现要求真实 admission seed、可信历史来源以及精确输入锚点。仅 `RootRunStore.create(...,{})` 再 `admitRoot` 不足以建立生产历史边界。
3. `storage/root-runs/index.ts` 的 `finishOwned` 要求子执行真实 join/drain 凭证；pending 需 park 和后续恢复。跳过这些步骤会产生未汇聚的子任务、错误终态或无人接收的提问。
4. 普通 HTTP root resume 从持久 request 重建运行。若插件使用该通道而未增加插件专属 ownership/revision/grant 重验证，恢复后可能失去插件限制。
5. `tools/subagent/subagent-tool.ts` 的普通继承路径代理父 registry；配置 Agent 的分支则重新创建 registry。插件未来开放协作时必须向该分支传播实时插件授权与禁用策略，不能只在根 Agent 加一次检查。
6. `core/browser-execution.ts` 和 browser bridge 需要可信 browserAuthority/browserPrincipal 与真实 root/owner identity，不能从插件参数接收。

## 接入方案与审阅依据（历史记录）

- 为插件 Agent 在其独立 session 建立真实 root admission，绑定不可变插件身份、revision、父会话与工作区，不占用或改写主会话的 root。
- 持久化插件运行的 admission seed，并安装生产 history collaboration boundary。绑定会话仅用于获准的 SDK 数据读取，不能充当独立 root 的身份字段。
- 让所有后代执行继承插件的实时权限、用户工具禁用、资源选择和取消边界，包括 configured Agent 重建 registry 分支。
- 增加插件专属 pending 事件、回答/批准、取消和恢复通道。每次恢复重新验证插件启用状态、版本、权限、工作区与 pending 的精确 tool call identity。
- 从宿主认证状态传入浏览器身份与工作台投递能力。终态先真实 drain/join，再写持久状态和发送事件；关闭插件/退出引擎需取消并等待整个树。
- 对上述链条同时覆盖 JSONL/SQLite、重启恢复、撤权、换工作区、重复回答、取消竞态与跨租户负例，再移除相应 `available: false`。

不能将目录存在、伪造文本状态或模型声称完成作为这些能力已接通的证据。

## 独立 root 可行性实证与接入改动面

隔离诊断 `.e2e-tmp/plugin-root-evaluation/proof.mts` 已实际执行以下路径：

`RootRunStore.create({message}) → server admission seed → admissionProjectingHistory → admitRoot → JSONL delivery boundary → SubagentRunner.start → owned child completion → finishOwned/drain → releaseRoot`。

结果为独立 root 与真实 owned child 均 `succeeded`，没有模型调用、生产数据库访问或伪造 owner。`create` 必须传递真实 `message` 才能获得 server seed；先前提到的空 request 缺少 seed 并非不可解决的根架构阻碍。SubagentPool 按 parentSessionId 分组，插件外层与独立 root 的内层协作不共用同一组配额；不能误判为全局五个槽的递归死锁。

接通需要共同评审、验证的最小修改面：

| 修改区域 | 具体职责 |
| --- | --- |
| `plugins/agent-capability.ts` 与新插件 root helper | 建立独立 root；保存 root 与插件 run 关联；真实 pending park、回答后恢复、终态 drain 与取消；普通任务续跑和 pending 回答不得混为一条路径 |
| `storage/root-runs/index.ts` 与 server-only provenance helper | 在 root 创建的同一持久化操作中保存可信 pluginId/revision/boundSessionId，不能从客户端 JSON 接受 owner 标记 |
| `api/http/routes/chat.ts` | 在普通 toolResponse 接受/幂等回答之前拒绝 plugin-owned root，避免重新构造无插件授权的普通聊天执行 |
| `agent-context/factory.ts`、`tools/subagent/subagent-tool.ts` 与 registry authority helper | 通过进程内可信标记继承插件实时授权、禁用名单和工作区约束，尤其配置 Agent 的 registry 重建分支；保留子代理自己的更窄资源范围和原生 preflight |
| 插件 HTTP/Node dispatcher 与 SDK | 宿主注入 browserAuthority/browserPrincipal，新增 pending 事件和宿主专用回应接口；公开事件只使用 `publicPending` 投影，不泄漏封存操作；不向插件公开批准方法 |
| 前端插件宿主确认组件 | 区分普通问答与 permission 批准。插件 JS/Node 不得自行提交 `approved` 来批准自身命令；必须取得宿主可信确认结果及绑定精确 pending 的一次性授权 |
| workbench bridge 与前端连接 | 独立插件 rootSessionId 没有主会话已注册的工作台连接，需要受信委托到绑定会话的承载面；不能覆盖 execution.rootSessionId 冒充主会话 |

浏览器 native host demand 已支持通过可信身份为真实执行取得独立连接，故浏览器与 workbench 的接入问题不同。workbench 当前用 execution.rootSessionId 查找注册连接，并在命令与画面回执中检查 session 与 execution；只传 browserPrincipal 不会让它自动共享主会话连接。

`RootRunStore.answer` 解决精确 pending、重复回答和恢复 attempt，不负责证明调用来自用户点击。直接向任意插件脚本开放 permission 的 `approved` 会绕过原生命令的每次确认。当前使用宿主专用入口及控制者记录；不能通过设置 `approvedToolCallId` 或泛化 `agents.manage` 来替代。
