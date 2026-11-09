# 内置 Agent 团队实现核查与逻辑审计

日期：2026-11-09。审查对象：`D:/dev/ai-agent-engine` 与 `D:/dev/aether-code` 的当前工作树，包含尚未提交的修改。本轮只做调研、隔离验证和报告，没有修改产品或原测试代码，没有启动/重启用户应用，也没有操作真实会话数据库。

## 结论

**三类内置 Agent 的核心功能已经实现，不再只是方案。** 引擎 HEAD 为 `76b792e10416e72367375c4a1177205fc6a6273b`（2026-11-06 19:06，新增内置团队代理与协作工具），前端核查时 HEAD 为 `4c83749`，两仓都有后续未提交修改。

实现包括三角色模板、多实例身份、持久子代理目录、完成后续跑、运行中补充、邮箱结束封口、消息唤醒等待、问题转交、自动压缩状态、子成果报告与父采纳。前端也有对应入口和同 child 多轮聚合。

当前确认 **4 项问题：1 项 P1、3 项 P2**。另外发现一项工具层并发风险，但当前正式调度串行执行，未证实用户路径可达，因此单独列出，不作为已确认的生产漏洞。

这里的“已实现”指源码和定向测试，不表示用户当前窗口已经加载这份代码，也不表示完成了真实模型长任务或全部端到端验收。

## 1. 已确认的问题

### F1 / P1：代码图查询绕过工作区范围检查

定位：

- `src/tools/codegraph/codegraph-tool.ts:28`：绝对 path 直接返回。
- 同文件 `:35`：相对路径仅 resolve，也没有包含性校验。
- 同文件 `:144`、`:195`：使用该路径检查并打开索引。

触发：research 拥有 codegraph 工具，传入授权目录之外、已有索引的项目路径，例如 `status(path=另一个项目)`。查询分支没有统一的工作区授权与绑定版本检查。

隔离验证使用真实 ToolRegistry、真实 research 工具过滤器和真实 CodeGraph SDK。仅授权临时目录 `authorized`，会话设为 safe；查询兄弟目录 `other` 仍返回 `success:true` 及索引统计。没有访问真实项目。

影响：可以读取授权范围之外的代码图；search/files/callers 等使用同一打开路径，可能暴露其他项目已索引的符号、文件位置与结构。实际复现的是 status 跨目录读取，未声称已读取真实私有源码。这个缺口来自共享 codegraph 工具，不仅影响新 research 模板。

建议修复：在所有代码图动作前使用统一的真实工作区路径解析、规范化包含性检查和有效绑定检查，检查必须早于索引存在性探测及 SDK 打开。不能仅限制 index 动作；也不能仅比较用户传入字符串。

### F2 / P2：合法只读查询仍会写项目文件

定位：`src/tools/codegraph/codegraph-tool.ts:195`、`src/tools/codegraph/codegraph-module.ts:96–128`。

旧版允许 research 调用 `action=index` 的问题已经修了，preflight 和 execute 都会拒绝，模型定义也去除了该动作。但是允许的 `status` 等查询仍调用 SDK 的 `openSync()`；当前 SDK 在打开时校验/修复目录，自动补建 `.ae/.gitignore`。引擎适配器在该文件原本缺失时返回空恢复函数，不能阻止创建。

真实 SDK 探针结果：

```json
{"label":"authorized","success":true,"beforeGitignore":false,"afterGitignore":true}
{"label":"outside","success":true,"beforeGitignore":false,"afterGitignore":true}
```

影响：用户明确要求调研代理不修改任何项目文件，但正常查询也会落盘；同时与 F1 组合，可影响另一个已索引目录。当前证实的是 `.gitignore` 创建，未把 SDK 可能的数据库迁移当作已复现事实。

建议修复：查询采用真正不修复目录、不迁移数据库的只读打开方式。写后恢复不满足无写入要求，也不能消除并发窗口。内部历史/计划持久化属于允许的运行状态；这里修改的是被查询项目文件，不属于该例外。

### F3 / P2：前端多选同一模板后，实例分开了，具体分工没有传递

定位：

- `D:/dev/aether-code/src/renderer/src/contrib/chat/agent-references.ts:36–37`。
- `src/core/subagent/collaborators.ts:120–126`、`:139`。

触发：选择两个执行模板，在输入中分别安排“制作组件 A”和“制作组件 B”。前端生成两个 `{builtinRole, instanceKey}`，没有每个实例的 task；服务端仅在 plan.task 存在时增加具体分工，否则广播同一完整用户请求。

同时，instanceKey 只用于选择去重，没有变成 child 可见的“你对应哪个选择”的身份。两个 child 的 task、builtinRole、description 都相同；它们在主模型开始协调前已经异步启动。

本轮用真实前端 `buildAgentMentionMessage` → 引擎 `collaboratorTools` 串接探针验证：

```json
{
  "collaborators": [
    {"builtinRole":"executor","instanceKey":"one"},
    {"builtinRole":"executor","instanceKey":"two"}
  ],
  "differentDispatchIds": true,
  "identicalChildArgs": true,
  "noPerInstanceTask": true
}
```

影响：两个执行者不能可靠判断自己负责 A 还是 B，可能重复执行、都改同一组件或互相等待。该探针确认分工数据丢失，未声称每次模型都会造成实际文件冲突。当前共享目录又没有强制文件责任约束，因此不能仅依赖事后由主模型纠正。

建议修复：前端发送对应 instanceKey 的明确 task，或者由主 Agent 先拆分任务、再启动同类执行者。仅增加实例编号仍不充分，还需要把任务范围与实例建立明确对应。应补前端发送→真实服务端派发的分工断言；现有测试只证明不同实例 ID 能保留。

### F4 / P2：请求省略工作区路径时，未变的真实绑定也可能被误判为不可续用

定位：

- `src/tools/subagent/team-tools.ts:20–22`：workspaceMatches 仅检查 ctx.workspacePaths。
- 同文件 `:54`、`:111`：目录与 followup 使用该判断。
- `src/tools/subagent/subagent-tool.ts:230–231`：直接 resume 也只比较这个请求字段。
- `src/api/http/routes/chat.ts:1021`、`src/core/agent-context/factory.ts`：ctx 保留请求路径，未在此补成真实持久绑定。

触发条件：原 child 在显式 workspacePaths 下创建；后续请求省略/传空路径，实际 session workspace binding 仍指向原目录。该字段在 chat 协议中允许省略。

隔离真实绑定探针确认：workspaceManager.getWorkingDirectory 仍返回原目录，但目录给出 `canResume:false / resumeUnavailableReason:workspace_changed`，followup 返回 `Child continuation is unavailable in the current workspace`。探针对“应允许同绑定续用”的断言失败。

影响：合法后续请求不能使用已有上下文，主 Agent 可能误认为原代理不能恢复而重新创建。**不是所有默认工作区都失败**：一直以空请求路径创建并继续的情况不同。本轮没有操作真实 UI 重连来确认其具体发送形态。

建议修复：新建、目录、followup、直接 resume、显式 collaborators 使用同一套服务端有效工作区判定；保留绑定版本与权限收缩校验。不能为解决误拒而移除归属检查。

## 2. 潜在风险，未列为生产路径漏洞

### 同一个 followup key 跨运行中/终态边界的并发健壮性

`team-tools.ts:95–128` 先查 followupAdmission，再查邮箱 receipt；运行中走 send，终态走 reserveFollowup。两者分属不同接纳记录，没有统一的事务决策。

直接并发调用工具 execute 的隔离探针可使一次请求先被旧 child 消费，另一相同 key 的请求随后又创建新 run；额外脚本模型调用为 1，预期为 0。

但反证检查发现当前正式链路有三层约束：

- `registry-factory.ts:185–186` 将 subagent_followup 登记为 serial。
- `agent-loop/tool-batch.ts:121–130` 对该类调用逐项等待。
- followup 仅允许 root owner；child 不具有该工具，同一父会话禁止多个活跃 root；未找到外部 HTTP 直接执行 followup 的入口。

因此目前只证明工具层在直接并发调用下不具原子幂等，**未证明当前用户操作可以触发**。以后开放并发入口或复用工具服务时，应先统一接纳事务；当前不能把它描述为“重复点击必然重复执行”。

## 3. 实现范围核对

| 能力 | 当前结论 | 证据/限制 |
|---|---|---|
| research/executor/general 三模板 | 已实现 | builtin-roles.ts，保存版本；research 不允许 access=inherit |
| 同模板多个实例 | 身份层已实现，分工有 F3 | 不能把不同 instanceKey 等同于分工正确 |
| 完成后继续同一个 child | 已实现 | directory + followup/resume，childSessionId 不变、新 run；F4 影响部分工作区请求 |
| 跨重启发现旧子会话 | 已实现持久目录与恢复资料 | 不复活旧 owner；不盲目重放断电前外部动作 |
| 父子与兄弟消息、状态 | 已实现当前有效根范围的通信 | participants 已关联最新 invocation/status/inputClosed/activity |
| 最后答复期间收到补充 | 已加入原子封口与继续迭代 | 不再只有上轮调研中的“无 final recheck”旧缺口 |
| 等待被消息唤醒 | 已实现 | subagent_wait 可返回 pending/reason=message |
| 子代理提问 | 已实现问题转交 | blocked/needs_user；父封口时标 deliveryUnavailable；不代表允许直接审批 |
| 自动上下文压缩、计划恢复 | 已实现且定向测试通过 | 主子共核，压缩状态持久化；不等于磁盘清理或无限上下文 |
| 新的 load_tools | 子作用域与权限隔离有通过验证 | 未发现通过加载定义扩权；主测试有一处旧工具曝光预期未同步 |
| 子成果与父验收登记 | 已实现 | report_artifacts 不可变副本，父按 child/run/artifact 精确采用，来源/回退有校验 |
| 前端同 child 多轮与继续入口 | 已实现 | 按 childSessionId 聚合，结构化 resumeRunId，回执区分 queued/injected/closed |

两种历史后端、实际 ReAct 压缩、真实 SQLite/HTTP 路由和成果持久化分别有本轮定向测试，不是仅阅读上一份实施记录后认定完成。

## 4. 仍然存在的产品边界

以下与现有实施记录一致，应作为能力范围，不混作新发现漏洞：

- 没有自动为每个 child 创建 worktree，也没有完整的 ownedPaths/writeScope 强制隔离；共享目录仍需明确分工、单一集成者，shell/MCP 不受内置文件锁完整覆盖。
- 子代理共用执行内核，但仍不递归创建子代理，不替用户审批，不直接发布父最终成果。
- 旧根未消费消息不无条件迁移到新根；“保留历史”不等于“旧未读需求已处理”。
- 子补充附件目前主要是选择已有任务文件并传路径引用，不等同主输入的完整上传/粘贴多模态链路。
- 视频能力取决于真实工具，资产仍有单件 32 MiB、最多 16 件、总 128 MiB 限额。
- 子代理面板仍有可见条件下的 5 秒目录轮询；这是运行状态发现，不是此前存储统计采样，不能仅据旧统计页需求认定违规。
- 已完成代理保留上下文但不常驻模型调用；上下文复用是否省钱仍取决于相关性、长度和模型缓存。

## 5. 本轮验证

### 常规定向测试

| 范围 | 结果 |
|---|---:|
| collaborators、bounded storage、真实 collaborator chat、async chat，4 文件 | 66 passed / 1 failed |
| team tools、durable mailbox、child drain，3 文件 | 79 passed |
| 权限、reviewer access、model tool loading，3 文件 | 54 passed |
| child compaction、production compaction、plan recovery，3 文件 | 50 passed |
| results、file change producers，2 文件 | 56 passed |
| 前端 builtin-agent-team-contract，1 文件，纯契约 | 7 passed |
| 引擎 npm run typecheck | exit 0 |

引擎常规用例合计 **305 passed / 1 failed**；前端 **7 passed**。额外审计探针单独记载，不将“断言漏洞存在时通过”的探针加入产品正确性通过数，也不重复计算探针复跑。

唯一常规失败位于 `src/api/http/routes/__tests__/collaborator-chat.test.ts:182`：预期父第一次模型请求直接出现全部协作工具，实际为 `load_tools + plan_update`。当前新增按需加载后，完整协作工具在 loader 目录中，需先加载定义。已有 loader 权限测试通过；此失败属于测试契约与新曝光方式不一致，不能据此断言协作权限被删除。

但该断言之后的同用例续跑断言没有执行，所以也不能把整个用例报为已通过。后续应更新测试以实际走加载→协调→续用链路，而不是简单删除断言。

### 可重复审计证据

1. F1/F2：`.e2e-tmp/team-permissions-review/probe.mjs`，真实 SDK 和临时项目；已执行 exit 0，输出上文两个写文件/跨路径结果。
2. F3：`.e2e-tmp/team-dispatch-review/probe.mjs`，真实前端转换与引擎派发参数串接；已执行 exit 0，证明两份 child args 相同，没有启动任何 child。
3. F4：`.e2e-tmp/team-lifecycle-review/probe.txt` 与 `vitest.config.ts`，在内存中为现有夹具追加探针；未改原测试文件。`AUDIT omitted roots` 为 1 failed / 13 filtered，失败断言正是同绑定应可恢复。
4. 潜在并发风险：同一配置的 `AUDIT same followup key`，原执行为 1 failed / 12 filtered；当时仅追加这一条探针。该结果不能替代生产可达性证明。

隔离脚本保留在忽略目录，随机数据夹具按各脚本策略清理或仅保留测试诊断；未接触真实会话与用户成果。

### 复现命令

引擎目录执行：

```powershell
npm run typecheck
npx vitest run src/core/subagent/__tests__/collaborators.test.ts src/core/subagent/__tests__/collaborator-bounded-storage.test.ts src/api/http/routes/__tests__/collaborator-chat.test.ts src/api/http/routes/__tests__/chat-async-subagents.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
npx vitest run src/tools/subagent/__tests__/team-tools.test.ts src/core/collaboration/__tests__/durable-mailbox.test.ts src/core/collaboration/__tests__/child-drain-continuation.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
npx vitest run src/tools/subagent/__tests__/subagent-capabilities.test.ts src/tools/subagent/__tests__/subagent-reviewer-access.test.ts src/tools/__tests__/model-tool-loading.test.ts --maxWorkers=1 --minWorkers=1
npx vitest run src/core/subagent/__tests__/subagent-compaction.test.ts src/core/collaboration/__tests__/production-compaction.test.ts src/storage/todo/__tests__/plan-recovery.test.ts --maxWorkers=1 --minWorkers=1
npx vitest run src/storage/results/results.test.ts src/tools/file/__tests__/file-change-producers.test.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
node --import tsx .e2e-tmp/team-permissions-review/probe.mjs
node --import tsx .e2e-tmp/team-dispatch-review/probe.mjs
npx vitest run --config .e2e-tmp/team-lifecycle-review/vitest.config.ts -t 'AUDIT omitted roots' --maxWorkers=1 --minWorkers=1 --reporter=dot
```

前端目录执行：

```powershell
npx playwright test --config playwright.builtin-agent-team.config.ts e2e/builtin-agent-team-contract.spec.ts --output .e2e-tmp/team-review-contract-results --reporter=line
```

本轮没有重跑真实 Electron E2E、产品构建、真实模型并行开发，也没有核对当前运行窗口的加载版本；这些均不作为已验证结论。

## 6. 建议后续修复顺序

1. 先修 codegraph 全动作路径授权和真正只读打开，补跨目录/无文件副作用回归。
2. 修多执行实例的分工映射，验证前端到引擎每个实例获得不同且明确的任务，再允许它们开始修改共享文件。
3. 统一工作区有效范围判断，覆盖显式路径→请求省略但绑定不变，以及真实绑定变更必须拒绝两类相反场景。
4. 更新 lazy-loading 集成用例，完整验证显式协作后的加载、消息、等待与续用；后续再用独立 profile 做真实 Electron E2E。
5. 在引入 followup 并发入口前补统一幂等事务；当前保留串行约束。

本轮产出是核查与复现证据，以上修复尚未执行。
