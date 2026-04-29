## Context

当前 `ExplorerPanel.tsx` 使用 Ant Design `Tree` 组件 + `vscode-icons-js` 图标，仅提供基础文件列表、搜索过滤与工作区重命名。缺少：
- 代码编辑能力（EditorArea 与文件树完全解耦）
- Git 状态感知
- 图片/视频/二进制预览
- 右键菜单与快捷键体系
- 文件操作安全回退（回收站）
- 大目录虚拟滚动

目标平台：Electron ≥ 22 + React 18 + TypeScript 5，UI 框架 Ant Design 5。

---

## Goals / Non-Goals

**Goals:**
- 将 ExplorerPanel 升级为与 VS Code 体验一致的生产级资源管理器
- 集成 Monaco Editor 多标签宿主，支持 150+ 语言
- 图片、视频、十六进制三类预览器
- Git 状态图标 + 历史面板 + git pull/三方合并
- 文件操作回收站 + 回滚日志
- 性能：5 万文件首次展开 < 200 ms
- E2E 测试 ≥ 30 条

**Non-Goals:**
- 完整 LSP（Language Server Protocol）后端——仅 Monaco 内置的 IntelliSense
- 实时协同编辑（CRDT）
- 远程文件系统（SSH/SFTP）——已有独立 RemoteSettings 模块
- VS Code 插件生态兼容

---

## Decisions

### D1：文件树方案 — 保留 Ant Design Tree + 虚拟滚动补丁 vs 自研虚拟树

**选择：保留 Ant Design Tree，增加 `rc-tree` 的 `virtual` 属性 + `react-window` 辅助**

理由：Ant Design 5 的 `Tree` 底层即 `rc-tree`，直接传入 `virtual={true}` 可启用内置虚拟滚动，无需重写树逻辑，降低迁移风险。5 万节点场景下 `rc-tree` 虚拟列表渲染 DOM 节点 ≤ 50 个，满足 < 200 ms 指标。

### D2：Monaco Editor 宿主方案 — `@monaco-editor/react` vs 手动 CDN loader

**选择：`@monaco-editor/react`**

理由：官方维护、TypeScript 类型完整、支持 `onMount` 拿到 editor 实例，可直接调用 `editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, ...)` 注册快捷键。打包方式选择 `monaco-editor-webpack-plugin` 以保证离线可用（不依赖 CDN）。

### D3：Git 操作层 — `simple-git` vs 原生 `child_process` 调用 git 命令

**选择：`simple-git`**

理由：提供 Promise API、跨平台 Windows 路径处理、内置 `diff`/`log`/`status` 解析，避免手工解析 git 输出。在 Electron 主进程中通过 IPC 暴露给渲染进程。

### D4：删除安全 — `trash` npm 包 vs 自定义实现

**选择：`trash` 包（`trash@^7`）**

理由：`trash` 在 Windows/macOS/Linux 均使用系统回收站 API，无需额外 native 绑定，在 Electron 主进程中调用。

### D5：图标加载方式 — CDN vs 本地 bundle

**选择：开发环境 CDN（jsDelivr），生产打包时内联至 `public/vscode-icons/`**

理由：现有代码已使用 CDN，短期维持兼容；生产构建通过 `vscode-icons-js` 提供的图标名称列表预下载至本地，避免离线场景失效。

### D6：状态管理扩展 — `session` store vs 新增 `explorerStore`

**选择：新增 `src/store/explorer.ts`（Zustand slice）**

理由：编辑器标签、未保存状态、Git 状态缓存、操作回滚日志都属于 Explorer 专属状态，混入 `session` store 会造成单一 store 过重。通过 Zustand 的 `combine` 保持 devtools 可见性。

### D7：预览类型分发 — 在 `EditorArea` 做统一路由

**选择：`EditorArea` 根据文件扩展名枚举分发至 `MonacoEditor` / `ImagePreview` / `VideoPreview` / `HexEditor`**

```
EditorArea
  ├── isImage(ext)  → ImagePreview
  ├── isVideo(ext)  → VideoPreview
  ├── isBinary(ext) → HexEditor
  └── default       → MonacoEditor
```

---

## Risks / Trade-offs

| 风险 | 缓解措施 |
|---|---|
| Monaco + webpack 打包体积 > 150 MB | 使用 `monaco-editor-webpack-plugin` 按需加载语言包；仅打包 top-50 语言；其余动态 import |
| `rc-tree` virtual 在超深层级（> 10 层）滚动时出现抖动 | 节点高度固定为 22 px；展开时批量计算偏移 |
| `simple-git` 在 Electron renderer 无法直接调用 | 通过 `contextBridge` 暴露 IPC handler；主进程维护 `simpleGit` 实例 |
| git pull --rebase 冲突时三方合并视图实现复杂 | 第一期使用 Monaco diff editor（双栏）降级实现，三方视图列为 P2 |
| Windows 路径分隔符导致文件 key 匹配失败 | 统一使用 `path.posix` 归一化；存储时始终用 `/` |
| E2E 测试 ≥ 30 条耗时 | 使用 Playwright + `electron` 驱动；并行运行 worker = 4 |

---

## Migration Plan

1. **阶段一（当前 PR）**：在 `src/components/explorer/` 新建子目录，不删除原 `ExplorerPanel.tsx`，通过 Feature Flag `REACT_APP_NEW_EXPLORER=1` 切换
2. **阶段二**：新组件通过所有 E2E 测试后，替换 `App.tsx` 中的引用，删除旧文件
3. **回滚**：关闭 Feature Flag 即可回退，无数据库 migration

---

## Open Questions

- [ ] Electron IPC 接口命名规范是否需要对齐现有 `workspaceApi`？（建议：复用 REST 接口风格，主进程通过 `ipcMain.handle` 代理）
- [ ] `prettier`/`eslint` 格式化在保存时是否阻塞编辑器 UI？（建议：放入 Web Worker 或主进程异步执行）
- [ ] 三方合并视图（P2）的优先级排期
