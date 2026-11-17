# 性能与资源测量方法

更新日期：2026-11-17。本页描述当前可用测量入口，不提供未经本轮复测的性能基线。旧版 45 ms 冷启动、112 ms 目录展开、28 ms 搜索和 35 ms SSE 首帧表没有可复现的当前证据，已撤下；旧 npm run perf:bench 和 multi-agent-console 路径也不再作为运行命令。

## 指标必须说明范围

| 指标 | 需要同时记录的条件 |
|---|---|
| 启动和健康 | Node/原生模块版本、冷/热启动、数据规模、/health 与模型就绪的区别 |
| 首帧和首字 | 接纳、模型连接、思考、工具准备、首文本各自耗时；不要把心跳当首字 |
| 上下文与缓存 | 实际模型、供应商输入/缓存 token、当前上下文估算、记忆策略、压缩点 |
| 会话存储 | SQLite 主库/WAL/SHM、可回收页、JSONL、正文 blob、子代理和工作区分别统计 |
| 内存与并发 | RSS/heap/external、父子进程、活动会话数、峰值、运行时长和回收后残留 |
| UI 响应 | Electron 版本、DPR、目录规模、预览类型、是否远端、是否运行生产构建 |

数据库文件大小不等于全部会话数据，也不等于可释放空间。详情见[存储维护](../../operations/session-storage-maintenance.md)。监控界面进入时采样，后续由用户手动刷新；旧截图不代表当前时刻。

## 可运行入口

从引擎仓库：

```powershell
node scripts/diagnostics/documentation-audit.mjs --check-catalogue
# 查看现有专项测试，再选择与测量目标匹配的用例
npx vitest list
```

第一条只核对文档路由，不测业务性能。真实模型验收入口见[验收脚本说明](../../../scripts/real-model-acceptance.md)，长时并发的历史条件见[长期任务说明](../../../scripts/longrun/README.md)；不要把历史通过结果复用为当前验收。

从同级桌面仓库：

```powershell
npm run perf:work
```

该命令先 build，再运行 scripts/work-performance-probe.mjs --verify --default-graphics，会启动独立应用验证，不能与另一个 Electron 验收并行，也不应在用户当前窗口执行。先读脚本确认隔离目录、输入与环境条件。

报告统一保存到仓库 .e2e-tmp 下相应任务目录，记录命令、构建身份、样本数、冷/热条件、p50/p95 或逐轮值、失败与跳过原因。真实模型测试需有可用测试凭据和调用预算；本次文档刷新未运行真实模型压测、第三方授权或 Docker 验收。
