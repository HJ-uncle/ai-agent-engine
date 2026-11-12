# 自定义插件实现与真实实验验收

日期：2026-11-11。引擎：`D:\dev\ai-agent-engine`；前端：`D:\dev\aether-code`。

> 后续真实用户「定时器」失败暴露了本报告的验收缺口：下述「真实引擎 Electron」测试使用 Electron 界面连接由外部 Node 启动的引擎，没有覆盖 Electron 本身以 Node 模式运行引擎后再启动插件的嵌入式路径。后者丢失 `ELECTRON_RUN_AS_NODE`，确实无法正确接收 stdin；不能用原有通过数证明该路径可用。另，下面的 AI 测试预先给出了详细协议及业务断言，是受控工具插件实验，不能证明一句自然语言创建交互插件的体验。UI 扩展与常驻生命周期始终未实现，原结果不得被理解为与 Harness 完整插件能力等价。补充证据和修复范围见 [定时器问题复盘](2026-11-11-plugin-timer-review.md)。

## 交付结果

Work 已新增「插件」页面，提供创建、源码编辑、测试、发布、启停、删除、GitHub/目录/ZIP 导入和 AI 创建入口。`@插件管理` 管理插件，`@具体插件` 按会话选用已发布版本，普通会话不会自动获得全部插件工具。界面为单行列表，手动刷新使用图标，已检查浅色、深色和窄窗。

插件源码、快照、依赖和导入作业保存在磁盘；SQLite 不保存插件源码。调用使用受生命周期管理的独立 Node 进程。版本经内容哈希校验，已执行任务与子代理继续执行保留原修订；停用及当前权限撤销会阻止后续调用。插件协议产物使用现有文件变更账本，支持回退。

## 实验一：5 个插件全部由 Aether 内的 AI 创建

模型为本机已配置的 `deepseek-v4.1-flash-1017`，通过真实 `/chat`、工具选择、持久审批恢复及 PluginService 完成。测试驱动只提供需求、参数和断言，不包含这些插件的预写实现。每个插件有自己的会话，两款迭代插件继续使用原会话和上下文。

| 插件 | 场景 | 新功能迭代 | 最终修订 | 结果 |
|---|---|---|---:|---|
| invoice-helper | 财务报价、金额与税费 | 3 次：折扣 → 运费 → 币种格式 | 5 | 通过 |
| log-inspector | 运维日志统计 | 3 次：服务分组 → P95 → 最低严重级过滤 | 4 | 通过 |
| meeting-report | 办公会议纪要与 Markdown 文件 | 初始创建 | 1 | 通过 |
| privacy-redactor | 邮箱、手机号脱敏与中文换行保留 | 初始创建 | 1 | 通过 |
| dependency-planner | 研发依赖排序与环检测 | 初始创建 | 1 | 通过 |

合计 **29 项业务回归与实际会话调用检查通过**，包括 5 次真正只选中具体插件的 AI 会话调用。会议报告实际写入隔离工作区，验证其文件内容。每次功能迭代均重新测试之前的需求。

第一版报价插件误把小数税率再次除以 100，独立断言得到 `0.05` 而应为 `5`。错误保留在报告中，由原 AI 会话读取源码、修改、测试、重新发布后通过。该额外修复使最终修订为 5；三次新功能迭代分别有独立需求记录。

执行时间为本地 20:06:57–20:11:11。实验引擎已正常关闭，报告记录 `graceful engine shutdown`。源模型配置只读读取，凭据没有写入明文报告或插件包。

- [AI 完整报告](../../.tmp/plugin-acceptance/ai-2026-11-11T12-06-57-770Z-8fd9e60b/report.json)
- [会话、审批、源码与原始 SSE 证据目录](../../.tmp/plugin-acceptance/ai-2026-11-11T12-06-57-770Z-8fd9e60b/)

## 实验二：3 个真实 GitHub 插件

使用 Remark 适配器，在独立进程导入锁定 commit 的仓库源码。安装依赖禁用生命周期脚本，实际依赖树和 lockfile 纳入版本哈希。

| GitHub 插件 | 固定 commit | 实际能力验证 |
|---|---|---|
| [remark-gfm](https://github.com/remarkjs/remark-gfm) | `109972e8a773bf5dac1d6d2da0776557f36971aa` | 表格、任务勾选、删除线的 AST 和 Markdown |
| [remark-frontmatter](https://github.com/remarkjs/remark-frontmatter) | `1125009e530386bc8c2ba497087f7f2a3ae99ddf` | 默认 YAML frontmatter 解析与保留 |
| [remark-breaks](https://github.com/remarkjs/remark-breaks) | `71f4ff3ca9f08b685dccf2fdb9882d8bbaea3388` | 软换行转换为 break |

三项均完成预览、安装为禁用草稿、发布、执行、结果断言、重新创建 Service 加载磁盘版本后再次执行。并非只下载仓库或读取 README。

真实测试发现并修复两个问题：完整 commit 原本仍调用 GitHub commit API，遇到公开配额 403，现直接下载该 SHA；适配器原本用 `{}` 替换缺省参数，破坏 frontmatter 插件默认配置，现保留 `undefined`。失败证据和最后成功证据分别保留。

- [GitHub 成功报告](../../.tmp/plugin-acceptance/github/run-f955cc18-5bdc-4780-9423-a4ab7f2a0eb6/evidence.json)
- [API 配额失败记录](../../.tmp/plugin-acceptance/github/run-49f6ddef-0de4-4f99-967b-e63905e27450/evidence.json)
- [默认参数兼容失败记录](../../.tmp/plugin-acceptance/github/run-63066ca2-e96c-4107-a754-4707ef70a381/evidence.json)

## 实验三：2 个复杂原生插件经导入运行

| 插件 | 导入方式 | 业务与边界验证 |
|---|---|---|
| acceptance-artifacts | ZIP | 多工具、子目录相对模块导入、Unicode、CRLF、精确文本与二进制产物、SHA256、文件与空父目录回退 |
| acceptance-data | 本地目录 | CSV 引号及多行、原型键、3 个独立进程并发、180,000 字节输入、1,600,000 字节输出 |

**2 项业务场景、11 项负例全部通过**。负例独立列出，包括路径穿越、重复与祖先冲突路径、版本篡改、禁用、输入输出限额、超时及取消，不计为业务成功。

另启独立第二宿主进程，重新打开隔离数据目录。两插件版本哈希、导入收据、3 条已回退记录均正确保留；成果父目录保持不存在；两插件通过新建执行注册器再次调用成功。数据库关闭回执均为健康，无强杀。

- [复杂插件报告](../../.tmp/plugin-acceptance/adversarial-20261111/evidence.json)
- [独立进程重启报告](../../.tmp/plugin-acceptance/adversarial-20261111/restart-evidence.json)

## 可直接导入的交付包

[插件包目录](../../.tmp/plugin-acceptance/deliverable-bundles/) 中有 5 个 AI 插件最终版与 2 个复杂验收示例，共 7 个原生 ZIP。每个 ZIP 都再次经过真实导入、发布和运行，源码哈希与原最终版相同；不携带会话、凭据或伪造来源。`acceptance-data` 包含故意超时的测试工具，属于验收示例。

第三方插件使用同目录的 `import-sources.json` 提供 URL、固定 SHA 和 `format=remark`，便于重新导入并安装锁定依赖，不以缺依赖的原生 ZIP 代替。

- [7 个导出包的再次导入验证](../../.tmp/plugin-acceptance/deliverable-bundles/evidence.json)
- [GitHub 导入参数](../../.tmp/plugin-acceptance/deliverable-bundles/import-sources.json)
- [使用说明](../plugins.md)

## 前端与产品边界

最后统一运行引擎 TypeScript 检查、8 个文件共 **119 项回归**及构建，全部通过。另有 Agent 工具与 tool-profile 路由的定向回归通过，未将重复执行的用例累加成新的覆盖数。最终引擎 build ID：`sha256:0882f7c55dbd527522edebd6ba361ba3bf4b527a7cb9cddcf7dacbbc570633bf`。

最终检查也补齐了 Agent 配置目录：仅列本租户已发布插件工具，默认不勾选，保存时校验归属；绑定自定义 Agent 后可通过工具白名单与 `@` 组合选用插件。草稿不进入能力目录，停用仍阻止执行。启停与删除在存储锁内再次验证已批准的版本。

前端 typecheck/build 已通过；43 项协议测试、1 项真实引擎 Electron、5 项模拟 Electron，共 **49 项通过**。真实引擎用例覆盖代码编辑、Node 执行、发布版本固定、目录与 ZIP 导入、`@` 版本替换；GitHub 界面流程采用模拟服务，而三个 GitHub 仓库的真实下载与执行由上述独立实验覆盖。

当前支持原生 Node 插件和 Remark 适配。没有承诺任意 GitHub、MCP、Cordis 或 VS Code 扩展都能直接运行，也没有把独立进程称为操作系统沙箱。通用 secret 配置、UI 扩展、插件市场和自动更新不包含在本次交付中。

所有实验运行于 `.tmp/plugin-acceptance` 及前端独立测试 profile，未向当前用户数据安装测试插件、未删除或重启真实 Aether。当前打开的窗口需重新加载对应新构建后才能显示新入口。
