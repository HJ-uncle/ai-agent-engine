# 快速开始

核对日期：2026-11-17。桌面使用见 [用户指南](../../../aether-code/docs/user-guide.md)。本页用于独立引擎开发与接入。

## 选择运行方式

桌面内置模式由 Aether 管理进程、连接令牌和数据目录。桌面远端模式连接指定引擎，远端工作区是服务端路径。独立引擎按下面配置运行。仓库另保留 [multi-agent-console Web 实现](../../multi-agent-console/README.md)，不是桌面界面的启动入口；其历史账号和 UI 接线不能替代当前桌面/引擎协议说明。

## 安装与启动

```powershell
npm ci
Copy-Item .env.example .env
npm run typecheck
npm run build
```

为本机开发配置 `.env`：

```dotenv
HOST=127.0.0.1
PORT=12323
AUTH_ENABLED=false
DATA_DIR=./data/agent.db
WORKSPACE_ROOT=./workspace
ENCRYPTION_KEY=<your-64-hex-secret>
```

生成密钥：`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`。实际密钥不提交仓库，已有数据库保留原密钥。启动会初始化数据库及迁移。

```powershell
npm run dev
# 或运行已构建版本
npm start
Invoke-RestMethod http://127.0.0.1:12323/health
Invoke-RestMethod http://127.0.0.1:12323/meta
```

独立运行未设置 HOST 时默认 `0.0.0.0`，本机示例显式限制 loopback。桌面内置实例优先交给桌面管理，避免重复打开同一数据目录。启动参数实现见 [server-listen.ts](../../src/server-listen.ts)。

## 打开管理后台

桌面用户从「设置 → 引擎管理 → 打开管理后台」进入。若桌面自己启动并仍持有本机回环引擎、尚未设置过个人账号，且服务允许匿名业务访问，首次即可在该窗口管理本机引擎，无需创建密钥。已选身份时只使用该身份在目标服务原有的后台权限；退出或过期不会切换成本机管理员。单独启动的 localhost 服务和普通浏览器不会获得桌面临时权限。

独立服务随引擎在同一端口提供后台。用浏览器打开启动日志中的地址（默认 `http://127.0.0.1:12323/admin/`），填写管理员提供的后台凭据；服务已配置实例令牌时还要填写该令牌。没有后台管理员的独立部署可按[首个管理员与令牌配置步骤](../operations/engine-admin.md)初始化。

## 配置模型

在桌面“设置 → 模型”添加模型 ID、提供方、API 地址和密钥，并启用模型。创建接口默认不启用；连接测试不代表所有视觉/思考/工具能力均可用。

模型接口的完整路径是 `/api/v1/models`。该路由模块虽然在 server.ts 根级注册，但声明本身已经包含 `/api/v1`，不要重复加前缀。模型密钥、账号恢复码、实例连接令牌是不同凭据。先确认服务和账号；切换账号后显示的是对应租户的模型配置。

## 发起第一轮任务

以下示例要求已有启用模型，并使用上面的本机匿名开发模式：

```powershell
curl.exe -N http://127.0.0.1:12323/api/v1/chat -H "Content-Type: application/json" -H "X-Aether-Tool-Profile: general" -H "X-Aether-Subagent-Protocol: 2" --data-raw '{"sessionId":"getting-started","message":"介绍当前工作区，暂不修改文件"}'
```

鉴权部署另加实例令牌和用户身份头。保存会话 ID；断线默认不会取消持久任务，不能直接重发同一条消息。重连、显式停止、输入回执与继续机制见 [集成指南](third-party-integration.md)。

未选项目使用默认工作区；选定项目后在授权范围内操作该目录。多个会话可以使用同一项目，不会自动创建独立文件副本。

## 账号与第三方登录

本机匿名使用无需注册。在「设置 → 个人账号 → 创建主账号」输入本服务管理员签发的一次性开通码，即可创建独立空间；旧匿名历史不会自动迁入。主账号可管理自己的子账号，子账号不另领开通码。已有账号通过恢复文件、恢复码或已绑定第三方登录。

第三方入口由服务端配置决定。已有账号先登录再绑定；直接使用未绑定的第三方身份会创建另一账号，不按相同邮箱自动合并。见 [账号机制](../account-login.md)、[第三方配置](../account-external-login.md)。

## 运维边界

远端部署显式配置鉴权、实例令牌、稳定加密密钥与 TLS。业务设置不能覆盖启动信任边界。审批模式和执行隔离分别配置；账号隔离不代表手选项目文件有独立副本。

当前运行不以旧 `TOKEN_BUDGET`/`MAX_ITERATIONS` 字段强制停止；上下文窗口、工具输出约束和显式取消仍有效。记忆需要开启策略，不会因注册自动持续注入。

[运行指南](../runtime-guide.md) · [安全边界](../security-architecture.md) · [存储维护](../operations/session-storage-maintenance.md)
