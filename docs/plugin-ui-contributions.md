# 插件前端贡献协议

完整开发入口、所有挂载区域及 SDK 签名见 [插件开发者文档](../../aether-code/docs/plugin-api/dist/index.html)。本文保留 Webview、服务与生命周期的细节；新增扩展以开发者文档和 `contributions.ts` 严格 Schema 为准。

`manifest.contributes` 将已发布工具连接到 Aether 的页面、侧栏、工作区与服务托盘。引擎验证并封存清单和 HTML；桌面宿主只加载当前引擎连接中已发布且启用的修订。AI 作者通过 `plugin_get_template`、HTTP 客户端通过 `GET /plugins/project/templates` 获取相同能力目录与贡献 JSON Schema。`desktop-timer` 是包含真实工具、页面和确定性测试的完整示例。

## 贡献类型

页面、导航、标签、服务、状态按钮、设置、后台各最多 16 条，命令/内嵌界面/装饰/hooks 各 32 条，菜单 64 条。`id` 使用小写字母开头的字母、数字、连字符（最多 48 字符）；`title` 为 1–120 字符。`scope` 为 `global`（默认）或 `session`；`when` 可按 `session`、`workspace`、`engineReady` 的布尔条件显示。`order` 为 -1000 至 1000 的整数。

| 字段 | 必填字段 | 行为 |
|---|---|---|
| `pages`，`kind: "tool"` | `id`, `title`, `kind` | 原生参数操作页；可用 `tool` 指定默认工具 |
| `pages`，`kind: "webview"` | `id`, `title`, `kind`, `entry`, `tools` | 包内自包含 HTML；`tools` 是页面可调用的本地工具白名单 |
| `navigation` | `id`, `title`, `page` | 左侧导航入口；`page` 引用同插件页面 |
| `workspaceTabs` | `id`, `title`, `page` | 工作区“更多工作区”菜单入口；通常设置 `scope: "session"` |
| `services` | `id`, `title`, `tool` | 底部固定活动入口中的服务状态；可选 `stopTool`, `statusTool`, `page`, `args` |
| `pages`，`kind: "native"` | `id`, `title`, `kind`, `entry` | JSON 声明的宿主 React 组件树，可选工具白名单 `tools` 默认空 |
| `commands` | `id`, `title`, `tool` 或 `page` | 命令面板与窗口快捷键 |
| `menus` | `id`, `title`, `location`, `command` | 消息、会话、文件、编辑器、顶栏、服务及输入框操作 |
| `views` | `id`, `title`, `location`, `page` | 消息内嵌、输入扩展、工作区面板 |
| `statusBar` | `id`, `title`, `command` | 状态区按钮 |
| `settings` | `id`, `title`, `page` | 全局插件设置分区 |
| `editorDecorations` | `id`, `title`, `text` | 内容字面子串匹配与编辑器装饰 |
| `hooks` | `id`, `title`, `event`, `tool` | 已授权的事件触发工具 |
| `background` | `id`, `title`, `tool`, `intervalMs` | 引擎持久周期调度 |

工具名必须已在 `manifest.tools` 声明。Webview 的 `entry` 必须是已有包内 `.html` 文件，native 页面使用 `.json`；不可越界，页面文档最大 512 KiB。`services.args` 最大 64 KiB。每种贡献各自不允许重复 ID。宿主内部 ID 为 `plugin:<插件ID>:<贡献ID>`，作者清单和 bridge 只填本地 ID。

```json
{
  "contributes": {
    "pages": [{ "id": "timer", "title": "计时器", "kind": "webview", "entry": "ui/index.html", "tools": [] }],
    "navigation": [{ "id": "timer", "title": "计时器", "page": "timer", "icon": "clock" }],
    "workspaceTabs": [{ "id": "timer", "title": "计时器", "page": "timer", "scope": "session", "when": { "workspace": true } }],
    "services": [{ "id": "countdown", "title": "倒计时", "tool": "start_timer", "stopTool": "stop_timer", "page": "timer", "scope": "session" }]
  }
}
```

## HTML bridge

新插件统一使用 `$AE`；原有 `aetherPlugin` 页面方法保持兼容。两者都能操作页面工具、下载和服务；`$AE` 另提供平台模型、AI、Agent、会话、Skills、MCP、知识库、工作区与插件设置。平台方法须先在清单声明并由用户授权，具体签名随脚手架 `aether-sdk.d.ts` 提供，见[平台 SDK 与权限](plugin-project-v1.md#平台-sdk-与权限)。

页面运行在 `sandbox="allow-scripts allow-forms"` 的不透明源 iframe，拿不到 Electron preload、宿主 React、文件系统或任意 IPC。表单支持浏览器原生必填校验与 `submit` 事件，处理函数应调用 `event.preventDefault()` 再通过 bridge 执行工具。CSP 的 `form-action 'none'` 仍禁止实际提交与导航；网络、嵌套页面、worker 与外部脚本同样被阻止。样式与脚本应内联，图片可使用 data URL。此限制仅针对 HTML，Node 工具依然沿用现有插件执行与安全模式，不是操作系统沙箱。

宿主会等待文档加载完成和首帧绘制后再开放页面交互。加载期间 iframe 持续绘制，轻量覆盖层阻止过早点击落在尚未接入输入路由的 iframe 外壳上；不重放用户事件，也不使用固定等待时间。

桌面主进程将封装后的文档暂存于有界内存，以随机令牌 `aether-plugin-ui://document/<token>` 提供只读响应。该协议从不把 URL 映射为磁盘路径；单文档最多 1 MiB，每窗口最多 32 份/8 MiB，全局最多 16 MiB。仅受信任工作台主窗口可寄存/释放自己的文档，页面卸载、主窗口导航、renderer 退出时撤销。响应使用独立 CSP，宿主页面的 `script-src` 保持收紧。

页面加载和宿主外观/强调色变更时，宿主通过同一实例 channel 发送 `theme` 事件。bridge 更新 `documentElement.style.colorScheme` 和有限颜色变量白名单（`--bg-*`、`--fg*`、`--accent*`、`--border*` 中的 16 个界面令牌）；默认页面背景/文字使用 `--bg-surface`、`--fg`。作者可使用这些变量或随 `color-scheme` 变化的 `Canvas`/`CanvasText`。同步仅修改样式，不重载页面，也不清除输入。

```js
const context = await aetherPlugin.context()
// {sessionId, workspacePath, engineReady, pluginId, revision}
const output = await aetherPlugin.invoke('local_tool', { value: 1 })
// output = {result,artifacts,stderr,durationMs,plugin:{id,revision,hash}}
renderResult(output.result) // 业务数据在 result 中，不能直接将 output 当作业务对象。
await aetherPlugin.navigate('another-local-page')
const saved = await aetherPlugin.download({ fileName: 'report.json', content: JSON.stringify(output.result, null, 2), encoding: 'utf8' })
// {saved:boolean,bytes?:number}; 用户在原生保存对话框中选位置或取消。

const snapshots = await aetherPlugin.services.get()
await aetherPlugin.services.start('countdown', { seconds: 60 })
await aetherPlugin.services.stop('countdown')
await aetherPlugin.services.refresh('countdown') // 需要 statusTool
const unsubscribe = aetherPlugin.services.subscribe(renderSnapshots)
```

`invoke` 只能调用此页面 `tools` 白名单中的本地工具。服务操作只接受同插件声明的服务 ID，并检查当前会话/工作区条件。每页最多 8 个并发请求，普通请求参数最多 256 KiB；请求按窗口来源、随机 channel 和当前插件实例验证。停用、修订替换或切换引擎后，旧页面与延迟回执失效。服务快照仅包含当前插件和当前会话可见数据；初始化使用 `get()`，后续用 `subscribe()`。

`download` 为用户点击导出提供原生保存入口，支持 UTF-8 文本与标准 Base64 二进制，解码后上限 16 MiB。`fileName` 只能是单文件名，禁止路径、控制字符、Windows 设备名和备用数据流；实际路径由用户在保存对话框选择，不返回给插件。每窗口只允许一个保存流程，保存前再次验证文档未关闭或被替换。取消返回 `{saved:false}`，不会写盘。图片可在 iframe 内用 Canvas 缩放、裁剪后直接导出，避免将大图塞进工具调用参数。此能力需要包含 download bridge 的新版 Aether 宿主；不要用被沙箱阻止的 `<a download>` 代替。

## 本地开发与浏览器承载

插件管理中的开发模式可以直接打开含 `aether-plugin.json` 的本地工程。界面预览、工具测试与权限面板共用此工程，修改后用刷新按钮重新读取。执行时校验源码版本并生成临时快照，无需反复安装卸载；退出开发工程会停止其 Node 调用与 Agent。涉及会话和工作区的功能先选择绑定会话。

页面工具栏的浏览器入口创建受信插件标签，复用同一沙箱页面和 `$AE` 桥。它不是普通网址：手工输入 `aether-plugin-ui://` 不能获得插件身份。普通 HTTP/HTTPS 页面不注入 `$AE`；从插件标签打开外部地址会创建独立网页标签。停用、发布替换或切换引擎会使旧插件标签失效。开发预览的浏览器标签有独立开发会话，关闭标签释放该会话；刷新重新读取本地工程，权限仍按声明与授权校验。

## 服务结果与生命周期

服务启动工具返回标准 `{result}`，其中 `result` 可为：

```json
{ "status": "running", "detail": "60 秒倒计时", "completesAt": 1790000060000 }
```

支持状态：`idle`、`running`、`waiting`、`completed`、`stopped`、`error`。可选 `detail` 最多显示 2000 字符；`completesAt` 为有限 Unix 毫秒数。已过期截止时间立即完成，未来最多 7 天的截止时间由宿主计时并产生完成状态。没有截止时间的服务由后续工具返回状态，宿主不轮询。

页面关闭不会清除服务状态和截止时间。会话服务按插件实例、修订和会话隔离；全局服务在会话间共享。切换会话释放旧的未运行条目，非当前会话的非活动记录最多保留 64 条，运行中的服务继续存在。停用、卸载、发布修订替换或引擎连接变化清理贡献、服务与计时器，旧回执不会恢复已卸载实例。

每次工具调用仍是独立 Node 子进程，输出后退出。`services` 的内存截止时间不会跨重启保留。需要持久后台任务时另声明 `background` 并授权 `background.run`：调度由引擎持久化、重启恢复，错过周期最多补一次。有有效后台任务时关闭桌面窗口进入托盘；真正退出或关机停止运行，下一次引擎启动恢复。它不是系统唤醒闹钟或自动安装的 OS 服务。
