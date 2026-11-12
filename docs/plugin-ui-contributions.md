# 插件前端贡献协议

`manifest.contributes` 将已发布工具连接到 Aether 的页面、侧栏、工作区与服务托盘。引擎验证并封存清单和 HTML；桌面宿主只加载当前引擎连接中已发布且启用的修订。AI 作者通过 `plugin_get_template`、HTTP 客户端通过 `GET /plugins/project/templates` 获取相同能力目录与贡献 JSON Schema。`desktop-timer` 是包含真实工具、页面和确定性测试的完整示例。

## 贡献类型

每类最多 16 条。`id` 使用小写字母开头的字母、数字、连字符（最多 48 字符）；`title` 为 1–120 字符。`scope` 为 `global`（默认）或 `session`；`when` 可按 `session`、`workspace`、`engineReady` 的布尔条件显示。`order` 为 -1000 至 1000 的整数。

| 字段 | 必填字段 | 行为 |
|---|---|---|
| `pages`，`kind: "tool"` | `id`, `title`, `kind` | 原生参数操作页；可用 `tool` 指定默认工具 |
| `pages`，`kind: "webview"` | `id`, `title`, `kind`, `entry`, `tools` | 包内自包含 HTML；`tools` 是页面可调用的本地工具白名单 |
| `navigation` | `id`, `title`, `page` | 左侧导航入口；`page` 引用同插件页面 |
| `workspaceTabs` | `id`, `title`, `page` | 工作区“更多工作区”菜单入口；通常设置 `scope: "session"` |
| `services` | `id`, `title`, `tool` | 宿主管理的服务状态；可选 `stopTool`, `statusTool`, `page`, `args` |

工具名必须已在 `manifest.tools` 声明。页面 `entry` 必须是已有包内 `.html` 文件，不可越界、最大 512 KiB。`services.args` 最大 64 KiB。页面、导航、标签、服务各自不允许重复 ID。宿主内部 ID 为 `plugin:<插件ID>:<贡献ID>`，作者清单和 bridge 只填本地 ID。

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

页面运行在 `sandbox="allow-scripts allow-forms"` 的不透明源 iframe，拿不到 Electron preload、宿主 React、文件系统或任意 IPC。表单支持浏览器原生必填校验与 `submit` 事件，处理函数应调用 `event.preventDefault()` 再通过 bridge 执行工具。CSP 的 `form-action 'none'` 仍禁止实际提交与导航；网络、嵌套页面、worker 与外部脚本同样被阻止。样式与脚本应内联，图片可使用 data URL。此限制仅针对 HTML，Node 工具依然沿用现有插件执行与安全模式，不是操作系统沙箱。

宿主会等待文档加载完成和首帧绘制后再开放页面交互。加载期间 iframe 持续绘制，轻量覆盖层阻止过早点击落在尚未接入输入路由的 iframe 外壳上；不重放用户事件，也不使用固定等待时间。

桌面主进程将封装后的文档暂存于有界内存，以随机令牌 `aether-plugin-ui://document/<token>` 提供只读响应。该协议从不把 URL 映射为磁盘路径；单文档最多 1 MiB，每窗口最多 32 份/8 MiB，全局最多 16 MiB。仅受信任工作台主窗口可寄存/释放自己的文档，页面卸载、主窗口导航、renderer 退出时撤销。响应使用独立 CSP，宿主页面的 `script-src` 保持收紧。

页面加载和宿主外观/强调色变更时，宿主通过同一实例 channel 发送 `theme` 事件。bridge 更新 `documentElement.style.colorScheme` 和有限颜色变量白名单（`--bg-*`、`--fg*`、`--accent*`、`--border*` 中的 16 个界面令牌）；默认页面背景/文字使用 `--bg-surface`、`--fg`。作者可使用这些变量或随 `color-scheme` 变化的 `Canvas`/`CanvasText`。同步仅修改样式，不重载页面，也不清除输入。

```js
const context = await aetherPlugin.context()
// {sessionId, workspacePath, engineReady, pluginId, revision}
const output = await aetherPlugin.invoke('local_tool', { value: 1 })
await aetherPlugin.navigate('another-local-page')

const snapshots = await aetherPlugin.services.get()
await aetherPlugin.services.start('countdown', { seconds: 60 })
await aetherPlugin.services.stop('countdown')
await aetherPlugin.services.refresh('countdown') // 需要 statusTool
const unsubscribe = aetherPlugin.services.subscribe(renderSnapshots)
```

`invoke` 只能调用此页面 `tools` 白名单中的本地工具。服务操作只接受同插件声明的服务 ID，并检查当前会话/工作区条件。每页最多 8 个并发请求，单次参数最多 256 KiB；请求按窗口来源、随机 channel 和当前插件实例验证。停用、修订替换或切换引擎后，旧页面与延迟回执失效。服务快照仅包含当前插件和当前会话可见数据；初始化使用 `get()`，后续用 `subscribe()`。

## 服务结果与生命周期

服务启动工具返回标准 `{result}`，其中 `result` 可为：

```json
{ "status": "running", "detail": "60 秒倒计时", "completesAt": 1790000060000 }
```

支持状态：`idle`、`running`、`waiting`、`completed`、`stopped`、`error`。可选 `detail` 最多显示 2000 字符；`completesAt` 为有限 Unix 毫秒数。已过期截止时间立即完成，未来最多 7 天的截止时间由宿主计时并产生完成状态。没有截止时间的服务由后续工具返回状态，宿主不轮询。

页面关闭不会清除服务状态和截止时间。会话服务按插件实例、修订和会话隔离；全局服务在会话间共享。切换会话释放旧的未运行条目，非当前会话的非活动记录最多保留 64 条，运行中的服务继续存在。停用、卸载、发布修订替换或引擎连接变化清理贡献、服务与计时器，旧回执不会恢复已卸载实例。

每次工具调用仍是独立 Node 子进程，输出后退出。宿主服务不是跨重启的 daemon：退出桌面、renderer 重启或连接丢失后不保留计时；没有系统闹钟、后台常驻插件进程或恢复保证。插件作者应将这些限制写在用户可读说明中。
