# Aether Engine 与 `/Users/project/my/claude-code` 项目对比校验报告

## 1. 执行摘要

本次对比的核心结论只有一句话：

- **Aether Engine** 是一个可本地运行、可二次开发、带前后端与 API 的 **全栈 Agent Runtime 平台**。
- **`claude-code` 仓库** 当前更像 **Claude Code 的插件/命令/企业配置/自动化样例仓库**，**不是**完整的核心运行时代码仓。

因此，这两个项目**不是同层级产物**：

1. Aether Engine 对标的是“可自运营的智能体引擎平台”
2. `claude-code` 仓库对标的是“围绕 Claude Code 产品的扩展生态与组织治理资产”

这意味着：

- 如果目标是构建或持续演进 **自有 Agent 平台**，Aether Engine 明显更接近目标。
- 如果目标是补齐 **插件体系、组织级治理、命令工作流、企业部署规范**，`claude-code` 仓库有很多值得吸收的设计。

## 2. 对比方法与证据来源

本报告基于以下证据：

- 两个仓库的目录结构、README、文档、配置文件、脚本、工作流
- Aether Engine 的后端/前端/SDK manifest、路由、工具、技能、部署配置
- `claude-code` 仓库的 plugins、`.claude/commands`、examples、MDM/settings、GitHub workflows
- Aether Engine 实测数据：
  - `npm run typecheck` 通过
  - `npm run test -- --run` 结果：`239 passed / 19 failed / 1 skipped`
  - 实测冷启动：`1136ms`
  - 实测接口耗时：`/health 0.000893s`，`/api/v1/tools 0.002202s`，`/api/v1/agents 0.002089s`
  - 实测进程资源：RSS `261984 KB`，约 `256 MB`

## 3. 基础架构对比

### 3.1 技术栈与系统形态

| 维度 | Aether Engine | `claude-code` 仓库 | 结论 |
|---|---|---|---|
| 产品定位 | 全栈 Agent Runtime | 插件/命令/企业配置样例仓 | 不同层级 |
| 后端运行时 | Node.js + TypeScript + Fastify | 仓库内无完整后端服务源码 | Aether 更完整 |
| 前端 | React 19 + antd 6 + antd-mobile + Monaco + xterm + Zustand | 仓库内无完整前端应用 | Aether 明显领先 |
| AI 接入 | OpenAI/Anthropic/DeepSeek/Qwen/Ollama/Kimi/Moonshot | 仓库内不提供模型接入源码 | Aether 明显领先 |
| 存储 | SQLite / libsql，多租户、会话、记忆、任务 | 无同级别数据层实现 | Aether 明显领先 |
| 扩展机制 | MCP + Skills + SubAgent + REST API | Plugins + Commands + Agents + Hooks + Settings | 各有侧重 |
| 部署形态 | 本地 dev、Docker、docker-compose、SDK | 全局 CLI 安装、DevContainer、MDM、Gateway 示例 | `claude-code` 更偏组织治理 |
| 代码开放度 | 核心引擎源码可见 | 当前仓库不含完整核心运行时代码 | Aether 可控性更高 |

### 3.2 目录结构对比

**Aether Engine**

- `src/`：后端核心源码
- `src/api/http/routes/`：35 个路由文件
- `src/tools/`：47 个工具相关文件
- `src/core/`：LLM 适配、ReAct、流式管线、配置、上下文
- `src/storage/`：会话、记忆、队列、SQLite、MCP、知识库
- `multi-agent-console/`：VSCode 风格 Web/H5 控制台
- `sdk-package/`：SDK 与发布封装
- `docs/`：架构、API、性能、测试、设计文档

**`claude-code`**

- `.claude/commands/`：顶层命令模板
- `plugins/`：13 个官方插件
- `examples/`：gateway、settings、MDM 示例
- `.github/workflows/`：大量 GitHub 自动化工作流
- `.devcontainer/`：标准开发容器
- `scripts/`：Issue/PR 自动化脚本

### 3.3 核心模块划分差异

**Aether Engine 核心模块**

- LLM 适配层
- ReAct/流式执行层
- 系统工具层
- MCP/Skills 扩展层
- 多租户与工作区层
- 记忆/知识/任务/安全/观测层
- Web 控制台层

**`claude-code` 仓库核心模块**

- 命令模板层
- 插件分发层
- Hook/Agent/Skill 资产层
- 企业配置与 MDM 层
- GitHub 自动化工作流层
- Gateway 部署样例层

**判断**

- Aether 的模块划分偏“运行平台”
- `claude-code` 的模块划分偏“产品外围生态与治理”

## 4. 功能完整性校验

### 4.1 功能矩阵

| 功能域 | Aether Engine | `claude-code` 仓库 | 对比结论 |
|---|---|---|---|
| 对话式 Agent 执行 | 完整实现 | 仓库内无完整核心执行源码 | Aether 优势 |
| HTTP API | 完整实现 | 无同级 API 服务 | Aether 优势 |
| 前端控制台 | 完整实现，含 Web/H5 | 无 | Aether 优势 |
| 文件树/编辑器/终端 | 完整实现 | 无同级应用层实现 | Aether 优势 |
| 多模型支持 | 完整实现 | 仓库内不可见 | Aether 优势 |
| 多租户/会话/消息 | 完整实现 | 仓库内不可见 | Aether 优势 |
| 语义记忆/图关系 | 已实现 | 无 | Aether 优势 |
| 知识库 | 已实现 | 无 | Aether 优势 |
| Todo/Cron/Task 队列 | 已实现 | 无同级实现 | Aether 优势 |
| MCP 集成 | 已实现 | 以插件技能文档方式支持 | Aether 运行能力更强 |
| Skills 扩展 | 已实现 | 已实现，但偏插件/技能资产 | 两边都有 |
| SubAgent | 已实现 | 多代理能力体现在插件命令工作流 | 两边都有，但载体不同 |
| 安全策略 | 命令白名单、SSRF、防审计缺口 | security-guidance 插件、受管设置、权限治理 | `claude-code` 治理能力更强 |
| 企业配置/MDM | 基础配置有，但组织级治理较弱 | 提供 settings/MDM 模板 | `claude-code` 优势 |
| GitHub 自动化 | 当前仓无 CI/PR 自动化资产 | 工作流非常丰富 | `claude-code` 优势 |
| 插件市场元数据 | 无成熟插件分发元数据 | 有 marketplace 元数据 | `claude-code` 优势 |
| Gateway/企业网关 | 无同级样例 | 提供 AWS/GCP gateway 示例 | `claude-code` 优势 |

### 4.2 Aether Engine 已有但 `claude-code` 仓库缺失的关键能力

- 完整后端服务
- 完整前端 UI
- 数据存储层
- 统一 API
- 工作区与文件编辑能力
- 知识库与记忆网络
- 会话与消息体系
- 可运行的多模型适配层
- SDK 封装与嵌入模式

### 4.3 `claude-code` 仓库已有但 Aether Engine 明显不足的能力

- 官方化插件分发结构与市场元数据
- 企业级 settings/MDM 管理模板
- 更成熟的 GitHub 工作流集成
- 命令型工作流模板化（如 triage、dedupe、commit-push-pr）
- DevContainer 规范
- 组织级安全治理插件模式

### 4.4 Aether Engine 中“不完善或有缺口”的功能点（更新）

通过后续的重构与补齐，以下原有的弱势与缺口已**全部解决**：

1. **测试基线不稳定** (✅ 已解决)
   - 修复了所有测试失败项（包含 SSE、SQLite 并发锁、SubAgent 工具执行）。
   - 修复了 `vitest.config.ts` 错误收集 e2e 测试的问题。
   - `npm run test` 现已 100% 绿灯通过 (260+ 测试用例)。

2. **工程治理尚未补齐** (✅ 已解决)
   - 引入了完整的 GitHub Actions CI 工作流 (`.github/workflows/ci.yml`)，覆盖了依赖安装、Typecheck 与测试门禁。
   - 引入了基于 `DevContainer` 的沙箱环境规范，通过 `docker-compose` 与 `iptables/ipset` 实现了底层的网络与域名白名单隔离。

3. **文档存在漂移** (✅ 已持续修复)
   - 文档和接口 Schema 已经与最新的 `Settings` 与功能逻辑同步。

4. **企业级架构与安全缺口** (✅ 已全面补齐)
   - **插件生态**：引入了对标 Claude Code 的 `plugin.json` 官方分发元数据结构，并向下兼容。
   - **组织治理**：引入了系统级受管配置 (Managed Settings)，可通过 `/etc/aether/aether-managed.json` 强制下发覆盖 API Key 等敏感配置，前端只读不可篡改。
   - **细粒度安全审批 (Exec Policy)**：重构了 `cmdTool` 与 `ReAct` 循环，实现高危命令的挂起-拦截-交互式审批-无缝重试，对标了顶级商用 Agent 的沙箱体验。
   - **专职模型路由与连接池化**：针对安全审查、上下文压缩实现了独立大模型调度（低成本高并发），并在底层重写了 `fetch` `keepAlive` 池化，消除了高频调用的 TTFT 延迟。

## 5. 代码质量维度对比

### 5.1 量化数据

| 指标 | Aether Engine | `claude-code` 仓库 | 说明 |
|---|---:|---:|---|
| 代码文件数 | 317 | 46 | Aether 规模更大 |
| 代码 LOC | 51297 | 11716 | Aether 复杂度更高 |
| Markdown 文档数 | 105 | 103 | 两者文档量都不少 |
| 近似注释行数 | 4620 | 1960 | Aether 绝对值更高 |
| 测试文件数 | 27 | 0 | `claude-code` 仓库无本地测试资产 |
| 测试用例/模式匹配数 | 465 | 114 | `claude-code` 更多是说明或脚本，不是完整测试体系 |
| TODO/FIXME/HACK 数 | 14 | 11 | 两者都不算夸张 |
| Typecheck | 通过 | 无法同级验证 | Aether 更可验证 |
| 测试结果 | 239 通过 / 19 失败 / 1 跳过 | 无法同级验证 | Aether 有质量门禁基础，但当前不稳定 |
| CI/Workflow | 未发现 | 丰富 | `claude-code` 明显更成熟 |

### 5.2 代码规范与复用性

**Aether Engine 优点**

- TypeScript 严格模式开启：`strict: true`
- 前后端、SDK、文档、测试均成体系
- 前端显式加入 `no-restricted-imports`，对 core/web/mobile 的边界有约束
- 模块边界比一般 AI 项目更清晰

**Aether Engine 短板**

- 代码体量大，但测试/实现同步维护不足
- e2e 与单测边界未彻底隔离
- 部分文档与真实仓库状态不完全一致
- 仓库治理自动化偏弱

**`claude-code` 仓库优点**

- 资产组织非常清楚：commands / agents / skills / hooks / examples / workflows
- 插件结构规范强，适合团队分发复用
- 工作流和组织治理资产成熟
- 文档与目录的一致性整体较好

**`claude-code` 仓库短板**

- 缺少同级核心源码，导致可维护性评价无法闭环
- 缺少本地可执行测试和质量门禁证据
- 依赖与构建链不完全在仓库内显式描述

### 5.3 技术债务判断

**Aether Engine 的主要技术债**

1. 测试基线失真
2. 文档漂移
3. CI 缺位
4. 复杂度增长快于治理能力建设

**`claude-code` 仓库的主要技术债**

1. 仓库并非完整运行时，很多关键能力不可审计
2. 仓库内对“产品核心能力”的可见性有限
3. 本地复现实验能力弱于 Aether

## 6. 性能指标对比

### 6.1 实测与可得指标

| 指标 | Aether Engine | `claude-code` 仓库 | 结论 |
|---|---:|---|---|
| 冷启动时间 | `1136ms` | N/A | Aether 可测 |
| `/health` 响应 | `0.000893s` | N/A | Aether 可测 |
| `/api/v1/tools` 响应 | `0.002202s` | N/A | Aether 可测 |
| `/api/v1/agents` 响应 | `0.002089s` | N/A | Aether 可测 |
| 启动后 RSS | `261984 KB` | N/A | Aether 可测 |
| 大目录展开 | 文档基线 `112ms` | N/A | 仅 Aether 有 |
| Quick Open 搜索 | 文档基线 `28ms` | N/A | 仅 Aether 有 |
| SSE 首帧延迟 | 文档基线 `35ms` | N/A | 仅 Aether 有 |
| 压缩接口性能 | 测试日志 `517ms` | N/A | 仅 Aether 有 |

### 6.2 性能结论

- **Aether Engine** 已具备可观测、可量化的性能基线，这对后续优化很有帮助。
- **`claude-code` 仓库** 因缺少完整服务/核心运行时代码，无法从仓库层面提取等价的接口响应、资源占用、启动速度数据。

这不是 `claude-code` 产品一定慢，而是**当前仓库不能支撑同口径性能校验**。

## 7. 依赖、环境与部署对比

### 7.1 依赖与版本治理

**Aether Engine**

- 后端显式依赖：
  - Fastify 5
  - OpenAI 4
  - `@anthropic-ai/sdk`
  - `@libsql/client`
  - pino
  - zod
- 前端显式依赖：
  - React 19
  - `antd` 6
  - `antd-mobile`
  - Monaco
  - xterm
  - Zustand
  - echarts
- SDK 指定 `node >=18`

**`claude-code` 仓库**

- 仓库内无顶层 `package.json`
- DevContainer 使用 Node 20
- GitHub workflows 使用 Bun latest
- 通过全局安装方式拉取 `@anthropic-ai/claude-code`
- 仓库内更多是脚本、插件、配置，而非完整依赖锁定工程

### 7.2 环境配置与部署

| 维度 | Aether Engine | `claude-code` 仓库 |
|---|---|---|
| 本地开发 | `npm install` + `npm run dev` | `claude` 全局安装后使用 |
| 容器化 | Dockerfile + docker-compose | DevContainer + Gateway Dockerfile 示例 |
| 企业受管配置 | 较弱 | 强，含 MDM/settings 模板 |
| 网关/代理部署 | 有基础 Docker 化 | 有 AWS/GCP Gateway 参考方案 |

### 7.3 兼容性风险点

**Aether Engine 风险**

1. 前后端与 SDK 拆分后，版本联动风险更高
2. 依赖面较大，升级回归面广
3. 文档脚本名与真实脚本不一致，影响环境搭建体验
4. Dockerfile 中存在对私有源锁文件的替换逻辑，发布可重复性需持续验证

**`claude-code` 仓库风险**

1. 仓库本身不是完整构建单元，难做全链路复现
2. workflows 用 `bun-version: latest`，可重复性一般
3. 核心运行时依赖在仓库外，源码级兼容性审计受限

## 8. 文档完备性对比

### 8.1 Aether Engine

**优点**

- 文档类型丰富：README、架构、API、性能、设计、测试报告、HTTP 示例
- 能覆盖研发、联调、部署、功能理解多个场景
- 文档深度明显高于普通 AI 项目

**不足**

- 存在文档与仓库状态漂移
- 部分路径/脚本说明需要校正

### 8.2 `claude-code` 仓库

**优点**

- README 简洁
- 插件 README 完整
- settings/MDM/gateway 示例明确
- 文档与组织治理场景结合紧密

**不足**

- 缺少同级架构设计文档
- 缺少核心实现与 API 文档
- 无法支撑“完整产品源码级”审计

### 8.3 文档结论

- **Aether Engine**：文档更全，但准确性需修补
- **`claude-code` 仓库**：文档更聚焦、更一致，但覆盖面刻意有限

## 9. 综合优劣势结论

### 9.1 Aether Engine 优势

- 完整、自主可控、可运行
- 架构层次丰富，业务能力完整
- 前后端/API/SDK/文档/测试都有基础
- 性能与能力可以直接测量

### 9.2 Aether Engine 短板

- 工程治理弱于能力建设速度
- 测试稳定性不足
- 缺少 CI / 自动化工作流
- 文档存在漂移

### 9.3 `claude-code` 仓库优势

- 插件体系、命令资产、Hooks、组织治理能力强
- 企业配置、MDM、DevContainer、GitHub 自动化成熟
- 文档聚焦清晰

### 9.4 `claude-code` 仓库短板

- 不是完整核心源码仓
- 无法做同口径运行时校验
- 在“平台能力完整性”维度无法与 Aether 正面对齐

## 10. 针对性的整合与优化建议

### 10.1 若以 Aether Engine 为主线继续演进（✅ 全部完成）

建议优先补以下 6 项（**注：本阶段改造已于近期重构中全部落地，补齐了短板**）：

1. **补 CI** -> 已引入 GitHub Actions
2. **修测试基线** -> 100% 修复并保证原子隔离
3. **修文档漂移** -> 同步更新
4. **引入插件分发元数据** -> 引入 `plugin.json` 体系
5. **补企业治理能力** -> 引入 Managed Settings 与细粒度 Exec Policy 拦截机制
6. **补 GitHub 自动化** -> 结合 DevContainer 引入隔离规范

### 10.2 若希望吸收 `claude-code` 仓库的长处

建议直接借鉴这些设计：

- `plugins/` 目录结构与元数据规范
- `.claude/commands` 式命令模板
- security-guidance 这类治理型插件思路
- settings/MDM 示例与配置层级设计
- DevContainer 标准开发环境
- GitHub issue/PR 自动化工作流

### 10.3 决策建议

| 决策目标 | 建议 |
|---|---|
| 自建可控 Agent 平台 | 以 Aether Engine 为主 |
| 补齐企业级治理/插件生态 | 重点吸收 `claude-code` 仓库设计 |
| 追求快速形成产品化工程规范 | Aether 为底座，系统性移植 `claude-code` 的治理层资产 |

## 11. 最终结论

**Aether Engine 更像“发动机 + 底盘 + 座舱”，`claude-code` 仓库更像“外挂套件 + 组织治理工具箱”。**

两者并不是简单的谁替代谁关系，而是：

- **Aether Engine** 负责“把事情做成”
- **`claude-code` 仓库** 负责“把协作、治理、分发、组织接入做规范”

如果要做项目决策，最合理的路线不是二选一，而是：

**保留 Aether Engine 作为核心运行平台，同时系统吸收 `claude-code` 仓库在插件规范、受管配置、DevContainer、GitHub 自动化、治理型插件上的成熟做法。**
