# Aether Code 宿主、协议与两仓联动发布审计

日期：2026-09-29。前端消费方为 `D:\dev\aether-code`，引擎为 `D:\dev\ai-agent-engine`。本文简称 **F** 与 **E**；路径后的数字为本轮当前磁盘源码行号。

证据简写：后文 F/host.ts、runtime.ts、client.ts、secrets.ts、sdk/* 默认指 F/src/main/engine/ 下文件；F/ipc.ts 指 F/src/main/ipc.ts。特别标注 renderer 的客户端指 F/src/renderer/src/core/engine/client.ts；E 的路由文件均在 E/src/api/http/routes/。完整路径首次出现或可依此映射。

本轮先读取 F/AGENTS.md，仅做只读审计，没有启动 Electron、引擎服务、模型请求或改动业务。F 的 HEAD 为 `2c6a74a55f42d09f7751e1142382c361c51625e6`，有大量未提交改动，包括宿主/client/聊天及测试；E 的 HEAD 为 `770090dbd9f4857e6bb11c0d1ceef3db8c5b27d5`，开始审计时工作树干净。结论以本轮磁盘为准，不沿用上一轮测试或源码行号。

## 1. 结论与上一轮范围修正

**实际消费方是完整 Electron IDE，不是引擎仓库内的 multi-agent-console。** 当前组合产品已经有真实的主进程、预加载桥、IPC、HTTP/SSE、引擎状态面板与进程回收。前端自己的 Git、终端、LSP、文件服务属于产品能力，不能因为引擎仓库没有相同实现就判断整个产品缺失；这些具体功能由前端功能分报告核查。

**升级引擎的风险主要在“连接到了哪份代码、协议是否相容、用户数据是否延续”。** 同级源码更新不会保证宿主换到新引擎；旧端口复用和 userData 已安装版本优先级都可能挡住新 dist。开发态的 E2E 也不能代替打包态验证。

**Aether Code 没有使用已发布的 agent-engine-sdk npm 包。** F/package.json 没有该依赖；`F/src/main/engine/sdk/port-finder.ts:7` 明确说明上游混淆产物导致 require 难以静态打包，因此内联改写源码。真正需要同步的是两仓的 HTTP/SSE 契约与 F 的自有宿主，不是只升级一个 SDK 依赖版本。

**组合产品的 embedded 模式强制监听 127.0.0.1。** `F/src/main/engine/host.ts:203` 与 `sdk/process-manager.ts:86` 注入本机监听，不能把 E/main.ts:44 独立服务默认 `0.0.0.0` 直接套到这个模式。远端与 adopted 进程的监听配置仍由外部服务决定。

## 2. 当前实际调用链

```text
Renderer core/engine/client.ts
  → window.aether.engine（preload/index.ts）
  → 具名 IPC（shared/ipc.ts / main/ipc.ts）
      ├─ start/stop/restart → EngineHost → 自有内联启动器 → 引擎 dist/main.js
      ├─ request → main/engine/client.ts → fetch HTTP → /api/v1/...
      └─ stream → EngineHost.stream → fetch SSE → IPC streamEvent → Renderer
```

| 层 | 已实现行为 | 源码证据 |
|---|---|---|
| 主入口 | 注册 IPC，创建窗口，按设置自动启动；启动失败不阻塞窗口 | F/src/main/index.ts:140、:155、:159 |
| Preload | 固定具名通道；request、stream start/abort、snapshot/log/event 订阅，返回取消订阅函数 | F/src/preload/index.ts:62、:69、:73、:80、:92 |
| IPC | 普通 request 转发；streamId→AbortController；重复 ID 先取消旧请求；终态 finally 清理 | F/src/main/ipc.ts:43、:80、:85、:100 |
| 状态广播 | engine snapshot、log、stream event 广播给存活 webContents | F/src/main/ipc.ts:45、:53、:56 |
| 前端状态 | 初次取 snapshot，订阅状态与日志；UI 有启动/停止/重启 | F/src/renderer/src/core/engine/useEngine.ts:41；contrib/settings/EngineSettingsView.tsx:186 |
| 本地配置 | userData/settings.json 整体存储并合并默认值；包含 mode/port/remoteUrl/autoStart | F/src/main/settings-store.ts:19、:38；shared/ipc.ts:337 |
| 模型凭证保护 | 首次生成 ENCRYPTION_KEY，优先 safeStorage 加密，注入引擎环境 | F/src/main/engine/secrets.ts:33；host.ts:173、:204 |
| 退出 | before-quit 中止流、终端、LSP；will-quit 等引擎 stop，再退出 | F/src/main/index.ts:170、:176 |

协议桥不是透明代理：它会重写 URL、解包 envelope、丢弃一部分响应字段、解析 SSE，再转换为本地类型。因此这些文件必须是引擎升级的消费方审查清单。

## 3. Runtime 选择、启动与复用

### 3.1 实际优先顺序

EngineHost 的顺序与 runtime.ts 注释不是同一层：

1. **首先尝试复用首选端口已有进程**（F/host.ts:149）。只要端口被占用且 `/health` 返回 `{code:200,data:{status:'ok'}}` 就采用（:248）。这一步早于环境变量入口。
2. 未复用时才调用 resolveRuntime（:152），内部依次为：
   - `AETHER_IDE_ENGINE_ENTRY`（F/runtime.ts:70）；
   - `<userData>/engine/1.0.0/dist/main.js`（:76）；
   - 打包态 `<resourcesPath>/engine/<platform>-<arch>/dist/main.js`（:81）；
   - 同级 `ai-agent-engine/dist/main.js`（:88）；
   - 同级 `sdk-package/bin/dist/main.js` 旧副本（:89）。
3. 寻找可用端口、注入 `ELECTRON_RUN_AS_NODE=1`、`HOST=127.0.0.1`、DATA_DIR、ENCRYPTION_KEY 和 SKILLS_ROOT；`process.execPath` 执行入口目录里的 `main.js`（F/sdk/process-manager.ts:74、:95）。
4. 轮询健康检查至多 60 秒，成功后每 5 秒检测，连续 3 次失败标 error（F/host.ts:31、:212、:344、:359）。

**现有进程复用的边界：** adopt 不比较版本、build SHA、数据目录、安装身份、协议版本、tool profile 支持情况或租户；PID、entryPath、dataDir 设 null，无法证明它就是本用户这次想用的运行时。停止 adopted 只断开，不杀外部进程（F/host.ts:308）。再次“重启”会重新采用同一个旧进程，不会使新代码生效。

当前 subagent E2E 比普通开发启动更严格：强制 `AETHER_IDE_ENGINE_ENTRY` 指向同级 dist，并断言 `snapshot.adopted === false`（F/e2e/subagent-lifecycle.spec.ts:71、:202）。这个断言应推广到升级验收。

### 3.2 就绪、掉线与重连

- adopt 检查健康 envelope，但 remote 初连（F/host.ts:114）、readiness（F/sdk/readiness-probe.ts:71）以及持续健康检查（F/host.ts:365）主要只看 HTTP 2xx。一个返回 HTTP 200 的其他服务/错误 JSON 不能被一致排除。
- `/meta` 拉版本只影响展示，失败不阻断连接（F/host.ts:499）。没有最低版本、协议主版本或能力门禁。
- 失联后停止健康轮询并标 error，没有带退避的自动重连；用户可手动 restart。子进程意外退出会清空 baseUrl（F/host.ts:290）。
- stop/restart IPC 直接操作 host，没有像 app before-quit 那样统一 abortAllStreams（F/ipc.ts:71、:73 对比 :448）。尤其 remote/adopted 停止不关闭对方服务，已有 SSE 是否继续推事件需要明确契约并验收。
- start 有并发 Promise 合并（F/host.ts:87），但手动 stop 并未取消正在执行的启动/readiness。应增加启动代数或 AbortController，测试“starting 时 stop 之后不能又变 ready”。此处是静态竞态风险，未动态复现。

## 4. 当前打包与升级闭环

| 环节 | 当前事实 | 不能据此声称的能力 |
|---|---|---|
| IDE build | `npm run build` 只 typecheck + electron-vite build（F/package.json:21） | 不会自动构建同级引擎，也不会拷贝引擎产物 |
| 安装包构建 | electron-builder 配置有资源解包规则，但没有 `extraResources` 引擎拷贝或构建 hook | 不能保证 fresh install 自带 engine runtime |
| 当前 resources | 本轮只发现 icon.png，没有 resources/engine | 不是已具备随包交付的证据 |
| runtime 定位 | 代码期待 resourcesPath/engine/platform/dist/main.js | 只有查找逻辑不等于该文件会进入安装包 |
| tgz 安装 | `installFromTgz` 有 staging/解压/入口检查/rename 实现（F/runtime.ts:112） | 全 src 仅找到定义，未见 IPC/UI 调用或 CDN 下载流程；`installing` 状态目前不能证明被驱动 |
| 引擎 tgz 产物 | E/sdk-package/scripts/copy-bin.js:64 复制 dist；:75 拷 shell asset；:134 拷技能；:166 写包元信息；create-cdn-package.js:83 打出 package/ 前缀 tgz | 平台参数只是产物标签，不意味着在一个平台上已经交叉构建所有 native modules |
| 发布 manifest | E/create-cdn-package.js:127 记录平台 URL 和 size | 未见 digest/signature、API/协议范围、最低 IDE 版本或数据 schema 兼容信息 |
| 原生依赖 | IDE 有 node-pty，engine runtime 也带 native dependencies；electron-builder `npmRebuild:false` | 必须分别验收 Electron Node 运行时下的 ABI/平台包，不能靠 TS build 推断 |
| 跨平台包 | IDE 的 mac/linux 脚本直接 electron-vite build，不含前置 typecheck（F/package.json:25、:26） | 与 win/unpack 的门禁不一致 |

本轮未运行打包，结论是**仓库没有形成可复现的引擎随包交付闭环**，不是声称某个外部手工制作的安装包已经失败。

### 4.1 版本身份不可靠

- F/runtime.ts:25 的 `DEFAULT_ENGINE_VERSION='1.0.0'` 实际用于目录槽位；E/package.json 的引擎版本为 2.0.0，E/sdk-package/package.json 的 npm 包版本另为 0.1.1。三者没有统一 manifest 或关联约束。
- F 启动器 `cwd=dirname(entry)`，即 dist（F/process-manager.ts:96）。E 的 `/meta` 却从 `process.cwd()/package.json` 读取版本，否则返回 ENGINE_VERSION 或 unknown（E/routes/metrics.ts:15-24）。
- 本轮只读确认 `E/dist/package.json` 和 `E/sdk-package/bin/dist/package.json` 都不存在，宿主也没有设置 ENGINE_VERSION。主线随后用真实路由探针验证：root cwd 返回 2.0.0，切到 dist cwd 且无 ENGINE_VERSION 则返回 unknown；根目录 package.json 存在不能修复这个相对路径问题。
- 当前没有在握手中比较两仓 build SHA。看到“ready”不能证明运行的是刚审核/测试过的 dist。

### 4.2 数据与密钥保护必须先于可更新交付

**潜在 P0：安装目录与数据目录实际重叠。** F/runtime.ts:48 将 agent.db 放在 `installedDir(version)/data/agent.db`。installFromTgz 在目标没有有效 entry 时会 `rm(finalDir, recursive)`（:139）。如果该目录只有入口损坏但历史数据库还在，修复安装会连数据库一起删。这条安装函数尚未被 UI 接通，但启用升级前必须解决，不能让注释“运行时与数据分离”掩盖实际路径。

简单把 DEFAULT_ENGINE_VERSION 改为新版本也不是完整修复：host.ts:183 会换到新版本槽位里的 DB，使旧会话/模型配置看起来消失。应将运行时版本目录与不随运行时版本变化的用户数据根分离，定义迁移、备份、兼容窗口与回滚策略。

**P0：safeStorage 暂不可用时不能覆盖旧密钥。** F/secrets.ts:40 只在 encrypted=true 且 safeStorage 可用时读取旧密钥；若 encrypted=true 但不可用，既不 return 也不 throw，继续到 :62 生成新随机密钥并于 :70 覆盖旧文件。引擎模型凭证仍由旧 key 加密，会失去解密能力。应保留原密钥文件、显式报恢复状态，且在轮换被明确支持前永不自动替换已存在密钥。

## 5. 认证修复必须两仓同步

当前 F 的普通请求（client.ts:53）和 SSE（host.ts:408）都只带 Accept/Content-Type 与 `X-Aether-Tool-Profile: code`；没有 Authorization、X-API-Key 或会话凭证。AppSettings 和 EngineSettingsView 也只有远端地址，没有引擎登录/凭证管理。模型供应商 API key 是另一种凭证，不能当成引擎服务认证。

E/auth/middleware.ts:16 验 X-API-Key，:22 验 JWT Bearer；:28 对无凭证返回 default。当前 F 能工作部分依赖这个降级行为。**E 若改成“AUTH_ENABLED=true 时缺凭证拒绝”，F 的 embedded/remote HTTP、SSE、重新附接和管理页都必须同步适配。** 主机本地加密 ENCRYPTION_KEY 只保护数据库密文，不是 HTTP 登录凭证。

建议联动契约：

1. embedded 生成专用本机服务凭证并以明确启动参数/环境注入 E；F 在主进程集中加头，渲染层无需持有明文。E 只认这份本机实例身份，宿主继续强制 loopback。
2. remote 单独配置可验证的 API key/JWT，主进程安全存储；先验证 `/meta` 的认证模式，再进行业务请求。不要为了兼容旧前端保留共享远端匿名管理权限。
3. adopted 必须证明实例来源/所有权和凭证兼容；无法证明时明确选择“外部服务连接”，不要冒充本用户 embedded 会话库。
4. 管理角色变更需同步 Security/Model/Settings 面板的 disabled/error 呈现；401/403 要提示认证或权限原因，不能显示空数据或继续生成成功。
5. 对普通 request、POST SSE、GET stream resume、重试/取消建立同一认证拦截器，防止只补一条路径。

## 6. HTTP / SSE / Schema 的契约点

| 项目 | 当前行为 | 升级要求 |
|---|---|---|
| API envelope | F/client.ts:18 接受 code 200 或 0；业务失败返回 ok=false，renderer 可 requestOrThrow（renderer client.ts:68） | E 改状态码时保留业务 code/message，消费者应同时检查 HTTP 与业务成功 |
| 非标准 JSON | F/client.ts:87 缺 code 时按 HTTP 状态判成功，且只返回 body.data/null，注释却说按失败处理 | 定义严格/宽松模式，不要把错误 envelope 变化变成 ok=true/null |
| Metadata | E/conversation.ts:82 返回 envelope.metadata.sessionUsage/subagentRuns；F/client.ts:83、:101 只保留 data/pagination | 明确透传 metadata，或通过正式接口取得；不能保证新增顶层字段自动到达 renderer |
| 根路径路由 | F/client.ts:26 和 host.ts:514 只认 health/metrics/openapi.json；meta 在 host 手写直连 | 新增 `/auth/user` 或 `/meta` 消费不能直接走通用 API，否则会误加 `/api/v1` |
| Tool profile | F/tool-profile.ts:2 在 HTTP/SSE 固定 code；E/api/http/tool-profile.ts:6 解析，省略为 general | 老 E 可能忽略未知 header；应握手确认 profiles，而不是假定加头就收敛工具范围 |
| SSE 业务失败 | host.ts:423 检查 content-type，非 SSE 标准 JSON 会发 error；好于静默空回复 | 保留这一条失败路径；新 401/403 与 200 fail 都验收 |
| SSE framing | host.ts:447 按 LF 空行分块，:521 取首个 data，支持心跳注释/[DONE]/event:done | 与当前 E/sse-sink.ts 的 LF/单行 JSON 一致；CRLF、多行 data、尾部残片、未知字段需要固定协议或健壮解析 |
| 流 ID/恢复 | StreamStartInput 支持 GET/query，useChat.ts:658 查询状态后按 lastEventId 续传 | 测试断线恢复不重复工具副作用；host 当前并不把原始 SSE id 独立透传至 renderer |
| 子代理 schema | F/shared/subagent.ts:41/71 固定 v1，normalizeSubagentRun `:98` 拒绝其他版本 | 这是局部有效的边界验证；升级 v2 必须先协商/兼容，不应静默丢控制帧 |
| 整体握手 | `/meta` 目前只有 version；没有整体 apiVersion/capabilities/schema 范围 | 用版本化 manifest 定义必要能力、认证方案与兼容范围 |

旧取消路径目前有兼容接线：F/renderer/core/engine/client.ts:75 的 `/subagent/cancel` 仍被 Legacy SubagentCard.tsx:226 调用；E/chat.ts:311 注册该路由，:325 用 tenant/sessionId/toolCallId 调用 cancelSubagent。同时 E/subagent.ts:25 提供 `/subagent/runs/:runId/cancel`。主线真实路由探针确认旧端点在空任务时 HTTP 200、code 200、cancelled:false，不能报作 404；后续改变取消契约仍须同时验收新旧分支。

建议 `/meta` 后续新增且可后向兼容的字段：`engineVersion`、`buildSha`、`apiVersion`、`streamProtocolVersion`、`subagentSchemaVersions`、`toolProfiles`、`capabilities`、`authSchemes`、`instanceId`、`dataSchemaVersion`。这只是建议契约，当前没有上述完整握手。

## 7. E2E 覆盖和空缺

**已存在且有价值的跨层验证：**

- smoke：启动就绪、安全模式/策略渲染、主进程文件/Git/终端等（F/e2e/smoke.spec.ts:323、:327）。
- LSP：引擎就绪、保存触发诊断、问题面板与跳转（F/e2e/lsp-diagnostics.spec.ts:102、:106）。
- history replay：应用重启后消息/思考/工具回放及清空（F/e2e/history-replay.spec.ts:140、:181），但夹具直接写旧 SQLite `conversations` 且硬编码 `engine/1.0.0/data/agent.db`（:67、:100），需要另加 JSONL 主路径及迁移契约验证。
- subagent lifecycle：真实引擎/工具，替换远端 LLM 为可控本地 provider；覆盖并行成功/400、单子任务取消、页面刷新继续流、不重复派发、重启/导出、HTTP 与 SSE tool profile（F/e2e/subagent-lifecycle.spec.ts:316、:364、:424、:464）。
- pending/security/subagent-state 纯函数测试对控制帧、状态和交互语义有价值；但无法证明宿主启动/打包/鉴权执行。

**这些测试尚未覆盖的发布边界：** fresh packaged install 无同级源码/无 userData runtime；installed→bundled→dev 优先级；adopted 旧/不兼容/不同数据实例；remote API key/JWT/RBAC；版本/能力握手；HTTP 200 错误和真实 HTTP 401/403/5xx；发布 tgz 解压与 native 依赖；升级/降级持久数据；safeStorage 暂不可用；start-stop 竞态；远端停止活动流；使用旧 IDE 配新 E / 新 IDE 配旧 E。

F/AGENTS.md 明确：引擎通信或 IPC 改动必须 E2E；E2E 加载 out，先 build；workers=1。F/package.json 的 pretest:e2e 只 build F，不 build E；两个产物都必须独立构建并记录 SHA，避免拿旧 engine dist 通过测试。AGENTS 的 103 条历史基线不等于本轮测试数量。

**本轮主线实际验证（最新 18:06）：** F 重新执行 `npm run typecheck`，node 与 web 两段均通过；E typecheck 也通过。最新证据为 `docs/research/aether-code-typecheck-latest.txt`。初次检查曾发现 ChatView.tsx 的 setMemory 未使用与 setOpen 未定义，随后被并发工作修复；旧日志 `aether-code-typecheck.txt` 只保留为工作树基线漂移的观察，不是当前阻断。纯函数 pending/security/subagent-state 共 38 条，37 过/1 fail（无选项交互语义断言，具体结论由主报告补齐），证据 `aether-code-contract-tests.txt`。类型检查通过不等于 build 或真机 E2E 已通过；本文未据旧 out 声称当前源码的真机验收通过。

主线额外采用 buildServer + 隔离临时 DB 做真实路由注册/注入探针、未监听网络：前端 48 个字面量 HTTP 调用点全部匹配当前注册路由。证据为 `docs/research/aether-code-route-contract.json`、`engine-registered-routes.txt`。这证明该集合的路径/方法存在，不证明动态生成路径、请求 body、认证、返回字段或实际工作流均兼容。

## 8. 可执行的两仓联动发布矩阵

每轮必须保存四份身份：**F commit+dirty patch、E commit+dirty patch、E runtime artifact digest、实际 EngineSnapshot/握手结果**。仅记录 npm 版本不足以识别当前运行代码。

| 场景 | 引擎侧准备 | 前端侧准备 | 必须断言 |
|---|---|---|---|
| 当前源码联调 | typecheck/tests/build 新 dist | 记录已通过的 typecheck，再构建本轮产物；使用隔离 userData/port 和明确 ENV entry | adopted=false；entryPath 是目标产物；model/tool/permission/subagent/chat 完整走 HTTP+IPC |
| 新 E + 旧 F | 固定上一发布 IDE 与新 runtime | 启动旧消费方，不能偷偷用新源码 | envelope/已知帧兼容；新增 required auth/schema 必须明确拒绝或有兼容窗口 |
| 新 F + 旧 E | 固定上一 engine artifact | 新 F 远端和 adopted 两条分别测 | 缺 toolProfile/subagent 等能力时禁用并解释；禁止静默展示已支持 |
| fresh 打包安装 | 制作目标平台 tgz/资源清单 | 在无同级源码、空 userData 环境安装 IDE | resourcesPath 入口存在；依赖/技能/assets 正确；无需开发机 node_modules |
| 已安装升级 | 旧包建立会话/模型凭证/JSONL/SQLite | 安装新包并启动，显式选择 runtime | 旧数据可见、密钥可解密；实际 buildSha 更换；失败回滚不删数据 |
| 修复损坏 runtime | 保留 data，删除/损坏 runtime entry 的专用夹具 | 走修复安装流程 | 数据与 secrets 字节不受损；运行时替换原子；失败不混版本 |
| adopt 外部实例 | 在目标端口准备旧版/不同 instanceId 的真实 E | 启动新 IDE，或改 ENV entry 后启动 | 不兼容/非本实例不可无声 adopted；restart 对外部服务的语义清楚 |
| remote 认证 | AUTH_ENABLED=true，API key/JWT 与非管理员用户 | 配置主进程凭证，覆盖所有请求类型 | HTTP/SSE/resume/cancel 都同一身份；401/403 明确；不漏发头、不降级 default |
| 生命周期故障 | 受控延迟启动、退出、失联和长流 | start→stop、restart、关闭应用、远端 stop | 无 stale ready、无孤儿活动流；owned 退出、adopted 不杀外部进程；无重复副作用 |
| 密钥不可用 | 旧 safeStorage 密钥文件+加密模型数据 | 模拟临时不可解密/不可用 | 保留原文件并报恢复错误；绝不自动生成替代 key |
| 平台/ABI | 分别构建 win32-x64、darwin-arm64、linux-x64 等支持平台 | 使用对应 Electron 安装包测试 | libsql/native/PTY/技能脚本与文件权限可用；不能只改 tgz 文件名冒充目标构建 |

### 推荐发布顺序

1. **先冻结契约和消费方基线。** E 的接口变化列入变更表，F/client/host/shared types/renderer consumers 都指定责任；当前两仓 typecheck 已通过，仍需固定本轮 dirty patch 与新构建产物再验收，不能把类型检查等同升级验收。
2. **先补身份和数据底座。** 实例/build/capability 握手、明确 runtime 选择、独立持久数据根、不可破坏密钥；完成后再接下载/安装入口。
3. **E 先提供后向兼容扩展。** 新字段可选、新能力有 capability；不在旧客户端还无法携带凭证时直接无提示切换认证要求。
4. **F 同步实现新契约与错误状态。** 通用 request+stream+resume 共用认证和路径策略；按能力打开入口，保留升级提示。
5. **构建两仓、运行当前与 N-1 组合，再测 fresh packaged install。** 开发态测试与发布包测试分开，记录实际运行时身份；不复用常驻进程获得假阳性。
6. **最后发布配对 manifest 和迁移说明。** 标出最低 IDE/API/stream/schema、artifact digest、平台、数据迁移和回滚边界。破坏性改动作为明确 major 迁移，不依赖 `version:'unknown'` 继续碰运气。

主线后续已完成两仓 build，并运行真实 Electron 子代理生命周期 E2E，3/3 通过；见 [E build](consumer-engine-build.txt)、[F build](aether-code-build.txt)、[E2E 日志](aether-code-lifecycle-e2e.txt)。这不等于全量测试或发布包验收。后续正式发布还须调用 E 的 runtime 打包和 F 的 electron-builder，并补齐 packaged/auth/upgrade fixture，才能将相应矩阵行标通过。本轮未制作安装包。
