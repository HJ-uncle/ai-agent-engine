# 插件界面内部维护地图

本文描述引擎与桌面宿主的实现分工。开发者公开契约唯一来源为 [HTML 挂载参考](../../aether-code/docs/plugin-api/content/contributions.html)、[页面 API](../../aether-code/docs/plugin-api/content/page.html)、[原生组件](../../aether-code/docs/plugin-api/content/native.html) 和 [事件与后台](../../aether-code/docs/plugin-api/content/events.html)。这里不维护第二份字段、签名或完整清单。

## 贡献类型

`src/plugins/contributions.ts` 定义 12 类贡献、8 个菜单位置、3 个内嵌位置和 15 个事件名称；`service.ts` 校验目标引用与包内文档。当前不附加旧的贡献数量、页面体积和服务参数容量上限，仍保留 ID、字段类型、引用与作用域校验。

前端统一目录 `src/renderer/src/features/extensions/` 负责装配，不存在需要插件分别适配的 Work / Code 两套界面。

| 前端实现 | 职责与边界 |
|---|---|
| extensions/host.ts、registry.ts | 当前引擎发布目录、修订与注册生命周期；逐插件失败隔离 |
| extensions/slots.tsx | 同时过滤贡献和目标页面条件；内嵌默认收起，展开才挂载 |
| extensions/interactions.ts | 命令、快捷键、目标注册、事件与系统交互 |
| conversation/MessageContent.tsx | 普通消息与补充内容的菜单和内嵌区域 |
| sessions/SidebarTask.tsx | 会话菜单目标 |
| composer/Composer.tsx | 输入工具栏、扩展区域与草稿目标 |
| workspace/WorkspacePanel.tsx、WorkspaceView.tsx | 文件菜单与工作区扩展区 |
| workspace/CodePreview.tsx | 代码预览菜单、工具栏、标记和选择目标；当前只读 |
| services/ServiceTray.tsx | 服务菜单与实例上下文 |
| app/MenuBar.tsx | 应用菜单 |

导航、工作区页签、插件设置和底部状态入口使用同一注册目录。不要把代码预览能力泛化到所有预览器：Office、PDF、图片和普通成果文本不是 ui.editor 目标。编辑器或输入框动作须匹配唯一有效目标，歧义应报错，不能落到另一个会话。

## HTML bridge

`ExtensionPage.tsx` 中的 ExtensionWebview 和 `webview-document.ts` 建立不透明源 iframe、随机通道、来源校验及生命周期绑定。文档加载并经过两帧绘制后开放交互，不重放点击或依赖固定延时。流式事件顺序等待页面回调确认，按消费速度形成背压；销毁页面取消所拥有的流和待处理请求。

页面没有 Electron preload、宿主 React、任意 IPC 或直接文件访问。CSP 限制网络、导航和表单提交；主题按有限令牌同步，不重载页面。`NativeExtensionPage.tsx` 只渲染 JSON 组件树，不执行任意 JSX/JS，也没有异步数据源或结果到属性的自动绑定。

主进程 `src/main/plugin-ui-documents.ts` 按窗口持有随机 URL 到文档的映射，精确查询，不把 URL 映射为磁盘路径。窗口导航、退出和文档释放应撤销访问。当前没有旧的单文档 1 MiB、窗口 8 MiB、全局 16 MiB 插件专项容量限制。

`plugin-ui.ts` 和 `plugin-download.ts` 处理原生保存；`plugin-host.ts` 处理消息框、系统通知和文本剪贴板。真实参数边界以公开页面 API 为准。保存和消息框各自每窗口只能有一个流程；保存前重新验证文档。系统能力检查当前引擎、修订和授权，不能吞掉失败伪装成功；平台不支持系统通知时仍可展示应用内通知。

## 本地开发与浏览器承载

开发模式读取所选工程，执行前验证源码哈希；权限绑定工程和插件身份，刷新保留仍声明的授权。会话和工作区来自显式绑定，不能由业务参数伪造。

`features/browser/PluginBrowserSurface.tsx` 复用插件 Webview；普通网页没有 SDK。插件标签不是输入自定义 URL 即可获取的身份。开发标签有独立开发会话，关闭释放；正式标签在停用、修订替换和引擎切换后失效。这里提供页面承载，没有公开浏览器自动化或 Office 编辑器 SDK。

## 服务结果与生命周期

服务状态属于前端宿主。关闭页面不等于停止服务；会话服务按实例、修订和会话隔离，全局服务可跨会话显示。可选截止时间由前端计时，无截止时间时不自动轮询。当前会话活跃服务、已完成历史和全局通知是不同视图，范围见 [服务参考](../../aether-code/docs/plugin-api/content/page.html#services)。

`host.ts` 独立于插件管理页存在，按目录变化协调注册。停用、卸载、修订替换和引擎切换会清理贡献、服务及计时器；短暂传输失败保留健康注册。代际检查使旧回执不能重新激活已移除实例。

引擎 `lifecycle-runtime.ts` 维护有限近期事件和 hooks：高频事件可合并，同一 hook/会话忙碌或冷却期间跳过，不排队补发；引擎事件不能由页面冒充。停止只留有限收尾时间，不能依赖退出 hook 保存唯一业务数据。

`background-runtime.ts` 将计划写入租户调度文件，仅执行已发布、启用并授权的当前修订；任务无会话上下文，同一任务不重叠，错过周期合并一次。重启将未完成执行恢复为到期工作，业务需容忍重试；不是任意常驻 Node 生命周期。

桌面 `src/main/plugin-background.ts` 仅在检测到有效后台任务时进入托盘。`src/main/engine/host.ts` 退出时回收桌面拥有的引擎进程，远端引擎生命周期独立。不要把关闭桌面写成必然停止全部后台任务，也不要把前端内存计时写成持久调度。

人工审阅须核对目标、签名、权限、错误、取消、旧修订、主题、返回与完整示例，自动检查不替代真实交互。流程见 [站点维护说明](../../aether-code/docs/plugin-api/maintenance.html)，实例见 [工作台扩展示例](examples/workbench-extension/README.md)。
