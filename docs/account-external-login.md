# 第三方登录接入

引擎支持 OIDC Authorization Code、OAuth2 Authorization Code 和已有平台凭证校验接口。三种方式均由引擎访问管理员配置的第三方服务，客户端不能提交可信用户 ID、租户或第三方用户数据。

## 服务端配置

设置 `AETHER_ACCOUNT_PROVIDERS_JSON` 为 JSON 数组（未配置时为空列表）。它属于服务端机密配置，不通过设置 API 或公开提供方列表返回。服务器重启后生效。第三方浏览器登录还需要：

* `AETHER_ACCOUNT_PUBLIC_URL`：浏览器可访问的引擎外部地址，例如 `https://aether.example.com`，可包含反向代理的路径前缀。
* `ENCRYPTION_KEY`：稳定保存的随机 32 字节密钥，64 位十六进制。短期 OAuth 流程的 PKCE verifier 和待领取身份使用 AES-256-GCM 加密。不要使用开发示例密钥；丢失或轮换此密钥将使未完成的登录失效。

在第三方控制台登记回调地址：`https://aether.example.com/auth/account/external/callback`。回调不需要实例令牌，依赖服务端一次性 state。其余接口仍受实例令牌配置约束。生产所有服务地址必须 HTTPS，仅 `localhost`、`127.0.0.1`、`[::1]` 开发环境允许 HTTP；不跟随第三方 HTTP 重定向。

### OIDC

```json
[
  {
    "id": "company",
    "name": "企业单点登录",
    "type": "oidc",
    "issuer": "https://identity.example.com/realms/company",
    "clientId": "aether-desktop",
    "clientSecret": "配置实际的服务端客户端密钥",
    "tokenAuthMethod": "client_secret_basic",
    "scopes": ["openid", "profile", "email"],
    "mapping": { "name": "name", "email": "email", "avatarUrl": "picture", "userData": "employee" }
  }
]
```

通过 issuer discovery 获取服务端点，严格验证 discovery issuer、JWKS 签名、issuer、audience、azp（如有）、有效期、nonce，并要求 UserInfo sub 与签名 ID Token 一致。OIDC 身份始终取签名后的 `sub`，不允许通过映射覆盖。仅接受非对称签名算法。

### OAuth2

```json
{
  "id": "legacy-oauth",
  "name": "现有平台 OAuth",
  "type": "oauth2",
  "issuer": "https://platform.example.com",
  "authorizationUrl": "https://platform.example.com/oauth/authorize",
  "tokenUrl": "https://platform.example.com/oauth/token",
  "userInfoUrl": "https://platform.example.com/api/me",
  "clientId": "aether",
  "clientSecret": "配置实际密钥",
  "scopes": ["profile"],
  "mapping": { "subject": "user.id", "name": "user.displayName", "userData": "user.custom" }
}
```

OAuth2 必须显式指定稳定、不会随昵称/邮箱变化的 `mapping.subject`。服务必须支持 Authorization Code + PKCE S256。`tokenAuthMethod` 支持 `client_secret_basic`、`client_secret_post`、`none`；未指定时有密钥默认 post、无密钥默认 none。授权码和访问凭据仅在交换期间使用，不保存到用户信息。

### 已有平台凭证接口

```json
{
  "id": "erp",
  "name": "企业业务平台",
  "type": "credential",
  "verificationUrl": "https://erp.example.com/internal/verify-login",
  "serviceToken": "仅服务器保存的可选服务间凭证",
  "mapping": {
    "active": "active", "subject": "user.id", "name": "user.name",
    "email": "user.email", "avatarUrl": "user.avatar", "userData": "user.data"
  }
}
```

引擎向固定 verificationUrl 发送 `POST {"credential":"用户提供的现有平台凭证"}`。配置 serviceToken 时携带 `Authorization: Bearer ...`。第三方必须验证凭证签名、有效期和撤销状态，再响应，例如：

```json
{"active":true,"user":{"id":"stable-employee-007","name":"张三","email":"employee@example.com","data":{"department":"研发","roles":["developer"],"locale":"zh-CN"}}}
```

`active`（或映射路径）必须严格为布尔 `true`。错误凭证应返回 401，或 `active:false`。不要仅解码未验签的 JWT。第三方 `roles` 仅为展示数据，不赋予 Aether 管理员权限。服务端不得接收由桌面直接提交的 subject/userData 替代验证。

## 客户端协议

* `GET /auth/account/providers` → `{providers:[{id,name,type}],registrationEnabled:boolean}`，不包含密钥或服务端认证配置。
* `POST /auth/account/external/start {providerId,mode:"login"|"link"}` → `{authorizationUrl,flowId,pollToken}`。
* 在系统浏览器打开 authorizationUrl。回调只写入待领取身份，返回固定文本，不返回平台凭证、不依赖浏览器访问桌面 loopback。
* `POST /auth/account/external/poll {flowId,pollToken}` → `{status:"pending"}` 或 `{status:"complete",result:...}`。建议每两秒轮询。五分钟过期；结果仅领取一次。
* 凭证类型直接 `POST /auth/account/external/credential {providerId,credential,mode}`。

`mode:"link"` 必须携带本系统有效且最近十分钟认证的账号 session。服务端在启动、回调和领取时检查该 session 未撤销。绑定保留原用户和租户；不会根据相同邮箱自动合并。已绑定其他用户的外部身份应拒绝，由人工确认后通过安全迁移处理。

新第三方身份直接登录会由账户模块自动创建本系统账号，再签发本系统 session；第三方凭证不会成为本系统长期访问密钥。外部身份以提供方 ID + issuer + 稳定 subject 唯一定位。不要随意修改已上线提供方的 ID/issuer；更改会被视为新的身份命名空间。

`mapping` 是点分隔对象路径。未指定 userData 映射时从验证结果保留可显示字段；建议明确映射第三方 `user.data` 等受控对象。过滤 token/secret/password/credential/cookie/authorization/privateKey/apiKey 等机密字段与原型键；限制 16 KiB、六层、1024 节点、每数组 100 项。第三方数据只供资料展示，不能解释为引擎角色、策略或任意指令。

每个第三方请求十秒超时、响应最多 256 KiB。流程持久存储、五分钟过期、定期清理；每 IP 每分钟 start/credential 10 次、callback 60 次、poll 240 次，存储最多 10,000 活动 flow 和 10,000 限流桶。生产反向代理必须保护真实 IP 头，不能无条件信任客户端 `X-Forwarded-For`。服务间密钥应存于受控环境变量/secret manager，日志不得记录 callback 查询参数或凭证请求体。

这些是通用协议适配器；接入实际第三方仍需管理员在该平台创建客户端、填写真实端点与密钥、登记回调地址，并使用该平台测试账号完成联调。
