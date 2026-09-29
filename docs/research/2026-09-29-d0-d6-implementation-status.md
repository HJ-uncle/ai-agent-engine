# D0–D6 实施与阶段验收记录

用户要求：D0 到 D6 全部实施，每一阶段通过测试后再进入下一阶段。每阶段两仓联动，保留用户已有工作。

实施起点：E `770090dbd9f4857e6bb11c0d1ceef3db8c5b27d5`；F `d642ac92356aec2fda30fd93370fcc4d9fe9380e`（用户已提交上一轮前端改动）。基线与测试输出位于 `.e2e-tmp/d0-d6-evidence/`。

| 阶段 | 状态 | 验收 |
|---|---|---|
| D0 运行时/身份/状态目录/密钥迁移 | 已通过 | E 411/411；F 13/13；两仓 build 通过 |
| D1 局部高收益修复 | 已通过 | E 448/448；F 63/63；两仓 build 通过 |
| D2 文件回退与版本检查 | 已通过 | E 487/487；F 16/16；两仓 build 通过 |
| D3 根运行身份/审批/终态 | 已通过 | E 535/535；F 28/28 + 最后影响范围 8/8；两仓 build 通过 |
| D4 快照与事件恢复 | 已通过 | E 580/580；F 51/51；两仓 build 通过 |
| D5 真流式/fallback/上下文 | 已通过 | E 627/627；F 48/48；两仓 build 通过 |
| D6 精确编辑工具 | 已通过 | E 658/658；F 64/64；两仓 build 通过 |

仅按授权清理确定的引擎开发状态；项目源码与其他应用数据不属于清理范围。密钥与模型凭据迁移验证成功前保留旧副本。测试使用隔离目录、本地可控模型服务及单 worker Electron。

## 初始基线

开始时全仓 Vitest：370 passed / 1 failed / 15 skipped，另有一个控制台测试文件因缺依赖无法收集。失败是原有 sandbox 测试仍要求旧错误文案；已保留“越界必须拒绝”断言并允许当前 `outside any bound workspace` 文案，单文件7/7通过。控制台缺少其已声明的 `@testing-library/react`，本轮阶段引擎回归会明确排除独立 `multi-agent-console` 项目；实际消费者 Aether Code 单独构建并真机验收，不把控制台未验收算作通过。

## D0 验收

- 两仓构建通过；E buildId `sha256:186764b5cbe4a7ddd254f7e244f647e53cb4a51c757e71016b0f04c9eb703f66`，协议 1，实际入口 `D:/dev/ai-agent-engine/dist/main.js`。
- E：`vitest run src/ --exclude 'multi-agent-console/**' --exclude '.e2e-tmp/**' --fileParallelism=false`，43 文件、411 测试全部通过。
- F：`engine-storage-contract`、`engine-host-contract`、`subagent-lifecycle`，单 worker 13/13 通过。覆盖占端口不 adopt、实例认证、停止启动竞态、协议拒绝、HTTP/SSE、子代理取消与重启回放。
- 原子代理历史测试按 F 现有空会话占位行为改为精确选择根会话，仍严格断言后端只列根会话，不把本地占位算作持久会话。
- 迁移采用隔离合成数据验证：只迁移模型连接、能力覆盖和必要配置；密文使用原密钥验证，无会话历史迁移。真实用户状态未清理，下一次真实启动按新目录执行幂等迁移。
- 完整输出：`.e2e-tmp/d0-d6-evidence/D0-{engine-build,engine-tests,frontend-build,frontend-tests}.txt`。

## D1 验收

- 模型 API 区分 `capabilityOverrides` 与 `resolvedCapabilities`；旧 `capabilities` 仅保留读别名及同语义写入口。更新使用 SQLite `json_patch` 原子合并；省略保留、单项 `null` 恢复推断、整体 `null` 清全部覆盖、`false` 显式关闭。前端表单只提交实际改动。
- Anthropic/Ollama 保留压缩摘要；原生 Ollama 不再被模型家族名误路由到其他协议，能力声明受实际 adapter 实现约束。
- 诊断采用独立并发池与明确终态。F 问题面板区分不支持/失败/完成，取消或关闭文档清理状态，过期请求不得覆盖新请求。
- 安全状态按 session 和请求代次隔离；未知状态不显示成 safe；standard 的工作区外读写语义明确展示。
- 联查补齐 D0 的 remote 条件：未建立共享工作区约定时，实验性远端只允许引擎/模型/工具信息读取，主进程拒绝文件、诊断和聊天执行，避免把 IDE 本地路径发送到另一文件空间。
- E buildId `sha256:6e221d9e109f332baba242369706aa1593bde6a767750f7b9a71e8f1d94fc19e`。E 49 文件、448 测试全部通过；F 11 个 spec、63 测试全部通过，包含真实模型表单、诊断、会话切换、安全模式写入和 owned 引擎异常退出/重启。
- 两仓 build/typecheck 通过。详细输出：`.e2e-tmp/d0-d6-evidence/D1-{engine-build,engine-tests,frontend-build,frontend-tests}.txt`。
- 限制：TypeScript 编程 API 仍同步运行，取消检查位于调用前后；CLI 路径有取消和 30 秒超时。此次未扩展为语言服务器 worker 架构。

## D2 验收

- 公共规范文件路径锁与完整字节 hash；不存在文件采用 `missing`，区别于空文件。Agent write/delete 和手动 workspace REST 写入共用锁；记录读取真实磁盘输出，而非工具输入的未格式化内容。
- 文件写入部分失败仍记录已发生的改动并返回失败；记录失败明确说明文件已变更但无法从面板回退。delete 只支持普通文件，拒绝目录及直接符号链接，成功后才记变更；不建设目录快照回退。
- 服务端 `/changes/revert-batch` 按会话/明确 ID/时间范围筛选完整集合，文件锁内按操作顺序逆序回退；冲突保留文件并给逐条结果。消息级时间范围在 D3 接入稳定 turnId 后替换。
- 前端全量撤回不再并发请求当前列表的单条快照；部分失败时保留对应会话历史。修复托盘初始无任务时不会挂载变更查询的问题。

- D2 E 52 文件、487 测试全通过；F 16/16（10 合同、3 撤回真机、3 子代理生命周期）通过。两仓 build/typecheck 通过，E buildId `sha256:97f38337cdbc31b37272840500249e0e184be16f6ed5580c99efe77f4bd51530`。

## D3 验收

- 轻量 root_runs 持久化稳定 run/turn/user/assistant ID、seq/version、待应答及真实终态。请求答案原子 claim；相同答案幂等，冲突答案拒绝；原模型/工作区/profile 恢复，密钥不落运行记录。
- 内部 attemptId 阻止旧执行分支改写新状态。停止覆盖已运行、已批准尚未执行和还在准备中的请求。重启只把运行中标为 interrupted，不自动重放副作用；等待中的请求可恢复回答。
- 工具批次先全部登记与预检；只读/子代理组可并行，其他串行；等待时未执行兄弟标 interrupted；所有已启动结果持久化后再发终态帧。原调用审批通过后直接执行一次，不要求模型重新调用。
- 同进程 history 操作串行；删除/截断必须指定并核验 session，修改期间阻止新运行和审批恢复，迟到写入不能恢复已删除消息。自动/手动压缩与反馈写入同一锁。
- code 模式的命令、扩展、网络策略统一，safe 不提供无法约束扩展的虚假批准路径；RAG 在检索 SQL 内按绑定文档 ID 过滤，code 未请求时不自动全库检索。
- 前端接入稳定 ID、pending/outcome/metadata，消息撤回使用 fromTurnId。第一轮 Electron 检出实时 ID 回填的 React 可变引用竞态，已修正，待复跑。
- 当前 E 完整 57 文件、535/535 通过。F build 通过；第一轮 F 中 D2 及子代理回归 16/16 通过，D3 首项失败导致同组后4项尚未执行，不据此宣布本阶段通过。

- 最终 E 57 文件、535/535；F 28/28（7 root合同、10 revert合同、5 root真机、3 revert真机、3 child生命周期）通过。最终旧流普通工具结果旁路移除后，两仓最新构建并补验 root/child 8/8 通过。E buildId `sha256:0bda622e3c2d313d116f3054adf9fcd77b5c041127db18606f2a4285c886e8db`。输出 D3-engine-tests、D3-frontend-tests、D3-frontend-final-regression 与两仓 build 日志。

## D4 验收

- `/chat/snapshot` 提供当前轮语义投影和同水位游标，历史、root runs、待办、附件引用及文件变更一起恢复；不自动重启模型或工具。审批续跑继承同轮投影。
- StreamBus 使用独立 stream UUID 和递增序号，有界重放（2048 条 / 8 MiB），游标失效明确要求重新取快照；立即订阅避免重放与监听之间丢帧。SSE 和快照共用帧解码器。
- 快照只采用仍属于最新持久 root 的缓存，删除后不会复活旧消息；完成的等待流被取消时，状态与游标一起推进。新轮发布屏障只阻塞快照，不阻塞取消。
- E 最终 59 文件、580/580；F 51/51（40 纯逻辑、5 root 真机、3 child 生命周期、3 recovery 真机）通过，两仓构建通过。E buildId `sha256:0fcca040acdc395229b82fd462b950ef4a402da81b38a9f553a8d0904a8eaa13`。
- 真实窗口验证思考/参数传输中刷新、写入后刷新、结束后刷新及应用重启，附件/todo/diff 完整恢复且模型调用与写入次数不增加；过期游标透传重新取快照信号，停止先取消引擎再断开传输。慢消费者缓冲溢出由 E 单测覆盖，未另建 Electron 人工慢读场景。
- 输出：`D4-engine-{build,tests}.txt`、`D4-frontend-{build,pure,tests}.txt`、`D4-recovery-targeted.txt`。前两次真实窗口失败为新夹具的写文件参数和折叠待办断言错误，已按真实 schema/交互修正并保留原日志；未删断言规避问题。

## D5 验收

- 正文逐 delta 立即发送；工具调用前的正文保留原位，只把 provider 的 reasoning 放入思考区。F 时间线按实际事件顺序分组，历史回放顺序一致。
- fallback 只处理本次请求交付前的可重试错误；正文、思考或工具进度一旦交付就不重放。备用模型使用正确请求 ID，按各物理请求结算一次；OpenAI/Ollama 缺终止帧的断流明确失败。
- `RootRun.modelId` 保留原配置用于应答恢复；`actualModelId`、usage/history.modelId 显示实际输出模型。只收到模型身份尚无用量时显示模型标签，不伪造零用量；失败/取消保存已有内容和推理，上游不提供用量时保留估算标识。
- 上下文按完整 history + system + tools + 实际发送的 maxTokens 预留检查；小窗口默认输出预留受限。压缩自身也检查窗口，共用摘要函数保留 system/user 完整原文；保留后仍过大则明确拒绝。关闭历史继承不会恢复旧摘要。
- 修复 SQLite 压缩重建时遗漏最近消息 turn/model/reasoning/metadata/time 的问题，真实 SQLite 回归验证附件与变更证据不丢。
- E 最终 62 文件、627/627；F 48/48（33 纯逻辑、11 D3/D4/child 真机回归、4 D5 真机）通过，两仓 build/typecheck 通过。E buildId `sha256:cf90eea7ce9ccb84e8d1f738eff839cb32be5be44edd2c8836d2aa84920da60b`。
- 真机验证首段早于 provider 结束、刷新不重新请求、正文→工具→正文顺序、累计 24/59/14 tokens 在 live 与重启回放一致；503 后切备用，流中断后保留部分输出且不切备用。初次真机检出模型标签被零用量条件隐藏，已修复并复验 4/4。
- 输出：`D5-engine-{build,tests}.txt`、`D5-frontend-{build,pure,tests}.txt`、`D5-streaming-targeted.txt`。

## D6 验收

- 新增内置串行 `edit_file`，加入 code profile、OSM 默认工具及模型 canonical schema；实现子代理继承，只读子代理预检和执行都拒绝写入。
- `read_file` 的 `mode: "exact"` 返回纯 JSON：规范路径、完整字节 `expectedHash`、原始 UTF-8 content、换行与 BOM 信息；原文不含展示行号，分页仍用完整文件 hash。精确读取不做文件名猜测。
- `edit_file` 接收 `{path, expectedHash, edits:[{oldText,newText}]}`。所有替换同时匹配同一原文件，各自唯一且互不重叠，全部验证后一次写盘。版本过期、匹配缺失/重复/重叠均明确失败，文件和 ChangeStore 不变。
- 复用规范路径锁、完整字节版本和标准 ChangeStore；不格式化原文件，保留 CRLF、Unicode、BOM。前后均限制为 100,000 bytes 的 UTF-8 普通文本，确保成功编辑可完整审查和回退；二进制、目录及超大文件明确拒绝。写入部分失败时保留真实变更证据。
- F 复用现有工具卡、diff、路径跳转、保留/撤回，不新增一套编辑器。真实模型先读取两个文件、消费返回 hash、调用实际 schema 编辑，live/刷新/重启一致，界面撤回后文件字节完全恢复。另验证人工修改后的旧 hash 失败且保留人工内容，重复匹配导致整个批次零写入。
- E 最终 64 文件、658/658；F 64/64（43 纯逻辑、21 真机：D2 3 + D4 3 + D5 4 + D6 3 + root 5 + child 3）通过，两仓 build/typecheck 和 diff whitespace 检查通过。
- E 最终 buildId `sha256:25b90e97ed46391cb2a65c866ad13ce9fd8e3a431da0fe41253cf78ee9c283f2`，protocol 1，code profile，subagent schema 1。F 开发配对入口为 `D:/dev/ai-agent-engine/dist/main.js`。
- 初次真机 18 通过，2 失败、1 未运行：新增断言未展开过程区；原子代理导出测试在 Windows 写入句柄释放前读文件得到 EBUSY。只修夹具的展开和异步等待，保留磁盘/导出完整内容断言，D6+child 最后 6/6 复验通过。
- 输出：`D6-engine-{build,tests}.txt`、`D6-frontend-{build,pure,tests}.txt`、`D6-edit-child-targeted.txt`。每阶段失败过程也保留，未把失败运行算作通过。

## 最终交付范围

D0–D6 已全部完成，各阶段通过后才进入下一阶段。当前两仓配对验证覆盖真实 IDE 的多文件编辑、差异审查、撤回、取消、审批、刷新恢复和实际模型用量。D7–D9 未实施；没有创建提交或发布制品。

实际用户开发状态未清理，测试全部使用隔离目录和本地可控模型。最小模型连接/密钥迁移保留旧来源、成功后启用新 state/secrets，不迁移历史会话。独立 `multi-agent-console` 因原缺测试依赖未纳入通过统计；本次实际消费者 Aether Code 已单独完成构建和真机测试。精确编辑文件上限与单进程文件锁为本版明确边界，不承诺 shell/MCP 外部副作用回退或进程重启后自动继续执行。
