# Aether Engine — 项目上下文

调用项目上下文加载器的执行通路会按所选工作区读取 AE.md，并注入 system prompt。用户级上下文默认来自 `~/.aether/AE.md`（可由 `AETHER_GLOBAL_DIR` 改写）；项目级优先读取 `.ae/AE.md`，仅在它不存在时兼容本文件 `.aether/AE.md` 与根目录 `AE.md`。已存在但为空的 `.ae/AE.md` 不会重新启用旧文件。

## 项目简介

Aether Engine（AE，以太引擎）是全栈 AI 智能体运行时引擎：Fastify HTTP/WS API、Agent 推理循环、记忆检索、工作区管理与多智能体协作。另保留 Flow DAG 等辅助入口；具体边界见 [运行指南](../docs/runtime-guide.md)。

## 技术栈与约定

- 后端：Node.js、TypeScript ESM（import 必须带 `.js` 后缀）、Fastify 5、SQLite（libsql）、Vitest；环境要求见 [开发说明](../docs/docs/getting-started.md)
- 配置包含数据库层（system_config / tenant_config）与文件层（aether.json、MCP、Skills、AE.md 等），`.env` 提供启动参数与保底回退；不能假定所有配置都在数据库
- 工具系统：内置工具 + MCP + Skills（SKILL.md 带 YAML frontmatter）。项目数据以 `.ae/` 为规范位置，兼容旧 `.aether/`；实际加载还受全局层、配置路径和会话授权影响

## 常用命令

- `npm run dev` — 启动后端（tsx watch）
- `npm run db:migrate` — 主库迁移
- `npm run memory:migrate` — 记忆库迁移
- `npm test` — Vitest 全量测试
- `npm run typecheck` — TS 类型检查

## 注意事项

- 改动 LLM 适配 / 工具协议相关代码时，注意未知 Provider 需降级为 OpenAI-compatible
- `DATA_DIR` 默认 `./data/agent.db`，语义是主 SQLite **文件路径**。主库保留运行元数据；默认会话正文位于同级 `sessions/` JSONL，大正文在 `blobs/`，子代理正文在 `<数据库文件>.subagent-payloads/`。记忆库为同级 `memory/memory.db`，知识库为同级 `knowledge.db`，变更快照为同级 `change-snapshots/`；路径可受各自配置覆盖，详见 [存储维护说明](../docs/operations/session-storage-maintenance.md)
- `~/.agent-engine/deepseek-prices.json` 用于价格缓存，不代表引擎全部运行数据位置；共享用户配置与技能默认位于 `~/.aether/`
- 安全模式（safe/standard/full-access）可由会话覆盖；未设置 `DEFAULT_SECURITY_MODE` 时默认 standard，非法值回退 safe；aether.json 的 defaultSecurityMode 可在启动时提供默认配置
