# 两端同步与五会话开发的最终验收记录

## 当前状态（2026-10-09）

引擎、SDK、客户端内置引擎已编译和同步，引擎分页修复版全量回归通过。正式 R3、R4 都 **未通过**：各 49/50 阶段合格。R4 终态客户端历史恢复通过，两个项目在正式轮结束后的独立修复源码上通过浏览器 / HTTP 验收。修复后的结果不能倒算为原 Agent 轮次成功。

客户端账号身份切换和终端字号恢复已修复，R3 冻结包下最终完整回归 764/764 通过。新分页修复包已编译同步且真实五会话历史恢复通过，R4 增量开发正在正式运行。R4 活跃客户端复查另发现会话模型串用：API 的实际模型正确，但打开 Qwen 会话后的输入栏可能沿用全局 DeepSeek，续聊会显式发送错误模型。客户端正在按引擎来源和会话恢复模型并补真实发送验证，因此不能把早先 active helper 的通过解读为全部参数同步通过。本文继续补充终态结果，未完成项不计为通过。

正式并发及重放使用隔离端口 12499，模型配置从用户模型库只读复制。15:33 UTC 只读检查发现本机 12323 / 12366 都无监听；真实客户端配置是 embedded、preferredPort=12366。12323 仅出现在保存的远端地址中。没有足够日志确认无监听的原因，不宣称常驻服务正在运行；测试未重启用户服务或修改用户配置。

## 保留项目和实际模型

根目录：`D:\dev\ai-agent-engine\test-projects\longrun-20261009`。源码、合同、测试、真实操作数据、失败尝试及数据库保留。

| 项目 / 职责 | 根运行 actualModelId | 温度 | 思考 | 记忆 |
| --- | --- | ---: | --- | --- |
| ops-board / domain | qwen3.8-flash | 0.2 | 关闭 | 关闭 |
| ops-board / view | qwen3.8-flash | 0.5 | 关闭 | 当前会话 |
| ops-board / storage | qwen3.8-flash | 0.1 | low | 全局 |
| ledger-api / domain | deepseek-v4.1-flash | 0.15 | 关闭 | 当前会话 |
| ledger-api / API | deepseek-v4.1-flash | 0.35 | low | 关闭 |

三会话共享 ops-board、两会话共享 ledger-api。每角色十个累计阶段，共五十阶段。父 Agent 必须执行指定 Node 测试、当前实现只读子评审、评审后复测、驱动独立复验。合同 / 测试 / manifest / 职责范围受保护。实际模型取 root 的 actualModelId，不能只看请求设置。

## R3 历史冻结构建和全量测试

R3 冻结 buildId：`sha256:8b7556358c696b626c3172d4b1e2dcd744b5053d173ded4c170764d711f93c75`。后续真实重放发现通用分页缺陷，现已使用文末 1038e372 新冻结包；不得把修复倒算入 R3。下表和本节 TGZ 哈希仅属于 R3，旧包已归档。

TGZ：`release/agent-engine-2.0.0-win32-x64.tgz`，SHA256：`E86EC132ED340B7ED3ECD2557747CE4D7DD6818261681388CD67408EC390C947`。

client stage：`D:\dev\aether-code\resources\engine\win32-x64`。Engine / SDK / stage 的 ConPTY 补丁和 receipt 一致；patchDigest：`ccd56c0006cb1b691348f8e748e5debfc2ad317025ea92117a9626665b15602d`。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 引擎 TypeScript、node-pty receipt / targets | 通过 | 最终双端 parity 命令输出 |
| 最终引擎全量 | 130 文件通过、1345 项通过、1 项已有 Windows 文件名 skip | `.tmp/final-engine-full-fixed-20261009.json`、`.log` |
| 失败夹具六专项 | 77/77 通过 | 专项执行日志 |
| analyzer / driver / artifact identity / project UI | 49/49 通过 | 脚本回归输出 |
| Engine / SDK / stage 一致性 | 285 生产文件、570 次比较；17662 stage 文件校验，无差异 | `.tmp/two-end-artifact-parity-20261009.json` |
| 真实 stage ConPTY 启停 | 五场景通过、stderr 0、残留 0 | PTY 诊断报告与真实 stage 探针 |

引擎全量原失败保留在 `.tmp/final-engine-full-20261009.json`。六类旧夹具未显式设置 `AUTH_ENABLED=false`，authenticated workspace manager 拒绝不可信 ctx 路径；meta exact keys 未同步 dependency 字段。仅修夹具和字段期望，保留安全边界断言，没有放宽产品认证。

客户端开发 `node_modules/node-pty` 不属于 engine stage，不与已同步 stage 的补丁身份混淆。

## R3 正式轮次：严格失败

证据：`test-projects/longrun-20261009/runs/run-20261009T102756447Z-rkLZAC`。

| 指标 | 结果 |
| --- | --- |
| 正式预算 / 总时长 | 120 分钟 / 含客户端等待约 132 分钟 |
| 阶段 | 49/50；ops-view 9/10，其余四会话 10/10 |
| 尝试 | 61 次：49 合格、12 拒绝，失败重试保留 |
| 子 Agent | 92 个；5 个历史失败 |
| 五 root 同时 running | 591600ms（9 分 51.6 秒），排除依赖等待和独立复验 |
| active health | 3600/3600 成功；p95 约 17.44ms、最大约 60.36ms |
| 启动 health | 4 次失败保留，启动期不计 active 门 |
| 数据库 | 三个 native libSQL 库 integrity / quick / FK / 终态检查通过 |
| 包身份 | 开始、约 30 秒采样、终态均无漂移 |
| 资源采样 | start 1 / sample 1571 / stop 1；active sample 1440，无 sequence gap，每样本含子进程 |
| 进程树峰值 | RSS 约 1.5687GiB / private 约 1.5498GiB / 10 进程 / 2102 handles / 205 threads |
| 清理 | orchestrator exit 2；cleanupConfirmed=true，剩余进程 0 |

资源仅引擎进程树，包含数据库与 Agent 命令子进程，不包含 Electron 和驱动独立复验。五秒采样无法捕获两样本之间生灭的短进程，不推出最大服务器容量或长期无泄漏。

S10 attempt0 在 20 分钟截止取消，最后 app.mjs 重复 const state 导致 SyntaxError；attempt1 同样截止取消，15 项测试 14 pass / 1 fail，创建表单 INVALID_DUE_AT。第三次因总预算截止未派发，两 root 均 cancelled。原证据为真实模型工具循环，没有证据归因上游断流。

active Electron 验收 `client-live-20261009T103004056Z` 通过：10 次选择、rendererErrors 0。原终态验收 `client-live-20261009T123915980Z` 失败：2 次选择、rendererErrors 0。历史数据源错误修复不改写原报告。

## 证据分析和历史验收修复

默认 command retention 为每会话 100、全局 500、7 天。S10 大量命令清理 ops-view S1–4 DB rows，旧 analyzer 因缺 DB 证据额外误拒绝。archivedCommandEvidence 仅在 DB 缺 row 时启用，并同时核验原 snapshot、原 SSE toolCall / toolEnd 准确输出和测试计数、DB root 的 run / turn / session / model / time；有矛盾 DB row 不允许绕过，driver 自报不能当证据。15/15 回归通过，含 21 项负向 mutation。

重分析恢复 R3 为 49 合格，整体仍 failed。人工修复后另报 app.mjs changed after final acceptance，这是正确的外部改动记录。

压缩快照 history 是 assistant 40 / tool 40 / summary 1 / user 0，不是用户历史删除：完整 JSONL 归档有 12 条真实 user，最新 S10 ID 与 DB root 一致。客户端脚本改为分页 archive、核对 cursor / total / 重复、精确 root userMessageId / turn / session；显式加载直到真实 user 行可见，摘要不能代替。两长历史核对全量用户 ID、S1 / S10、turn、reload。4 项 contract / JS 检查通过，真实 copied replay 待执行。

## 两项目当前源码验收

外部修复 ops-board app.mjs：空日期映射 null，YYYY-MM-DD 映射 ISO UTC；重绘保留 filter toolbar DOM，避免筛选清空、焦点 / 输入法丢失。bootstrap.mjs API origin 从空字符串改为当前浏览器 origin，修复实际浏览器初始化失败。原 app / bootstrap 备份于 `.tmp/ops-s10-repair-20261009`，保护测试 / 合同 / manifest 未改。

当前源码 ops-board 49/49、ledger-api 36/36 通过，真实 Chromium browserErrors 0、cleanupConfirmed=true：

- ops-board 创建、编辑、过滤、完成、删除、reload、服务重启持久化、390px 布局。
- ledger-api catalog 创建、checkout、幂等重放、oversell 拒绝、fulfil、服务重启持久化。

证据为 R3 下独立 `current-project-ui-acceptance.json`、`current-project-uis/` 七截图和操作日志；scope 明确为人工修复后当前源码，**不认证原 Agent 轮次**。真实 task / product / order 保留。

## 客户端 R3 冻结包下的完整回归

真实故障顺序：logout 200 → terminal DELETE 401 → browser unregister DELETE 401。旧凭据先撤销，清理失败冒泡，已提交退出被显示为失败。现在切换前使用旧凭据 abort streams、并行清理 terminal / browser，再提交身份；清理 best-effort，保留待重试资源归属。登录 / 注册 / 外部登录同样覆盖。

客户端已重新 typecheck / build，engine-import 独立 9/9 通过。新增恢复来源断言曾误假定开发 Electron 用 bundled，实际是 dev-sibling；改为导入前真实启动记录默认 snapshot，恢复后精确比 source / entry / buildId。错误验收轮保留为失败。

终端字号 12→20→12 恢复少一行也是实际缺陷：DPR=1.25、host 高度不变，xterm 按旧 rows 四舍五入 canvas 后反算 cell height，一次 fit 只得到 11，下一次应为 12 却无 host 变化触发。以 public proposeDimensions 做最多四次有界收敛，只发送最终 PTY resize；保留严格原行数断言，不读取 privateCore、不扩大容差。独立四用例及完整轮均通过。

旧冻结 8b755 基线完整轮 `.e2e-tmp/client-converged-final-full-20261009.json` 为 **764/764 passed、0 failed / skip / not-run / flaky**，workers=1、retries=0、13.3 分钟。入口分类：405 纯契约、326 真实 Electron、33 本机 API / 进程。它证明本轮覆盖的客户端行为，不抵消另行真实重放发现的通用归档分页故障。新 1038e372 包需另行完整轮和实际历史恢复验收。

详情见客户端 `docs/test-reports/2026-10-09-account-identity-lifecycle-fix.md`、`2026-10-09-terminal-dpr-fit-fix.md`、`2026-10-09-client-converged-baseline-full.md`。旧 JSON 保留；早期默认 Playwright output 的 trace 可能被重跑清理，不宣称每轮旧 trace 都存在。最终轮采用独立 output 目录。

## 后续门槛

成熟代码已全绿，原五十阶段重跑可认证真实模型复验与并发，但本身不保证新开发。R4 正在准备独立新增红测试、明确 Agent 需求、owned 源码变化及新功能通过门禁；保留旧断言和源码，不为凑运行时长重置项目或伪造负载。

R4 合同已准备：ops-board 保存视图的纯函数 CRUD、持久化 CAS、真实 UI 和 bootstrap 重载；ledger-api 低库存查询、批量盘点、事务原子性、幂等、预留库存边界及多 repository 并发。最终独立测试计数为 ops 65、ledger 112；ledger 两角色各重复旧项目 36 项基线，因此 177 次最终执行不等于 177 个独立用例。旧 85 项继续全部通过。五角色 S1 基线均完整红、无 skip / cancelled / todo，不以缺模块加载失败代替新功能缺失。

### 重放新发现：通用 HTTP 分页

copied replay `replay-20261009T133202395Z-TAwmA9` 在第二个会话发现归档页重复，rendererErrors 0。原库及复本 session2 JSONL 均为 1158 个 message UUID、全部唯一。故障发生在 paginateArray：HTTP pageSize 为字符串，start + pageSize 拼接。旧冻结 helper 实证第一页 200、第二页 958、第三页 758；第二 / 三页重复 758。原状态 484 个文件哈希不变、owned remaining 0，失败副本保留。

已修为先归一化正整数再计算全部边界，非法 / 溢出参数返回明确业务失败；数值调用和无分页读取兼容。真实 Fastify HTTP query 六页完整恢复 1158 行，无漏行 / 重复，边界与非法参数三专项通过。新源码全量 131 文件、1348 passed、1 已有 Windows 平台 skip、0 fail；证据 `.tmp/final-engine-pagination-fixed-20261009.json`。旧冻结复现 `.tmp/pagination-original-frozen-20261009.json`，旧 TGZ 保留 `release/archive/agent-engine-2.0.0-win32-x64-8b7556358c69.tgz`。等待当前客户端旧冻结全量结束才重编 dist / TGZ / stage，保证每轮只用一代产物。

AUTH_ENABLED=true 多租户 Cron 内部派发仍有明确设计缺口。需可信 dispatcher 绑定 job.tenantId 及同租户 session / agent / model / workspace，完成跨租户负向验收。单机 token 修复没有绕过账户认证。详见 `2026-10-09-two-end-runtime-sync.md`。

### 新冻结包、真实历史恢复与 R4 启动

新 buildId：`sha256:1038e372195972f9a7277f14933d69e8b20fa56a958d91d4a28af9cb7f0f1fcb`。TGZ SHA256：`904F3C09FAD300AA893940D2FB02F924E21C3C8BE9EAF9C58D2F8BE78F306CCD`。Engine / SDK / client stage 的 285 生产文件、17662 stage 文件一致，无 mismatch / inventory change；独立证据 `.tmp/two-end-artifact-parity-r4-20261009.json`。SDK 五组真实运行通过；client stage Node 24.20.0 / ABI 137、50 SQL transaction / commit / rollback / reopen / memory scope、codegraph 生命周期、PTY 原生校验通过。

正常完整 copied replay `replay-20261009T140101921Z-Tr3tPI` **通过**：selected 10、reloadRecovered true、rendererErrors 0，五会话完整用户消息顺序 / ID / 每条 turn 全部核验。归档数量分别 142 / 1158 / 404 / 124 / 246，共 2074 条；61 条 user 精确恢复。S2 六页 200×5+158、S3 三页 200+200+4，无重复或遗漏，并实际点击压缩历史入口。原 R3 全部 484 状态文件 hash unchanged；cleanup remaining / errors 均空。该重放仅认证修复包的复制状态恢复，不认证原 cancelled S10。

R4 正式目录 `runs/run-20261009T140435168Z-Qy9TUP`，实际客户端 stage 新冻结包，显式 `LONGRUN_MANIFEST=manifest-r4.json`、`LONGRUN_OTHER_MODEL=deepseek-v4.1-flash`、120 分钟 / 每尝试 20 分钟 / 最多三次。五 S1 同时启动，新功能完整红基线先于所有模型请求，要求 owned 源码相对基线改变且新测试通过。每次 fresh review / parent 复测 / 独立复验、旧基线、角色保护与五路实际 running 重叠门不变；终态仍需真实客户端及项目 Chrome / HTTP 验收。

14:25 UTC 的尝试层只读快照为 34/50 阶段：ops-domain 10、ops-view 9、ops-storage 2、ledger-domain 10、ledger-api 3。ops-view S6 attempt0 因八次 EDIT_INVALID_ARGUMENTS 触发 REPEATED_FAILURE，attempt1 已恢复；子评审也出现 MAX_STEPS 后重派恢复，均保留原失败。八次编辑拒绝均为模型复用少四位的 expectedHash（60 位 hex），在文件锁及 CAS 之前拒绝；正确返回值为 64 位 hex，没有证据证明并发文件漂移或工具写入故障。顶层 errors 为空不能证明所有尝试通过。此处仅是运行中快照，实际计数和失败分类以终态独立分析为准。

### 会话参数同步的实际范围

R4 的五会话驱动分别显式请求三 Qwen / 两 DeepSeek，实际 root 模型必须由终态独立分析确认。客户端目前发现的模型恢复问题要求覆盖来源隔离、会话正反切换、迟到响应、刷新、手动选择、外部新 run、加载中快速发送及同会话队列。

memoryScope 已通过来源 / 会话 / generation 守卫恢复，未完成加载时不发送错误全局值；引擎省略时使用已存会话设置。agentId 首次绑定后由服务端约束，temperature 来自绑定 Agent，客户端没有温度输入。thinking 原来是全局偏好；当前公开 RootRun / snapshot 不返回 thinkingMode、subagentModel、utilityModel 等请求参数，所以不能声称外部创建的会话已完整恢复这些参数。完整且不含凭据的参数回读契约需后续设计和双端测试，正式 R4 运行中不改冻结引擎。

客户端最新会话模型修复已经 typecheck / build、31/31 汇总专项通过。它覆盖 requested 与 actual/fallback 区分、来源 / 会话 / anchor run、快速发送时迟到快照、手选刷新与队列隔离。已有模型不在目录时保留 ID，不静默改选首项；目录不含 env-only 模型，isEnabled 也不是既有主 chat 调用权限，因此没有新增客户端单方阻塞。合法空 requested / “当前配置 of AI”保留引擎默认语义，发送省略 model。最终 out 下 active 验收 `client-live-20261009T145423302Z` 再次十次选择和刷新通过；终态和新完整轮仍待完成。客户端详情为 `docs/test-reports/2026-10-09-client-session-composer-fix.md`。11937、15361 两个中间完整轮因发现真实问题主动中断，均不计全套通过。

### 实际记忆告警与语义降级

截至 14:57:48 UTC，engine.err.log 的 “Failed to generate embedding for memory node: Embed not supported by underlying adapter” 精确出现 85 次。实际端点声明 Anthropic 协议，factory 优先创建 AnthropicAdapter，底层没有 embed；RetryingAdapter 始终暴露 embed，提取器因此尝试并失败。不能归因为 Qwen / DeepSeek 模型族天生没有向量能力，也不能为解决此问题擅自切换聊天协议。

使用本轮 packagedRoot 的 native libsql、mode=ro 与 query_only，仅聚合而不输出记忆正文：85 个节点正常落盘，session2 / session scope 43、session4 / session scope 29、session3 / global scope 13；embedding_json 和 native embedding 非空均为零，part_of 边 49、reinforces 边零。错误 catch 后继续 createNode，未导致保存丢失。

自动 recall 缺查询向量时降级为 summary / detail 的 LIKE 关键词匹配、importance 排序（最多十五锚点）及 scoped 图扩展，再按 importance / strength 排序；没有自动“近期记忆”或全体高重要度兜底。JSON cosine fallback 只补数据库 vector 扩展缺失，不能补缺查询向量。tenant / scope / session 谓词仍独立应用；此次现象不证明隔离失效，但本轮**完整语义记忆召回未通过**。

后续需要让提取与召回共用独立 embedding client，显式配置模型 / 端点 / 凭据，并约束模型身份与维度一致，随后对无向量节点做可恢复回填和真实语义召回 / 隔离测试。当前 EMBEDDING_* 只由 OpenAIAdapter.embed 消费，在 Anthropic 路径仅添加环境变量无效。单纯修 capability 探测只能抑制无效调用及重复告警，不能称语义功能恢复。

4–5 小时和 7×24 小时任务在项目根 BACKLOG.md，尚未完成，不用两小时预算或五路重叠推导已验证。未生成发布安装包、未强制切换正在运行的客户端 / 服务。R1 / R2 原失败和修复依据继续保留于 pressure / runtime sync / PTY 诊断报告。

## R4 正式终态与结束后修复

正式目录 `runs/run-20261009T140435168Z-Qy9TUP`，14:04:35–15:20:46 UTC，含收尾 76.19 分钟。Driver / orchestrator 都 exit 2。49/50 阶段：ops-view 9/10，其余四会话 10/10；54 attempts 中 49 qualified、5 failed attempts；79 child runs、6 历史 failed child。五 root 实际 running 重叠 426706ms（7分6.706秒）。active health 2124/2124 成功，p95 17.39ms、max 118.02ms；startup 1 失败、cleanup 3 失败另记。

905 资源样本、active 849；进程树峰值 RSS 955592704B、private 945180672B、6 进程、1437 handles、189 threads。独立 sequence 检查记录于 `resource-sequence-acceptance.json`。18 条短进程退出时读取诊断保留，未判 fatal。144 次周期构建检查及终态无漂移，原三库完整性通过，cleanup confirmed，remaining/errors 都空。正式独立结论封存为 `independent-acceptance.original.json`，不会用当前源码重分析覆盖。

失败证据：ops-view S6 attempt0 将合法 64hex hash 抄成 60hex，8 次 EDIT_INVALID_ARGUMENTS 后 REPEATED_FAILURE，retry 成功。Ledger API S10 attempt0 的 root succeeded、源码与父测试通过，但 reviewer B MAX_STEPS failed，严格拒绝；retry 补有效评审后通过。Ops view S10 三次全部 REPEATED_FAILURE：首次合法编辑把 `app.mjs` 括号写坏且导入未公开 attr，之后 23 次无效编辑（22 次坏 hash、1 次漏 hash）均未更改文件，最终三个尝试都是模块加载失败 0/20。

正式结束后仅修 Ops `app.mjs`、`bootstrap.mjs`，补齐保存视图 CRUD 事件、错误保留、重复提交保护、destroy guard 和真实 localStorage。原坏源码封存于 `.tmp/r4-source-before-correction-20261009`。修复后 node --check 两文件通过，View 20/20、Ops 完整合同 65/65。app SHA256 `879FE8FDADB72EC81BADB5EE84D2A1D71427627D522309CFD00F7AC67719618F`；bootstrap `5BEC5291A382CCC8C81AB92098EE4481DCBCC09DBDA3CCBD7E505E3EBC8ED89E`。

`verify-project-uis --current-projects` 真实 Chromium / HTTP 通过，browserErrors 0、cleanup confirmed；Ops 保存视图新增 / 选择 / 重命名 / 删除 / 重载及 CAS，Ledger 库存调整幂等 / 重启持久化都实际执行。scope 明确为当前独立修复源码，不认证原 R4。证据 `current-project-ui-acceptance.json` 和八截图。

R4 终态真实 Electron `client-live-20261009T152017124Z` 恢复通过：794 归档消息、54 user，每条 turn / requested / actual / composer / workspace 归属核验，79 child 和 106 command jobs 归属核验。S2 为真实 200+14 两页，S3 点击压缩归档入口，不声称五会话都多页。S2 failed 原样保留。客户端完整首轮为 743 passed、4 failed、42 serial not-run，不计全套通过；旧全局偏好断言与隔离契约冲突、固定 smoke profile 遗留进程锁已定位并保留证据。修正后 50 专项通过，新 789 完整轮仍运行。

## 用户追加的六小时续测准备

MiniMax-M2.5 / glm-5.3 / kimi-k2.6 同一已有 HTTPS 网关的 completion 与 tool_calling 预检都通过，returnedModel 精确一致；证据 `runs/continuation-gateway-preflight-20261009T153449756Z.json`。该结果只认证协议，实际引擎开发另验。

从停止的 R4 完整复制 418 文件到 `runs/continuation-20261009T155024884Z-nu9BFy`，保留五原 session ID、两原项目、JSONL 和原记忆；新副本五参与模型统一 contextWindow=100000、memoryScope=session，原文件哈希保持。准备交叉轮换、持续需求、重启检查点、反复自动压缩和隐藏答案的历史决策探针。六小时计时尚未启动。

新增 search_history 明确只检索执行上下文的本 tenant/session，按关键词或准确 messageId 分页恢复压缩前原文，保留编辑/删除语义；JSONL 两遍流式检索，不整文件建立原文数组。归档模式压缩分段处理所有内容，层级汇总、旧 digest 不逐字嵌套、实际 system 原文保留。非归档后端继续原约束保留策略。65 个检索 / 压缩 / 权限与旧回归专项通过；独立 embedding 服务与空间身份 / 回填修复仍待统一全量和同步。当前没有真实 embedding 配置，语义召回不计通过。
