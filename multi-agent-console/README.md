# Multi-Agent Console

VS Code 风格的 AI Agent 管理控制台，内置完整资源管理器、代码编辑器与 Git 集成。

---

## 资源管理器（VS Code Explorer）

### 功能特性

| 功能 | 快捷键 | 说明 |
|------|--------|------|
| 快速打开文件 | `Ctrl+P` | 模糊搜索工作区所有文件，100 ms 内返回结果 |
| 内联重命名 | `F2` | 在文件树中直接重命名文件/文件夹 |
| 多选 | `Ctrl+Click` / `Shift+Click` | 支持范围选和跳选 |
| 保存文件 | `Ctrl+S` | 自动调用 prettier 格式化后保存 |
| 保存全部 | `Ctrl+K S` | 保存所有未保存标签页 |
| Git 历史 | 右键菜单 → 在 Git 中查看历史 | Monaco DiffEditor 展示提交 diff |
| Git 拉取 | 工具栏 ↓ 按钮 | `git pull --rebase`，有冲突自动打开 MergeView |
| 回收站删除 | `Delete` / 右键菜单 | 文件移至系统回收站，`Ctrl+Z` 可还原 |
| 拖拽移动 | 拖拽树节点 | 拖拽到目标文件夹自动移动 |

### Git 状态徽章

文件树节点右侧显示彩色徽章：
- 🟢 **U** — 未跟踪（Untracked）
- 🟡 **M** — 已修改（Modified）
- 🔵 **A** — 已暂存（Added/Staged）
- 🔴 **C** — 冲突（Conflict）

状态每 **5 秒**自动轮询刷新。

### 文件预览

| 类型 | 扩展名 | 功能 |
|------|--------|------|
| 代码编辑器 | ts/js/py/go/... (50+ 语言) | Monaco Editor，语法高亮、IntelliSense |
| 图片预览 | jpg/png/gif/webp/svg/bmp/ico | 缩放（滚轮）、旋转、1:1/适应窗口 |
| 视频播放 | mp4/webm/ogg | 进度条、倍速、全屏（F）、逐帧（← →） |
| 十六进制 | 其他二进制文件 | 16 字节/行，偏移+HEX+ASCII 三列显示 |

### Feature Flag

默认使用新版资源管理器。如需回退旧版，设置环境变量：

```bash
REACT_APP_NEW_EXPLORER=0 npm start
```

---

# Getting Started with Create React App

This project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).

## Available Scripts

In the project directory, you can run:

### `npm start`

Runs the app in the development mode.\
Open [http://localhost:12323](http://localhost:12323) to view it in the browser. (Frontend dev server, not the API server which runs on port 12323)

The page will reload if you make edits.\
You will also see any lint errors in the console.

### `npm test`

Launches the test runner in the interactive watch mode.\
See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### `npm run build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.\
Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.

### `npm run eject`

**Note: this is a one-way operation. Once you `eject`, you can’t go back!**

If you aren’t satisfied with the build tool and configuration choices, you can `eject` at any time. This command will remove the single build dependency from your project.

Instead, it will copy all the configuration files and the transitive dependencies (webpack, Babel, ESLint, etc) right into your project so you have full control over them. All of the commands except `eject` will still work, but they will point to the copied scripts so you can tweak them. At this point you’re on your own.

You don’t have to ever use `eject`. The curated feature set is suitable for small and middle deployments, and you shouldn’t feel obligated to use this feature. However we understand that this tool wouldn’t be useful if you couldn’t customize it when you are ready for it.

## Learn More

You can learn more in the [Create React App documentation](https://facebook.github.io/create-react-app/docs/getting-started).

To learn React, check out the [React documentation](https://reactjs.org/).
