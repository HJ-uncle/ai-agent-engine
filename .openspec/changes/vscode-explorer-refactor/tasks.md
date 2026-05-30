## 1. 依赖安装与项目初始化

- [x] 1.1 在 `multi-agent-console/package.json` 中添加 `@monaco-editor/react`、`monaco-editor`、`monaco-editor-webpack-plugin`、`react-window`、`@types/react-window`
- [x] 1.2 添加后端依赖：`simple-git`、`trash`（主进程/server 侧）
- [x] 1.3 添加测试依赖：`@playwright/test`、`electron` playwright driver
- [x] 1.4 配置 `craco.config.js`（或 `webpack.config.js`）引入 `MonacoEditorWebpackPlugin`，按需加载语言包（top-50 语言）
- [x] 1.5 在 `tsconfig.json` 中确认 `strict: true`，TypeScript 5 兼容性

## 2. 状态管理层（explorerStore）

- [x] 2.1 创建 `src/store/explorer.ts`（Zustand），定义 `TabItem`、`UndoLog`、`GitStatusMap` 类型
- [x] 2.2 实现 `openTab` / `closeTab` / `setActiveTab` / `markDirty` / `markSaved` actions
- [x] 2.3 实现 `undoLog`：pushLog / popLog（LIFO，最大 50 条），持久化至 `~/.agent-engine/undo-log.json`
- [x] 2.4 实现 `gitStatusMap`：按文件路径缓存 U/M/A/C 状态，`refreshGitStatus` action
- [x] 2.5 编写 explorerStore 单元测试（Jest）

## 3. API 层扩展（workspaceApi + IPC）

- [x] 3.1 在 `src/api/index.ts` 中扩展 `workspaceApi`：`createFile`、`createFolder`、`deleteFile`（调用 trash）、`moveFile`、`readFileText`、`readFileBinary`
- [x] 3.2 扩展 `workspaceApi`：`getGitStatus`、`getGitLog`、`gitPull`（`simple-git` 封装）
- [x] 3.3 后端（Electron 主进程或 Express server）实现对应 IPC/REST 路由，引入 `simple-git` 和 `trash`
- [x] 3.4 路径归一化工具函数 `normalizePath(p: string): string`（统一使用 `/` 分隔符）

## 4. VS Code 风格文件树（FileTree 组件）

- [x] 4.1 创建 `src/components/explorer/FileTree.tsx`：Ant Design `Tree` + `virtual={true}` + 行高 22 px
- [x] 4.2 实现图标渲染逻辑：`vscode-icons-js` + fallback `default_file.svg` / `default_folder.svg`
- [x] 4.3 实现 Ctrl+Click 多选、Shift+Click 范围选（`multiple` prop + 自定义 onSelect 逻辑）
- [x] 4.4 实现拖拽排序（`draggable` + `onDrop` 调用 `workspaceApi.moveFile`）
- [x] 4.5 内联重命名：F2 触发节点名称进入 `<Input>` 编辑，Enter 确认，Esc 取消
- [x] 4.6 创建 `src/components/explorer/ContextMenu.tsx`：右键菜单 7 项，快捷键绑定

## 5. Git 状态徽章（GitBadge 组件）

- [x] ~~5.1 创建 `src/components/explorer/GitBadge.tsx`~~ **[已移除] Git 功能整体下线**
- [x] ~~5.2 在 `FileTree` 节点 `title` 渲染区嵌入 `GitBadge`~~ **[已移除]**
- [x] ~~5.3 实现 5 秒轮询 `refreshGitStatus`~~ **[已移除]**

## 6. 重构 ExplorerPanel

- [x] 6.1 新建 `src/components/explorer/index.tsx` 作为新 ExplorerPanel 入口，包含 Feature Flag `REACT_APP_NEW_EXPLORER`
- [x] 6.2 将工作区 Header Dropdown（现有逻辑）迁移至新组件，保留现有功能
- [x] 6.3 接入 `FileTree`，替换旧 Ant Design Tree
- [x] 6.4 工具栏增加"拉取"按钮（调用 `workspaceApi.gitPull`）
- [x] 6.5 工具栏增加 Ctrl+P 快速文件搜索面板（`QuickOpenPanel` 组件）
- [x] 6.6 在 `App.tsx` 中增加 Feature Flag 判断，切换新旧 ExplorerPanel

## 7. Monaco Editor 多标签宿主

- [x] 7.1 创建 `src/components/editor/EditorTabs.tsx`：标签栏（显示●未保存标识）、关闭按钮、拖拽重排
- [x] 7.2 创建 `src/components/editor/MonacoEditor.tsx`：`@monaco-editor/react` 封装，`onMount` 注册 Ctrl+S / Ctrl+K S 快捷键
- [x] 7.3 Ctrl+S：调用 prettier/eslint 格式化（主进程异步）后 `workspaceApi.writeFile`，`markSaved`
- [x] 7.4 Ctrl+K S：遍历所有 dirty tabs 逐一保存
- [x] 7.5 关闭 dirty tab：弹出 VS Code 风格三按钮确认对话框（`UnsavedDialog` 组件）
- [x] 7.6 未保存标识同步至浏览器标题栏（`document.title`）

## 8. 文件预览器

- [x] 8.1 创建 `src/components/editor/ImagePreview.tsx`：支持 jpg/jpeg/png/gif/webp/svg/bmp/ico，棋盘格背景
- [x] 8.2 图片缩放（滚轮 + 按钮）、旋转（90° 步进）、1:1 / 适应窗口还原
- [x] 8.3 创建 `src/components/editor/VideoPreview.tsx`：HTML5 video 播放器
- [x] 8.4 视频控制：播放/暂停（Space）、进度条、倍速下拉、全屏（F）、静音（M）、逐帧（← →）
- [x] 8.5 创建 `src/components/editor/HexEditor.tsx`：每行 16 字节，偏移地址 + 十六进制 + ASCII 列
- [x] 8.6 重构 `src/components/EditorArea.tsx`：根据扩展名分发至对应预览器或 MonacoEditor

## 9. Git 历史面板与冲突解决视图

- [x] 9.1 创建 `src/components/git/GitHistoryPanel.tsx`：展示 git log（作者、日期、短哈希、消息）
- [x] 9.2 点击提交记录展开 Monaco DiffEditor（`@monaco-editor/react` DiffEditor）
- [x] 9.3 创建 `src/components/git/MergeView.tsx`：冲突文件列表 + Monaco DiffEditor 双栏（OURS / THEIRS）
- [x] 9.4 "标记为已解决"按钮：调用 `git add <file>`，冲突列表移除该条目

## 10. 文件操作安全（回收站 + 回滚）

- [x] 10.1 所有删除操作调用 `workspaceApi.deleteFile`（后端用 `trash`），前端弹出确认对话框
- [x] 10.2 删除/重命名成功后调用 `explorerStore.pushLog`
- [x] 10.3 文件树聚焦时 Ctrl+Z 绑定到 `explorerStore.undoLastOp`（还原删除 or 反向重命名）
- [x] 10.4 回滚日志持久化：启动时读取 `~/.agent-engine/undo-log.json`，关闭时写入

## 11. 性能优化与 Ctrl+P 快速搜索

- [x] 11.1 `QuickOpenPanel.tsx`：Ctrl+P 唤起，模糊匹配（`fuse.js`），100 ms 内呈现结果
- [x] 11.2 文件索引在工作区加载时后台构建（Web Worker），增量更新（fs.watch）
- [x] 11.3 性能基准脚本 `scripts/perf-benchmark.ts`：cold-start / 大目录展开 / Ctrl+P 三项指标
- [x] 11.4 `npm run perf:bench` 脚本命令配置，输出 `reports/perf-baseline.json`

## 12. E2E 测试

- [x] 12.1 Playwright 配置文件 `playwright.config.ts`（Electron 驱动，worker=4）
- [x] 12.2 文件树操作用例：新建文件（×2）、新建文件夹（×1）、重命名（×2）、删除（×2）、拖拽移动（×1）
- [x] 12.3 多选用例：Ctrl+Click（×1）、Shift+Click（×1）
- [x] 12.4 编辑器用例：打开文件、编辑内容出现●、Ctrl+S 保存消除●、Ctrl+Z 撤销（×4）
- [x] 12.5 快捷键冲突用例：Ctrl+N / F2 / Delete 在编辑器聚焦时不触发文件操作（×2）
- [x] 12.6 保存确认对话框用例：保存、不保存、取消三个分支（×3）
- [x] 12.7 预览用例：图片打开+缩放（×2）、视频打开+播放（×1）、hex 打开（×1）
- [x] 12.8 Git 状态刷新用例：修改文件后文件树出现 M 徽章（×1）
- [x] 12.9 Git 历史面板用例：Ctrl+G 打开面板，展开 diff（×2）
- [x] 12.10 Git pull 无冲突用例（×1）、有冲突打开 MergeView（×1）
- [x] 12.11 回收站/撤销用例：删除后 Ctrl+Z 还原（×2）、重命名后 Ctrl+Z 还原（×1）
- [x] 12.12 性能用例：大目录展开 < 200 ms 断言（×1）、Ctrl+P 搜索 < 100 ms 断言（×1）
- [ ] 12.13 验收：所有测试用例通过率 100%，CI 流水线集成

## 13. 终端功能（待实施）

> 决策：使用 **xterm.js + node-pty + WebSocket**，与文件树右键「在终端中打开」联动

- [x] 13.1 安装依赖：前端 `@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-web-links`；后端 `node-pty`、`@fastify/websocket`
- [x] 13.2 后端：新增 `TerminalManager`（`src/terminal/index.ts`）管理 PTY 生命周期（create/write/resize/kill）
- [x] 13.3 后端：新增 WebSocket 路由 `GET /terminal/ws/:id`，双向转发 PTY ↔ xterm 数据流
- [x] 13.4 后端：新增 REST 路由 `POST /terminal/create`（传入 `cwd`、`sessionId`）返回 `terminalId`
- [x] 13.5 前端：封装 `<XTerminal>` 组件（`src/components/terminal/XTerminal.tsx`），挂载 xterm 实例，ResizeObserver 自动 fit
- [x] 13.6 前端：创建 `terminalStore`（Zustand）管理多 Tab 终端状态（id、title、cwd、alive、panelHeight）
- [x] 13.7 前端：创建 `<TerminalPanel>` 容器（Tab 栏 + 新建/最大化/关闭按钮 + 拖拽调整高度）
- [x] 13.8 前端：`EditorArea.tsx` 布局改为上下分割（编辑器区 + 终端面板），`panelVisible` 控制
- [x] 13.9 联调：右键「在终端中打开」→ `explorer:open-terminal` 事件 → `TerminalPanel` 新建终端并 `cd` 目标目录
- [x] 13.10 联调：`ResizeObserver` 监听容器尺寸变化 → `fitAddon.fit()` + WS `resize` 消息 → PTY `pty.resize()`
- [ ] 13.11 测试：终端基本交互（输入/输出/Tab 补全）、多 Tab 并发、resize 正确性

## 14. 清理与发布

- [ ] 14.1 确认所有 E2E 测试通过后，在 `App.tsx` 默认启用新 ExplorerPanel（移除 Feature Flag）
- [ ] 14.2 删除旧 `ExplorerPanel.tsx` 及相关模块
- [ ] 14.3 清理临时文件（`_design_instructions.json`、`_specs_instructions.json`、`_tasks_instructions.json`）
- [x] 14.4 更新 `README.md`：新增"资源管理器"章节，说明快捷键、预览类型
- [ ] 14.5 打包体积验证：确保 < 150 MB（Monaco 按需加载，图标本地化）

---

## 🐛 Bug 修复记录

| 日期 | 问题 | 根因 | 修复方案 |
|------|------|------|---------|
| 2026-04-29 | 编译错误：import 在 module body 中 | `App.tsx` 动态 import 位置不对 | 移至文件顶部静态 import |
| 2026-04-29 | TS 错误：Icon prop 类型不匹配 | FileTree icon props 类型推断失败 | 改为 `(props: any)` + `!!props.expanded` |
| 2026-04-29 | **Maximum update depth exceeded**（无限循环） | `MonacoEditor` 用 `selectDirtyTabs`（每次返回新数组引用）订阅 Zustand，触发 `tabs` 变化 → 重渲染 → 再触发 | ① `EditorTabs` 去掉 `selectDirtyTabs` 订阅，直接读 `tab.isDirty`；② `markDirty` 加 early-return（已 dirty 不重复 set）；③ `updateDirtyContent` 写入模块级 `Map` 绕开响应式 |
| 2026-04-29 | TS 错误：`useStore` 第二参数类型不支持 | Zustand 版本类型定义不含 `equalityFn` 重载 | 拆分为多个原始类型 selector（`activeTabPath`、`activeTabName`、`activeTabIsDirty`），渲染时手动组合 `TabItem` |
| 2026-04-29 | Git 功能整体下线 | 需求变更：当前阶段不需要 Git 集成 | 删除 `GitBadge`、`GitHistoryPanel`、`MergeView`，清理所有 Git 相关 store / API / 后端路由 |
