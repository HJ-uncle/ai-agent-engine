# 保留会话长测的独立验收

`analyze-continuation.mjs` 只读原始证据，不重写旧结果、原红基线、checkpoint、归档或数据库。只有新输出文件可以写入；`--output` 使用 `wx`，拒绝覆盖已有文件。

```powershell
node scripts/longrun/analyze-continuation.mjs "D:\dev\ai-agent-engine\test-projects\longrun-20261009\runs\NEW_RUN" --output ".tmp\NEW-qualification.json"
```

退出码 0 表示所有严格门槛通过，2 表示证据不足或验收失败。未结束的运行不会因为已启用功能、调用次数或经过六小时而通过。

## 开发、维护与计时

新开发必须具备独立进程的完整原始 red TAP、精确冻结 Node argv/cwd/executable、前后完整 owned 文件哈希变化、真实模型根运行、当前实现的两份成功只读评审，以及评审后真实父命令和独立项目合同测试。

维护恢复允许使用原有红基线，不制造新失败、不抹掉旧失败。原基线缺少早期未记录的命令字段会写入 `historicalLimitations`。涉及 `recoveryImplementation` 的任务全部属于维护；不会混入新开发计时。

`checkpoint.firstQualifiedDevelopmentAt` 必须等于最早独立合格新开发根运行的真实 `createdAt`。从这里验收完整六小时；准备、旧证据、维护和 replay 不计为新开发时间。实际 running 区间及五个唯一 session 的重叠另外报告，不用 worker 时钟替代 SSE 观测时间。

每个模型需要真实自动压缩日志中的 `preRequestTokens`、`postRequestTokens`，确实缩小且低于 100000，随后在相同模型和会话中继续独立合格新开发。微压缩、压缩审计、恢复任务或未验收开发都不能代替。子 Agent 的模型从其 JSONL assistant `modelId` 验证，并绑定 parent root/turn、child session、tenant 和执行时间。

## 功能语义证据

在 owned run root 创建 `continuation-qualification-evidence.json`。它必须引用独立断言的原始进程结果及实际输入；测试代码、报告和每个输入文件都保存 SHA-256。输入可复制进 run root，但必须保持实际原始输入的相同哈希。

```json
{
  "features": [{
    "feature": "files.crud",
    "mode": "agent-semantic",
    "bindings": [{"dispatchId": "ACTUAL_DISPATCH", "toolCallId": "ACTUAL_CALL", "name": "write_file"}],
    "proof": {
      "checker": "node-test",
      "buildId": "ACTUAL_FROZEN_BUILD_ID",
      "file": "qualification/files-report.json",
      "sha256": "64_HEX",
      "sourceFile": "qualification/files-assertions.mjs",
      "sourceSha256": "64_HEX",
      "inputFiles": [{"file": "qualification/actual-events.jsonl", "sha256": "64_HEX"}],
      "expectedTests": 6
    }
  }]
}
```

独立 `*-report.json` 至少包括真实的 `buildId`、`stdout`（完整 TAP totals）、`exitCode:0`、`signal:null`、`timedOut:false`、`startedAt`、`finishedAt`、`independent:true`。建议保留 `command`、`cwd` 和 `executable`。`proof.buildId` 和报告 buildId 都必须与当次冻结候选一致；断言运行不得早于候选冻结或它依赖的实际结果。测试必须校验业务效果，调用成功或配置启用本身不是语义验收。

四种 scope 分开处理：

- `agent-semantic`：bindings 必须对应独立合格根运行的成功原始工具调用，inputs 必须包含实际对应 SSE 的哈希；断言晚于工具结果。工具及 Agent 注入、执行能力使用此 scope。
- `client-semantic`：额外提供 `clientChecks:["EXACT_FULL_CLIENT_CHECK_NAME"]`，inputs 包含完整客户端报告的原始哈希；只用于真实 UI/客户端管理行为，不能代替 Agent 执行。需要 full client gate 成功，checker 晚于实际 UI 流程。
- `live-api-semantic`：额外提供 `httpBindings:[{requestId,method,route}]` 与 `proof.httpEvidenceFile`。该 JSONL 每条记录保留真实 `requestId,base,method,route,buildId,startedAt,finishedAt,httpStatus,response`，与当次 supervisor base/build 一致，inputs 包含它。只用于管理 CRUD、知识库提取格式等 API 语义；不能代替 Agent 注入、工具执行或拖拽 UI。
- `engine-regression`：记录独立回归是否通过，保留 `regressionPassed`；不自动变成用户实际操作或 Agent 语义通过。

完整工具清单取真实 request 的所有 `allowedTools` 与资源清单的并集。知识库 `/knowledge/formats` 的所有 extensions 单独列为 `knowledge.format:<extension>`。报告逐项区分 `qualified`、`used_unqualified`、`untested`；没有断言覆盖的工具或格式不会漏掉，也不会自动算通过。

## 完整客户端门槛

`START_DRIVER.clientAcceptanceFile` 可以指定完整客户端报告；否则读 `client-acceptance.json`。该文件必须包含：

```json
{
  "scope": "full-client",
  "fullSuite": true,
  "passed": true,
  "buildId": "ACTUAL_FROZEN_BUILD_ID",
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "startedAt": "ISO_DATE",
  "finishedAt": "ISO_DATE",
  "listTotal": 818,
  "listFile": "client/full-list.json",
  "listSha256": "64_HEX",
  "rawReportFile": "client/full-results.json",
  "rawReportSha256": "64_HEX",
  "checks": [{"name": "file.spec.ts :: file.spec.ts > suite > test", "project": "", "passed": true}],
  "proofFiles": ["client/full-results.json"],
  "screenshots": ["client/actual-screen.png"]
}
```

`listTotal` 必须按当次真实 `--list` 输出计算，示例 818 不是固定常量。导出的 `playwrightCases(rawReport)` 返回精确 `name`、`project`、`key`、真实通过状态和尝试状态，wrapper 可以直接据此生成 checks。

验收器重新遍历原始 Playwright list 和 results。每个唯一注册项都必须有实际执行的 passed result；拒绝 skip、flaky、missing、失败、仅有 stats 的空报告、少报检查、未运行专项冒充完整套件，以及旧候选的执行时间。只有专项通过时应交付专项报告，不能设置 fullSuite 来代替完整客户端验收。

## 审批、资源、构建与清理

历史 `permissionRequest` 会保留；是否未解决根据最终 pending 和逐条审查证据判断。`permissionResolutions` 对应精确 owned review/receipt 文件及哈希，检查完整 argv、root/session/request/tool 身份、实际 `/chat` POST、approved decision、原始恢复 SSE 的 running 状态和对应命令真实终态。`manualReview.authority` 明确区分 `root-agent` 与 `human-user`。验收器不执行审批、不改变审批策略，不要求引擎不存在的 `answeredAt` 字段。

恢复 receipt 的 `traceFile` 指向在实际接收每个恢复 SSE frame 时落盘的 `{at,id,event,data}` JSONL。它必须与原始 `streamFile` 的 frame 内容完全一致；验收器按原始时间合并它与当次 `events.jsonl`，按 event ID 去重并拒绝矛盾。不事后补写接收时间，不修改原始流来制造恢复或 running 时长。Agent 语义断言的 inputs 同时保留相关 original/resume trace 哈希。

资源监控只统计记录的引擎树及主线程 PID。health、process、runtime、artifact 采样必须覆盖完整 active lifecycle，输出 nominal interval 和最大实际缺口；超过三个 nominal cycles 的缺口不能作为完整连续覆盖。它是证据覆盖规则，不是外推服务器容量的结论。

两端冻结读取 `continuation-freeze.json` 的实际 `artifactRoot`、`stageRoot`，重新捕获当前所有生产 runtime 文件和 node-pty 补丁，比较初始 source/stage 及当前实际文件；不会只相信历史 `unchanged:true`。

最终数据库通过冻结 stage 的原生 libsql 只读检查 agent、memory、knowledge 三库的 integrity/ANN/foreign keys/terminal state。普通 SQLite 对 libsql 向量索引的兼容失败不是权威 ANN 损坏结论。清理必须有真实 stopped 状态、成功完整进程枚举和零残留；枚举失败返回空数组不能算清理完成。

六小时验收不会自动声明 7×24 连续无人值守可靠性，也不会声明无限服务器容量。后续持续运行仍需独立监测和实际完成的可靠性证据。
