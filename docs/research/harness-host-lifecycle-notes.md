# DeepSeek Harness：Host 插件生命周期与 Client 连接的源码追踪

研究时间：2026-11-12。源码：`D:\dev\deepseek-harness`，提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。本文件只记录源码研究，没有执行第三方插件、修改产品实现或用户数据。

## 1. 结论与边界

Harness 的插件是能同时贡献 Host 服务、Agent 工具、RPC、事件、浏览器模块和 UI 插槽的应用扩展。把它描述为“导入一个 Node 脚本并注册工具”会漏掉它最重要的部分。其完整链路是：

```text
profile/package.json 的依赖与 bundles 选用
  → bundle 的 Cordis patch + 用户/启动配置层
  → Loader Entry → registry/Fiber → apply(ctx, config) / Service
  ├─ ctx Service / 工具 / effect
  ├─ ./typert 反射 → Gateway RPC → Client typed remote
  ├─ allowlist Host events → Gateway → Client remote events
  └─ dsh.client + ./client → ClientModuleRegistry graph
       → /plugins/events SSE → entries.sync / entries.reload
       → Client plugin 的 apply(ctx) → UI 插槽和本地服务
```

安装、已选用、Host 已激活、Client 已挂载是不同事实。管理器用 `ChangeResult` 区分磁盘是否变化、实际应用结果以及是否需要重启，而不是只返回“安装成功”。

## 2. 安装和持久化：GUI 与 AI 共用同一个管理服务

### 服务入口

- `packages/boot/plugin-manager/src/index.ts:312`：`PluginManager extends TypertRemoteService`，注入 Loader 与 profileContext。
- `packages/boot/plugin-manager/src/index.ts:832`：`setPluginEnabled` 写 entry 的 enabled override，再重组运行配置；存在更高层覆盖时可返回 `overridden`。
- `packages/boot/plugin-manager/src/index.ts:850`：`setBundleEnabled` 改 profile 的 bundle selection，然后发布解析/重载。
- `packages/boot/plugin-manager/src/index.ts:872`：`installBundle`；`1046`：`removeBundle`。
- `packages/boot/plugin-manager/src/tools.ts:85`：AI 工具 `plugin_manager`；`:143`、`:149`、`:156` 调相同的管理服务方法。没有另写一套 AI 安装实现。

### 安装真实步骤

`installBundle` 在 `src/index.ts:872–1010` 中执行这些步骤：

1. 生成/记录安装操作，向 Client 发 `plugin-manager/install-state` 和安装日志。
2. 检查既有包、安装输入、GitHub/下载传输和 registry。将 profile 的 `package.json`、`pnpm-lock.yaml` 做快照。
3. 调 profile 下的 `pnpm add`。只有显式传入 `approvedBuilds` 时才更新 build-script 授权。
4. 识别新依赖，解析 bundle，检查 manifest 的 `dsh.bundle.patch`、平台和 DSH 版本兼容性。
5. 默认选用 bundle，将包名写入 `package.json` 的 `dsh.profile.bundles`；`enabled:false` 可以只安装不选用。
6. `publishAndReload` 发布后续运行解析并尝试应用。进入 applying 阶段后不能再把它当成可随时取消的纯下载。

包管理或初步校验失败时恢复 manifest/lock。不能由此推断所有下载文件、pnpm store、已发生 build script 的副作用也都回滚了。

持久存储位置：

| 内容 | 真实位置/实现 | 含义 |
|---|---|---|
| 安装依赖与版本 | profile `package.json`、`pnpm-lock.yaml`、`node_modules` | 包已安装 |
| bundle 是否选用 | `package.json` 的 `dsh.profile.bundles`；`index.ts:1168` | 参与下次/本次配置组合 |
| 单个 entry 是否启用 | profile patch；`patch.ts:27` | 保留 YAML AST 的 override |
| entry 配置 | profile/home patch；config-editor | 与包源文件分离 |
| 有效运行状态 | Loader entries/Fibers、service registry | 进程内状态，必须观察实际激活 |
| 远程协议贡献 | typert registry | 跟随贡献者生命周期注册/撤回 |
| 浏览器模块图与 bundle 快照 | ClientModuleRegistry 内存表 | 从活动 Host entries 和磁盘 bundle 派生 |

`packages/boot/app-boot/src/profile-context.ts:75` 的配置优先顺序是 **bundle patches → profile patch → home patch → launch overlays**。因此 GUI 写入的值可能被更高层覆盖；保存值与 effective value 应分别展示。

### 一次管理操作的完成语义

`packages/boot/plugin-manager/src/index.ts:1259–1296`：

- 持 profile `package.json` 文件锁，读取操作前磁盘状态。
- 有 HMR 默认尝试 `applied`；无 HMR 为 `restart-required/no-hmr`。
- 捕获取消和应用失败，结果分别为 `cancelled`、`failed`；重启原因转 `restart-required`。
- 比较操作前后 `diskState` 决定 `changed`。
- 无论应用是否成功都发 `plugin-manager/changed`，Client 重新读真实状态。

`packages/boot/plugin-manager/src/types.ts:161` 的结果类型还包含 `overridden`。这使“保存成功但未激活”“配置被覆盖”“已部分落盘但运行失败”有明确表达空间。

## 3. Host 激活与停用：不是把模块 import 进来就算完成

启动时 `packages/boot/app-boot/src/index.ts:1224` 安装 Loader，`:1227` 挂载 profile root include。配置重组在 `:328` 的 `recomposeProfile`：

1. 计算新的包解析与合成 entries。
2. 找出消失的 rows，先停止并等待旧 Fiber dispose，期间保留旧包映射给 cleanup 使用。
3. 发布 successor 解析，再准备/应用 patch。
4. 更新 root include，恢复应重启的 running entries 和之前 import 失败的 entries。
5. 等待 Loader/Fiber，检查 required entries 和曾运行 entries 是否成功激活；返回 inactive diagnostics 或抛错。
6. 发 `app-boot/config-reload`。

关键生命周期实现：

- `vendor/loader/src/config/entry.ts:121`：`Entry.update`；`:140` disabled 时等待 Fiber dispose。
- `vendor/loader/src/config/entry.ts:153`、`:167`：只有 schema 标记的 volatile 配置可就地提交；普通 config/context 变化走 patch/Fiber 更新。
- `vendor/loader/src/config/entry.ts:236`：经 `registry.plugin(plugin, config)` 实际注册。
- `vendor/cordis/src/fiber.ts:251`：解析配置；class 插件实例化并跑 init hooks/Service.init；函数插件调用 `apply(ctx,config)`。
- `vendor/cordis/src/fiber.ts:271`：父 Fiber effect 拥有子 Fiber 的 disposer。卸载将 `uid` 置空、发 `internal/plugin`、从 runtime 移除，并等待 unload。
- `vendor/cordis/src/fiber.ts:421`：`ctx.effect` 收集清理器并逆序撤销，支持异步清理；它不是只删除一个 Map 项。
- `vendor/cordis/src/service.ts:43`：具名 Service 通过 reflect/provide 提供给 Context，随所属生命周期撤下。

插件要把 listener、timer、后台任务、路由、service 和 socket 清理放进 effect/disposer。框架能提供所有权机制，不能自动撤回任意未登记的外部副作用。

## 4. HMR：Host 模块重载、profile 重组与浏览器重载是三件事

### Host 重组与互斥

`packages/boot/hmr/src/index.ts:268` 的 `runExclusive` 使用 promise 队列串行化管理操作和自动重载，AsyncLocalStorage 拒绝嵌套事务；失败不阻断下一项。

`:384–407` 观察 profile manifest、profile patch、home patch；`:438` 将源码 watcher 的变更也送入同一队列。`:310` 明确要求 Loader internals，HMR 不是在任何部署模式都可用。

管理器 `reload` 在 `packages/boot/plugin-manager/src/index.ts:1247` 分两条：

- 无 HMR：仅验证保存的 patches 能组合，等下次启动实际应用。
- 有 HMR：调用 `hmr.reconcileProfile(requiredIds)`，将 pending/restartReason 返回给用户。

`packages/boot/hmr/src/index.ts:930–987` 的 profile reconciliation 会比较磁盘模块、规划替换、停止可替换旧插件、清理失败 import，再调用 `recomposeProfile`。它还会清理已移除包的 module cache。

### 不同替换路径的失败语义不同

- 源码 watcher 的替换路径在 `hmr/src/index.ts:647–746`：尝试加载新模块、撤旧插件、以旧 config 注册新实现；失败会恢复 cache 并尝试注册旧实现。
- 管理器 profile reconciliation 的契约在 `hmr/src/index.ts:920–928` 明确写了：新插件 load/start 失败时，其上一版代码可能已不再运行。
- 因此不能统一对外宣称“升级失败自动完整回滚”。磁盘快照恢复、模块 cache 恢复、插件重新注册和业务副作用回滚是四种不同保证。

### 热生效/重启矩阵

| 操作或变化 | 热应用条件 | 不能热应用/不能这样承诺的情况 |
|---|---|---|
| bundle/entry 启停、config patch | profile 装有 HMR，重新组合后依赖/entries 能激活 | 无 HMR 时保存后等重启；高层覆盖可 overridden |
| Host 插件实现变更 | 模块可归属 Loader 管理，依赖闭包可安全替换 | 触及 Host 入口静态依赖 `host-module`；无 Loader owner `unmanaged-plugin` |
| 包路径/解析变化 | 可发布同 scope 的 successor | retained package scope/path 移动可 `package-moved` |
| 模块文件比较 | 可访问/操作 ESM cache | 无 ESM cache 或比较失败为 `module-comparison` |
| 浏览器 `./client` bundle | Client HMR 已启用、产物实际重新构建 | 只改 TS 源码却没 build 不会凭空生成新 bundle |
| 同包 `./typert` 反射内容 | 需另考虑 typert-loader 本身的刷新 | loader 活着时内部 manifest promise 无失效路径；不能承诺跟 Host 实现同步热刷新 |
| 卸载运行中的 bundle | 先停 Fiber 并确认不再 in-use，再 pnpm remove | 无 HMR 的 startup/active bundle 返回 stop-profile；仍活跃返回 bundle-in-use |

重启原因规划见 `packages/boot/hmr/src/index.ts:823`、`:1013`；包解析边界见 `packages/boot/app-boot/src/profile-resolution/service.ts:92–106`。单独 `pluginPackages.refresh()` 明确不会卸载已加载模块或清 Node cache。

### 一个容易漏掉的热更新限制：Typert Loader 自己的缓存

`packages/typert/loader/src/index.ts:342–351` 在 `apply` 内维护：

- `registered`：按 entry 的注册 disposer，可撤回；
- `artifactPath`：按包名缓存 `./typert` 路径或 null；
- `manifests`：按包名缓存 dynamic import + validated manifest 的 Promise。

`:362–405` 一旦有 artifact verdict 就复用；`:408–421` 一旦有 manifest Promise 就复用。后面的 entry 卸载只删除 `registered`，并没有清 `artifactPath` 或 `manifests`（`:432–453`）。所以同一个 typert-loader 生命周期里，新增已被负缓存的 export、替换同包 reflection 都不具备通用失效机制。文件头也明确把这种插件集变化描述为重启生效。

准确边界是“缓存持续至 typert-loader 自身重建”，而不是持久数据库缓存；直接重启 profile 是可确认的刷新方式。不能把所有 Host HMR 成功误报成远程协议也已用新定义。

## 5. Host 如何把服务与事件暴露给 Client

### RPC 并非扫描任意 Service 的全部 public 方法

`packages/typert/protocol/src/index.ts:236` 的 `bindTypertRemote` 建立显式 service/namespace binding；`:250` 的 `TypertRemoteService` 和 `:278` 的 `@Remote` 定义边界。`packages/typert/loader/src/index.ts:330` 根据活动 Loader entries 查包的 `./typert`，加载并校验 `TYPERT`，通过 registry 注册；卸载撤回贡献。

Client 远程调用链：

```text
ctx.remote.pluginManager.setBundleEnabled(...)
 → Client Gateway prepared arguments
 → connection.rpc.call('/api', 'pluginManager/setBundleEnabled', { args }, signal)
 → Host Gateway descriptor / 参数校验
 → 非 owner 的 action/resources 访问判定
 → live receiver Context / service binding / lookup
 → 调真实 PluginManager 方法
```

证据：

- `packages/api/gateway/src/client/index.ts:255` 安装 namespace 的远程贡献，`:443` 调 `/api`。
- `packages/api/gateway/src/index.ts:793–825` 校验 descriptor 和参数，先做 non-owner 资源权限判定。
- `:827–838` 再解析活 service、验证 binding、处理 lookup。拒绝的调用不会先激活 lookup 资源。
- `:840–858` 创建本次调用的 Invocation Context，`this.ctx.invocation` 是本次 peer/signal，避免把调用状态写进共享 Service。
- `packages/api/remote-access/src/index.ts:199` owner 默认允许；non-owner 无对应 policy 时拒绝。

Client 的 `whenAccess` 用于 UI 的动态挂载便利。真正权限判定在 Host Gateway，隐藏按钮不能替代服务端校验。

### Host 事件不是任意内部事件都外发

- `packages/api/remotes/src/remote-events.ts:26` 定义 `API_REMOTE_FORWARDED_EVENTS` allowlist，包含 plugin-manager 的 changed、install-log、install-state、update-state。
- `packages/api/remotes/src/index.ts:49` 对 allowlist 订阅 Host event，编码为远程事件 frame。
- `packages/api/gateway/src/index.ts:615` 对 non-owner 按 `event:<name>` 与 resources 判定；一条事件整条发送或丢弃，不做字段级裁剪。
- `packages/api/gateway/src/client/remote-events.ts:88`、`:119` 将订阅和本地 private-event 投递绑定到 Client plugin 生命周期。

因此自定义 Host 事件要进入协议定义/forward allowlist，不能仅 `ctx.emit('my/event')` 就期待所有浏览器自动收到。

### 安全边界的准确理解

`packages/boot/plugin-manager/src/tools.ts:105–110` 的 AI 管理工具检查 session sandboxPolicy，并经 `approveEscalation` 请求 danger-full-access；原文明确 installed Host code 运行在 workspace sandbox 外，变更影响 profile 的所有 session。

这说明它是受信任宿主扩展，不是 OS 级隔离的安全插件沙箱。Gateway 的用户权限隔离、Agent 工具调用批准、pnpm build script 授权和插件运行隔离不能混为一层。

## 6. Host 生命周期如何真实驱动浏览器新增/撤下插件

`packages/client/modules/src/index.ts:680` 订阅 Cordis `internal/plugin`：标记相关 entry 为 dirty，并在 microtask 增量重组。

这条事件也确实在卸载时触发：`vendor/cordis/src/fiber.ts:120` 定义 `emitPluginDisposed`；`:274–275` 先将 Fiber uid 置空再通知观察者；`:308` 是构造后的发布。观察者异常会被隔离，不能破坏所有权清理。

ClientModuleRegistry 的处理：

- `packages/client/modules/src/index.ts:891` 从包解析 `dsh.client` 和 `./client`，检查浏览器平台/导出。
- `:1043` 从当前活动 entries 计算 sources。
- `:1083` 一个 package 多个活 source 会报错；`:1097` 无活动 source 从表删除。
- `:1099–1114` 根据 bundle 与 metadata 生成 revision/graph row；相同内容不重复发布。
- `:1118–1158` compose 成新图并 `notifyGraphChanged`。坏插件或不可排序图会报告问题；不把无法 compose 的新图冒充成功图。
- `/plugins` route 分发版本化浏览器产物，index injection 给首屏 boot graph；bundle revision URL 对应固定 bytes，避免旧 URL 读到新内容。

浏览器热更新 transport：

- `packages/client/hmr/src/index.ts:36` 默认每 500ms stat-poll **已构建 client bundle 文件**，用于发现重建；`:149` timer；这不是插件管理页不断轮询业务列表。
- `:162` 发 `{type:'graph',graph}`；`:176` 新 SSE 连接立即发完整 graph。
- `:195–197` graph change 和 bundle rebuilt 经 `/plugins/events` 推送。
- `packages/client/hmr/src/client/index.ts:52–54` 收到 graph 用 `entries.sync(graph)`，收到 rebuilt 用 `entries.reload(id,rev)`。
- `:83–85` EventSource 随 effect dispose 关闭；Host route、timer、连接、订阅也有 disposer。

因此运行中的 Host entry 移除会真正使 Client graph 少一个模块，再由 Client lifecycle 撤 UI。它不是“前端刷新整个网页才能看见包已经卸载”。后续 Client controller/slots 的细节可与专门的 Client 研究合并。

## 7. 内置完整案例：插件管理页本身也是插件

包：`@deepseek-ai/dsh-client-ui-plugin-manager`。

### 一个包的多面导出

`packages/client/ui-plugin-manager/package.json:16–45` 同时定义：

- `.`：Host 类 PluginRegistryProbe；
- `./client`：浏览器管理页 plugin bundle；
- `./typert`：Host reflection；
- `./remote`：Client remote contribution；
- `dsh.client.inject`：声明浏览器依赖，platform 为 web。

Host 面不负责真实包管理，而是提供 registry 网络探测；管理服务来自 `@deepseek-ai/dsh-boot-plugin-manager`。`ui-plugin-manager/src/index.ts:25` 的 PluginRegistryProbe 继承 TypertRemoteService，`:51` 远程 `fastest`；`:38–40` 在卸载时 abort 网络并等待 pending 工作收敛。此细节说明 Host/Client 共享功能包无需把所有业务塞进一个 Service。

### 浏览器挂载

`packages/client/ui-plugin-manager/src/client/index.ts:86` 声明 slots、locale、remote.pluginManager、pluginInventory、registryProbe、layout、remoteAccess 等注入依赖。

`:94–99` 注册语言、创建 controller、把 controller.dispose 放进 effect，并 provide pluginChanges。

`:106–174` 在 `whenAccess('pluginManager/listBundles')` 内成组挂载：

1. changed/log/progress/connection reset 订阅（`:117–121`）。
2. shell.overlay 的刷新提示（`:122`）。
3. main 的 `plugins` 页面（`:129–149`），且页面自己声明 `plugins.tab`、`plugins.bundle.config`、`plugins.detail.section` 等子槽，允许其他插件继续扩展管理页。
4. sidebar.panellist 的 Plugins 图标（`:167–173`）。

这些注册由 generator yields 交回 disposer；权限撤回或插件卸载时会随 owner 撤下。页面从未渲染时不读业务快照；收到 changed 时只对已加载 controller 重新 load（`:110–117`）。

### 点击启用/安装后的往返

```text
侧栏 Plugins → PluginManagerPage/controller
 → manager-store 的 remote.pluginManager 调用
 → Gateway / 权限 / PluginManager
 → profile 文件锁 / pnpm / 选用或 patch / HMR
 ├─ changed/progress/log 远程事件 → controller 更新列表/进度
 └─ Cordis Fiber 变化 → ClientModuleRegistry → SSE graph → UI 模块变化
```

`manager-store.ts:836`、`:849` 调 removeBundle；`:857` 调 setPluginEnabled；`:1087` read 首先读 inventory，再在管理可用时并行 listBundles/listPlugins（`:1107–1108`）；`:1277` 调 installBundle 并关联 requestId。

这里有两条互补通道：业务列表用管理事件/RPC更新，插件代码和 UI 贡献用模块 graph/HMR 更新。若只实现“事件来了重新拉列表”，不会自动得到可卸载的 Client 插件体系。

## 8. 对 Aether 研究范围的直接含义

若目标是用户创建的插件可以在 Aether 中增加侧栏页、成果渲染、配置表单、消息交互和后台能力，后续设计必须包含这些契约：

1. **一个插件项目、Host/Client 多面入口**，并明确只有 tool 的项目与含 UI/后台的项目可贡献哪些能力。
2. **Host 生命周期 owner 与 dispose**，管理工具、GUI、API 共用一套管理服务。
3. **UI contribution registry**，先规定有限稳定的 slots，而不是让第三方任意改 React 树。
4. **版本化 RPC 与 event bridge**，服务端权限、资源范围和撤回机制要可验证。
5. **持久安装状态与观察运行状态分离**，分别显示 installed/enabled/active/client-mounted/failed/restart-required。
6. **更新策略**，Host/Client/协议反射分别判断可热更新，不能一个布尔值笼统宣称全部成功。
7. **失败和卸载语义**，先停工作、撤 UI/事件/路由、等待 cleanup，再删包；业务数据删除单独定义。

Harness 这些能力建立在自己的 Cordis Context、Loader、Typert、Gateway、Client controller 和 slots 体系上。复用思想和协议边界是可行的；把它的 bundle 原样导入现有 Aether 并直接运行，并不由“都使用 Node/React”自然成立。
