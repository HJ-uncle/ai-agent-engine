# Multi-Agent Console（独立 Web 实现）

本目录保留一套 React Web 控制台，包含桌面浏览器界面与移动入口，使用本仓库引擎的 HTTP/SSE/WebSocket API。它有自己的 package.json、Vite 配置和源码，并非已删除或只有设计稿的目录。

当前主桌面产品在同级 [aether-code](../../aether-code/README.md)，采用 Electron 与统一默认界面。本目录不承载该桌面应用；修改它不会同步改变 Aether Code。下述内容按 2026-11-17 源码核对，未进行浏览器、构建或真实模型验收，不能据此宣称全部功能与当前引擎兼容。

## 启动

从引擎仓库根目录安装两边依赖：

```powershell
npm install
npm --prefix multi-agent-console install
```

在一个终端按引擎 [开发说明](../docs/docs/getting-started.md) 配置并启动后端：

```powershell
npm run dev
```

另一个终端启动本控制台：

```powershell
npm run dev:web
```

也可进入本目录执行 `npm start`。实际脚本是 `vite`，不是 Create React App。开发服务配置端口为 **3010**，被占用时以 Vite 输出为准；默认将 `/api` 代理到 **http://localhost:12323**。

- 桌面浏览器入口：`http://localhost:3010/`
- 移动入口：`http://localhost:3010/m/chat`
- 移动源码入口是 `m.html`，路由 basename 为 `/m`；开发服务器对 `/m/*` 做历史回退。

API 客户端读取 `VITE_API_URL`，值不包含 `/api/v1`。要使用同源开发代理，可在本目录自己的 `.env.local` 中显式设置：

```dotenv
VITE_API_URL=
VITE_NEW_EXPLORER=1
```

前端源码仍保留旧 `process.env.REACT_APP_*` 回退，而当前 Vite 配置只明确替换 NODE_ENV；显式设置上述 Vite 变量可避免走这两处旧读取。不要把后端凭据或模型 API Key 放进 VITE_* 变量，它们会进入浏览器产物。旧 CRA 的 setupProxy.js 和 REACT_APP_PROXY_* 不是当前 Vite 启动的代理配置。

## 构建与本地检查入口

在本目录执行：

| 命令 | 实际作用 |
| --- | --- |
| `npm run build` | Vite 构建桌面与移动两个入口，输出 dist/ |
| `npm run preview` | 预览已构建静态资源；不是引擎服务器 |
| `npm run typecheck` | tsc --noEmit |
| `npm test -- --run` | 按 vitest.config.ts 运行现有单元测试 |
| `npm run check:mobile` | 保留的移动 bundle 检查；脚本仍读取旧 build/m.html，与 Vite dist/ 不一致，需先对齐后使用 |
| `npm run perf:bench` | 保留的性能脚本；目前会在用户目录创建大量夹具并写 reports/，尚未符合项目 .e2e-tmp 输出约定，不作为默认检查命令 |

包中残留的 eject 脚本属于 CRA 旧工具链，不是当前 Vite 工作流。生产部署需要静态服务器正确回退桌面/移动路由，并显式配置 API、SSE 与 WebSocket 代理；开发配置不能直接视为生产部署方案。

## 已有界面与源码入口

| 区域 | 源码中已有内容 | 主要入口 |
| --- | --- | --- |
| 桌面 Shell | 会话侧栏、聊天/编辑器分屏、活动面板、设置弹窗 | [web/App.tsx](src/web/App.tsx) |
| 聊天 | SSE 文本、思考、工具、用量、提问卡片和历史恢复 | [useChat.ts](src/web/hooks/useChat.ts)、[API 客户端](src/core/api/index.ts) |
| 资源管理 | 文件树、编辑器、预览、Git 与终端组件 | [explorer](src/web/components/explorer/)、[terminal](src/web/components/terminal/) |
| 管理面板 | Agent、MCP、知识库、工具、技能、记忆、待办等 | [panels](src/web/components/panels/index.tsx)、[SettingsModal](src/web/components/SettingsModal.tsx) |
| 移动页面 | /m/chat、/m/todo、/m/me、/m/settings/* | [mobile/App.tsx](src/mobile/App.tsx)、[SettingsRoutes](src/mobile/pages/SettingsRoutes.tsx) |
| 共享状态/API | 会话状态、Agent 状态、类型与 HTTP/SSE 方法 | [core](src/core/) |

这是源码能力清单，不是全量端到端通过清单。旧 README 的“100 ms 返回”“所有保存自动格式化”“完整 Git 集成”等保证需要各自运行证据，不能由组件存在直接推导。

## 账号与当前引擎的兼容边界

桌面“账号设置”和移动账号页仍是“即将推出”的占位，未实现当前引擎的注册、登录、刷新、恢复码、外部身份或二次认证完整流程。普通 API request() 会读取浏览器 localStorage 中的 api_key/auth_token 并附加请求头，但这只是已有凭据的读取，不是登录实现。

以下差异已经由源码确认：

1. chatStream、cancelChat、编辑/重新生成、恢复流等独立 fetch 路径未复用普通 request() 的鉴权头。即使普通管理请求带凭据，也不能推断聊天、取消和恢复请求携带同一身份。
2. 控制台 toolResponse 结构只有 toolCallId/name/output；当前引擎还要求 runId/requestId。不能承诺旧提问/批准卡片可完成当前持久运行的恢复。
3. 当前 SSE 解析主要覆盖文本、思考、工具、用量与旧提问事件；新的 root run、pending、协作和成果状态需要逐项对齐，不能把基础文本流正常当成完整运行状态兼容。
4. terminalApi 构造同源 WebSocket URL；当前 Vite /api 代理未设置 ws:true，而旧 setupProxy.js 设置不会被 Vite 使用。终端 WebSocket 代理与身份握手需专项核对。
5. healthApi 请求 /health，但开发代理只覆盖 /api；同源页面成功响应不能单独证明引擎健康。
6. 移动模型/API Key 页面主要是引导占位，与桌面设置功能范围不同。

这些问题不表示所有资源读取或管理页面都不可用。已有 HTTP 方法和页面是否可用，要按当前引擎路由、身份、权限与实际返回分别验证。不要为兼容旧控制台而关闭生产认证；账号标准流程见引擎 [账号登录说明](../docs/account-login.md)，当前桌面操作以 Aether Code 为准。

## 引擎调度能力的限制

即使页面有管理入口，也应以当前引擎实际能力为准：`/tasks` 的 HTTP 队列当前未注册生产 handler，未知提交类型返回 501；`/cron/capabilities` 在需要请求认证的部署中明确返回 executionSupported=false，不能承诺登录后自动化即可运行；Flow 的运行/取消索引在进程内，没有持久 DAG 重启恢复，且部分 DTO 配置字段尚未被执行器消费。这些不是“所有 Web 功能不可用”的结论，而是需要分别对齐的后端边界。详见 [调度、队列与流程](../docs/runtime-guide.md#调度队列与流程)。

## 维护范围

本轮只更新 README，未修复以上兼容差异、修改 UI 或运行真实会话。目录中的历史 docs/openspec 设计、旧测试报告和示例不能替代当前 API 契约；运行机制见 [引擎运行指南](../docs/runtime-guide.md)，HTTP 定义以引擎当前路由及生成产物为准。
