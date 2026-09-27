## Why

`responsive-h5-layout` 采用「单入口 + media query 响应式」方案，在桌面端零回归的目标下不得不把所有 PC 形态的 antd 组件、`onMouseDown` 拖拽监听、`Tooltip`、`Modal`、`Select` 直接套上 mobile 样式。实测下来：

- 底部 `BottomTabBar` 被 `100vh` 内容遮挡，无法正常滚动到底部
- 触摸需要点两下才能触发（`click` 与 `mousedown` 冲突 + antd `Tooltip` 拦截）
- `Toast`、`Modal`、`Select`、`ContextMenu` 仍是 PC 弹层逻辑，没有原生的 ActionSheet / 半屏 Sheet 体验
- `viewport` 高度抖动（移动浏览器地址栏伸缩）破坏布局
- 整体「不像移动 App」，根因是**复用 PC UI 组件 + media query 永远做不出原生手感**

业务后续要打包到 React Native，UI 层必然要重写。继续在响应式方向投入是沉没成本——**应当现在就把 UI 壳分叉**：

- 桌面端 (`web/`) 维持当前 VSCode 形态零变化
- 移动端 (`mobile/`) 用 `antd-mobile` 重新设计交互、布局和样式
- 共用层 (`core/`) 收敛 store / api / hooks / 领域逻辑，未来可被 RN 直接消费

## What Changes

- **BREAKING**: 移动端不再走 `App.tsx` 同一棵树；新增独立入口 `mobile/index.tsx` + `m.html`，nginx / 部署层按 UA 把 `/m/*` 或移动 UA 分流到 `m.html`
- **BREAKING**: 废弃 `src/components/mobile/MobileShell.tsx` 等基于 antd PC 组件的移动壳，由 `src/mobile/` 下基于 `antd-mobile` 的全新页面体系取代
- 新增 `src/core/` 目录，把当前散落在 `src/store/`、`src/api/`、`src/hooks/` 中的可复用部分迁入；`src/web/` 与 `src/mobile/` 各自从 `core/` 消费，二者之间不互相 import
- 引入 `antd-mobile@^5` 依赖，仅在移动入口使用；桌面入口不打入 `antd-mobile`，反之亦然
- `craco` 改造（或迁 vite）：`webpack.entry` 多入口、`HtmlWebpackPlugin` 双产物 (`index.html` / `m.html`)、`splitChunks` 共享 `core` chunk
- 移动端 UI 重新设计：原生 `NavBar` + `TabBar` + `ActionSheet` + 半屏 `Popup`，单手优先信息密度，禁用所有 PC 拖拽 / hover 交互
- `responsive-h5-layout` 中已落地的 `src/components/panels/index.tsx`（与 UI 框架解耦的面板渲染逻辑）和共享 hooks 直接迁入 `src/core/`，不浪费

## Capabilities

### New Capabilities
- `shared-core`: 跨形态复用的领域层（store、api 客户端、hooks、领域服务、类型定义），UI 框架无关，未来可被 React Native 入口直接消费
- `mobile-app-shell`: 移动端 H5 独立应用（独立入口、独立路由、独立 UI 体系、基于 antd-mobile 的原生手感导航 / 弹层 / 列表 / 表单）
- `multi-entry-build`: 多入口构建与分发（webpack 多入口、双 HTML 产物、按 UA 路由分流、移动包不打入桌面专属重型依赖）

### Modified Capabilities
<!-- 无：openspec/specs/ 目前为空，无既有 spec 需要修改 -->

## Impact

- **新增依赖**：`antd-mobile@^5`（仅 mobile 入口）
- **目录结构重排**：
  - 新增 `src/core/`、`src/web/`、`src/mobile/`
  - `src/App.tsx` → 拆为 `src/web/App.tsx` + `src/mobile/App.tsx`
  - `src/components/mobile/*` → 标记废弃，迁移至 `src/mobile/components/`
  - `src/store/`、`src/api/`、`src/hooks/`、`src/types/` → 合并入 `src/core/`
- **构建配置**：`craco.config.js` 重写以支持多入口；`public/` 增加 `m.html` 模板
- **CI / 部署**：`npm run build` 同时产出两份 HTML；nginx / Capacitor 配置需新增 UA 分流或路径规则
- **既有变更归档**：`responsive-h5-layout` 中桌面零回归 + `panels/` 抽离 + `useBreakpoint` 这些产物迁移至 `core/` 后归档；移动壳代码（`src/components/mobile/`）作废
- **不影响**：后端 API、数据库、Agent / MCP 内核逻辑均零变更
