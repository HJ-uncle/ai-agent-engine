# 隔离真实引擎：同机 LAN 地址鉴权验证

2026-09-30，**实例鉴权断言 18/18 通过**。这是同一台机器对其 LAN 地址的真实 HTTP 测试，**不是跨机器连通性或防火墙验收**。引擎 `/metrics` 额外暴露业务错误，不能计为该接口功能通过。

## 运行对象与隔离

- 启动真实 `node dist/main.js`，Node `v24.20.0`，监听 `10.219.14.186:61742`。
- 使用已有构建，不重建、不改生产代码。服务返回 buildId `sha256:ab93020802cca9fbb647689e34b839419bae9d8d03ff8ee41ed6e1b02e61741c`，与磁盘 manifest 一致；运行前后 main.js SHA-256 未变。
- 仅新建一个临时子进程；使用 `.e2e-tmp/isolated-lan-auth-<uuid>` 独立 cwd、主数据库、记忆库、workspace、skills、MCP、HOME/USERPROFILE、APPDATA/LOCALAPPDATA、PROGRAMDATA 与临时目录。
- 子进程只继承 OS 运行环境白名单，没有继承现有应用凭据；实例令牌、加密 key、JWT secret 均临时随机生成，不写入证据。
- `AUTH_ENABLED=false`，同时显式设置合成 `AETHER_INSTANCE_TOKEN`，验证实例门禁独立于租户认证开关。
- 两个业务 GET 返回空列表，确认未读入已有模型或会话。未调用聊天/模型测试/工具执行，未启动 Electron。
- 本测试**未向现有用户实例 `10.219.14.186:12323` 发请求，也未重启或修改它**。操作进程范围仅本脚本持有的 ChildProcess。

## 实际结果

| 检查 | 数量 | 实际结果 |
|---|---:|---|
| GET models、conversation/sessions，无令牌 | 2 | HTTP 401，业务 code 40100 |
| 上述两个业务 GET，错误令牌 | 2 | HTTP 401，业务 code 40100 |
| 上述两个业务 GET，正确令牌 | 2 | HTTP 200，业务 code 200，data=[] |
| GET health/meta，含有/没有 query，无令牌 | 4 | HTTP 200，业务 code 200 |
| HEAD health/meta，含有/没有 query，错误令牌 | 4 | HTTP 200；符合公共探针豁免 |
| GET metrics，无令牌/错误令牌 | 2 | HTTP 401，业务 code 40100；旧白名单没有绕过门禁 |
| GET metrics，正确令牌 | 1 | 门禁放行，但 HTTP 200 / 业务 code 500，见下方观察 |
| POST health，无令牌 | 1 | HTTP 401，业务 code 40100；豁免仅限 GET/HEAD |

`/metrics` 正确令牌请求的服务器日志出现 `FST_ERR_REP_INVALID_PAYLOAD_TYPE`：返回对象与 `text/plain` Content-Type 不匹配。该项只断言鉴权放行，**没有断言业务成功**；原始 JSON 已保留 businessCode=500。此问题位于 [metrics.ts](D:/dev/ai-agent-engine/src/api/http/routes/metrics.ts:19)，全局错误封装使它表现为 HTTP 200。没有在本任务中修复。

## 清理与证据

临时子进程已退出；同地址同端口可以重新绑定，验证端口已释放；在核验真实路径为本次 `.e2e-tmp` 直接子目录后删除了 fixture。现有构建文件未变。

- [脱敏结果 JSON](D:/dev/ai-agent-engine/docs/research/2026-09-30-isolated-lan-auth-result.json)
- [脱敏服务器日志](D:/dev/ai-agent-engine/docs/research/2026-09-30-isolated-lan-auth-server.log)
- [可复现探针脚本](D:/dev/ai-agent-engine/docs/research/2026-09-30-isolated-lan-auth-probe.mjs)

鉴权来源：[instance-token.ts](D:/dev/ai-agent-engine/src/auth/instance-token.ts:6)、[authMiddlewareHook](D:/dev/ai-agent-engine/src/api/http/middleware.ts:44)。这次只验证实例令牌层，不能据此推出完整租户 RBAC、TLS、跨机器网络、远端共享工作区或整个前端连接流程已经通过。
