# 定时器创建问题复盘与验收边界

用户记录：2026-11-11 23:30 导出的「@插件管理 请帮我创建一个自定义插件：定时器」。首轮超时 60 秒，之后出现退出 1、空 stdin、重复诊断、8 次源码修订；第 6 修订已发布，第 8 修订只剩诊断工具。用户继续要求可点击开始的页面后，Agent 生成了独立 HTML，反复尝试浏览器文件访问，再运行静态服务。这不能算应用内插件页面交付。

## 1. 直接根因：测试路径与实际启动路径不同

Aether `src/main/engine/runtime.ts` 的开发/环境路径以 `process.execPath` 启动引擎；在桌面里它是 `electron.exe`。`src/main/engine/host.ts` 给子进程添加 `ELECTRON_RUN_AS_NODE=1`。引擎插件 runtime 再使用 `process.execPath` 启动孙进程时，只传最小环境，却漏掉该标记，因此插件被当作 Electron 应用启动。

引擎原本确实调用 `child.stdin.end(input)`。Agent 在用户记录中猜测「宿主没有关闭 stdin」，进而改成轮询、多通道参数、入口分拆，没有代码依据；错误在平台执行器，不能让作者通过改插件绕过。

相同 Electron 39.8.10 二进制、相同探针、相同请求的修复前后证据：

- `.tmp/plugin-electron-stdin-20261112/before.json`：孙进程 `asNode=null`，只有 `end/close`，原始输入为空。
- `.tmp/plugin-electron-stdin-20261112/after.json`：孙进程 `asNode=1`，出现 `data/end/close`，完整 Unicode 参数到达。
- `.tmp/plugin-electron-stdin-20261112/original-timer-r1/evidence.json`：用户最初版本源码 SHA-256 `588192e41856215702314ce23ce651e308335124a83043dba5a5735528fe136b`，原样拷贝到隔离目录后，四个工具在修复后的 Electron 宿主下全部通过。now、countdown、elapsed、parse_duration 分别约 100、107、96、85ms。生产文件前后 hash 不变。

修复显式为 Electron 宿主的插件子进程设置 Node 模式，不放宽完整环境继承。仍不继承凭据、`NODE_OPTIONS`、代理密码。新增 `src/plugins/__tests__/electron-runtime.test.ts` 与前端 `e2e/plugins-embedded-host-ui.spec.ts` 覆盖该路径；无 Electron 时的 skip 不能算作桌面通过。

## 2. 之前测试为什么能过

| 原验证 | 确实覆盖 | 没有覆盖 |
|---|---|---|
| `scripts/plugin-ai-acceptance.mjs` | 真实模型、真实管理工具、5 个工具插件、迭代、业务断言 | 输入已提供完整协议、固定工具名与参数；引擎为外部 Node；不是开放式交互插件创建 |
| `e2e/plugins-ui.spec.ts` | Electron 管理界面、模拟 HTTP、基本交互 | 实际插件执行器 |
| `e2e/plugins-real-engine-ui.spec.ts` | Electron 页面连接真实外部 Node 引擎，保存/测试/导入/版本 | 内嵌引擎使用 Electron executable 的路径、插件专属页面/后台状态 |
| GitHub Remark 实验 | 三个固定来源的转换插件可下载、安装、执行 | 通用 GitHub 插件兼容、Host/Client 插件生命周期 |

这些通过记录不等于造假，但之前把它们概括为完整体验已经跑通，结论超出了证据。尤其成功返回 JSON 不能替代业务断言，诊断结果中「未收到参数」也不该被发布为可用插件。

## 3. Harness 前后端调查结论

参考路径 `D:\dev\deepseek-harness`。核心区别不是管理页皮肤，而是插件能扩展宿主产品：

| 能力 | Harness 证据 | Aether 当前范围 |
|---|---|---|
| 标准持久包和模板 | `packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md:8`，`templates/decoration/` | `aether-plugin.json` 自包含工具包，本次补统一工程模板/测试/导出 |
| 默认交互页面应位于应用中 | 同 SKILL.md:22–25 明确独立 HTML 不算完成、注册 slot 不等于可见验收 | 尚无插件自定义页面契约 |
| Host 服务和生命周期 | `references/host-plugin.md:61–77`：apply、inject、Config、effect 清理 | 每次调用启动独立进程 |
| Client 模块和槽位 | `references/ui-plugin.md:3–13`，`packages/client/modules/src/index.ts:891`，`packages/client/ui-slots/src/index.ts:1241` | 尚无 Client loader/slot/RPC |
| 可撤销定时器 | `vendor/timer/src/index.ts:35–75` | 普通工具限时运行，不能承诺后台提醒 |
| 持久调度 | `packages/schedule/schedule/src/index.ts:224`、`:268` | 应用已有自动化能力，但插件未获得稳定的调度服务契约 |

原研究已经记下部分这些差别，但实现和验收没有跟上；不能说已经领会并实现了完整机制。没有运行 Harness 全套产品，以上是源码调查证据。

## 4. 本次补齐的工程基础

- 同一模板服务供 AI、页面和 CLI 使用。标准工程包含清单、代码、README、确定性用例、package.json、独立 Node 测试脚本。
- `plugin_get_template` 给 AI 返回协议和完整工程，避免每次临时编造。
- `plugin_test.cases` 将一组测试锁定在同一修订，一次操作确认；检查 expected 的业务结果，而非只看退出码。
- 顶层错误封装及非零退出保留错误详情，避免仅显示「退出 1」。不通过猜测任意嵌套业务字段制造成功或失败。
- 标准项目 `init/check/test/pack` 和原生修订 ZIP 导出，按「生成→独立测试→导出→导入→执行」验证。
- 清单双源同步，防止 UI 编辑清单与导出包根清单不一致。

工程规范：[Aether Tool Plugin v1](../plugin-project-v1.md)。该名称明确是我们定义的工具协议，不是假称行业统一标准。独立 Node 可运行工具源码/测试；安装到其他产品仍需适配。

## 5. 本次实际验证（2026-11-12）

引擎构建成功：`2.0.0`，build ID `sha256:33a768bb9b6ebc072a0cfa3d4211a59e3987169340b3e164352d431de5daa088`。前端也完成 TypeScript 检查与构建。生产 Aether 实例没有重启，旧进程不会自动加载这个引擎修复。

| 验证 | 实际结果与边界 |
|---|---|
| 引擎定向回归 | 142 个不重复用例通过：schema 15、importer 14、tool-profile 49、integration 6、agent-catalogue 5、service-runtime 22、templates 17、project 6、project-runner 7、Electron runtime 1。不是全仓库测试。 |
| 前端纯逻辑 | 91 项通过，覆盖模板接口、批量测试审批内容、工具名、例参、远端路由和会话选项。 |
| Electron 模拟接口 UI | 6 项通过，含模板切换失败保留草稿、根清单只读、导出实际下载文件、主题与窄窗。 |
| Electron 内嵌真实引擎 | 1 项通过，实际 EngineHost → startProcess → 引擎 → 插件孙进程接收 Unicode 参数，凭据环境未泄露。原红测 trace 被重跑清理，不能再引用；修复前证据使用上面的 before.json。 |
| Electron 连接外部 Node 引擎 | 1 项通过，从引擎官方模板创建，实际执行、导出 ZIP 解包核对、目录/ZIP 导入与固定修订选择。 |
| 三个模板独立工程 | 每个完成 init/check/test/pack/npm test，15 步全部退出 0；独立测试是 Node 业务断言，不替代宿主的 Schema 与产物验证。 |

模板最终证据：[操作记录](../../.tmp/plugin-project-final-20261112/report.json)，可下载原生包：[基础 JSON](../../.tmp/plugin-project-final-20261112/json-tool.zip)、[文档产物](../../.tmp/plugin-project-final-20261112/markdown-report.zip)、[时间计算](../../.tmp/plugin-project-final-20261112/time-calculator.zip)。项目回归还验证了这些模板导入、发布、再次执行和导出字节一致。

所有真实桌面测试顺序执行，使用独立数据目录与端口；没有删除或覆盖生产插件。本机实测平台为 Windows，不能把本次结果宣称为 macOS/Linux 实测。

前端独立报告为 `D:/dev/aether-code/docs/plugin-manager-frontend-verification-2026-11-12.md`。最终内嵌测试另落盘 `D:/dev/aether-code/.e2e-tmp/plugins-embedded-host/results/plugins-embedded-host-ui-E-63730-真实启动链路向插件传入完整stdin，且不泄漏引擎环境/embedded-host-receipt.json`，记录上述 build ID、完整 72 字节输入、`runAsNode: "1"`、`secretLeaked: false` 和 77ms 插件执行时间。测试后对应端口与实例进程均已退出。

### 普通需求的真实 AI 创建

`scripts/plugin-natural-ai-acceptance.mjs --run` 已在本机 2026-11-12 00:04–00:05 完成，模型为已配置的 `deepseek-v4.1-flash-1017`。用户输入仅要求创建并发布「时间助手」，将 `1h30m` 这样的表达式转为秒，并计算两个 ISO 时间之差；测试驱动没有提供协议、源码、Schema、工具调用顺序或后续修复提示。

模型自行执行 `plugin_get_template(time-calculator)` → 查重 → 创建 → 批量测试 → 发布，第一次修订即成功。模型编写的 10 个批量用例全部通过，创建/测试/发布分别通过真实审批恢复流程，驱动自动批准的是隔离实验对象。模板发现和批量测试的实际覆盖都为 `covered`，没有中断、重试修订或漏测冒充成功。

发布后又用两个自然语言会话选中该插件并真实调用，再按实际工具清单和调用参数进行 4 个额外宿主业务检查，共 6 项通过：8100、5400、2700、5415、-5415、0 秒。运行时 IPC 证明引擎确为 Electron 39.8.10 / Node 22.22.1 / Node 模式。实验约 59 秒，隔离引擎正常退出，按实例目录复核残留进程为 0。

[完整 AI 实验报告](../../.tmp/plugin-acceptance/natural-ai-electron-2026-11-11T16-04-01-493Z-1a612f10/report.json) · [进程清理复核](../../.tmp/plugin-acceptance/natural-ai-electron-2026-11-11T16-04-01-493Z-1a612f10/cleanup-verification.json)。这是普通需求工具插件的通过证据，不能推广为任意需求、任意模型、交互型 UI 或后台提醒都已通过。

## 6. 尚未完成

交互型插件仍需要真正的 Client 入口、受控 Host RPC、持久状态/配置、事件、停用清理、重启恢复、后台调度和实际页面验收。本次没有把 HTML 产物、管理页或时间计算模板当成这些能力。用户现有生产定时器记录没有被覆盖，运行中的桌面也没有被强制重启。
