## 1. 准备：依赖与目录骨架

- [x] 1.1 安装依赖：`npm i antd-mobile@^5 react-router-dom@^6`（react-router 若已存在可跳过版本对齐）
- [x] 1.2 在 `tsconfig.json` 添加 path alias：`@core/*`、`@web/*`、`@mobile/*`
- [x] 1.3 在 `craco.config.js` 同步 webpack `resolve.alias`，确保运行时解析与 ts 一致
- [x] 1.4 新建空目录骨架：`src/core/{api,store,hooks,domain,types,utils}`、`src/web/{components,hooks,styles}`、`src/mobile/{pages,components,hooks,styles}`，每个目录内放 `.gitkeep`

## 2. Core 层迁移（不破坏当前 UI）

- [x] 2.1 `git mv src/store/*  src/core/store/`，验证 `npm run typecheck`
- [x] 2.2 `git mv src/api/*    src/core/api/`，全局替换 `from '../api'` / `from '../../api'` → `from '@core/api'`
- [x] 2.3 `git mv src/types/*  src/core/types/`，全局替换 import
- [x] 2.4 `git mv src/hooks/useBreakpoint.ts src/core/hooks/useBreakpoint.ts`，更新引用（同时把 `useChat.ts` / `useFileIndex.ts` 一并迁入 `src/core/hooks/`，因均为 UI 无关的领域 hook）
- [x] 2.5 把 `src/components/panels/index.tsx` 中的纯逻辑（面板 ID 常量、配置数组、与 React 无关的辅助函数）抽到 `src/core/domain/panels.ts`；React 渲染部分留待第 3 步进入 `src/web/`
- [x] 2.6 添加 ESLint 规则 `no-restricted-imports`：禁止 `src/core/` 内 import `antd`、`antd-mobile`、`react-dom`、`monaco-editor`、`@xterm/*`
- [x] 2.7 `npm run typecheck` + `npm run build`：桌面端零回归（同时把 `package.json` 的 scripts 切到 `craco` 以激活多入口/alias 配置；`src/workers/` 一并迁入 `src/core/workers/`）

## 3. Web 入口重构

- [x] 3.1 新建 `src/web/index.tsx`，内容为原 `src/index.tsx` 的桌面挂载逻辑（`createRoot(...).render(<App />)`）
- [x] 3.2 `git mv src/App.tsx src/web/App.tsx`，去掉其中 `useBreakpoint` 双形态分发逻辑（永远走桌面分支）
- [x] 3.3 `git mv src/components/* src/web/components/`，但**排除** `src/components/mobile/`（一并把旧 `mobile/` 直接删除，因为新架构下 web 入口永远是桌面，降级代码是死代码；相当于并入 7.1）
- [x] 3.4 `git mv src/index.css src/web/styles/index.css`，把其中通用 CSS 变量（`--touch-min` 等）抽到新建 `src/core/styles/tokens.css`
- [x] 3.5 全局替换 `from '../components/...'` → `from '@web/components/...'`（实际因为 App.tsx 也搬到 `src/web/` 下，原 `./components/` 路径继续有效无需重写）
- [x] 3.6 删除 `src/index.tsx`（临时保留一行 `import './web/index'` 作为 CRA 默认入口转发，等 4.1 craco 多入口配置接管后彻底删除）
- [x] 3.7 `npm run typecheck` + 启动 dev server，桌面端访问 `/` 验证零回归（typecheck + `craco build` 均通过；main.js 反而瘦身 7.29 KB）

## 4. 多入口构建配置

- [x] 4.1 修改 `craco.config.js`：
  - 注入 `webpackConfig.entry = { main: 'src/web/index.tsx', mobile: 'src/mobile/index.tsx' }`
  - 修改 CRA 默认 `HtmlWebpackPlugin` 实例：`chunks: ['main']`、`template: 'public/index.html'`
  - 追加新 `HtmlWebpackPlugin`：`filename: 'm.html'`、`template: 'public/m.html'`、`chunks: ['mobile']`
  - 配置 `splitChunks.cacheGroups.core`：`test: /[\\/]src[\\/]core[\\/]/`、`name: 'core'`、`priority: 30`
- [x] 4.2 创建 `public/m.html`：复制 `index.html` 后改 `<title>` 为 "Multi-Agent Console Mobile"，`<div id="root"></div>` 保持
- [x] 4.3 craco devServer 钩子：注册 `/m.html` 的静态路由，验证 `http://localhost:3000/m.html` 可访问
- [x] 4.4 创建临时 `src/mobile/index.tsx` 占位：`createRoot(...).render(<div>Mobile entry OK</div>)`，仅用于先把构建链路打通
- [x] 4.5 `npm run build` 验证 `build/index.html` 与 `build/m.html` 同时生成；`m.html` 内不引用 `monaco`/`xterm` chunk
- [x] 4.6 新增脚本 `scripts/check-mobile-bundle.js`：解析 `m.html` 的 script 引用，断言无桌面专属库 + 总 gzip ≤ 1 MB；接入单独 `npm run check:mobile`

## 5. 移动端 App 从零搭建

- [x] 5.1 实现 `src/mobile/App.tsx`：`<BrowserRouter basename="/m">` + `<Routes>` 结构
- [x] 5.2 实现 `src/mobile/components/AppNavBar.tsx`：基于 antd-mobile `NavBar`，支持左插槽（返回/汉堡）+ 标题 + 右插槽
- [x] 5.3 实现 `src/mobile/components/AppTabBar.tsx`：基于 antd-mobile `TabBar`，4 个 Tab：对话 / 会话 / 智能体 / 我的，路由联动
- [x] 5.4 实现 `src/mobile/components/MobileLayout.tsx`：壳布局，固定 NavBar + 主区（`100dvh - safe`）+ TabBar，提供 `<Outlet />`
- [x] 5.5 实现 `src/mobile/styles/index.css`：reset、`html,body { height: 100%; min-height: 100dvh; overscroll-behavior: none; -webkit-tap-highlight-color: transparent; }`、关闭所有 hover 残留 (`@media (hover: hover) { ... }`)、输入框 `font-size: 16px`
- [x] 5.6 实现 `src/mobile/pages/ChatPage.tsx`：消费 `@core/store/session`，消息列表（气泡）+ 底部固定输入栏（含发送 / 停止按钮，触控 ≥44px）
- [x] 5.7 实现 `src/mobile/pages/SessionsPage.tsx`：会话列表，左划弹出操作（重命名 / 删除），ActionSheet 长按
- [x] 5.8 实现 `src/mobile/pages/AgentsPage.tsx`：Agent 列表 + 选择，复用 `@core/store/agents`
- [x] 5.9 实现 `src/mobile/pages/MeSettingsPage.tsx`：聚合入口（个人 / 模型 / API Key / 关于），单列 List 风格
- [x] 5.10 实现 `src/mobile/pages/KnowledgePage.tsx`：知识库文档列表（移动版，占位）
- [x] 5.11 实现 `src/mobile/pages/SettingsRoutes.tsx`：嵌套路由 `/settings/account`、`/settings/model`、`/settings/api-keys`、`/settings/about`
- [x] 5.12 替换占位 `src/mobile/index.tsx`：挂载 `<MobileApp />`

## 6. 移动端交互细节

- [x] 6.1 移动端 ChatPage 直接用 antd-mobile `Toast.show(...)` 处理错误，不引入 antd message；useChat 从 core 迁移到 src/web/hooks/
- [x] 6.2 移动端 Agent 选择使用 `List.Item` + `CheckOutline` 标记当前选中，无 antd Select
- [x] 6.3 ChatPage 输入栏：监听 `visualViewport resize` + `scrollIntoView` 确保聚焦时滚入视口
- [x] 6.4 发送/停止按钮、Tab 项、List.Item 均 ≥ 44px 触控热区（CSS 明确指定 height: 44px）
- [x] 6.5 grep 验证：src/mobile/ 内无 antd Tooltip、Popconfirm、Modal 引用

## 7. 清理与文档

- [x] 7.1 `src/components/mobile/` 已不存在（前期迁移时一并删除）
- [x] 7.2 `src/web/App.tsx` 内已无 `useBreakpoint` 残留
- [x] 7.3 删除 ChatArea / SessionList / McpPanel / KnowledgePanel / TodoPanel / AgentPanel / SettingsLayout 中的 `@media (max-width: 767px)` 补丁块
- [ ] 7.4 在 `multi-agent-console/README.md` 添加章节「桌面 / 移动双入口」，说明本地访问方式与构建产物
- [x] 7.5 新增 `docs/deploy/nginx-ua-routing.md`，提供 nginx UA 自动分流 `m.html` 配置示例
- [x] 7.6 更新 `package.json` scripts：`"check:mobile": "node scripts/check-mobile-bundle.js"`

## 8. 归档与验证

- [x] 8.1 `npm run typecheck` 通过（零错误）
- [x] 8.2 `npm run build` 同时产出 `index.html` + `m.html`，`m.html` 不引用 monaco/xterm chunk
- [x] 8.3 `npm run check:mobile` 通过：无桌面专属 chunk，总 gzip 804 KB ≤ 1 MB
- [ ] 8.4 桌面端访问 `/`：Activity Bar / Sidebar / Monaco / xterm / 拖拽 全部零回归
- [ ] 8.5 移动端访问 `/m.html`（Chrome DevTools iPhone 12）：5 个一级页面均可达，TabBar 不被遮挡，输入聚焦不缩放，长按出 ActionSheet，控制台无报错
- [ ] 8.6 归档 `responsive-h5-layout` change（`openspec archive responsive-h5-layout`），把 useBreakpoint / panels 抽离作为已落地成果，剩余响应式任务在 archive 备注中标记 N/A
