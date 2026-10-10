# 真实客户端驻留监控

这份 harness 不启动引擎、不发送 Agent 对话、不修改产品源码，也不写 `client-acceptance.json`。它从指定 continuation run 的 supervisor 状态读取实际远端地址和 buildId，读取该 run 的实例令牌及原始五会话。只有最终候选客户端中的 stage 与 packaged engine buildId 都吻合时才允许连接。

```powershell
node scripts/longrun/continuation-client-monitor.mjs --run-root <ownedrun> --client-root <最终candidate的aether-code目录> --build-id <sha256:...> --check
```

`--check` 只读并验证配置，既不加载 Playwright，也不启动 Electron或创建证据。必须等待完整客户端测试通过，并由主任务放行后才运行去掉 `--check` 的命令。

真正运行时，用户数据在 run 内新建的 `client-monitor-*/userdata` 中隔离。真实历史列表依次选择原始五会话，正反顺序交替；默认每轮后间隔 60 秒。每次对比实际页面与前后稳定的 root 配置，包括模型、技能/MCP/知识库标签、长期记忆菜单、最新 user/turn identity 和当前浏览器连接。每十轮还重载页面检查恢复。并发新轮次导致比较前后的模型或配置改变时，记录竞态并重新取样，不把旧快照强行当成新轮次。

截图、完整快照、错误和生命周期留在独立证据目录；`client-monitor-status.json` 提供证据目录及当前选中会话。原始全量客户端验收报告保持独立。

## 给浏览器能力测试分配真实窗口

当前 BrowserEngineBridge 只属于一个 selected session。能力 probe 必须先写入 run 的 `client-browser-lease-request.json`：

```json
{"requestId":"browser-probe-001","sessionId":"原始五会话之一","expiresAt":"实际未来UTC时间"}
```

监控通过真实历史 UI 选择该会话，核验实际模型、资源、记忆，然后打开可见的内置浏览器面板。只有实际 bridge 状态为 connected、绑定到指定 session，且真实面板截图完成后，才向 `client-browser-lease.json` 写入同 requestId 的 `state: "ready"`、buildId、截图与快照路径。

probe 等待 ready 后，在 expiresAt 前通过正式 Agent/tool/API 链进行浏览器操作。完成后写 `client-browser-lease-release.json`：

```json
{"requestId":"browser-probe-001"}
```

租约期间暂停五会话切换并持续核对真实 bridge 归属。一次只保有一个实际选中会话；不会创建虚拟五会话注册或声称五个会话同时支持客户端浏览器。过期、失败、释放和 supervisor 结束均保留原始日志。

在 supervisor 尚等待长时 driver gate 的阶段，客户端可以先完成真实窗口准备；一旦见到 active，后续离开 active 即自然收口。run 的 `STOP`、证据目录内的 `STOP`、SIGINT/SIGTERM 也会收口。关闭仅针对本 harness 创建的 ElectronApplication；保留用户数据和全部证据，不关闭外部引擎，不删除用户项目。

## 已完成的纯检查

`node --check scripts/longrun/continuation-client-monitor.mjs` 和 `node --test scripts/longrun/continuation-client-monitor.test.mjs`，6/6 通过。覆盖只读 check 不启动/写入、候选及源身份漂移、非 owned endpoint、重复会话、浏览器租约归属/有效期、真实分页窗口的消息身份、模型/资源/记忆错配与动态新 root 检测。没有启动 Electron；真实驻留运行结果必须另看该次证据。
