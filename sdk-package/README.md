# agent-engine-sdk

源码核对：2026-11-17；包版本以 [package.json](package.json) 为准。当前 SDK 是引擎启动和连接生命周期封装，不提供旧文档所称的 22 个完整业务 API 命名空间。插件 SDK 是另一个接口体系，见[公开 HTML](../../aether-code/docs/plugin-api/dist/index.html)。

## 公开接口

[入口类](src/index.ts)导出 AgentEngineSdk，配置和结果见 [types.ts](src/types.ts)。

| 接口 | 当前行为 |
|---|---|
| new AgentEngineSdk(config) | mode 为 embedded 或 remote |
| start() | 返回 baseUrl；embedded 启动子进程并等健康就绪，remote 只建立连接配置 |
| stop() | 回收 SDK 创建的子进程并清空本地状态；remote 不停止远端服务 |
| healthCheck() | 返回 ok/latencyMs/detail/error；不是模型和全部业务能力验收 |
| baseUrl、mode、started | 当前实例生命周期状态 |

```ts
import { AgentEngineSdk } from 'agent-engine-sdk'

const sdk = new AgentEngineSdk({
  mode: 'remote',
  remote: { baseUrl: 'http://127.0.0.1:12323' }
})
await sdk.start()
const health = await sdk.healthCheck()
if (!health.ok) throw new Error(health.error ?? 'Engine unavailable')
// 使用 sdk.baseUrl 与标准 fetch 接入业务协议。
await sdk.stop()
```

## 内嵌运行

embedded.binaryPath 默认是包旁 bin/dist/main.js，preferredPort 默认 12323，startupTimeoutMs 默认 15000。dataDir 推荐传明确的 SQLite 文件路径；历史目录形式会自动追加 agent.db。未指定时使用 SDK 包旁 data/agent.db，不随自定义 binaryPath 改变。

宿主负责提供可用 Node 运行环境、引擎产物及匹配系统/ABI 的原生依赖，配置稳定密钥与隔离数据位置。不要把桌面应用的生产数据目录用于测试。

```ts
const sdk = new AgentEngineSdk({
  mode: 'embedded',
  embedded: {
    binaryPath: '/absolute/path/to/engine/dist/main.js',
    dataDir: '/absolute/path/to/app-data/agent.db',
    startupTimeoutMs: 90_000,
    env: { HOST: '127.0.0.1' }
  }
})
await sdk.start()
```

以上路径为需替换的示意；鉴权、加密与模型配置仍按[引擎快速开始](../docs/docs/getting-started.md)准备。

## HTTP 边界

内部 client 没有公开在 AgentEngineSdk 上。config.apiKey 当前被作为 Authorization: Bearer 发送，不能误认为自动生成 X-API-Key；普通业务调用应由集成方使用正确请求头。SDK 不代管账号刷新、实例令牌、完整 SSE 恢复和输入接纳收据。

当前内部 URL 拼接只特殊处理 health/metrics/models/api/v1 等路径，不能依赖它自动判断所有根路由。直接用 sdk.baseUrl + 完整路径调用，见[HTTP 集成](../docs/docs/third-party-integration.md)。

## 构建和分发

在引擎仓库先 npm run build，再进入 sdk-package：

```powershell
npm run typecheck
npm run build
npm run build:full
```

build 只生成 SDK dist；build:full 另复制引擎到 bin。package.json 的 npm files 当前只列 dist/，因此 pack:full 的名字不保证 npm 包含 bin 和完整运行时。发布前用 npm pack --dry-run 检查实际清单；内嵌部署需随宿主分发引擎或配置 binaryPath。CDN 脚本有独立打包逻辑，不能与 npm 包内容混为一谈。

package.json 声明 Node >=18 仅是 SDK 的引擎范围，不构成所有当前引擎依赖在 Node 18 上的实测保证。真实内嵌启动检查使用既有 test:embedded，先核对脚本数据隔离和所需构建；本轮文档更新没有执行生产数据启动。
