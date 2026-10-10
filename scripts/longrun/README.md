# 两项目、五会话真实开发验收

本目录通过客户端打包的引擎执行真实模型开发，默认使用独立端口 `12499`。不重启用户服务，不修改用户模型数据库。凭据从已有数据库读取，只在隔离数据库内配置本轮模型。

两个正式项目保留在 `test-projects/longrun-20261009`：`ops-board` 的三个会话使用 `qwen3.8-flash`，`ledger-api` 的两个会话使用已有的第二个模型。每个角色十个累计阶段；角色在同一个项目目录协作，不能修改同事负责的文件、规格或验收测试。

在引擎与客户端完成构建和运行时同步后，从引擎仓库运行：

```powershell
node --test scripts/longrun/project-driver.test.mjs
$env:LONGRUN_WAIT_CLIENT='1'
$env:LONGRUN_MAX_MINUTES='120'
$env:LONGRUN_STAGE_TIMEOUT_MS='1200000'
node scripts/longrun/orchestrate.mjs
```

控制台打印本轮 `root` 后，等正式五个会话已产生历史，在客户端仓库运行真实 Electron 验收。不要同时运行另一个 Electron E2E：

```powershell
node scripts/verify-live-five-session-client.mjs <本轮root绝对路径>
```

编排器等待该脚本写入 `client-acceptance.json`，随后回收它创建的测试进程。项目源码、数据、每次失败和重试、SSE、数据库、资源指标和截图均保留。不要把 `.instance-token`、数据库或原始日志直接发布；报告只引用脱敏证据。

严格通过要求：三次真实模型工具预检；五个根会话的实际 `running` 区间发生重叠；三会话实际模型为 Qwen；全部五十阶段通过保护测试、Agent 自己执行的最新测试、当前实现版本的子 Agent 评审与独立复验；两个项目集成测试无跳过；客户端界面切换及历史恢复通过；数据库与任务终态完整；运行中引擎产物身份一致；进程回收完成。失败后最终修复通过也应保留并报告首次失败。

R2 运行 `run-20261009T073642124Z-qUttIX` 使用每次尝试 8 分钟、总开发预算 60 分钟。`ledger-api` S1 第三次尝试在 8 分钟到期时取消：当前代码独立契约 2/2 通过，S1 的唯一必需评审 A 静态审阅耗时 381053 毫秒后成功且证据新鲜，父 Agent 随后多派非必需 B，拖到取消，没有完成本轮父 Agent 的审阅后测试和成功终态；B 并非 S1 的通过要求。该会话已判失败，不能用放宽预算后的运行覆盖或改称原条件通过。R2 还暴露驱动缺陷：`ledger-api` 失败错误地打断另一个项目等待 `ops-domain` 的 `ops-view`；新的依赖门禁只判断当前阶段真正依赖的角色与阶段，已通过的依赖不会因该角色后续失败而失效。原始 R2 结果和失败日志保留。

R3 驱动与协调器默认每次尝试 20 分钟、总开发预算 120 分钟，仍最多三次尝试；`test-budget.json`、`active-start.json`、`active-report.json` 和 `orchestrator-result.json` 写明实际 `budget`。协调器使用 `LONGRUN_MAX_MINUTES`，驱动直接运行使用 `LONGRUN_MAX_MS`，每次尝试使用 `LONGRUN_STAGE_TIMEOUT_MS`；协调器验证有限正数和计时器范围后把两项具体毫秒数传给驱动，不允许 NaN、Infinity、零或负数进入等待循环。上面的环境变量可用于明确固定本轮条件。新的评审提示限定当前合同、函数与累计断言，评审仅使用只读工具、不运行命令、不扫历史 `.test-data`，结论最多 400 中文字；两个必需评审同批并行，`maxSteps:24` 保留。五十阶段、当前源码的新鲜评审、父 Agent 的评审后测试、保护文件、无跳过和五会话实际并发门禁均保留。新条件下成功也只说明新条件通过，必须与 R2 原失败分别报告。

每次重试前重新检查总预算和停止请求，先等待上一尝试的取消与快照检查结束；到期后不再发起模型请求，避免把死线后立即取消、未实际调用模型的请求当成正常重试。时间预算不是等待目标，不能用等待填满。资源监控统计引擎及其子进程，不包含独立验证驱动或客户端 Electron。该脚本和一次通过不能证明 4–5 小时或 7×24 小时稳定性；继续开发任务见项目的 `BACKLOG.md`，应扩展独立规格与验收并分轮保留证据。

R2 在开发预算截止时，旧协调器先用相同截止时间执行清理，驱动约三秒后才写完报告，客户端等待阶段未开始。R3 保留驱动本身的开发截止，另给协调器最多 60000 毫秒的独立收口宽限，只等待既有请求取消、终态快照、最终集成与报告、driver 自然关闭；超出宽限仍失败并清理，不追加模型请求。生命周期使用 `finalization` 独立阶段，`driver-finalization.json` 和最终结果记录是否使用宽限。客户端十分钟从进入 `client_acceptance` 后独立计时；协调器总截止包含这六十秒。该修复不改变 R2 原条件下报告和客户端验收失败的事实。

最终数据库完整性验收使用本轮 `two-end-build-identity.json` 记录的客户端打包 native `libsql`，连接采用 URI `mode=ro` 和 `PRAGMA query_only=ON`，要求 `quick_check`、完整 `integrity_check` 都为 `ok`、外键错误为空、全部执行状态终结；缺少记录的后端时拒绝回退。内建 `node:sqlite` 不能识别 `libsql_vector_idx` 向量索引，其 memory 兼容检查独立保存且不裁定 native 数据库完整性。R2 已保存此前的 Node 误报报告为 `independent-acceptance.node-sqlite-compatibility-false-failure.json`；正确后端复核三库通过，原 DB/WAL/SHM 的 SHA256 完全不变，整体仍因阶段、集成和界面验收缺失而失败。兼容复核只纠正检查器，不修复或重建原数据库。

R3 产物身份新增 `node_modules/node-pty` 的 `package.json`、生产 JS（`.js/.mjs/.cjs`）、原生运行时（`.node/.dll`）与 `.aether-node-pty-patch.json` 确定性回执的排序内容哈希和 `patchId`；source 与客户端 package、启动、约 30 秒周期和最终检查均覆盖。正式编排要求该包及原生运行时存在，并用 `applyNodePtyPatch({check:true})` 只读核对回执、补丁资产与全部五个声明目标的实际修复后哈希（包括类型目标）；不允许未知内容或伪造回执。只有明确的假 fixture 可记录 `present:false`。文件时间戳变化不算内容漂移，测试、fixture、source map 和声明文件不计入生产指纹，但补丁声明的类型目标仍受回执验证。R1/R2 已启动进程使用旧身份监控，未覆盖此依赖和回执；它们的报告应显示 `nodePtyCovered:false`、`nodePtyPatchCovered:false` 并保留历史限制，不得用新脚本推定旧运行已检查。
