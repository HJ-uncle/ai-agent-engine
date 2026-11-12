# DeepSeek Harness 可交互插件闭环：Schedule

调研日期：2026-11-12。参考仓库：`D:\dev\deepseek-harness`，HEAD `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。本轮以只读源码调研为主，另运行末节所列 SlotCore 源码探针；未启动 Harness 应用、未安装依赖、未运行其单测套件或浏览器 E2E，未改 Aether 产品代码。以下“已证实”指源码路径闭合；测试文件存在只作为设计证据，不等于本轮执行通过。

## 结论

Harness 的 Schedule 确实是能点击、编辑、立即运行、查看历史、跨重启恢复的插件功能。它由 **Host 业务服务 + Client 浏览器插件 + 类型化 RPC + 持久业务域 + 变更通知** 共同组成。不是工具运行后返回 HTML，也不是在插件管理列表中运行 Node 脚本就自动获得界面。

该样本是随官方 Web bundle 装配的插件，能说明其扩展架构；它不能单独证明任意 GitHub 插件导入后都具备同样的 UI、权限与恢复能力。Host 和 UI 分别在 `packages/bundle/web-app/cordis.patch.yml:135`、`:414` 装配。

## 从一次用户保存操作追到底

| 环节 | 已证实行为 | 源码位置 |
|---|---|---|
| UI 模块入口 | `dsh-client-ui-schedule` 同包有 Host 空 `apply` 和 `/client` 浏览器入口；package 元数据声明 Client 依赖，不是 iframe 清单。 | `packages/client/ui-schedule/src/index.ts:1`；`packages/client/ui-schedule/package.json:13`、`:23` |
| 导航及页面挂载 | Client 注册 `main` 的 `schedules` 页面、`sidebar.panellist` 导航项及右侧任务标签。卸载由对应 effect/slot disposer 管理。 | `packages/client/ui-schedule/src/client/index.ts:205`、`:218`、`:240` |
| 用户打开任务 | 点击任务行设置 `selectedId`；手工新建设置 `manualOpen`，编辑草稿保存在注册的 editor store 中。 | `packages/client/ui-schedule/src/client/TaskManagerPage.tsx:138`、`:306`；`index.ts:222` |
| 用户点击创建/保存 | `TaskDetail` 按钮调用 `save()`。新建把 title/prompt/timing/target 交给 `onCreateTask`；编辑附带 `expectedUpdatedAt`。请求 pending 与失败仍保留草稿，成功才清除。 | `packages/client/ui-schedule/src/client/TaskDetail.tsx:268`、`:405` |
| Client 业务接线 | `onCreateTask` 调 `ctx.remote.schedule.create(request)`，成功后 `retainCreated` 并等待 `refresh()`；编辑同理。组件不直接读取 Host 对象。 | `packages/client/ui-schedule/src/client/index.ts:176`、`:230` |
| RPC 发出 | 生成的 Remote 方法最终调用 `connection.rpc.call('/api', 'schedule/create', {args}, signal)`。Web carrier 构造随机 rpcId、`client-request` envelope，HTTP POST 到 `api/schedule/create`，返回时校验 rpcId。 | `packages/api/gateway/src/client/index.ts:444`；`packages/client/connection/src/client/rpc.ts:34` |
| Host 验证与派发 | Gateway 先匹配方法 descriptor、检查精确参数和编解码器、做非 owner 的权限判断，才解析 receiver/context 并调用服务；业务结果被编码回 RPC result。 | `packages/api/gateway/src/index.ts:771`、`:793` |
| 服务入口 | `ScheduleService extends TypertRemoteService`，namespace=`schedule`；`@Remote('create')` 的 `remoteCreate()` 调共享 `create()`，与 Agent 调用共用业务规则。 | `packages/schedule/schedule/src/index.ts:223`、`:248`、`:362` |
| 服务提交 | Host 生成 ID，解析时间规则及目标；进入串行 FIFO 后重新验证目标、检查取消、构造任务，`await domain.table('tasks').put(id,task)`。落盘后才 emitChanged、驱动调度和排队通知，最后返回 catalog entry。 | `packages/schedule/schedule/src/index.ts:381` |
| 写入磁盘 | `scheduleDomain` 声明 version 2、tasks 表。默认 storage-domain 路由 json，root=`dshHomePath('storages')`，single layout 对应 `<root>/schedule.json`。单元更新失败回滚内存；写入用同目录随机临时文件、文件 sync、rename，POSIX 再 sync 父目录。 | `packages/schedule/schedule/src/storage.ts:139`；`packages/bundle/base/cordis.patch.yml:175`；`packages/storage/storage-json/src/single-unit.ts:29`、`:77`；`atomic.ts:24` |
| UI 状态回流 | 提交后发 `schedule/changed`；该事件在 Remote 转发白名单里，通过 Gateway 的 Remote stream 返回。Web 流载体是 `/api/remote.mux` WebSocket。Client 收到事件或 connection/reset 后重读 catalog；`epoch` 丢弃过时请求，结果发布为 ready/error，多个同批消费者共用一次读取。 | `packages/schedule/schedule/src/index.ts:601`；`packages/api/remotes/src/remote-events.ts:56`；`packages/api/gateway/src/stream-protocol.ts:7`；`packages/client/ui-schedule/src/client/index.ts:125`；`catalog-source.ts:101`、`:126`、`:172` |

`schedule/changed` 本身没有整份任务载荷；它是失效通知。真正的当前记录仍从 `schedule/catalog` 取回。保存返回值可先保留新记录，再由权威读回接管。这样能处理“通知、旧读取、操作返回”顺序不固定的情况。

编辑在 Host 的 FIFO 内比较 `expectedUpdatedAt`，不一致返回 `schedule_conflict`；删除先删任务再通知。对应 `packages/schedule/schedule/src/index.ts:555`。这比 UI 一次点击直接修改本地列表更完整：业务提交和界面展示有明确的成功点。

## 权限、用户和 profile 的真实边界

**已证实：UI 可见性与后端权限是两层。** Client 用 `remoteAccess.whenAccess('schedule/catalog',...)` 决定挂载页面（`ui-schedule/src/client/index.ts:125`）。这只负责展示；真正调用 `schedule/create`、`schedule/edit` 等时仍由 Gateway 独立判断权限（`api/gateway/src/index.ts:793`）。不能因能读目录就推断能写任务。

**已证实：owner 具有全权限，非 owner 按 principal/action/resources 判断，默认拒绝。** Gateway 权限判断在 receiver lookup 前执行，拒绝不会先激活目标 Session。`RemoteAccessService.decide` 对 owner 放行；未知非 owner principal 无 policy 时拒绝，见 `packages/api/remote-access/src/index.ts:199`。通知也按非 owner 的 `event:schedule/changed` 权限过滤，不是向所有连接无条件广播，见 `packages/api/gateway/src/index.ts:624`。

**已证实：这些不是“所有插件都隔离 tenant”。** Schedule 是 Host-wide 业务服务，`scheduleDomain` 的 tasks key 是 ScheduleId，没有 tenantId 列或每 profile 独立域；默认 root 是同一个 `$DSH_HOME/storages`。profile 的安装/配置目录则位于 `$DSH_HOME/profiles/<name>`（`packages/boot/app-boot/src/profile.ts:165`）。因此同一 DSH_HOME 的配置 profile 与业务数据作用域不能混称。改用不同 DSH_HOME 或显式配置 storage root 可以获得目录分离，但本轮未运行多个 profile 交叉读写实验，也不声称它支持多进程共同写同一 JSON 文件。

**已证实：任务目标还有业务限制。** 创建/重设目标会验证保存的 Session header 和 live Agent，拒绝 archived Session 与 delegated child Session（`packages/schedule/schedule/src/index.ts:617`）。这用于合法调度目标，不是插件代码的操作系统沙箱。

**已证实：浏览器认证还有传输层防护。** 其 BrowserAuth 用启动 token 交换签名 cookie（`packages/client/connection/src/browser-auth.ts:202`、`:251`），请求信任检查拒绝跨 origin/opaque `null` origin（`api-request-trust.ts:119`、`:147`）。这些防止未授权网页访问 Host；不能据此宣称已经安装的 Host 插件源码受限。Schedule 服务在同进程 Cordis 上下文中直接注入 `agents/sessions/storageDomain/sessionPersistence`（`schedule/src/index.ts:224`），本轮未找到该样本的每插件 OS 级隔离执行路径。

## 重启恢复与交付保证

1. **恢复任务。** 服务启动 `storageDomain.open(scheduleDomain)`，校验 task key 与 record.id，再从保存的 tasks 构造 `ScheduleRuntime` 并 `requestDrive()`。Web activation provider 之后准备好时会再驱动逾期任务。见 `schedule/src/index.ts:247`、`:268`、`:302`。
2. **目标身份先落盘。** `new_once` 在创建任务时预留 Session ID；每次新建目标 `new` 在创建 Agent 前先 commit `pendingDelivery.targetSessionId`，重启可复用该目标。见 `schedule/src/index.ts:626`，`schedule/src/runtime.ts:425`。
3. **投递与任务进度。** `send()` 先 `agent.followup(message)`，再等待 `sessions.flush()` 确认 Session inbox 持久化；之后才保存任务 receipt 和下一次时间。见 `runtime.ts:349`、`:264`。
4. **恢复仍排队的投递。** 用保存 receipt.messageId 在目标 inbox 中寻找原消息，idle 时移除后把同一个 ID 重新 followup，再 flush；不新建第二个逻辑消息。见 `runtime.ts:304`。
5. **不能宣称 exactly-once。** inbox flush 与 task receipt commit 是两次独立写入。若在前者成功、后者未落盘时崩溃，存在重复交付窗口；持久 receipt 也只证明消息入队，不证明模型工作完成。这一限制由源码调用顺序和 `packages/schedule/AGENTS.md` 明示。
6. **正常退出。** 服务先停 runtime、排空 mutation FIFO 和 notification queue，再关闭 domain（`schedule/src/index.ts:286`）。浏览器重连后 catalog source 收到 reset 并重新读取，UI 不以旧本地缓存作为持久事实。

仓库有针对上述路径的测试：`packages/schedule/schedule/tests/domain-restart.spec.ts:42`（关闭句柄后重新打开 JSON）、`execution.spec.ts:36`（恢复原 inbox 消息）、`recovery.spec.ts`，以及 `apps/web/tests/schedule-manual.e2e.ts`。本轮没有执行这些测试，不能据文件名称报通过。

## Aether 可复用能力及最少缺口

当前共享工作树已经出现 **Schema 驱动的手动工具操作路径**，不能再概括为“只能通过聊天调用”：`src/plugins/application.ts:54` 返回封存发布版的 manifest、示例及执行策略，`:64` 允许用户在固定 revision 上直接 invoke，并返回 result/artifacts 与插件哈希；`src/api/http/routes/plugins.ts:32`、`:38` 暴露 `/plugins/runtime/apps/:id` 和 `/:id/invoke`。路由仍验证管理身份/tenant，调用使用引擎默认安全策略，不接受客户端指定安全模式或工作目录。前端 `D:/dev/aether-code/src/renderer/src/core/engine/plugins.ts:25` 有对应读取/调用 API 和版本回执检查，`src/renderer/src/contrib/work/plugin-form.ts:10` 已有从 inputSchema 派生原生字段、解析参数和结果表格的辅助代码。这些是本轮并发工作树新增实现，非本次调研修改；本轮只读核对，未测试其完整页面接线、构建或运行行为。

它与 Harness 样本尚有明确差别：Aether 清单只接受 `runtime:'node' + tools` 且 strict，无作者自定义 Client 模块/slot 或 Host service 扩展项；执行器每次起短进程，stdin 一次输入，等待 close 后解释末行 result/artifacts。见 `src/plugins/service.ts:13`、`src/plugins/runtime.ts:63`、`:79`、`:104`、`:136`。Schema 表单是宿主根据工具参数生成的操作面，不等于加载作者编写的 React/HTML 应用、维护常驻服务、独立业务状态和订阅流。容许包内 `.html/.css` 只是允许保存文件，不会注册视图或自动加载该文件。Work 插件管理页仍是宿主实现的 CRUD 页面；新增手动 invoke 也不改变上述运行生命周期。

最少复用清单如下；它们是源码已存在的构件，组合方案尚未实现或运行：

| 现有能力 | 可复用之处 | 不能直接等同于 |
|---|---|---|
| `src/plugins/service.ts:113`、`src/plugins/catalogue.ts:45` | tenant 目录、不可变修订、哈希、启停、选择版本与白名单校验 | Client 视图加载器、Host 常驻服务、插件业务数据 API |
| `src/plugins/application.ts:54`、`:64`；`D:/dev/aether-code/src/renderer/src/contrib/work/plugin-form.ts:10` | 新增固定版本的手动 invoke、执行策略、参数表单映射与结果显示辅助代码 | 作者自定义 Client 模块/slot、常驻 Host 业务服务或状态订阅；本轮未验证完整界面运行 |
| `src/plugins/artifacts.ts:11` | 工作区路径验证、产物写入和变更账本 | 插件独立状态存储；不能把计时器配置塞进 revision 源码并反复改封存目录 |
| `D:/dev/aether-code/src/renderer/src/workbench/view-registry.ts:14`、`:42` | 内建 React view 注册、布局位置和 disposer | 给第三方执行任意 renderer JS 的授权；WorkView 仍需接入通用插件入口 |
| `D:/dev/aether-code/src/main/browser/service.ts:225`；`browser-ipc.ts:44` | 已有 WebContentsView，sandbox/contextIsolation 开、Node 关闭、网页不携带 IDE preload | 插件可直接调用 engine.request；应另设窄 action/state 桥 |
| `D:/dev/aether-code/src/main/browser-preview.ts:49`；`browser-workspace-preview.ts:13` | 工作区静态预览、随机 capability URL、路径及 engine/session 绑定失效 | 安装目录的插件资源协议；现实现授予的是工作区，不宜直接扩大其目录权限 |
| `D:/dev/aether-code/src/renderer/src/core/engine/client.ts:82` | trusted renderer 到主进程的预期引擎身份和请求代理 | 直接暴露给插件页面的通用 HTTP/IPC；插件只应取得其声明并批准的操作 |
| `src/api/http/routes/cron.ts:34`、`src/scheduler/cron-service.ts` | 已有持久调度、运行和通知服务，可承载重启后的计时任务 | 插件短进程里 `setTimeout` 能跨调用、退出或重启继续运行 |

若要进一步支持“AI 创建作者自定义界面、有独立状态、重启仍可用的计时/笔记插件”，仍需定义：作者 UI 资源入口与版本绑定、宿主挂载/卸载生命周期、在现有固定版本 invoke 之外的受限业务状态/订阅桥、独立业务数据空间、可恢复任务的宿主委托，以及每项能力授权。可选隔离页面或受信 React 贡献的路线尚待主设计决定；本轮不以读过源码替代可运行实现。

## 已运行：SlotCore 注册与撤销机制探针

命令：`node --import tsx .tmp/harness-client-research-20261112/slot-probe.ts`。直接导入 Harness 原始 `packages/client/ui-slots/src/index.ts` 的 `SlotCore`，没有复制或重写 registry 实现；利用其零运行依赖的核心，在本引擎现有 tsx 下执行。最终 **20/20 项检查通过**，exit 0。证据为 `.tmp/harness-client-research-20261112/slot-probe.ts` 和独立 `slot-report.json`，没有覆盖同目录其他探针的 `report.json`。

实际覆盖：内建 root→父项声明 list/keyed 子槽→插件组件按对象身份进入 entries→同 tick 变更微任务合并通知；disposer 移除自己的贡献和递归子声明；父项卸载同时清空子/孙条目；旧 disposer 不误删重新挂载的同 ID 贡献；相同 ID 重挂没有重复条目；unsubscribe 后下一微任务仍无通知。缺少 id/key、未声明槽、重复子声明、同优先级 list ID/keyed key 冲突均真实拒绝。不同 priority 允许 shadow，raw entries 可有两个但 entriesOfSlot 只投影一个赢家，不能概括成“所有同 ID 都拒绝”。

对应核心：`ui-slots/src/index.ts:1241`（注册及冲突验证）、`:1376`（raw entries）、`:1381`（shadow 赢家）、`:1522`（微任务订阅）、`:1538`（同步声明生命周期）、`:1627`（递归释放）。报告记录原文件执行前后 SHA256 相同。这个实验只证实 registry 生命周期机制，**没有执行 React 组件、没有真实浏览器布局、没有验证 RPC、持久化或完整插件加载**；前文的 Schedule 全链路仍属于静态追踪。
