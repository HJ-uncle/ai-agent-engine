# Aether Engine — 项目上下文

本文件（AE.md）的内容会自动注入每次对话的 system prompt，用于告知 Agent 本项目的关键信息与约定。

## 项目简介

Aether Engine（AE，以太引擎）是全栈 AI 智能体运行时引擎：Fastify HTTP/WS API + ReAct 推理循环 + 三脑记忆（向量/关系/图）+ 隔离工作区 + 多智能体协作 + Flow DAG 编排。

## 技术栈与约定

- 后端：Node.js ≥ 20、TypeScript ESM（import 必须带 `.js` 后缀）、Fastify 5、SQLite（libsql）、Vitest
- 一切持久配置走 DB（system_config / tenant_config），`.env` 仅作启动参数与保底回退
- 工具系统：内置工具 + MCP（`.aether/mcp.json`）+ Skills（`.aether/skills/`，SKILL.md 带 YAML frontmatter）

## 常用命令

- `npm run dev` — 启动后端（tsx watch）
- `npm run db:migrate` — 主库迁移
- `npm run memory:migrate` — 记忆库迁移
- `npm test` — Vitest 全量测试
- `npm run typecheck` — TS 类型检查

## 注意事项

- 改动 LLM 适配 / 工具协议相关代码时，注意未知 Provider 需降级为 OpenAI-compatible
- `~/.agent-engine/`（注意不是 ~/.aether）是运行时数据目录：deepseek-prices.json、undo-log.json
- 安全模式（safe/standard/full-access）为会话级开关，默认值见 aether.json 的 defaultSecurityMode
