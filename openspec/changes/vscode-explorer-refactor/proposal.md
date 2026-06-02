## Why

现有 `ExplorerPanel` 组件功能单薄，仅支持基础文件树浏览与简单重命名，缺少 VS Code 级别的编辑器集成、Git 状态感知、图片/视频预览、快捷键体系与高性能虚拟化。随着项目规模扩大，用户对文件管理体验的要求已与专业 IDE 对齐，现在是将其重构为生产级资源管理器的最佳时机。

## What Changes

- **重构** `ExplorerPanel.tsx`：采用 VS Code 层级树（无限嵌套、虚拟滚动、拖拽排序、多选 Ctrl/Shift+Click）
- **新增** Material Icon Theme 图标体系：基于 `vscode-icons-js` 按扩展名匹配，缺省 fallback 至 `default_file.svg`
- **新增** 右键上下文菜单：新建文件、新建文件夹、重命名（F2）、删除（Delete）、复制路径（Ctrl+Shift+C）、在终端中打开（Ctrl+\`）、在 Git 中查看历史（Ctrl+G）
- **新增** `EditorTabsArea` 多标签编辑器宿主：集成 Monaco Editor，支持 150+ 语言高亮与 IntelliSense
- **新增** 图片预览器：jpg/png/gif/webp/svg/bmp/ico，支持缩放、旋转、还原
- **新增** 视频预览器：mp4/webm/ogg，播放/暂停、进度条、倍速、全屏、静音、逐帧
- **新增** 十六进制编辑器：二进制文件回退，16 字节/行，偏移地址 + ASCII 对照
- **新增** 文本编辑状态管理：未保存标识"●"、Ctrl+S / Ctrl+K S 保存、eslint/prettier 自动格式化
- **新增** 关闭确认对话框：VS Code 风格三按钮（保存/不保存/取消）
- **新增** Git 状态集成：文件树节点旁实时显示 U/M/A/C 状态图标
- **新增** Git 历史面板：展示 log、diff 预览
- **新增** 一键拉取按钮：git pull --rebase，冲突自动打开三方合并视图
- **新增** 文件操作回滚日志：删除前移至回收站，支持撤销最近一次删除/重命名
- **新增** 性能优化：虚拟滚动（react-window）、≥5 万文件首次展开 < 200 ms
- **新增** E2E 测试套件：≥30 条用例（Playwright）

## Capabilities

### New Capabilities

- `vscode-file-tree`: VS Code 风格文件树，含图标体系、多选、拖拽、右键菜单、快捷键
- `monaco-editor-integration`: Monaco Editor 多标签宿主，含语言高亮、undo/redo、保存状态管理
- `file-preview`: 图片预览器、视频预览器、十六进制编辑器
- `git-integration`: Git 状态图标、历史面板、git pull/rebase、三方合并视图
- `file-ops-safety`: 文件操作回滚日志、删除移至回收站、撤销支持
- `explorer-performance`: 虚拟滚动、大目录优化、性能基准

### Modified Capabilities

（无现有 spec 需变更）

## Impact

- **修改文件**：`src/components/ExplorerPanel.tsx`、`src/components/ExplorerPanel.module.css`、`src/components/EditorArea.tsx`
- **新增文件**：`src/components/explorer/FileTree.tsx`、`src/components/explorer/ContextMenu.tsx`、`src/components/explorer/GitBadge.tsx`、`src/components/editor/EditorTabs.tsx`、`src/components/editor/MonacoEditor.tsx`、`src/components/editor/ImagePreview.tsx`、`src/components/editor/VideoPreview.tsx`、`src/components/editor/HexEditor.tsx`、`src/components/git/GitHistoryPanel.tsx`、`src/components/git/MergeView.tsx`
- **新增依赖**：`@monaco-editor/react`、`react-window`、`trash`（Node.js 回收站）、`simple-git`、`@playwright/test`
- **API 扩展**：`workspaceApi` 增加 `createFile`、`createFolder`、`deleteFile`（回收站）、`renameFile`、`getGitStatus`、`getGitLog`、`gitPull`、`readFileBinary` 接口
