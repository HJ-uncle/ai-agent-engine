# 运行时手动刷新修复

2026-11-05。用户反馈局部刷新看似无效、顶部刷新按钮位置分散。

## 原因与改变

- 原内部按钮显式调用全页刷新，顶部也是同一动作；不是没有绑定点击事件。局部刷新被整页采集及 busy 状态耦合，现由 runtime 自己的 reader 直接刷新，顶部仍协调全页。
- 原运行时接口缓存至少 5 秒；15 秒无访问后停止直方图并清除 ELU 基线。纯手动访问很容易每次都重新进入 warming，快速连点又得到同一缓存。现增加受同样认证保护的 `GET /api/v1/performance/runtime?refresh=true`：一次请求测量 200 ms 窗口，返回该窗口内的真实 ELU、延迟和最新 V8 内存；完成后立即关闭并重置直方图。并发请求共享正在进行的窗口，dispose 取消待完成窗口。
- 不带 refresh 的旧接口保持原缓存语义。响应增加可选 `collection.sampleWindowMs`，旧客户端可忽略；新客户端分别说明按需窗口和旧引擎缓存，重复的 sampledAt 明确标记为缓存。
- 顶部图标与状态标签收拢到右侧操作组，图标位于最右，使用既有 34 px 控件令牌和 accent-soft 背景。局部按钮继续为纯图标，保留 title、可访问名称、加载反馈和键盘操作。

本次不增加轮询；短窗口 P95 表示本次约 200 ms 的测量，不表示整个运行时段或两次用户点击之间的分布。健康连接检测和 OS CPU/I/O 增量采样不改变。

## 验证与加载

引擎 7 项真实 Node/HTTP 测试通过：首次和闲置后的单次完整采样、连续点击生成新时间戳、并发共享、关闭取消、未认证请求拒绝及旧接口兼容。typecheck 与完整 build 通过。

桌面 20 项契约测试及 4 项 Electron 用例均已覆盖通过，验证真实鼠标/键盘点击、局部和全局刷新独立性、采样时间前进、布局、无轮询及实际引擎闲置超过 15 秒后的单击取样。资源页面和实际引擎最后两项复验通过（35.6 秒），原始日志为 `D:/dev/aether-code/docs/assets/runtime-refresh-20261105/live-rerun.log`。测试全部使用本轮新构建的隔离产物和数据目录，实例已关闭。

前端完整 build/typecheck 被本次范围之外的并发浏览器改动阻塞（BrowserApi 缺少 openLocalDirectory/openLocalEntry、BrowserLocalPreview 的联合类型 size 访问）；未改动这些源码。electron-vite 单独构建成功后才执行上述 Electron 测试，不能将其等同于前端完整类型检查通过。完整结果记录于 `D:/dev/aether-code/docs/session-storage-frontend-compatibility-2026-11-05.md`。

当前开发启动器 `scripts/dev.mjs` 为每次运行制作固定引擎快照。前端可由 Vite 热更新；新引擎采样代码需要重新运行 `npm run dev` 才能加载，普通页面刷新不会替换旧引擎快照。
