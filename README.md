# Aether Engine

TypeScript / Node.js 智能体运行时，为同级 [Aether 桌面](../aether-code/README.md) 提供模型调用、持久任务、工具执行、子代理协作和 HTTP/SSE 服务。

文档以 2026-11-17 工作区源码为准；引擎版本见 [package.json](package.json)，实际安装版本通过 `GET /meta` 的构建身份确认。

## 开始使用

- [文档首页](docs/README.md)：全部功能与专题入口。
- [桌面用户指南](../aether-code/docs/user-guide.md)：配置模型、开始任务和管理工作区。
- [独立运行](docs/docs/getting-started.md)、[引擎管理后台](docs/operations/engine-admin.md)、[HTTP/SSE 接入](docs/docs/third-party-integration.md)。
- [运行机制](docs/runtime-guide.md)、[安全边界](docs/security-architecture.md)、[存储维护](docs/operations/session-storage-maintenance.md)。
- [插件公开参考](../aether-code/docs/plugin-api/dist/index.html)：在前端运行 `npm run docs:build` 后离线打开。

## 功能范围

模型与思考配置、自动上下文压缩、持久会话与重连、运行中补充、下一轮队列、三类内置子代理及消息协作、工作区与项目、文件搜索与变更回退、成果快照、记忆与知识库、Skills/MCP/工具包/插件、浏览器与Office工具、Git/终端/后台命令、Cron/Todo/任务队列/Flow、账号与第三方登录、权限与运行监控。完整源码对应见 [系统架构](docs/docs/overview.md)。

当前桌面只有一个默认界面；代码中的 Work/Code 兼容标识和后端工具 profile 不代表两个可切换界面。引擎启动后同端口自动提供 `/admin/` 管理后台，可管理后台成员、角色权限、审计及监控规则，并查看服务器状态与令牌配置，无需另外启动 Web 项目。

会话正文默认采用磁盘 JSONL，子代理大载荷有独立文件；SQLite 仍保留账户、配置、索引与运行元数据。模型上下文、显示历史、成果快照各自承担不同职责。

## 开发

```powershell
npm ci
npm run typecheck
npm run build
# 按快速开始配置独立数据目录、模型与鉴权后
npm run dev
```

仓库还保留独立的 [Web 控制台](multi-agent-console/README.md)，`npm run dev:web` 指向该实现，不会启动 Aether 桌面。两者接线与能力不同，不能共用桌面验收结论。使用与目标平台原生依赖匹配的 Node；本轮文档检查使用 Node 24.22.3。

[全量文档状态清单](docs/documentation-inventory.md) 区分现行说明、源码规范、历史提案和验收记录。旧测试数字不能视为当前版本的通过证明。
