# Aether Engine、`claude-code`、`codex` 三方对比校验报告

## 1. 执行摘要

这三个项目分别代表三种很不一样的产品形态：

- **Aether Engine**：可自部署、可二次开发、带后端 API 和 Web 控制台的 **全栈 Agent Runtime 平台**
- **`claude-code` 仓库**：围绕 Claude Code 的 **插件、命令、企业配置、自动化工作流样例仓**
- **`codex` 仓库**：OpenAI Codex 的 **完整本地编码代理工程**，核心是 Rust workspace，围绕 CLI/TUI、app-server、sandbox、SDK、Bazel/CI 展开

所以它们并不是简单的“同类竞品源码”：

1. **Aether Engine** 最适合做“自有平台底座”
2. **`claude-code`** 最值得借鉴“插件生态和组织治理”
3. **`codex`** 最值得借鉴“工程化深度、CLI/TUI 架构、Rust 多 crate 拆分、测试与 CI 体系”

如果从“项目决策参考”角度看，最合理的结论是：

- **以 Aether Engine 作为核心平台**
- **吸收 `claude-code` 的治理层设计**
- **吸收 `codex` 的工程化与运行时架构设计**

## 2. 校验范围与证据来源

本次报告基于以下内容：

- 三个仓库的目录结构、README、docs、manifest、部署配置、工作流
- Aether Engine 的后端、前端、SDK、测试、性能实测
- `claude-code` 的 plugins、`.claude/commands`、examples、MDM/settings、GitHub workflows
- `codex` 的 Rust workspace、Node 包装层、Python/TypeScript SDK、Bazel、DevContainer、CI/workflows、技能与安全文档

本轮拿到的关键实测数据：

### Aether Engine

- `npm run typecheck`：通过
- `npm run test -- --run`：`239 passed / 19 failed / 1 skipped`
- 冷启动：`1136ms`
- `/health`：`0.000893s`
- `/api/v1/tools`：`0.002202s`
- `/api/v1/agents`：`0.002089s`
- RSS：`261984 KB`，约 `256 MB`

### `claude-code`

- 当前仓库不含完整核心运行时代码，无法做同口径服务级性能测试

### `codex`

- 本轮未执行全量构建/测试/bench（Rust workspace 规模极大）
- 但已提取完整结构与工程化指标，可做高可信静态对比

## 3. 基础架构对比

### 3.1 产品形态与技术栈

| 维度 | Aether Engine | `claude-code` | `codex` | 结论 |
|---|---|---|---|---|
| 产品定位 | 全栈 Agent 平台 | 插件/命令/治理样例仓 | 本地 Coding Agent 完整工程 | 三者层级不同 |
| 核心语言 | TypeScript | Markdown + Shell + TS/Python 脚本 | Rust 为主，辅以 TS/Python/JS | `codex` 最底层工程化 |
| 后端服务 | Fastify API | 仓库内无完整核心后端 | app-server / exec-server / protocol | Aether 与 Codex 可正面对比 |
| 前端/交互 | Web/H5 控制台（React + antd） | 无完整 UI 应用 | CLI/TUI，本地 app-server 支撑 | Aether 偏 Web，Codex 偏终端 |
| 模型接入 | 多模型适配层 | 仓库内不可见 | 完整 provider / auth / protocol / model 管理 | Aether 与 Codex 都完整 |
| 扩展机制 | MCP + Skills + SubAgent | Plugins + Commands + Hooks + Agents | Skills + MCP + Hooks + Extensions | 三者都有扩展能力 |
| 构建系统 | npm/tsc/vite | 无完整统一构建 | Cargo + Bazel + pnpm + Nix | Codex 最重型 |
| 部署形态 | 本地、Docker、compose、SDK | 全局 CLI、DevContainer、MDM、Gateway 示例 | 安装器、CLI、SDK、DevContainer、Bazel/多平台发布 | Codex 发布链最成熟 |

### 3.2 目录结构与模块规模

| 指标 | Aether Engine | `claude-code` | `codex` |
|---|---:|---:|---:|
| 代码文件数 | 317 | 46 | 3942 |
| 代码 LOC | 51297 | 11716 | 1445857 |
| Markdown 文档数 | 105 | 103 | 153 |
| 工作流文件数 | 0 | 较多 | 30 |
| Rust crates | 0 | 0 | 141 |

### 3.3 核心模块划分

**Aether Engine**

- `src/core/`：LLM 适配、ReAct、流式执行
- `src/api/http/routes/`：API 层
- `src/tools/`：系统工具
- `src/storage/`：会话、记忆、知识库、MCP、队列
- `multi-agent-console/`：VSCode 风格前端控制台
- `sdk-package/`：SDK

**`claude-code`**

- `.claude/commands/`：命令模板
- `plugins/`：插件目录
- `examples/`：settings / MDM / gateway
- `.github/workflows/`：组织与 GitHub 自动化
- `.devcontainer/`：开发容器

**`codex`**

- `codex-rs/cli`：CLI 入口
- `codex-rs/tui`：终端 UI
- `codex-rs/app-server*`：本地服务端/协议/守护进程
- `codex-rs/exec*`：执行与隔离
- `codex-rs/sandboxing` / `linux-sandbox` / `windows-sandbox-rs`
- `codex-rs/model-provider*` / `login` / `auth`
- `codex-rs/skills` / `mcp-server` / `codex-mcp`
- `sdk/python` / `sdk/typescript`
- Bazel / Nix / DevContainer / GitHub Actions

### 3.4 架构结论

- **Aether Engine**：最像“自建业务平台”
- **`claude-code`**：最像“官方产品的外围生态资产”
- **`codex`**：最像“高复杂度、跨平台、本地优先的基础产品工程”

## 4. 功能完整性对比

### 4.1 功能矩阵

| 功能域 | Aether Engine | `claude-code` | `codex` | 结论 |
|---|---|---|---|---|
| 对话式 Agent 运行时 | 完整 | 仓库内不可见 | 完整 | Aether/Codex 都强 |
| 本地可运行核心实现 | 有 | 无同级别核心源码 | 有 | `claude-code` 不可同口径对比 |
| API 服务 | 完整 REST API | 无 | app-server / protocol | Aether/Codex 都有 |
| Web 控制台 | 有 | 无 | 无同级 Web 控制台 | Aether 独有优势 |
| CLI/TUI | 基础终端能力 | 产品本体不在仓内 | 强 | Codex 明显领先 |
| 多模型适配 | 强 | 仓内不可见 | 强 | Aether/Codex 相近 |
| 工作区/文件操作 | 强 | 以命令模板为主 | 强 | Aether/Codex 相近 |
| MCP | 强 | 以文档/插件形式支持 | 强 | 三者都有 |
| Skills | 强 | 强 | 强 | 三者都有 |
| 多代理/子代理 | 强 | 在插件命令中使用 | 强 | Aether/Codex 更底层 |
| 记忆/图谱 | 强 | 无同级能力 | 有 memories 相关模块 | Aether 在“业务化记忆”更突出 |
| 知识库 | 有 | 无 | 未见同级知识库产品化层 | Aether 优势 |
| Todo/Cron/Task | 有 | 无同级实现 | 有 goal / queue / task 相关扩展 | Aether 更业务化 |
| 沙箱/审批/执行策略 | 有 | 有治理模板 | 很强 | Codex 最成熟 |
| 插件/组织治理 | 中 | 强 | 强 | `claude-code`/Codex 更成熟 |
| 企业配置/MDM | 弱 | 强 | 强配置体系，但非 MDM 导向 | `claude-code` 最强 |
| SDK | 有 | 仓内无同级 SDK | Python + TS SDK | Aether/Codex 都强 |

### 4.2 Aether Engine 的明显优势

- 现成 Web 控制台，符合你当前 VSCode 风格诉求
- 知识库、记忆、任务、Cron、会话、工作区都做到了业务层
- 后端 + 前端 + SDK + 文档是一套完整平台能力

### 4.3 `claude-code` 的明显优势

- 插件分发结构非常成熟
- GitHub issue/PR 自动化极强
- settings/MDM/企业治理模板完善
- 命令式工作流设计清晰

### 4.4 `codex` 的明显优势

- 完整的本地编码代理工程
- Rust 多 crate 解耦非常细
- 支持 CLI/TUI/app-server/SDK 的多入口形态
- 跨平台、沙箱、执行策略、审批、协议层明显更成熟
- 工程体系完整：Cargo/Bazel/Nix/DevContainer/GitHub Actions

### 4.5 Aether Engine 的主要缺口

对照 `claude-code` 与 `codex`，Aether Engine 当前短板集中在：

1. **工程治理不足**
   - 缺少 CI/workflows
   - 缺少成熟插件市场/插件元数据
2. **测试稳定性不足**
   - 实测存在 19 个失败项
3. **企业级治理不足**
   - 受管配置、审批模板、组织部署方案不如另两者成熟
4. **终端/本地优先体验弱于 Codex**
   - 当前更偏 Web 控制台

## 5. 代码质量与工程成熟度对比

### 5.1 量化指标

| 指标 | Aether Engine | `claude-code` | `codex` |
|---|---:|---:|---:|
| 近似注释行数 | 4620 | 1960 | 82716 |
| 测试文件数 | 27 | 0 | 547 |
| 测试模式匹配数 | 465 | 114 | 12784 |
| TODO/FIXME/HACK | 14 | 11 | 374 |
| Typecheck / 编译门禁 | TS typecheck 通过 | 不适用 | 有完善 Rust/Bazel/nextest 体系 |
| CI/Workflow | 未发现 | 丰富 | 非常丰富 |

### 5.2 质量判断

**Aether Engine**

- 优点：
  - TS strict 模式
  - 前后端边界基本清晰
  - 文档与测试基础存在
- 问题：
  - 测试不全绿
  - 文档漂移
  - CI 缺位

**`claude-code`**

- 优点：
  - 资产组织清晰
  - 插件结构统一
  - GitHub 治理自动化强
- 问题：
  - 不含完整核心实现
  - 难以直接审计运行时代码质量

**`codex`**

- 优点：
  - 工程拆分极细，模块责任明确
  - 有 `AGENTS.md`、测试规则、snapshot 规则、bench 规范、Bazel 规则
  - 大量测试资产与工作流说明工程成熟度高
  - 既有 Rust 规范，也有 SDK 规范和多平台构建约束
- 问题：
  - 复杂度极高，维护门槛高
  - TODO/HACK 数量也明显更多
  - 构建与测试成本高，不适合小团队轻装演进

### 5.3 工程成熟度排序

如果只看“工程体系成熟度”：

1. **`codex`**
2. **`claude-code`**
3. **Aether Engine**

如果只看“平台完整性且可直接为你当前业务所用”：

1. **Aether Engine**
2. **`codex`**
3. **`claude-code`**

## 6. 性能与可观测性对比

### 6.1 当前可获取性能数据

| 指标 | Aether Engine | `claude-code` | `codex` |
|---|---:|---|---|
| 冷启动 | `1136ms` | N/A | 本轮未测 |
| 健康接口 | `0.000893s` | N/A | 本轮未测 |
| 工具/Agent 接口 | `~0.002s` | N/A | 本轮未测 |
| RSS | `~256MB` | N/A | 本轮未测 |
| Bench 机制 | 有 perf script 与性能文档 | 仓库内无等价基线 | 有 `just bench` / Bazel benchmark 线索 |

### 6.2 结论

- **Aether Engine**：当前最容易得到直接性能数据
- **`claude-code`**：仓库层无法做同口径服务性能对比
- **`codex`**：理论上可深测，但成本明显高于 Aether；本轮以工程证据为主，未做重型编译/基准跑分

## 7. 依赖、环境与部署对比

### 7.1 依赖与工具链

| 维度 | Aether Engine | `claude-code` | `codex` |
|---|---|---|---|
| Node 要求 | `>=18`（SDK），主工程 TS/Node | 安装态为 CLI，仓内无顶层包管理 | monorepo `node >=22`、pnpm `>=10.33.0` |
| 主工具链 | npm + tsc + vite | Bun + GitHub Actions + DevContainer | Cargo + Bazel + pnpm + Nix + just |
| SDK | 自有 SDK package | 仓内无同级 SDK | Python + TypeScript SDK |
| 安全/沙箱 | 自有安全策略 | settings / hooks / security plugin | sandbox / execpolicy / approvals / process hardening |

### 7.2 部署与开发环境

| 维度 | Aether Engine | `claude-code` | `codex` |
|---|---|---|---|
| 本地开发 | `npm run dev` | CLI 安装后使用 | 安装器或源码构建 |
| 容器化 | Dockerfile + compose | DevContainer + gateway 示例 | DevContainer 普通/secure 双配置 |
| 多平台发布 | 基础 | 产品安装脚本为主 | 多平台发布链更成熟 |
| 企业部署 | 基础 | MDM / settings / gateway 强 | sandbox / config / execpolicy 强 |

## 8. 文档完备性对比

### 8.1 Aether Engine

- 优点：覆盖架构、API、性能、测试、设计、HTTP 示例
- 问题：存在文档漂移，部分脚本/路径与仓库状态不完全一致

### 8.2 `claude-code`

- 优点：插件 README、settings、MDM、workflow 相关文档完整
- 问题：核心产品实现不在仓内，文档覆盖面天然受限

### 8.3 `codex`

- 优点：
  - 安装、配置、sandbox、skills、execpolicy、auth、slash commands、contributing 都有
  - `AGENTS.md` 对工程贡献规则极细
  - SDK 文档齐全
- 问题：
  - 很多用户侧主文档跳转外部官方文档
  - 仓库内信息量大，对新团队上手成本高

### 8.4 文档结论

- **最适合业务平台落地阅读**：Aether Engine
- **最适合插件/治理资产复用**：`claude-code`
- **最适合工程团队深挖实现与规范**：`codex`

## 9. 风险点与整合建议

### 9.1 Aether Engine 风险

1. 测试不稳定
2. CI 缺位
3. 文档漂移
4. 平台能力扩张快于治理能力建设

### 9.2 `claude-code` 风险

1. 仓库不能代表完整产品核心
2. 无法做源码级全链路平台对比

### 9.3 `codex` 风险

1. 工程规模巨大，学习与维护门槛高
2. Rust/Bazel/Nix 体系对团队要求高
3. 不直接提供你当前项目这种 Web 控制台形态

## 10. 针对性的决策建议

### 10.1 如果你的目标是继续做当前这个产品

建议路线：

1. **保留 Aether Engine 作为主线**
2. 从 `claude-code` 吸收：
   - 插件目录结构
   - 命令模板
   - GitHub 自动化
   - 企业 settings / MDM 思路
3. 从 `codex` 吸收：
   - 更严格的工程贡献规范
   - 测试分层与 snapshot/bench 机制
   - sandbox / approvals / execpolicy 设计
   - 多模块拆分与边界控制

### 10.2 短期最值得落地的 8 个动作

1. 给 Aether 增加 `.github/workflows`
2. 修掉现有 19 个失败测试
3. 把 e2e 和单测彻底分流
4. 修正文档漂移
5. 增加插件元数据和插件包规范
6. 增加受管配置/组织策略层
7. 增加审批/安全策略可视化与模板化
8. 为核心路径补 benchmark / smoke test / snapshot test

### 10.3 最终选型判断

| 目标 | 最优参考 |
|---|---|
| 做 Web 化、自有可控 Agent 平台 | **Aether Engine** |
| 做插件生态/组织治理体系 | **`claude-code`** |
| 做高成熟度本地编码代理基础设施 | **`codex`** |

## 11. 最终结论

三者最准确的理解方式不是“谁替代谁”，而是：

- **Aether Engine**：平台底座
- **`claude-code`**：治理层样板
- **`codex`**：高成熟度本地代理工程范本

如果用于项目决策，最建议的路线是：

**继续以 Aether Engine 为主线，系统吸收 `claude-code` 的治理能力和 `codex` 的工程体系。**

这条路线的收益最大，因为它既保留了你当前项目最有价值的“全栈平台能力”，又能显著补齐你现在最缺的“工程治理成熟度”。 
