# 账号登录与恢复

账号接口位于引擎根路径 `/auth/account`，使用标准 `{code:200,data,...}` 响应。配置实例令牌时，除浏览器第三方回调外的请求仍须携带 `X-Aether-Instance-Token`。远程生产部署必须使用 HTTPS，实例令牌不是用户身份。

## 用户入口

- `POST /register {}` 一键生成随机名称、内部 userId、独立 tenantId、恢复凭证与账号会话。`AETHER_ACCOUNT_REGISTRATION=false` 关闭公开注册（包括第三方首次自动注册）。可选个人信息通过登录后的 profile 保存；不要求填写密码或邮箱。
- `POST /login {recoveryKey}` 使用恢复凭证重登；也接受已存在有效 API Key，保留旧用户 ID、租户及所有租户数据。不会把匿名 default 数据自动归给新账号。
- `GET /me` 读取个人资料、已绑定身份及当前会话 ID。
- `PATCH /profile {name?,email?,avatarUrl?,bio?,userData?}` 更新资料。userData 限 16 KB JSON 对象，不能修改角色、内部 ID 或租户。邮箱为用户自填资料，不代表邮箱验证。
- `POST /refresh {refreshToken,requestId?}` 更新短期访问凭证。
- `GET /sessions`、`DELETE /sessions/:id` 查看或撤销自己的登录会话。
- `POST /logout {all?:boolean}` 注销当前会话或全部会话。
- `POST /recovery {}` 轮换恢复凭证，并撤销其他会话及旧 API Key；须在本次登录认证后 10 分钟内执行。新的恢复凭证只返回一次。
- `DELETE /identities/:providerId` 解绑第三方，须在本次认证后 10 分钟内执行，且不能删除最后的可用登录方式。

## 会话边界

成功登录返回 `{user,accessToken,refreshToken,expiresAt,recoveryKey?}`。时间字段为 ISO 8601。访问令牌为 `aether_session_` 加 256 位随机值，15 分钟过期；刷新凭证为独立 256 位随机值。会话固定有效期 30 天，届时需重登。数据库仅存恢复、访问与刷新凭证的 SHA-256 哈希。

每次刷新原子消费旧 refreshToken 并签发新凭证。客户端为每次刷新生成随机 requestId，先保存后发送，并使用单飞请求。同一旧 refreshToken + 同一 requestId 可在 5 分钟内重试并取得原结果，包括服务端重启后；缓存用旧明文 refreshToken 通过独立域派生 AES-GCM 密钥加密，数据库哈希不能用于解密。换用不同 requestId 重放旧凭证、超过重试窗口，或不带 requestId 重放会撤销该会话。正常临时网络错误不应清空本地凭证；客户端保留待完成 requestId 重试即可。

AUTH_ENABLED=false 只允许缺少凭证的本地匿名请求继续使用 default 租户；显式提交的账号会话仍会验证，错误凭证不会降级成匿名。旧 API Key 和 JWT 的既有业务认证保留；新账号管理接口只接受可撤销的本系统账号会话，旧 API Key 须经 login 换取账号会话。第三方须经可信适配器验证后调用内部身份映射服务，客户端不能指定自己要绑定的内部 userId。

第三方唯一身份为 `(providerId, issuer, subject)`。登录已有绑定会复用同一内部用户；登录新身份会创建新账号。绑定仅限已登录且最近认证的账号，保留原 userId 与 tenantId，不按邮箱自动合并。已绑定其他用户时返回冲突，避免隐式数据归属转移。

新账号只有 `tenant-admin`：可管理属于自己租户的模型及 safe/standard 会话安全模式；full-access 仍需实例管理员。实例级设置、安全策略、全局 Skills 等仍要求管理员。自定义资料和第三方 userData 不参与权限判断。

本地 SQLite 写事务使用认证模块共享队列，避免并发首次登录/刷新/回调互相争锁；数据库唯一约束与事务仍是最终数据一致性保障。登录端点按来源地址限速，计数持久化；应用默认不信任代理转发的来源地址。部署在反向代理后，需要由运维明确配置可信代理与入口限速。

会话及审计历史未启用自动删除；刷新结果虽只有 5 分钟可重试，数据库保留其密文，历史保留策略需由部署方决定。此版本提供账号和第三方登录基础，不包含组织目录、SCIM、密码/MFA管理、邮箱验证或独立审计管理平台。
