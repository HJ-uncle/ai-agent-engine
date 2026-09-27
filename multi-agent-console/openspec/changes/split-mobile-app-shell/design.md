## Context

`multi-agent-console` 当前是 CRA + craco 的单 React SPA，桌面 VSCode 形态。`responsive-h5-layout` 尝试用响应式做 H5 适配，结果证明：媒体查询无法解决「触摸事件」「弹层模型」「滚动容器」「viewport 抖动」等本质性差异。

业务路线已确定：H5 阶段在浏览器内独立可用 → 后续用 RN WebView 套壳 → 远期 RN 原生。需要提前为 RN 留出干净的层边界。

**已确认决策**（与用户对齐）：
- 架构方式：A. 同一 React 项目、双入口双 HTML
- 移动 UI 库：A. antd-mobile 5.x
- core 边界：A. 领域层全共享（store + api + hooks + 领域逻辑），UI 完全分离

## Goals / Non-Goals

**Goals:**
- G1 — `src/core/` 与任何 UI 框架解耦，可被未来 RN 入口直接 import
- G2 — `src/web/` 完全维持现有 VSCode 桌面形态，零回归
- G3 — `src/mobile/` 是从零设计的移动 App，使用 antd-mobile 原生组件，符合 iOS/Android 用户操作习惯（拇指可达、底部 TabBar、半屏 Sheet、ActionSheet、下拉刷新）
- G4 — `npm run build` 产出 `index.html`（PC bundle）+ `m.html`（mobile bundle），二者共享 `core` chunk，但绝不交叉打入对方专属依赖（PC 不打入 antd-mobile；mobile 不打入 antd / monaco / xterm / 拖拽逻辑）
- G5 — 部署侧通过 nginx UA 判断 + 路径 `/m` 双重分流，本地开发通过 `/m.html` 直接访问

**Non-Goals:**
- 不做 SSR / Next.js 迁移（暂无 SEO 需求）
- 不在本次接入 React Native（仅留出边界，RN 入口为后续单独的 change）
- 不重写后端 API
- 不动 Agent / MCP / LLM 调用内核
- 不做手势库（左滑删除、长按）的统一抽象，若需要直接用 antd-mobile 的 `SwipeAction`

## Decisions

### D1 — 双入口构建：craco + 多 entry，而非分离 monorepo

**选择**：保持单仓单 `package.json`，通过 `craco.config.js` 注入 webpack 多入口配置：

```js
// craco.config.js (片段)
configure: (webpackConfig) => {
  webpackConfig.entry = {
    main:   path.resolve(__dirname, 'src/web/index.tsx'),
    mobile: path.resolve(__dirname, 'src/mobile/index.tsx'),
  };
  webpackConfig.plugins.push(
    new HtmlWebpackPlugin({
      template: 'public/m.html',
      filename: 'm.html',
      chunks: ['mobile'],   // mobile.html 只注入 mobile chunk
    }),
  );
  // 修改 CRA 默认 HtmlWebpackPlugin 的 chunks 为 ['main']
  webpackConfig.optimization.splitChunks = {
    chunks: 'all',
    cacheGroups: {
      core:   { test: /[\\/]src[\\/]core[\\/]/, name: 'core', priority: 30 },
      vendor: { test: /[\\/]node_modules[\\/]/, name: 'vendor', priority: 20 },
    },
  };
  return webpackConfig;
}
```

**理由**：
- 现有项目深度依赖 CRA + craco（Monaco、worker-loader、reactflow 一堆配置都在 craco 里），迁 vite/monorepo 风险高
- 多入口是 webpack 标准能力，无需新工具链
- 共享 `core` chunk 保证两个入口 bundle 不重复打领域代码

**替代方案及否决理由**：
- pnpm monorepo (`apps/web` + `apps/mobile` + `packages/core`)：长期最干净，但前期需要重排构建、CI、Docker、依赖管理，风险/收益当前阶段不划算 → 留作 RN 阶段再做
- vite 多入口：vite 对 CRA 的迁移工程量大，且 Monaco / worker 配置需要重写

### D2 — Core 层目录结构

```
src/
├── core/                    # 共享，UI 框架无关
│   ├── api/                 # axios / fetch 封装、各 endpoint client
│   ├── store/               # zustand stores（chat, session, agent, mcp, ...）
│   ├── hooks/               # 与 UI 无关的逻辑 hooks（useStreamMessage, useMcpSession）
│   ├── domain/              # 领域服务（message-parser, llm-router, mcp-driver）
│   ├── types/               # TS 类型与接口
│   └── utils/               # 纯函数工具
├── web/                     # 桌面入口
│   ├── index.tsx            # ReactDOM.render(<DesktopApp />)
│   ├── App.tsx              # 当前 App.tsx 重命名搬迁
│   ├── components/          # 现 src/components/ 中桌面专属组件搬迁
│   ├── hooks/               # 仅 UI 相关 hooks（拖拽、Monaco mount 等）
│   └── styles/
└── mobile/                  # 移动入口
    ├── index.tsx            # ReactDOM.render(<MobileApp />)
    ├── App.tsx              # antd-mobile ConfigProvider + 路由
    ├── pages/               # 一页一文件：ChatPage, SessionsPage, AgentsPage, ...
    ├── components/          # 移动专属组件
    ├── hooks/               # 移动专属 hooks（手势、键盘、安全区）
    └── styles/
```

**强制约束（lint 规则）**：
- `src/core/` 不允许 `import 'antd'` / `'antd-mobile'` / `'react-dom'` / `'monaco-editor'` / `'@xterm/*'`
- `src/web/` 不允许 `import 'src/mobile/*'`
- `src/mobile/` 不允许 `import 'src/web/*'`
- 用 `eslint-plugin-import` + `no-restricted-imports` 强制

### D3 — 移动端架构：单页面应用 + react-router-dom

每个一级 Tab 对应一个 page route，内部用 react-router 嵌套：

```
/             → ChatPage          (默认首页)
/sessions     → SessionsPage      (历史会话)
/agents       → AgentsPage
/knowledge    → KnowledgePage
/settings     → SettingsPage
/settings/*   → SettingsDetailPage
```

底部固定 `TabBar`（4 个 Tab：对话 / 会话 / 智能体 / 我的），`+` 按钮居中突出新建会话。

**理由**：
- antd-mobile 的 `TabBar` 与 react-router 是官方标准组合，无需自研
- 一页一路由，浏览器返回键 / RN 物理返回键天然可用
- 未来 RN 用 `react-navigation`，结构对齐

### D4 — 移动端布局基线

| 元素 | 规格 | 备注 |
|---|---|---|
| 顶部 NavBar | 高 44 + safe-top | antd-mobile `NavBar` |
| 主内容 | `100dvh - 44 - 50 - safe` | `100dvh` 解决地址栏抖动 |
| 底部 TabBar | 高 50 + safe-bottom | antd-mobile `TabBar` |
| 触控最小 | 44×44 | iOS HIG |
| 字号基础 | 15px | 输入框 16px 防 iOS 缩放 |
| 弹层 | `Popup` (半屏) / `ActionSheet` / `Toast` | 一律不用 antd `Modal` |
| 列表 | `List` + `SwipeAction` | 长列表用 `VirtualInput` |
| 加载 | `PullToRefresh` + `InfiniteScroll` | |

### D5 — 状态管理：跨入口共享同一份 zustand store

- store 定义在 `src/core/store/`
- 持久化使用 `localStorage`（key 同名），桌面与移动 H5 在同源下天然共享会话/设置
- 已发出请求的网络 promise 不跨入口共享（一次会话只在一个入口内）

### D6 — 部署/路由分流

**生产 nginx（示例）**：
```nginx
location / {
  if ($http_user_agent ~* "(Mobile|Android|iPhone|iPad)") {
    rewrite ^/$ /m.html break;
  }
  try_files $uri $uri/ /index.html;
}
location /m {
  try_files /m.html =404;
}
```

**开发**：
- `npm start` 启动后，`http://localhost:3000/` = 桌面，`http://localhost:3000/m.html` = 移动
- DevTools 切移动设备模拟器后手动访问 `/m.html` 验证

**Capacitor / RN WebView**：
- 直接装载 `m.html`，不依赖 UA 分流

### D7 — 现有代码迁移策略

| 旧位置 | 新位置 | 备注 |
|---|---|---|
| `src/store/*` | `src/core/store/*` | 路径重写，import 全局替换 |
| `src/api/*` | `src/core/api/*` | 同上 |
| `src/types/*` | `src/core/types/*` | 同上 |
| `src/hooks/useBreakpoint.ts` | `src/core/hooks/useBreakpoint.ts` | 仍有用（mobile 内部还要分 ≥768 平板） |
| `src/components/panels/index.tsx` | 拆分：纯逻辑入 `core/`、桌面渲染入 `web/components/panels/`，mobile 重写 | |
| `src/App.tsx` | `src/web/App.tsx` | 仅去掉 `useBreakpoint` 分发逻辑 |
| `src/components/*`（除 mobile/）| `src/web/components/*` | |
| `src/components/mobile/*` | **删除** | 由 `src/mobile/` 重写 |
| `src/index.css` | 拆为 `src/web/styles/index.css` + `src/mobile/styles/index.css` | 公共变量入 `core/styles/tokens.css` |

迁移采用「批量 git mv + tsconfig path 别名」减少 import 改动量：

```jsonc
// tsconfig.json paths
{
  "@core/*":   ["src/core/*"],
  "@web/*":    ["src/web/*"],
  "@mobile/*": ["src/mobile/*"]
}
```

## Risks / Trade-offs

- **R1 多入口构建复杂度↑** → 用 craco 标准 webpack API，CI 不变；`npm run build` 输出验证脚本检查 `m.html` 不含 monaco/xterm chunk
- **R2 PC 与移动行为分叉，未来需要双向同步业务变更** → 通过 `core/` 层统一沉淀业务，UI 层只做渲染；约定新 feature 必须先在 core 落地
- **R3 antd-mobile 与 antd 同时存在导致包变大** → 各自只在自己入口打包，splitChunks 不合并，验证产物大小
- **R4 zustand store 跨入口持久化冲突** → 同源 localStorage 是优势不是劣势；若担心冲突，给 mobile store 加 key 前缀 `m:` 隔离
- **R5 craco 多 entry 与 CRA dev server 兼容问题** → 已知 CRA dev server 默认只服务 `index.html`，需要在 `craco devServer` 钩子里注册 `/m.html` 静态路由；测试方案含手动验证
- **R6 移动端首版功能缺口（Monaco 编辑器、xterm 终端不支持）** → 接受；移动端聚焦聊天 + 会话 + Agent 管理三件事，编辑器和终端不属于移动场景

## Migration Plan

1. **第一阶段：core 层抽离**（不破坏当前 UI）
   - 新增 `src/core/`，把 `store/api/types/utils` 搬过去，加 path alias
   - 全局替换 import，verify `npm run typecheck` & `npm run build` 通过
   - 此时桌面端依然是当前形态，无回归

2. **第二阶段：web 入口重构**
   - 新增 `src/web/`，搬迁 `App.tsx` 与桌面 `components/`
   - 修改 craco 多入口（仅 main）+ 修正 CRA 默认 HtmlWebpackPlugin
   - verify 桌面端零回归

3. **第三阶段：mobile 入口从零搭建**
   - 安装 `antd-mobile`
   - 新建 `src/mobile/index.tsx` + `m.html` 模板
   - 实现 5 个一级页面（Chat / Sessions / Agents / Knowledge / Settings）
   - 实现 NavBar / TabBar / Popup / ActionSheet 体系

4. **第四阶段：清理**
   - 删除 `src/components/mobile/*`
   - 删除 `App.tsx` 内的 `useBreakpoint` 分发逻辑
   - 归档 `responsive-h5-layout` change

5. **回滚策略**：每阶段独立 commit；若移动端阶段三失败，可只回滚 mobile 入口与 craco 多入口配置，桌面端不受影响

## Open Questions

- Q1：移动端是否需要支持「外部链接深度跳转」（`/m/sessions/abc-123` 直接打开某会话）？影响路由设计。**默认决策：是**，react-router-dom 配合参数化路由
- Q2：Capacitor 还是直接 RN WebView？影响 `m.html` 的 manifest / 启动图配置。**默认决策：RN WebView**（用户已确认），manifest 仅做 PWA 兜底
- Q3：是否需要 Service Worker 离线？**默认决策：本变更暂不做**，留作后续优化
