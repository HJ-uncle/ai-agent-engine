# 插件工作台扩展验收记录

日期：2026-11-13。范围：`ai-agent-engine` 引擎与同级 `aether-code` 桌面客户端的当前工作区改动。

开发入口：[插件开发者文档](../../../aether-code/docs/plugin-api/dist/index.html)。示例工程：[workbench-extension](../examples/workbench-extension/README.md)。

## 交付范围

- 清单提供 12 种贡献：pages、navigation、workspaceTabs、services、commands、menus、views、statusBar、settings、editorDecorations、hooks、background。
- 菜单提供 8 个位置，内嵌页面提供 3 个位置；消息、会话、文件及编辑器上下文由宿主绑定。
- 支持工具表单、自包含 Webview、声明式宿主 React 组件，以及受权限控制的系统弹窗、通知、剪贴板、输入框和编辑器接口。
- 生命周期由实际会话、文件与主/子 Agent 状态产生；后台调度由引擎持久化与恢复。
- 活动入口统一固定在底部引擎状态旁，服务/通知浮层向上展开；顶部和侧栏不再重复挂载。
- 开发模式直接打开源码目录，刷新后执行受校验快照，不需要反复安装卸载。

## 验证结果

| 验证 | 结果 | 实际范围 |
|---|---|---|
| 引擎插件与子代理广测 | 27 文件、383 项通过 | 插件服务、能力、工程、权限、生命周期、持久后台和标准子代理执行 |
| 引擎最后修改后的定向回归 | 3 文件、24 项通过 | application、lifecycle-background、contributions；与广测有重叠，不相加计总数 |
| 主 Agent 生命周期与真实 admission | 10 项通过 | 主任务开始/终止去重，以及主/子 Agent 真实事件接线 |
| 前端纯逻辑 | 15 项通过 | 原生文档/贡献注册与消息、文件事件逻辑 |
| 插件与活动区 Electron 验收 | 20 项最终均通过 | 见下方 5 个 spec；其中服务托盘 5 项经测试时序修正后复跑通过 |
| 既有终端定向回归 | 3 项通过 | 日志游标、隐藏后停止读取、会话隔离、停止/重启及历史保留 |
| 既有删除确认回归 | 1 项通过 | 取消不发送请求，确认只删除所属历史 |
| 示例清单与业务 | 清单有效、2 项通过 | 确定性工具输出；不是平台模型调用测试 |
| 构建 | 两仓类型检查与构建通过 | 客户端 E2E 使用本次构建的 `out/` |

Electron 的 20 项来自：

```text
e2e/extension-host-ui.spec.ts                 8
e2e/plugin-extension-surfaces-ui.spec.ts      3
e2e/plugin-native-host-ui.spec.ts             3
e2e/plugins-development-real-engine.spec.ts  1
e2e/service-tray-ui.spec.ts                   5
```

真实开发模式用例启动独立引擎、临时账户和 Electron，验证源码工具执行、HTML 刷新、授权保留/撤销、浏览器插件页面、原生受控输入 → 真实 Node 子进程以及零安装。其余 UI 用例使用真实 Electron/渲染层与隔离 HTTP 夹具。系统弹窗/剪贴板用例经过真实 preload/main IPC，但在 Electron 中替换 OS 调用，避免修改用户剪贴板或等待人工关闭弹窗。本轮没有调用正式模型、读取正式凭据或修改正式数据。

## 验收中修复的问题

1. 插件重新启用时旧导航请求重放，把用户从管理页面带走；改为按请求和来源消费一次。
2. 普通导航复用旧消息上下文；现在只保留本次打开动作的目标，普通导航清空。
3. 非当前会话右键打开插件页面被忽略；现在先切换到目标会话，再打开绑定页面，目标已删除时明确提示。
4. 插件设置只有分区可搜索，未登记结果元数据；现在设置搜索与注册/卸载同步。
5. Monaco 菜单移焦后选区折叠，工具收到空选择；现在保存菜单打开时的目标快照，同时验证下次空选区不会复用旧值。
6. 活动入口随会话/页面切换位置变化；现在由状态栏唯一承载，上下文独立传递。

两处验收手势也按证据修正：Monaco 菜单建立后有 100ms 的 mouseup 忽略窗口，测试使用 150ms 按压；托盘关闭动画期间 DOM 仍可见，测试改用按钮 `aria-expanded` 与面板 `data-motion-state` 判断真正打开。未删除或降低业务断言。

## 重跑命令

引擎仓库：

```powershell
npx vitest run src/plugins/__tests__ src/core/subagent/__tests__/subagent-runtime.test.ts src/core/subagent/__tests__/tracked-async-runner.test.ts --maxWorkers=1 --minWorkers=1
npx vitest run src/plugins/__tests__/application.test.ts src/plugins/__tests__/lifecycle-background.test.ts src/plugins/__tests__/contributions.test.ts --maxWorkers=1 --minWorkers=1
npx vitest run src/api/http/__tests__/root-agent-events.test.ts src/api/http/routes/__tests__/chat-production-admission.test.ts --maxWorkers=1 --minWorkers=1
npm run typecheck
npm run build
npx tsx scripts/plugin-project.ts check docs/examples/workbench-extension
npx tsx scripts/plugin-project.ts test docs/examples/workbench-extension
```

客户端仓库，先构建，再串行运行：

```powershell
npm run build
npx playwright test --config e2e/config/playwright.config.ts e2e/plugin-native-host-ui.spec.ts e2e/plugin-extension-surfaces-ui.spec.ts e2e/extension-host-ui.spec.ts e2e/service-tray-ui.spec.ts e2e/plugins-development-real-engine.spec.ts --output=.e2e-tmp/plugin-extensions/recheck
npx playwright test --config e2e/config/playwright.config.ts e2e/work-terminal-ui.spec.ts -g '活动入口|隐藏工作区|服务菜单真实停止' --output=.e2e-tmp/plugin-extensions/terminal-recheck
npx playwright test --config e2e/config/playwright.config.ts e2e/dialog-consistency-ui.spec.ts -g '删除服务历史' --output=.e2e-tmp/plugin-extensions/dialog-recheck
```

## 本机证据与示例包

客户端日志位于 `D:\dev\aether-code\.e2e-tmp\plugin-extensions\`：`final-build.log`、`final-ui.log`、`service-final.log`、`terminal.log`、`dialog.log`。`final-ui.log` 保留修正测试时序前的 18 passed / 1 failed / 1 did not run；`service-final.log` 是对应 5 项最终全部通过的复跑证据。失败 trace 未删除。深浅主题截图在 `final-ui-results/` 与 `service-final-results/`。

主 Agent 结果位于引擎 `.e2e-tmp/plugin-extensions/main-agent-results.json`（10 passed / 0 failed）。广测与最后定向引擎测试的退出码及摘要保存在本次协作执行记录中。

示例归档：`.e2e-tmp/plugin-extensions/workbench-extension.zip`，6161 字节。

SHA-256：`f7201ad703f12a87f8c4ebdfbc88028009897a929f707264d6d0123f364470c5`。

## 运行边界

- 新增主进程桥与托盘逻辑需要重启客户端加载；构建成功不代表正在运行的旧进程已经升级。
- 窗口关闭到托盘时，已授权后台任务继续；真正退出或电脑关机时停止，下次引擎启动恢复。
- 原生页面采用声明式宿主组件，系统操作采用具名、受权限控制的桥；不注入任意 React 代码或暴露原始 Electron IPC。
- 当前文件预览保持只读，`editor.get/reveal` 可用；文件修改使用已授权的 `workspace.write`。
- 生命周期事件是有界通知，不是持久消息队列；跳过、限流与重启恢复语义详见开发者文档。
