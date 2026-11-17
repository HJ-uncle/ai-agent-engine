# 文档刷新与功能覆盖记录（2026-11-17）

<!-- documentation-status: historical -->
> 本文记录这次源码审阅和验证结果；后续功能变化以[文档首页](README.md)和[全量状态清单](documentation-inventory.md)为准。原测试日期和条件不自动延续。

## 覆盖与处理方式

本轮同时核对 ai-agent-engine 与 aether-code，以源码实际注册、调用和界面挂载为依据。覆盖桌面全部 26 个 features 目录及 app 装配、主进程和 IPC 边界；引擎覆盖启动、HTTP、身份、模型、运行、历史、协作、文件、记忆、知识、工具、扩展、调度和监控。保留 Web 控制台另外说明，不与桌面能力混用。

| 范围 | 现行入口 | 本轮主要修正 |
|---|---|---|
| 用户操作与界面 | [桌面指南](../../aether-code/docs/user-guide.md)、[功能地图](../../aether-code/docs/feature-map.md) | 单一默认界面、真实入口、只读预览边界、手动刷新、回退/成果/队列及子代理复用 |
| 系统与集成 | [架构](docs/overview.md)、[API](docs/api-spec.md)、[集成](docs/third-party-integration.md) | 根挂载与完整 URL 的区别、真实模型路径、认证层次、SSE 游标/快照、接纳幂等与继续 |
| 运行与数据 | [运行指南](runtime-guide.md)、[存储维护](operations/session-storage-maintenance.md) | JSONL/blob/SQLite 分工、子代理持久记录、有界缓存、备份范围、回退与恢复边界 |
| 模型、记忆与知识 | [压缩](context-compression-design.md)、[思考](thinking-mode-config.md)、[附件](multimodal-design.md) | 真实摘要/microcompact、记忆默认关闭、动态请求注入、知识 FTS/LIKE 与 Office/OCR、模型能力差异 |
| 权限与账号 | [安全](security-architecture.md)、[账号](account-login.md)、[第三方](account-external-login.md) | standard 默认、full-access 仍有硬边界、第三方 reauth 和同 session 领取、独立账号不自动合并 |
| 工具与插件 | [系统工具](docs/system-tools.md)、[工具包](session-toolkits.md)、[HTML 参考](../../aether-code/docs/plugin-api/dist/index.html) | 当前工具名称、12 类挂载、22 项权限、49 个 SDK 方法，移除失效配额；内部 Markdown 不再复制公开 API |
| 桌面设计与数据目录 | [设计实现](../../aether-code/design-system/aether-code/MASTER.md)、[项目存储](../../aether-code/docs/project-storage.md) | 当前令牌/字体/图标、.ae 与旧路径的实际优先级 |
| SDK、部署与诊断 | [SDK](../sdk-package/README.md)、[容器部署](../deploy/workspace-runtime/README.md)、[性能方法](docs/bench/performance.md) | 生命周期 SDK 的真实边界、npm 分发缺口、容器未验收边界、移除无可复现证据的旧性能数字 |
| 规范与保留实现 | [OpenSpec](../openspec/specs/)、[Web 控制台](../multi-agent-console/README.md) | 16 个现行规范同步；Web 实际启动、旧账号/交互协议与当前引擎兼容限制 |

历史报告、提案及验收保留原有正文，补充状态和现行入口。运行指令/Skills、协作约定、页面样例与产品手册在清单中分别列出；运行说明只校正已核实的工具/技能名称、参数和能力描述，保留工作流、安全约束与业务执行代码。

## 检查机制

[documentation-audit.mjs](../scripts/diagnostics/documentation-audit.mjs) 只解析源码，不启动引擎、不访问数据库或凭据。它生成文档状态清单、HTTP 路由目录和有限 OpenAPI，并检查现行 Markdown 的本地链接及源码行号。

本轮独立核对得到 295 个 Fastify 路由声明点，两处循环展开后为 297 个显式方法/路径，无归一化重复。Fastify 自动 HEAD、静态资源和运行时扩展不是该声明数的一部分。仅 30 项路由具有可静态展开的 Fastify schema；Zod、权限及业务校验回指处理器，不能称为完整客户端生成契约。

直接挂载前缀从 server.ts 解析；当前嵌套路由的父级挂载经人工核对。新增不同前缀的嵌套模块时仍须审阅父子关系。生成器拒绝未知路由声明和重复 method/path，避免默默覆盖目录。

## 本轮验证

| 验证 | 结果与边界 |
|---|---|
| 插件 docs:check | 通过；HTML、SDK/贡献/权限及审阅指纹一致 |
| 插件 docs:review | 在源码与正文交叉审阅后显式执行；不是自动接受未审阅实现 |
| 桌面 npm run build | 通过，包含文档构建、Node/Web TypeScript 检查与 Electron Vite 构建 |
| 桌面 npm run docs:test | 5/5 通过：离线导航、搜索键盘、代码复制、示例真实工具子进程、深浅/窄屏/缩放可读性 |
| 文档生成器 | 语法与源码目录一致性检查通过；现行链接检查报告存于 .e2e-tmp/documentation-refresh/current-links.json |
| API / SDK 示例 | 9 个 JavaScript、TypeScript 和 JSON 代码块语法检查通过；未携带真实凭据发送请求 |
| Office 诊断入口 | 7 个脚本语法检查通过；文档分别注明离线合同、旧 runner、退役草案或未接线候选，不声称当前 UI 流程通过 |
| 内置 Office 与技能说明 | 既有公式重算测试 45/45 通过；28 份相关 Markdown、8 个技能 frontmatter、17 处 os-* 引用和 20 个本地链接静态检查无问题 |

日志在两个仓库的 .e2e-tmp/documentation-refresh/，插件站点报告在前端 .e2e-tmp/plugin-api-site/。未操作用户当前窗口、未修改生产数据库、账号凭据或会话。

本轮不是全部业务重新验收：未运行真实第三方授权、外部模型压测、Docker 隔离或完整产品 E2E。源码发现但尚有限制的 TaskQueue handler、鉴权环境 Cron dispatch、Flow 持久恢复和旧 Web 交互，在现行指南中如实说明；文档更新不宣称补齐了这些功能。

运行说明补充校正了 COUNTIF 与文本比较的已实现范围、PPTX 图片/图表/自由布局、AE.md 的加载及存储分层、当前文件/命令/计划/记忆工具参数、真实 os-* 技能引用。外部 Superpowers 技能仍明确标为外部依赖，不伪装成本仓库已内置；有效旧 role 与安全、评审流程保留。

## 同日后续清理

在现行指南完成更新后，按内容与实际引用清理重复阶段报告、已完成/归档提案、被替代设计、退役验证草稿和未用于结论的重复抓取。不是按日期批量删除；未完成事项、独立故障证据、诊断脚本的真实输入、现行规范、运行指令及插件 HTML 站点继续保留。

| 仓库 | Markdown | 配套旧资料 | 合计 |
|---|---:|---:|---:|
| ai-agent-engine | 129 | 123 | 252 |
| aether-code | 36 | 38 | 74 |
| 总计 | 165 | 161 | 326 |

正式资料目录减少 10,354,227 字节（约 9.87 MiB），自底向上非递归清理 38 个空目录。删除前按 SHA-256 核对原文件，并保存、逐项验证包含未提交内容的 ZIP：`.e2e-tmp/documentation-cleanup/removed-documents-20261117T060044721Z.zip`。审查清单、删除回执和引用检查同存该目录；备份不进入正式文档或 Git。

保留文档中的旧入口已修正，生成清单现为 334 项文档/页面资料。历史测量 JSON 的原抓取 URL、哈希及测试条件保持原样；同名诊断输出在临时目录生成，不代表继续依赖已删除的历史结果。14 个诊断/汇总脚本的默认输出改到仓库 `.e2e-tmp/` 专属目录，并保证目录创建；Claude 声明文件和 Office 手工复核数据继续从保留输入读取。

清理后重新验证：297 条 HTTP 路由目录与源码一致，1,584 个现行本地链接无失效，文档清单一致；前端 `typecheck`、`docs:check` 及 `docs:test`（5/5）通过。修改脚本通过 JavaScript 语法或 TypeScript 解析检查；未执行真实模型、网络探针或产品全量 E2E，本次不改变插件公开行为。
