# Windows PTY 关闭竞态诊断与最小修复方案

本文件保留 R2 冻结期间的诊断过程、被否决的 DLL 候选，以及后来获授权的仓库补丁脚本和隔离副本验证。至最后的隔离验证为止，没有修改引擎 / 客户端产品源码、正式依赖、制品或运行中的服务。前文候选方案的当前结论以最后的实测章节为准。

## 已确认的现象

R2 运行 `run-20261009T073642124Z-qUttIX` 的 `engine.err.log` 有 3 份相同错误：

```text
node-pty/lib/conpty_console_list_agent.js:13
Error: AttachConsole failed
```

三份错误与三次终端创建 / 删除时间一致：

| 终端 | 创建（引擎日志） | 删除 | 观察到的进程 | 删除后 |
|---|---|---|---|---|
| `1c392a65…` | 15:49:41.744 | 15:50:04.280 | `node` 28176 + `conhost` 37920 | 07:50:06 监测回到原始进程数 |
| `fc7f8632…` | 15:53:15.059 | 15:53:23.245 | `node` 36256 + `conhost` 44004 | 07:53:26 监测回到原始进程数 |
| `f791ea44…` | 15:53:22.990 | 15:53:23.270 | 5 秒采样未捕获 | 无残留 |

客户端首轮 07:49:40.744–07:50:04.686 的 UI 夹具失败是等待 `.subagent-group__head`，不是终端关闭失败；第二轮 07:53:14.053–07:53:23.664 通过，`rendererErrors: []`。两轮结果都没有 `closeError`。引擎健康请求继续返回 200。

07:59:52 的只读进程检查显示：`conpty_console_list_agent` 和 `workspace-shell.mjs` 进程数均为 0；首次 PTY 的 `node` / `conhost` PID 也不存在。引擎 PID 42424 及 SQLite 子进程仍在运行，说明没有主进程崩溃或终端泄漏。

## 根因

当前 `node-pty` 版本为 1.1.0。Windows ConPTY 的 `WindowsPtyAgent.kill()` 在默认 `useConptyDll=false` 路径中执行以下顺序：

1. fork `conpty_console_list_agent`，让子进程调用 `AttachConsole(shellPid)` 并读取进程列表；
2. **不等待查询结果**，立即调用 native `kill()` / `ClosePseudoConsole`；
3. 查询子进程若恰好在控制台关闭后才运行 `AttachConsole`，就抛出上述异常。该 helper 没有把 native 调用包在 `try/catch` 中，异常堆栈直接写入继承的 stderr。父进程只有 5 秒超时兜底返回 shell PID。

引擎自己的 `TerminalManager.kill()` 当前也没有把同一终端的关闭请求合并为一个 Promise，没有等待 `pty.onExit`，HTTP DELETE 和 WebSocket `kill` 可能并行触发底层 `kill()`。这会放大竞态并让路由在真实清理完成前返回成功。

## 推荐的最小修复顺序

### 1. 先在引擎 / 客户端包装层实现幂等关闭

修改点：引擎 `src/terminal/index.ts` 的 `TerminalManager`；客户端本地 PTY 若继续使用，则同步处理 `D:\dev\aether-code\src\main\terminal\pty-service.ts`。

- 每个 session 增加 `closing?: Promise<void>` / `exitPromise` / `killIssued`，退出监听在创建后立即注册，避免 kill 同步触发退出时漏掉事件。
- 第一次 `kill(id)` 设置 closing 状态并调用 `pty.kill()`；后续相同 ID 的 kill 直接返回同一个 Promise，绝不再次调用底层 kill。
- Promise 等待 `onExit`，设置有限超时（建议 5 秒）；超时仍要执行本地 cleanup，但要返回明确的 `PTY_EXIT_TIMEOUT`，不能伪装成正常退出。
- `kill` 发出后立即启动 runtime cleanup，再同时等待退出与 cleanup；Docker 模式可能需要清理容器才能让 CLI 退出，不能把 cleanup 延迟到等待退出之后。只有退出和 cleanup 都完成后才从 `sessions` / owner 计数中删除。创建中的 session 继续走取消路径。
- 失败后的重试保留 `killIssued` 和已观察到的退出状态，只重试尚未完成的 cleanup / exit wait，不重复底层 kill。closing 的成功终态保留短时 bounded receipt，重复请求共享结果；receipt 必须绑定 tenant/user，不能泄露其他租户同 ID 的结果。
- 路由 `DELETE /terminal/:id` 和 WS `kill` 都 `await` 同一个 kill Promise。WS 先回 close 帧时，后台 Promise 仍必须被观测并记录失败。
- 清理失败保持可见：返回现有错误 envelope，建议 `code:50000` 且 `message` 含 `PTY_CLEANUP_FAILED` / `PTY_EXIT_TIMEOUT`；业务错误名称是消息或受控详情字段，不替换现有数值 envelope code。日志记录 terminal ID、阶段和原始异常，不吞掉异常。成功响应语义保持 `{success:true}`。

这一步解决重复关闭、未等待退出和错误丢失，但单独做它不会消除 `AttachConsole`，因为根因在依赖内部的 helper 顺序。

### 2. Windows 优先使用随包提供的 `conpty.dll`

`node-pty` 的 `useConptyDll=true` 分支不会调用 `conpty_console_list_agent`；它直接关闭 ConPTY 并终止 shell。当前引擎依赖包内已有 `node_modules/node-pty/build/Release/conpty/conpty.dll`，客户端 stage 也会携带该生产文件。

冻结解除后的第一步是**独立临时进程验证此公共 API**，不是直接改默认模式。验证通过才在 Windows PTY spawn 选项中显式设置 `useConpty: true, useConptyDll: true`，并在启动时记录实际模式。引擎 / 客户端包内 DLL 的 SHA256 已核对相同。若 DLL 加载或启动失败，不能把现有 `for binary / catch` 启动重试当成 ConPTY 模式重试；它们是不同原因。应返回明确的 `PTY_CONPTY_DLL_UNAVAILABLE`，再按支持范围决定是否保留受控的系统 ConPTY 路径。降级必须标记为兼容模式，因为它会恢复 helper 竞态，不能静默掩盖。

风险：DLL 分支会走不同的 conout worker / socket drain 路径，并在 native close 中调用 `TerminateProcess(shell)`；JS 分支将 worker disposal 接在后续 `outSocket.data`，与系统分支的 process-exit flush 不同。必须验证**无输出终端、创建后马上关闭、连续大输出时关闭**都不会等待无穷或留下 worker。当前系统分支会额外枚举并终止 console 子进程，DLL 分支没有同一枚举逻辑，故要验证 PowerShell 启动的真实后台子进程以及 Docker attach 生命周期；文件 shell 的 worker 线程用例不够。随包 DLL 还需要覆盖目标 Windows 版本 / ABI / Electron unpack 布局。不能仅凭存在 DLL 或单次启动成功就切换默认。

### 3. 只有在不能使用 DLL 时才考虑依赖补丁

不建议直接编辑 `node_modules`。如果必须保留系统 ConPTY，使用锁定的 `patch-package` 或升级到包含修复的 node-pty 版本，并在补丁中：

- 父进程先查询 console 进程列表，收到结果 / 明确失败 / bounded 超时后才关闭 native ConPTY，并在 `finally` 中保证 native close 和 worker disposal 仍执行；不能在 `.then` 外立即 native kill。
- helper native 调用 `try/catch`，将 `{consoleProcessList, helperError}` 通过 IPC 返回；先确认原 shell 已自然退出的 `AttachConsole` 失败可分类为 already-exited，其余未知失败保持可见，不能仅按错误文本全忽略。
- 父进程监听 helper `message` / `error` / `exit`，once-settle、清除所有 timeout、断开 IPC并观测 helper 退出。查询失败不得让外层 Promise 挂住；native close失败和超时必须保留原始诊断。
- 进程列表快照应在控制台关闭前完成；不得依据延迟的裸 PID 杀任意复用 PID。现有内置 native 会持有 shell handle，应用不能通过私有 `_agent` monkeypatch 或任意 `taskkill` 绕过所有权来补救。

依赖补丁风险高于应用层包装：涉及原生 ABI、包内构建、客户端资源复制、SDK 包和三端哈希；除非 DLL 路径不能覆盖目标平台，否则不作为第一选择。

## 准确的应用层改动位置

| 文件 | 位置与必要改变 |
|---|---|
| `src/terminal/index.ts` | spawn 选项约 63 行；`onExit` 约 87 行；`kill` 122 行；`killAll` 135 行。退出 deferred、closing / receipt、保留失败、Docker cleanup 与退出共同等待；write/resize 在 closing 后拒绝。 |
| `src/api/http/routes/terminal.ts` | `/create` 当前未 `await terminalManager.create`，异步失败被错误报告为创建成功；必须等待后回复。WS kill 175 行及 DELETE 222 行当前均未等待。DELETE 的 own check 必须在 session / closing receipt 的 tenant/user 上执行，未知 / 外租户 ID 仍 404。 |
| `src/api/http/server.ts` | 当前 `onClose` 没有 `terminalManager.killAll()`；服务退出必须等待本实例 owned terminals（含创建中的终端）的同一 cleanup Promise，并聚合可见失败。真实 HTTP server close + Windows PTY 必须确认后代退出和进程自然结束。 |
| `D:\dev\aether-code\src\main\terminal\remote-terminal.ts` | `dispose` 155 行目前 WS kill 后又发 DELETE，并在等待前删 session；应以 awaited HTTP DELETE 为关闭确认，WS 留作传输关闭，同 ID 共享 dispose Promise。`removeRemote` 164 行现在 `.catch(()=>undefined)`，需解析 HTTP 与数值 envelope；未知错误不能当成功，已确认 own terminal 正常关闭后的 404 才可视为幂等成功。 |
| `D:\dev\aether-code\src\main\terminal\pty-service.ts` | `disposeTerminal` 167 行先删 map、吞异常并马上清 profile；改成异步 shared close，退出后才清临时 profile，保留真实失败。spawn 接公共 DLL 选项需与引擎一致。 |
| `D:\dev\aether-code\src\main\index.ts` | `before-quit` 204 行不等本地 / 远端终端；`will-quit` 212 行只等 engineHost.stop。以单个 shutdown Promise 顺序停止 streams、等待终端 / LSP / engine owned cleanup，记录失败后按既有退出策略退出，不能无限挡住用户。remote 模式不能停止独立远端引擎。 |
| `D:\dev\aether-code\src\main\ipc.ts` | `terminalDispose` 已返回服务结果，可承接异步 Promise；切引擎时约 77 行已 await remote disposeAll，要保留该顺序。 |

重复 DELETE 的一致终态是并发请求共享现有的关闭结果，关闭后同 owner 的短时 receipt 可返回成功；不应把未知、外租户或没有可信 receipt 的 404 自动改成成功。远端客户端应保留实际 endpoint snapshot 和实例鉴权，不能把终端 ID 迁移到新 engine。

## 验收测试设计

1. **无噪声基础循环**：Windows 机器上创建 / 连接 / 输入 / resize / DELETE 终端 20 次；`engine.err.log` 不出现 `AttachConsole failed`，每次 DELETE 只有在退出和 cleanup 完成后成功，session list / map 无 ID，健康接口保持 200；保存 stdout / stderr 及 PID+start identity 证据。
2. **并发幂等关闭**：同一 terminal ID 并发发起 10 个 DELETE，并同时从 WS 发送 `kill`；断言底层 `pty.kill` 只调用一次，所有请求得到一致终态，owner 计数不为负，无重复 exit 事件。
3. **关闭等待**：让 shell 延迟退出；DELETE 在 `onExit` / cleanup 完成前不得报告成功，超时必须返回 `PTY_EXIT_TIMEOUT`，并确认最终没有 shell / conhost 后代。
4. **真实清理失败**：测试替身让 `pty.kill`、ConPTY cleanup 或 exit wait 失败；断言 API / 状态报告失败和原始错误，不能返回 `{success:true}`，随后重试仍可收敛。
5. **应用退出**：同时开 5 个本地 / 远程终端，在 Electron `before-quit` / 引擎 close 中等待 `disposeAll` / `killAll`；断言所有终端完成或明确失败，不能留下工作区 shell、ConPTY helper、继续维持事件循环的引用 timer；确认自然退出 code 0，远端独立引擎仍健康。
6. **兼容矩阵**：`useConptyDll=true` 与系统 ConPTY 两种模式；Windows 1809、当前 Windows 11、无 DLL / DLL 加载失败、shell 已提前退出、重复 close、WS 断开后 DELETE。

当前 R2 证据只证明“终端确实回收、主引擎稳定”，不证明 stderr 噪声已修复。实现以上方案后，必须重新 build engine、SDK、client，并重复 stage 哈希、verify-runtime、真实 Electron 终端循环和 5 会话测试。

既有可扩展测试：`src/terminal/__tests__/boundary.test.ts`（将当前无事件 fake PTY 改为可延迟 / 失败退出的 EventEmitter；已有 Docker cleanup / pending-create / owner 限制不能退化），`src/runtime/__tests__/workspace-runtime.test.ts`；新增路由同 ID WS+DELETE 及 tenant receipt 测试。客户端已有 `e2e/remote-terminal-contract.spec.ts`（返回真实数值 envelope、超时与跨 endpoint 不误删）、`terminal-connection-ui.spec.ts`、`terminal-shell-input.spec.ts`、`terminal-output.spec.ts`、`terminal-resize.spec.ts`、`terminal-clipboard.spec.ts`。真实 Windows 进程验收需独立父进程捕获 stderr，不能仅 mock node-pty 后断言无堆栈。

建议范围：优先“公共 API 的 DLL 可行性探针 + 应用生命周期修复”，探针过全部 exit / child / worker 门槛后再确定模式；只有探针失败且需兼容系统 ConPTY时才做可重现依赖补丁。当前没有在冻结期间执行探针、安装新包或修改产品文件。

## 已获授权的隔离探针结果：DLL 默认切换已否决

后续收到授权，在不修改 `src` / `node_modules` / `dist` / 客户端 runtime、不启动另一引擎的条件下，使用当前客户端 standalone Node 24.20.0 与 node-pty 1.1.0 的公共 API执行 7 例。脚本 `.tmp/conpty-public-api-probe.mjs`，所有 stdout / stderr 与逐例观测保存在 `.tmp/conpty-public-api-20261009-WfJJlU`，汇总 `.tmp/conpty-public-api-probe-20261009.log`。未创建网络监听，不访问 12499 / 12323。

| 用例 | PTY exit | stderr | 测试宿主自然退出 | 判定 |
|---|---|---|---|---|
| 系统 ConPTY 空闲关闭 | 已收到 | 838 字节，1 次 AttachConsole failed | code 0，无残留 | 基线错误复现 |
| 系统 ConPTY 创建后立即关闭 | 已收到 | 838 字节，1 次 AttachConsole failed | code 0，无残留 | 基线错误复现 |
| DLL 空闲关闭 | exit 1 | 0 | 超过 11 秒仍存活 | 失败 |
| DLL 创建后立即关闭 | exit 1 | 0 | 超过 11 秒仍存活 | 失败 |
| DLL 大输出关闭 | exit 1；输出 1,572,953 字节 | 0 | code 0，无残留 | 通过 |
| DLL shell 带真实 Node 子进程 | exit 1；子进程写入停止 | 0 | 超过 11 秒仍存活 | 失败 |
| DLL 自然退出 | 正确收到 exit 7 | 0 | 超过 11 秒仍存活 | 失败 |

4 例 DLL 失败各留住“测试宿主 Node + 其 conhost”，不是原 PTY shell。测试随后只按每个探针已记录的 PID + Win32_Process.CreationDate ticks回收，共 8 个进程，无 PID 复用 / 清理异常。08:16:18 对 7 例全部 26 个已观察到的进程身份复查，匹配存活数为 0。自然退出结果与强制回收结果严格分开，不能把 cleanup 后无残留写成用例通过。

DLL 留住宿主的明确源码原因：`WindowsPtyAgent.kill` 的 DLL 分支只在未来的 `outSocket.data` 事件里调用 worker.dispose；`_$onProcessExit` 又对 DLL 跳过系统分支的 flush。`conoutSocketWorker` 建立的管道 server 没有其他关闭路径，只有 worker.terminate 能回收。没有新的输出时，PTY exit 事件已发生但 worker 持续维持事件循环。DLL 天然退出同样复现。基于真实失败，**保持系统 ConPTY 默认，实施可重现依赖修补**；前文的 DLL 候选方案已被本探针否决。

实际使用的 prebuild DLL 与额外 build/Release副本均为 SHA256 `7c7430632052ff703540b68371ec43821820aa1335d8e11dfbcd9ff00e9daaed`，引擎、客户端自身依赖与 client resources相同。未对这些文件作修改。

## 可重现系统 ConPTY 补丁的准确设计

以下是待 R2 结束后实施的方案，尚未创建 applicator 或改变依赖。

### 补丁文件与限定范围

建议持久化在 `scripts/patches/node-pty-1.1.0/`：一个描述文件、两份明确的 JS变换 / patched assets，以及无第三方依赖的 `scripts/apply-node-pty-patch.mjs`。只改生产运行的 `lib/windowsPtyAgent.js` 和 `lib/conpty_console_list_agent.js`，不改 `.node` / DLL / 原生 ABI。`.js.map` 不修改；报告中标记其映射为上游未修改源码，不能把旧 map 当成已补丁的准确源映射。主补丁只针对系统 ConPTY，保持 `useConptyDll=false`。

版本与上游文件的精确基线：

| 对象 | SHA256 |
|---|---|
| node-pty package.json（version 1.1.0） | `f8b6a14f7022c14f1cd5d109486f5dacd32bffb63a9a63e38eced37dacb47439` |
| lib/windowsPtyAgent.js | `8636d16b38266112204061a22b135734177c242837982fd3a4055be726efa64a` |
| lib/conpty_console_list_agent.js | `0d010879bb6680a0253d44363183d53e631f42972594eb6dcb1fb842c8c85e52` |
| lib/windowsConoutConnection.js（本补丁不改） | `1440f70908fb1f55911ac8e936a1230f68a9c00c03096fcef6788eac6aad9d62` |

实施时生成并提交 patched 文件的 SHA256，不能用正则“看起来匹配”代替精确 before/after hash。先读取 / 验证整个目标集的 package name、版本、锁版本、真实路径 / 非符号链接和所有原始或已补丁 hash，未知任意一项则**写入前失败**。写临时文件并原子 rename；全部文件验证完成后原子写 patch receipt。已是 patched hashes则直接校验并返回。已知原始/已补丁的混合状态允许恢复上一次中断，但任何未知内容禁止覆盖。receipt记录 patch ID、版本、每文件 before/after hash、变换资产 hash，不能以 receipt 存在代替实际内容检查。`--check` 模式完全只读。

### windowsPtyAgent.js：先查询，再关闭

默认 ConPTY路径的 `kill` 设置 per-agent closingPromise / killIssued。先完成 `_getConsoleProcessList` 的 bounded查询，再在同一连续执行段终止该控制台已查询进程并关闭 native ConPTY，worker.dispose在 finally保证执行。避免 nativeClose先发生导致helper AttachConsole必然竞态；重复 kill不再启动第二个helper。native关闭、kill未知异常或helper真正失败必须产生明确诊断，native清理仍继续，应用层等待 onExit / timeout判定最终关闭结果。

查询 Promise必须 once-settle，并处理 IPC `message`、fork `error`、helper `exit`（未发message）、deadline。每条路径清除 deadline和监听器，关闭IPC并观测helper实际退出；无message的退出不可再无条件等满原来的5秒。超时应为真实 `PTY_CONSOLE_QUERY_TIMEOUT`，不能静默把 `[shellPid]` 当成查询成功。

若 shell 在发起kill前已自然退出（已收到当前agent native exit）或helper查询错误后父进程确认该shell已不存在，可分类“已退出”；这时仍close native资源但不把 AttachConsole竞态升级为未捕获异常。其他无法确认的 AttachConsole失败 /权限失败 / helper崩溃保持结构化诊断和可观察 stderr，不能 blanket filter。不要在控制台关闭后按延迟裸PID调用taskkill，也不通过私有 `_agent`运行时monkeypatch。

### conpty_console_list_agent.js：错误是 IPC数据，真正未知失败仍可见

native getConsoleProcessList外层try/catch。成功send合法整数PID列表；失败send `{ error: { name,message,code }, shellPid }`。先等待IPC send callback再退出，防止消息没送达即exit。不得从helper直接吞掉所有AttachConsole错误或强制返回成功；父进程结合真实shell退出状态分类，对未确认失败输出受控完整诊断。保留原始错误信息，其他异常不能退化成“无进程”。

主方案不切DLL，也不补DLL遗留worker缺口。本次IDL/DLL失败要保留为明确禁用理由；避免为了备选路径引入额外发布范围。

### 安装、编译、打包与两端校验入口

| 入口 | 必须的行为 |
|---|---|
| 引擎 package.json postinstall | 运行 guarded applicator；root的package `files`必须包含 scripts/patches和applicator，保证npm安装制品后可执行。postinstall不是唯一保障。当前引擎没有postinstall。 |
| `scripts/build.ts` | 在计算build identity之前应用/验证补丁，写入 dist/runtime/dependency-patches.json再编译/生成manifest。`npm install --ignore-scripts`后build也必须补丁；失败不能生成新manifest。 |
| `src/runtime/build-identity.ts` | 当前仅 hash src+package/lock/tsconfig/build.ts，不会自动hash新patchassets；必须将applicator及scripts/patches下内容显式纳入input。补丁内容变化必须改变buildId。manifest可用可选dependencyPatchSchemaVersion/patchDigest表明此构建要求校验，不改HTTP协议版本。 |
| 引擎运行时验证 | 生成的dependency receipt伴随dist；受控制的hash checker在Windows终端spawn前确认实际package/lib hashes，明确拒绝当前build要求的缺失/篡改补丁。checker不能现场修改依赖，真实运行时只读。 |
| SDK `copy-bin.js` | 复制前`--check`源依赖，复制后`--check bin/node_modules/node-pty`。脚本可直接Node执行/调用独立无依赖module，不依赖postinstall是否执行。生成receipt随dist复制；SDK /CDN不能输出未补丁制品。 |
| 客户端自身node-pty | 客户端本地PowerShell PTY也用自己的 `node_modules/node-pty`，engine补丁不会自动覆盖它。保留原`electron-builder install-app-deps`顺序，在其后执行版本/hash guard；client build显式调用guard覆盖ignore-scripts路径。客户端需在仓库内携带同一锁定patchassets，不能依赖运行时访问兄弟engine源码。 |
| client `prepare-engine-runtime.mjs` | source模式在删除stage前只读`--check`已构建引擎补丁；TGZ模式检查解包制品 receipt / hashes，**不在导入时修改不可变制品**。复制完成、生成stage inventory前再次check。 |
| client `verify-engine-runtime.mjs` | 不只检查spawn/native loader；校验node-pty补丁schema/digest/每个生产JS实际hash，与stage receipt一致，并执行实际系统ConPTY创建/关闭烟测。 |
| client runtime import | `import-local-runtime.ts`目前只验证loader/必需文件。新增构建要求补丁时，导入校验读取manifest要求及receipt，校验真实JS hashes；缺失/未知补丁要给用户可读错误。用户明确选择的旧制品仍按旧manifest能力判定，不能伪造升级为新patch构建。 |
| engine/SDK/client parity | 在现有生产dist比较外，新增两个patched lib文件+receipt成对hash；stage完整inventory已有node_modules逐文件hash，应继续全部核对。 |

测试门槛：guard原始→补丁、重复应用不改变字节、未知版本/未知hash/链接越界写入前拒绝、已知中断状态恢复、`--check`不写、ignore-scripts后build补丁、SDK复制前后校验、client自有node-pty与resources相同补丁、import tamper拒绝。补丁行为mock一次查询直到message再nativekill、query error/exit/deadline各once且仍清理、nativeclose异常可见、onExit-beforekill无helper、重复close仅一次。

真正系统ConPTY验收须重新跑7例完整矩阵、20次循环、真实后台子进程、server.close owned终端、Electron本地/远端各5终端退出；追加异步terminal create失败不能报告成功的路由契约。成功标准是“终端退出+所有owned子进程/worker回收+宿主自然退出+没有未知stderr”，而不是过滤日志后看不到AttachConsole。

## 冻结期间获授权落地的隔离补丁：已通过真实系统 ConPTY

后来主任务授权只新增 `scripts` 资产 / 自测，并将完整 node-pty 包复制到 `.tmp` 后对副本应用；正式 `package` / `src` / SDK / client / `node_modules` / `dist` 仍冻结。本节的实测证明依赖修复本身可行，**不代表产品生命周期接入、两端新制品或正式 R3 已完成**。

实际提交的文件：

- `scripts/apply-node-pty-patch.mjs`：无第三方依赖，导出 `applyNodePtyPatch({packageDir, lockfile?, check?})`，支持 `--root` / `--package-dir` / `--lockfile` / `--check`。
- `scripts/patches/node-pty-1.1.0/manifest.json`、4 个 JS 资产、`node-pty.d.ts` 与说明。最终 manifest SHA256 为 `ccd56c0006cb1b691348f8e748e5debfc2ad317025ea92117a9626665b15602d`。
- `scripts/longrun/node-pty-patch.test.mjs`：独立 Node test runner，使用已被 Vitest 排除的路径。
- `scripts/longrun/conpty-runtime-probe.mjs`：可复用真实 Windows 公共 API 探针；只读检查实际 node-pty 补丁，支持 `--package-dir`、`--node`、`--output-root`、`--modes`。

准确范围比早期的“两份 JS”方案多两个 JS 和类型文件，原因如下：

| 资产 | 必要变化 |
|---|---|
| `windowsPtyAgent.js` | query-before-close、同 agent kill Promise 合并、bounded helper query / exit、原始失败收集、自然退出 worker cleanup。仅系统 ConPTY 接入修复。 |
| `conpty_console_list_agent.js` | catch native / loader 错误并通过 IPC 传给父进程；在 send callback 后退出；排除 helper 自身 PID。 |
| `windowsConoutConnection.js` | 系统模式 `dispose` 返回实际 `worker.terminate()` 完成的同一 Promise，不能把“已调度一个 timer”当成清理完成。 |
| `windowsTerminal.js` | 公开 `onExit` 在 cleanup 完成后触发，并保留错误；独立 `onCleanup` 使没有 exit 的失败仍能被应用观测，旧消费方继续看到 stderr。 |
| `node-pty.d.ts` | 给现有退出 payload 增加可选 `cleanupError`；声明可选 `onCleanup`，兼容非 Windows IPty。 |

最终公开合同：

```ts
interface IPtyCleanupError {
  code: 'PTY_CLEANUP_FAILED'
  message: string
  errors: Array<{ phase: string; code: string; name: string; message: string; stack?: string }>
}
onExit: IEvent<{ exitCode: number; signal?: number; cleanupError?: IPtyCleanupError }>
onCleanup?: IEvent<{ cleanupError?: IPtyCleanupError }>
```

应用必须在创建时订阅这两个公开事件。kill 发出后查询、native close 和 worker 清理的真实错误经 `onCleanup` 可见；若 exit 也到达，则 `onExit` 携带同一诊断。若 query 与 native close 同时失败，不能只等待 exit 丢失原始原因；超时结果也应保留已收到的 cleanupError。应用不接触私有 `_agent`。系统分支 native close 后没有延迟的裸 PID kill，DLL 分支既不默认启用也不宣称通过本修复的验收。

guard 的真实自测 **17/17**，见 `.tmp/conpty-system-patch-tests-20261009.log`：原始→补丁、重复不改字节 / mtime、只读 check、未知内容写入前拒绝、已知部分状态恢复、缺 receipt、未知 package / lock / receipt、链接拒绝、消息与退出后才 native close、同 ID 只查询 / kill 一次、error / 无消息退出 / deadline / 无效消息 / native query 错误仍清理、native 与 worker 原始失败、已自然退出无 helper、已确认 shell 消失才规范化 AttachConsole、真实 worker 完成等待、公开 onExit 延迟和无 exit 时的 onCleanup。

最终实际矩阵使用全包克隆 `.tmp/conpty-system-patch-dependency-09jY33/node_modules/node-pty` 与客户端 standalone Node 24.20.0；所有调用均为公共 spawn / kill / onData / onExit / onCleanup，不启动网络服务：

| 用例 | 结果 | 原始 stderr | 宿主 / owned cleanup |
|---|---|---:|---|
| 空闲关闭、重复 public kill | 通过 | 0 | 自然 exit 0，无残留、无强制回收 |
| 创建后立即关闭 | 通过 | 0 | 同上 |
| 持续大输出关闭 | 通过 | 0 | 同上 |
| 真正 Node 子进程持续写入 | 通过，关闭后写入停止 | 0 | 同上 |
| 自然 exit 7 | 通过，保留 exit code 7 | 0 | 同上 |
| helper 原生查询失败注入 | 通过，公开事件报告 `PTY_CONSOLE_QUERY_FAILED` | 127 bytes，完整保留注入原始 stack | 同上 |
| helper exit 19、无消息 | 通过，报告 `PTY_CONSOLE_HELPER_EXIT` | 521 bytes，完整保留 | 同上 |
| helper 超时 | 通过，报告 `PTY_CONSOLE_QUERY_TIMEOUT` | 497 bytes，完整保留 | 同上；helper kill 后实际 exit 已观测 |

正常 **5/5**，真实故障 **3/3**。失败用例的“通过”指准确报告失败并回收资源，绝不指关闭被当成成功。每例恰有一个公开 cleanup 事件。证据：

- `.tmp/conpty-system-patch-20261009-csTPvi/result.json` 与 `.tmp/conpty-system-patch-final-probe-20261009.log`。
- `.tmp/conpty-fault-helper-native-error-20261009-jCvysV/result.json`。
- `.tmp/conpty-fault-helper-abrupt-exit-20261009-RTTwfl/result.json`。
- `.tmp/conpty-fault-helper-deadline-20261009-HlwItO/result.json`。
- `.tmp/conpty-system-patch-final-owned-audit-20261009.json`：08:48:32 对 8 例共 **33** 个 PID + CreationDate 身份复核，匹配存活 **0**。

额外“shell 不写任何首屏业务内容”的隔离用例也通过，证据 `.tmp/conpty-silent-startup-20261009-9osFzZ/result.json`。ConPTY 自身仍产生 121 bytes 初始化控制序列，因此此结果准确含义是无业务输出启动，不能声称底层绝对零字节。此例是最终 onCleanup 增补前的资产；不冒充最终矩阵。

可复用探针本身对最终副本空闲关闭 **1/1** 验证通过，证据 `.tmp/conpty-runtime-YVem6B/result.json`；它要求 guard 完整 check，失败 case 退出码非 0，并保留全部 stdout/stderr，不能通过过滤 stderr 得到通过。

冻结解除后仍须完成前述应用 / HTTP / server close / client dispose 生命周期、安装与 build guard、SDK 与 client 准备 / 导入校验；再生成新的构建 ID 和 TGZ、完整复制依赖、hash 同步，并运行实际打包终端、HTTP server close 与 Electron 两端验收。旧 R2 没有 node-pty 补丁 receipt 的覆盖，不追溯改写成已覆盖。
