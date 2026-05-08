## ADDED Requirements

### Requirement: 多入口构建产物

`npm run build` 的产物 MUST 同时包含 `build/index.html`（桌面）与 `build/m.html`（移动），且二者注入的 `<script>` 不交叉：

- `index.html` 仅注入 `main.*.js` 与 `vendor.*.js`、`core.*.js`
- `m.html` 仅注入 `mobile.*.js` 与 `vendor-mobile.*.js`（或共享 vendor 中不含桌面专属库的部分）、`core.*.js`

#### Scenario: 双 HTML 同时产出
- **WHEN** 执行 `npm run build`
- **THEN** `build/` 目录下同时存在 `index.html` 和 `m.html`，且二者大小均小于 50 KB（gzip 前）

#### Scenario: 移动 HTML 不引用 monaco/xterm
- **WHEN** `cat build/m.html | grep -E "monaco|xterm"`
- **THEN** 命令返回空

### Requirement: 共享 chunk 拆分

构建配置 MUST 通过 `splitChunks.cacheGroups` 强制把 `src/core/` 下的代码独立成 `core.[hash].js` chunk，二个入口 HTML 都引用同一份 `core` chunk 文件名。

#### Scenario: core chunk 独立
- **WHEN** 检查 `build/static/js/` 下文件
- **THEN** 存在唯一一个名为 `core.[hash].js` 的文件，且 `index.html` 与 `m.html` 中均出现该文件名

### Requirement: Bundle 体积约束

`m.html` 首屏加载的 JS 总大小（gzip）MUST 满足：
- 桌面专属库（`monaco-editor`、`@xterm/*`、`reactflow`、`react-resizable-panels`）≤ 0 字节出现在 mobile chunk 中
- 总首屏 JS（含 vendor + core + mobile）≤ 350 KB gzip

#### Scenario: 体积自动验证脚本
- **WHEN** 在 CI 中运行 `node scripts/check-mobile-bundle.js`
- **THEN** 脚本检查 `m.html` 引用的所有 chunk，断言上述约束并以非零退出码失败

### Requirement: 开发服务器双入口访问

执行 `npm start` 后，开发服务器 MUST 同时服务两个入口：
- `http://localhost:3000/`        → 桌面入口
- `http://localhost:3000/m.html`  → 移动入口

#### Scenario: 移动入口本地可访问
- **WHEN** 启动 `npm start` 后用 Chrome DevTools 设为 iPhone 12 模拟，导航至 `http://localhost:3000/m.html`
- **THEN** 加载移动 App，TabBar、NavBar 正常渲染，控制台无 404 / 资源加载失败

### Requirement: UA 分流文档

仓库 MUST 在 `docs/deploy/nginx-ua-routing.md`（或 README 一节）提供 nginx UA 自动分流配置示例，使部署时移动 UA 自动跳转 `m.html`。

#### Scenario: 文档存在且包含 nginx 片段
- **WHEN** 查看 `docs/` 或 `multi-agent-console/README.md`
- **THEN** 存在一段含 `$http_user_agent ~* "(Mobile|Android|iPhone|iPad)"` 与 `rewrite ^/$ /m.html` 的 nginx 配置示例

### Requirement: 构建脚本兼容现有命令

新增多入口配置 MUST NOT 破坏既有 `npm run build` / `npm start` / `npm run typecheck` 的命令签名与产出位置（`build/` 目录、`build/static/` 子目录），便于现有 Docker / Capacitor / RN WebView 流程零改造。

#### Scenario: 既有命令签名不变
- **WHEN** 执行 `npm run build`
- **THEN** 不需要任何额外参数，产物输出至 `build/`，`build/static/js/`、`build/static/css/`、`build/static/media/` 目录结构与之前一致
