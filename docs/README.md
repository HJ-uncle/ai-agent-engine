# Aether 文档首页

核对日期：2026-11-17。当前说明以引擎和桌面源码为准；历史报告保留当时证据，不用于承诺当前功能。

本次更新的覆盖范围、验证结果和未验证项见[文档刷新记录](documentation-refresh-2026-11-17.md)。

## 用户入口

| 任务 | 当前文档 |
|---|---|
| 第一次使用、配置模型与工作区 | [桌面用户指南](../../aether-code/docs/user-guide.md) |
| 查找全部界面功能 | [桌面功能源码地图](../../aether-code/docs/feature-map.md) |
| 登录、绑定第三方与找回原账号 | [桌面账号说明](../../aether-code/docs/accounts-and-login.md) |
| 进入引擎后台、管理成员与角色、查看服务器指标和实例令牌 | [快速开始](docs/getting-started.md)、[管理员指南](operations/engine-admin.md) |
| 理解模块分工 | [系统架构](docs/overview.md) |
| 查找保留资料与文档状态 | [全量文档清单](documentation-inventory.md) |

## 引擎运行与管理

| 主题 | 文档 |
|---|---|
| 会话、持久执行、子代理、记忆、知识、调度 | [运行指南](runtime-guide.md) |
| 上下文与历史 | [压缩机制](context-compression-design.md) |
| 模型与多模态 | [思考配置](thinking-mode-config.md)、[附件输入](multimodal-design.md) |
| 工具、Skills、MCP与管理权限 | [系统工具](docs/system-tools.md)、[会话工具包](session-toolkits.md) |
| 认证和执行边界 | [安全架构](security-architecture.md)、[账号机制](account-login.md)、[第三方配置](account-external-login.md) |
| 数据与性能 | [存储维护](operations/session-storage-maintenance.md)、[性能验证方法](docs/bench/performance.md) |
| 容器执行环境 | [可选运行时部署](../deploy/workspace-runtime/README.md) |

## 接入开发

- [HTTP/SSE 集成](docs/third-party-integration.md)、[API 使用约定](docs/api-spec.md)。
- [完整路由](docs/http-routes.md)、[机器可读路由目录](docs/openapi.json)。
- [引擎 SDK](../sdk-package/README.md)：启动/连接生命周期接口及当前缺口。
- [插件公开 HTML](../../aether-code/docs/plugin-api/dist/index.html)：插件 API 唯一公开来源；不与引擎 SDK 混用。
- [桌面架构](../../aether-code/docs/frontend-architecture.md)、[当前运行规范](../openspec/specs/agent-loop/spec.md)。

## 更新与检查

变更功能时同步对应专题和源码地图。被现行指南替代且不再提供独立证据的旧资料及时清理，并同步修正引用和清单；保留的历史报告注明原日期、失败与适用条件，不把旧测量改成新验收结论。

```powershell
node scripts/diagnostics/documentation-audit.mjs --check-catalogue
# 核对现行文档链接与全量状态目录
node scripts/diagnostics/documentation-audit.mjs --check-index --check-links
# 路由改变并审阅挂载关系后
node scripts/diagnostics/documentation-audit.mjs --write-catalogue
# 新增文档或调整文档状态后，审阅分类再重建清单
node scripts/diagnostics/documentation-audit.mjs --write-index
npm --prefix ../aether-code run docs:check
npm --prefix ../aether-code run docs:test
```

诊断只解析源码，输出在 `.e2e-tmp/documentation-refresh/`。OpenAPI 展开静态可解析的 Fastify schema；Zod、业务校验、流协议和权限仍回指处理器，不承诺完整的客户端生成契约。
