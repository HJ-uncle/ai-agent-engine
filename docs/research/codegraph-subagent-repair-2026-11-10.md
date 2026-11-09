# 代码图大索引与子代理结果完整性修复

完成日期：2026-11-10。前置调查见 [审计记录](codegraph-subagent-research-audit-2026-11-09.md)。引擎和 `D:\dev\aether-code` 均已修改并构建；未重启用户当前 Aether 窗口，未修改生产历史数据库或现场代码图库。

## 修复后的行为

### 大代码图库可供研究子代理查询

`src/tools/codegraph/codegraph-readonly.ts` 改为异步私有磁盘快照：以固定 1 MiB Buffer 分块复制，双遍 SHA-256 和文件身份检查验证一致性，SDK 仅打开临时副本。查询按源版本共享构建与连接，每次使用仍独立验证调用者当前工作区权限；查询完成释放 lease，空闲 30 秒清理。

源数据库加 WAL 默认上限 512 MiB；进程私有快照磁盘预算 1 GiB、最多 2 项，并为临时盘保留额外 64 MiB 可用空间。这些是快照资源限制，不是 SQLite 容量限制。资源满时不淘汰正在查询的副本；数据库或 WAL 改变、目录被替换、journal 待恢复、临时磁盘不足或 SDK 恢复超出预留均明确失败。

`codegraph-tool.ts` 已接入异步路径，status 明确显示当前角色是否能查询；SDK stale 实际指索引提取版本，修正了原先误称“检测到文件变动”的说明。

### 子代理完整结果落盘，摘要不再冒充全文

`src/core/subagent/result.ts` 建立完整性协议：

- 完整最终回答复用租户隔离、不可变的 gzip CAS 本地文件；先完成写盘再提交数据库引用。
- SQLite 仅保存不超过 8,192 UTF-8 字节的摘要及 `resultRef/resultHash/resultBytes/resultTruncated/resultKind`。
- ReAct 独立传递 `finalOutput`，避免把先前的过程说明前缀当成最终结果。
- 父历史投影、实时 delta、结果通知和视图贯通完整性元数据。截断提示预留在摘要字节预算内，完整性不再依赖尾部提示文字；明确要求截断结果在汇总或验收前补读全文，未截断则避免重复读取。
- 失败和取消保留完整的已有部分输出，`resultKind=partial` 不会把任务标成成功。取消发生在最终状态读取前或文件发布期间都保留实际候选正文。
- 完整结果写盘失败进入 `failed/RESULT_PERSIST_FAILED`，并完成父投影和执行票据收束，不留下假成功或永久 running。

新增 `subagent_read_result` 和 HTTP `GET /subagent/runs/:runId/result`。读取须满足租户、父会话归属；子代理读取同伴结果还须满足当前协作根任务成员条件。摘要通知给出补读指引，已有权限的读取工具会自动出现在下一次模型请求中。

HTTP 默认每页 16 KiB、最大 64 KiB；每页通过流式解压校验完整哈希，仅保留所需片段。页首尾按 UTF-8 字符边界处理，BOM、中文和 emoji 可逐字恢复。模型工具再按当前 Work/Code 输出预算缩小页面，回执始终保留正确的 `nextOffset`，不会被通用输出截断切坏。

### Aether 同步展示完整性与真实状态

前端继续保持 4 KiB 预览上限，独立保留完整性字段。新增 `SubagentResultReader`，通过按钮读取完整结果，每次仅驻留 16 KiB 页面，支持上一页、下一页、从头读取和返回预览。切换引擎来源或关闭后丢弃在途响应；离线、错误归属和失败重试均有明确反馈。

结果页不再显示“当前仅为预览”的提示。旧记录没有完整引用时明确标注完整性未知，不显示一个无法工作的全文入口。

导出现在写真实 `toolCount`、已加载数、水位和覆盖信息；详情或正文不完整时明确注明，并保留结果引用、哈希、字节数及 codegraph action。导出仍是当前有界快照，不冒充全量归档，也不将所有历史正文一次聚合进内存。

状态区分续派“已接纳”、等待观察“已读取”、子任务“已完成”，内部单条工具失败保持原样。另修复 delta 二次归一化时，缺省 header 被变成 null 而导致合法事件被拒的问题。

### 减少无效调研读取

`glob` 增加 `countOnly`，仅需统计规模时不输出大量路径。计数超时或达到扫描上限时明确报告下限，不能当作精确总数。普通列表按工具输出预算分页，续读位置按实际返回数量计算，始终出现在正文前。路径和计数都验证工作区边界。

普通 Markdown/规则文件请求 `read_file mode=summary` 时，原 TextHandler 没有真正摘要能力，过去会返回大量原文，再被外层截断或批读拒绝。现在在 Work/批读中使用已有的源文分页协议，返回可继续的行列游标；支持代码签名的格式继续保持摘要能力。没有为降低 Token 数而强制提前终止任务或改写完整历史。

## 验证结果

### 现场 167.78 MiB 代码图库

新生产调用链 `withReadonlyCodegraph → codegraphTool.execute → 私有快照 → SDK` 的 status/search/callers/callees/files 全部成功；SDK 源库打开被验证脚本显式禁止，五次查询只创建了一份副本。

- 首次 status 约 388 ms，复用后的查询约 12–17 ms。
- 整次实测 RSS 增量约 30.8 MiB；这是单次现场观察值，不是所有项目的内存保证。
- 源库 SHA-256、mtime 和 `.ae` 目录清单前后相同，没有创建源 WAL/SHM。
- 可复现证据：`.tmp/codegraph-live-verification-20261109.json`、`.tmp/codegraph-live-verify-20261109.ts`。

### 引擎

两组不重叠目录的回归共 **102 个测试文件、1,589 项全部通过**：

```powershell
npx vitest run src/core/agent-loop src/tools/__tests__ src/tools/file/__tests__ src/tools/search/__tests__ --silent --reporter=dot
# 57 文件，1003 项通过

npx vitest run src/core/subagent src/tools/subagent src/api/http/routes/__tests__/subagent src/tools/codegraph --silent --reporter=json --outputFile=.tmp/codegraph-subagent-final-tests.json --maxWorkers=4 --minWorkers=1
# 45 文件，586 项通过
```

新增核心覆盖：大于旧 64 MiB 的真实 SQLite、活 WAL、一致性与资源限制、并发 lease 独立授权；结果落盘/重启/哈希损坏、跨租户/会话拒读、UTF-8/BOM/转义预算、写盘失败和取消竞争；目录计数与无重叠分页、规则文档续读。测试使用隔离数据，没有重新调用收费模型。

最终工具说明调整后，模型工具定义与加载的 19 项定向测试再次通过；随后强化完整性指引，对结果存储、投影、输出去重与子结果复核的 40 项测试再次通过。引擎 TypeScript 检查和 `npm run build` 通过，构建标识与当前运行源码匹配：

`sha256:1f5e8c1acf229519765c19d531ad74be387e2fb266a4b58facaea62076db2c4f`

### Aether

`npm run build`（含 node/web TypeScript 检查）通过。新增 12 项、既有相关回归 52 项、新 out 隔离 Electron 用例 1 项，共 **65 项通过**；最后的预览提示修正后，12 项重新通过且再次构建成功。

```powershell
npx playwright test --config playwright.subagent-result.config.ts
npx playwright test --config playwright.work-subagent-list.config.ts --grep '代理列表以用时'
npx playwright test e2e/builtin-agent-team-contract.spec.ts e2e/builtin-agent-team-transcript.spec.ts e2e/work-subagent-wait-summary.spec.ts --tsconfig tsconfig.web.json --workers 1 --reporter list --output .e2e-tmp/subagent-result-regression
```

真实 React 组件和 client 经隔离 HTTP bridge 验证连续分页、身份检查、断线重试、切源和回放；新 out 的隔离 Electron 用例验证列表状态与深浅主题、不同宽度。截图在前端 `.e2e-tmp/subagent-result-results/` 和 `.e2e-tmp/work-subagent-list-results/`，已检查，未操作用户当前窗口。

## 使用与边界

已经运行的 Aether 使用启动时的引擎快照；刷新页面不会替换它。结束当前工作后，在 `D:\dev\aether-code` 重新启动 `npm run dev`，才会加载本次引擎与前端构建。普通重新打开旧窗口不能视为已验证使用新引擎。

本次没有批量迁移旧记录。旧摘要已丢失的后半段仍在原子会话 JSONL 中，但旧 run 没有新的可验证结果引用，因此新补读接口明确返回不可用，不伪称历史已自动恢复。新的运行及续跑会按新协议保存完整结果。

本轮解决了查询与数据完整性问题，并修正部分重复读取来源；没有进行优化前后的真实模型费用对照，不能据此承诺固定比例的 Token 或费用下降。
