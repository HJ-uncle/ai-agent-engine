# 插件 API 文档与实现交叉验证

> 历史记录：本报告保留迁移前的 Markdown 验证数据。公开文档现已迁移到前端仓库的 [HTML 参考项目](../../../aether-code/docs/plugin-api/dist/index.html)，后续以该项目的同步检查和测试为准；旧 Markdown 及其构建入口已退役。

日期：2026-11-13。范围：引擎与同级 Aether 客户端的当前开发工作区，不代表正式环境已经升级。所有运行数据和报告均放在两仓的 `.e2e-tmp/`，未读取生产数据库或凭据。

公共入口为 [插件 API 参考](../../../aether-code/docs/plugin-api/dist/index.html)。维护者的新增挂载建议单独放在 [挂载点审计](../research/2026-11-13-plugin-mount-audit.md)，不进入公共文档导航或分发包。本轮没有新增这些建议挂载。

## 验证口径

交叉检查分为三层，不能互相替代：

1. **契约覆盖**：从实际 Node SDK 和页面桥执行生成的对象提取方法路径，比较生成的 TypeScript 声明、能力发现目录与文档；从严格 Schema 对照贡献、权限、事件和组件目录。检查完整文档的链接、锚点和 JSON 示例。
2. **源码调用链审阅**：沿界面挂载、页面桥、权限授权、目标绑定和引擎处理检查参数、返回、限制。没有把内部 React 组合接口或未接入的编辑器模块算作公共能力。
3. **实际执行**：文档完整工程经过现有清单校验和真实 Node 子进程运行；客户端回归使用本轮构建的 `out/`，开发模式用隔离的真实引擎实例。

## 结果

| 检查 | 结果 | 范围与证据 |
|---|---|---|
| 公共文档完整性 | 8 个 Markdown、108 个本地链接、24 个 JSON 示例、13 个贡献片段通过 | 仅链接公共参考；无引擎仓库路径、内部 HTTP 路由或维护脚本指令 |
| SDK 覆盖 | 23 个共享方法 + 22 个页面专用方法 = 45 个，全部有文档 | 真实对象、类型声明、发现目录一致；文档中的 `$AE` 调用也反向检查不存在虚构方法 |
| 贡献目录 | 12 类，8 个菜单位置，3 个视图位置 | Schema、发现目录、参考对应 |
| 权限／事件／原生组件 | 21／15／13 | 每项均在参考中列出；不把兼容对象重复计数 |
| 完整字符统计工程 | 通过 | Markdown 直接提取的三个文件；`你好🍎` → `3`，空串 → `0`，错误参数被拒绝 |
| 示例页面脚本与桥 | 通过 | 真实生成桥和 Node 子进程；DOM 与父窗口是隔离替身，不能称为 Electron UI 验收 |
| 原生 JSON 文档示例 | 通过 | 引擎校验与客户端解析均通过，绑定结果为 `{title:"检查报告",details:true}` |
| 引擎插件测试 | **27 个文件、309 项通过** | 本轮执行整个 `src/plugins`；包含能力、工程、权限、生命周期、后台、SDK 类型与运行边界 |
| 客户端定向回归 | **16 项通过** | 12 项纯逻辑 + 4 项真实 Electron 测试，详见下表 |
| 构建 | 两仓通过 | 引擎构建包含 TypeScript 检查；客户端构建包含主进程和渲染层类型检查 |
| 诊断脚本 | 实际执行与独立 TypeScript 检查通过 | 不依赖正式账户、真实模型或外部 MCP |

SDK 子代理单独执行的 14 项、原生边界单独执行的 6/12 项均与上表重叠，不相加计总数。

客户端本轮运行范围：

| 文件 | 数量 | 实际覆盖 |
|---|---:|---|
| `e2e/plugin-extension-events.spec.ts` | 5 | 历史基线不触发新消息；完成去重；文件成功操作及回退事件归属 |
| `e2e/plugin-native-document.spec.ts` | 7 | 绑定、输入、选项/深度边界、重复字段、事件声明和注册撤销 |
| `e2e/plugin-extension-surfaces-ui.spec.ts` | 3 | 真实 Electron 界面；隔离 HTTP 引擎夹具；消息/会话/输入框/服务/工作区/编辑器挂载与上下文 |
| `e2e/plugins-development-real-engine.spec.ts` | 1 | 真实 Electron + 隔离引擎 + 源码工具子进程；刷新、权限保留/撤销和零安装 |

## 本轮发现并修正的差异

| 差异 | 修正 |
|---|---|
| 能力目录声称存在 `$AE.ui.dialogs`、`$AE.ui.notifications` | 改为实际 `$AE.ui.dialog`、`$AE.ui.notify`；删除文本输入弹窗的虚假描述 |
| Webview 发现目录使用内部 `service.*` 名称，漏掉已有接口 | 改为完整 45 个公开方法，包括 `services.refresh`；自动检查防止再次漂移 |
| 编辑器描述暗示可写 | 明确当前接入的代码预览只读；`replaceSelection` 会拒绝，文件写入走已有工作区接口 |
| 原生下拉前端 100、引擎 256 | 前端统一 256；256 接受、257 拒绝已有回归 |
| 原生组件深度计数差 1 层 | 两端统一含根组件总计 12 层；12 接受、13 拒绝 |
| 前端拒绝重复 `bind`，引擎却接受 | 引擎在整个页面内检查唯一性，含不同分支；文档明确要求 |
| 前端 hooks 类型缺少 4 个 `agent.*` | 完整事件类型供订阅使用；宿主可发布事件类型仍保留原边界，编译测试证明不能伪造 Agent 发布事件 |
| SDK 会话声明缺少真实字段 | 补 `revision?: string`、可选消息 ID 及真实消息结构；页面 context 增加 `engineReady`，Node 不虚构此字段 |
| 剪贴板文档把底层 1 Mi 字符限制当作页面写入限额 | 区分读取上限与页面 262,144 字符 JSON 入参上限，说明封装/转义开销 |
| 开发者教程要求进入引擎仓库、运行维护脚本 | 公共参考改为客户端开发模式、标准文件和直接使用 SDK；内部证据另存 |
| 前端架构文档仍记载活动入口在侧栏 | 同步实际底部状态栏唯一入口与向上展开行为 |

## 明确保留的边界

- `agents.list` 省略 `limit` 时底层默认 64，显式传入允许 1–50；已如实说明并建议显式传值，本轮未改变分页行为。
- 部分 SDK 返回类型仍是 `Args` 或 `unknown`，参考给出实际返回结构；不能把宽泛类型当成任意字段都存在。
- 原生页面的部分前端字段检查比引擎更宽，例如标签长度、图片大小、动作参数总量；正式页面先经过更严格的引擎校验。本轮只统一会造成已接受页面无法展示的边界，未宣称两端 Schema 已完全共享。
- `file.context` 仍是单路径；`session.context` 仍只在侧栏接入；普通网页没有 `$AE`；子代理消息继承内嵌视图不等于开放运行详情挂载。
- 未对所有模型提供方、真实外部 MCP、系统通知可见性或全部 45 方法进行在线业务验收。本轮结论是文档契约与已有实现对应，并完成上述明确列出的运行测试。

## 可复现入口与证据

维护者在引擎仓库运行：

```powershell
npx tsx scripts/diagnostics/check-plugin-reference.ts
npx vitest run src/plugins
npm run build
```

维护者在客户端仓库先构建，再串行运行：

```powershell
npm run build
npx playwright test --config e2e/config/playwright.config.ts e2e/plugin-native-document.spec.ts e2e/plugin-extension-events.spec.ts e2e/plugin-extension-surfaces-ui.spec.ts e2e/plugins-development-real-engine.spec.ts --output .e2e-tmp/plugin-api-reference/client-results
```

引擎证据：`.e2e-tmp/plugin-api-reference/reference-check.json`、`engine-plugin-tests.log`、`engine-build.log`、`diagnostic-typecheck.log`。客户端证据：`.e2e-tmp/plugin-api-reference/frontend-build.log`、`client-tests.log`、`client-results/`。

公共分发包：引擎 `.e2e-tmp/plugin-api-reference/aether-plugin-api-reference.zip`，只含公开参考和已验证的最小示例，SHA-256 记录在 `reference-check.json`。此包不是应用安装包，也不夹带内部审计、产品源码、日志或运行数据。
