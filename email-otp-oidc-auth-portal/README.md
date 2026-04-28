# 统一邮箱 OTP 登录平台（OIDC/OAuth2）

一个统一的 Web 端邮箱验证码登录平台：用户用邮箱 OTP 验证登录；旗下任意项目通过 OIDC/OAuth2（授权码 + PKCE）接入作为登录凭证。

默认使用第三方认证平台完成邮箱 OTP（当前实现为 Supabase Auth），平台自身负责：
- OIDC/OAuth2 Provider（authorize/token/userinfo、Discovery、JWKS）
- 项目（client）管理与 redirect_uri 白名单
- 授权码、会话、基础速率限制、审计日志脱敏

## 1. 快速开始

### 1.1 安装依赖

```bash
npm install
```

### 1.2 配置环境变量

建议通过环境变量启动：

```bash
export ISSUER_URL="http://localhost:3000"
export PORT="3000"
export DATA_DIR="./data"
export ADMIN_TOKEN="please-change-to-a-long-random-string"

export AUTH_PROVIDER="supabase"
export SUPABASE_URL="https://xxxx.supabase.co"
export SUPABASE_ANON_KEY="xxxxx"
```

说明：
- `ISSUER_URL`：对外可访问的服务地址（OIDC issuer），必须与实际访问域名一致
- `ADMIN_TOKEN`：管理端接口鉴权（通过 `x-admin-token` header），至少 16 位
- `DATA_DIR`：本地 SQLite 与签名密钥存储目录
- `AUTH_PROVIDER`：
  - `supabase`：真实邮箱 OTP（需要配置 Supabase）
  - `fake`：本地测试用，OTP 固定为 `000000`

### 1.3 启动

```bash
npm run dev
```

健康检查：

```bash
curl -s http://localhost:3000/health
```

## 2. Supabase 配置要点（邮箱 OTP）

平台侧调用的是 `signInWithOtp`（发码）+ `verifyOtp(type=email)`（验码）。是否发“6 位验证码”取决于 Supabase 项目里 Email OTP 的配置与模板。

### 2.1 在 Supabase 控制台创建并启用 Email OTP

1) 创建项目  
- Supabase Dashboard 新建 Project（免费额度即可）

2) 启用 Email Provider  
- Dashboard → Authentication → Providers → Email  
- 确保 Email 登录方式已启用

3) 选择 Email OTP（而不是 Magic Link）  
- Dashboard → Authentication →（Sign In / Providers / Email 相关配置项）  
- 选择/启用 Email OTP（6 位验证码）  

4) 配置站点 URL（Site URL）与回跳白名单  
- Dashboard → Authentication → URL Configuration  
- `Site URL` 建议设置为你统一登录平台的外网地址（也就是本服务的 `ISSUER_URL`）  
- 如 Supabase 侧要求配置 Redirect URLs，可把统一登录平台域名加入允许列表  

5) 邮件模板与发信配置（生产建议）  
- Dashboard → Authentication → Email Templates  
- 确认 OTP 邮件模板中包含验证码变量，并符合你公司的品牌样式  
- 生产建议配置自有 SMTP（Dashboard → Project Settings → Auth / SMTP），并完成域名 SPF/DKIM，提高送达率

### 2.2 获取 SUPABASE_URL / SUPABASE_ANON_KEY

- Dashboard → Project Settings → API  
  - `SUPABASE_URL`：项目 URL（形如 `https://xxxx.supabase.co`）  
  - `SUPABASE_ANON_KEY`：anon public key（用于前端/公有场景的 key）

将它们配置到本服务环境变量中：

```bash
export AUTH_PROVIDER="supabase"
export SUPABASE_URL="https://xxxx.supabase.co"
export SUPABASE_ANON_KEY="xxxxx"
```

常见注意点：
- 邮件发送频率/验证码有效期/风控由 Supabase 侧配置与限制
- 生产环境要配置好发信域名、SPF/DKIM 等，以避免进垃圾箱
- 平台侧不会返回“邮箱是否存在”的差异化信息（避免枚举）

## 3. 项目接入（OIDC/OAuth2 授权码 + PKCE）

### 3.1 创建一个 Client（项目）

```bash
curl -s -X POST http://localhost:3000/admin/clients \
  -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{
    "id": "client-a",
    "name": "Project A",
    "redirectUris": ["http://localhost:4000/callback"],
    "scopes": ["openid", "email"],
    "enabled": true
  }'
```

查看所有 client：

```bash
curl -s http://localhost:3000/admin/clients -H "x-admin-token: $ADMIN_TOKEN"
```

### 3.2 生成 PKCE 并拼 authorize URL

已提供示例脚本，会输出：
- `authorize_url`：给浏览器打开
- `code_verifier`：后续换 token 用

```bash
export ISSUER_URL="http://localhost:3000"
export CLIENT_ID="client-a"
export REDIRECT_URI="http://localhost:4000/callback"
node examples/pkce-demo.mjs
```

浏览器打开 `authorize_url`：
1) 进入统一登录页  
2) 输入邮箱 → 发送验证码  
3) 输入 6 位验证码 → 验证成功后回跳到 `redirect_uri?code=...&state=...`

### 3.3 用 code + code_verifier 换取 Token

```bash
curl -s -X POST http://localhost:3000/token \
  -H "content-type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "client_id=client-a" \
  --data-urlencode "redirect_uri=http://localhost:4000/callback" \
  --data-urlencode "code=REPLACE_WITH_CODE" \
  --data-urlencode "code_verifier=REPLACE_WITH_CODE_VERIFIER"
```

响应字段：
- `access_token`：用于调用 `/userinfo`
- `id_token`：OIDC ID Token（JWT）
- `expires_in`：过期秒数
- `scope`：授权 scope

### 3.4 获取用户信息（userinfo）

```bash
curl -s http://localhost:3000/userinfo \
  -H "authorization: Bearer REPLACE_WITH_ACCESS_TOKEN"
```

当前实现：
- 必返 `sub`
- 当 scope 包含 `email` 时返回 `email`、`email_verified`

## 4. OIDC Discovery / JWKS

Discovery：

```bash
curl -s http://localhost:3000/.well-known/openid-configuration
```

JWKS：

```bash
curl -s http://localhost:3000/jwks.json
```

## 5. 登录/登出相关页面与端点

- `GET /authorize`：进入授权流程（未登录时展示邮箱 OTP 登录页）
- `POST /otp/send`：发送 OTP（表单提交）
- `POST /otp/verify`：校验 OTP 并继续授权（表单提交）
- `GET /logout`：清理会话（简单实现）

## 6. 速率限制与审计

已启用基础限流（按 IP）：
- `/otp/send`：1 分钟最多 10 次
- `/otp/verify`：1 分钟最多 20 次

审计日志输出到 stdout（JSON Lines），对邮箱做 hash 脱敏，不记录 OTP 与 token 原文。

## 7. 测试

当前仓库包含端到端流程测试（使用 `AUTH_PROVIDER=fake`，OTP 固定 `000000`）：

```bash
npm test
```

## 8. 生产部署建议（必读）

- `ISSUER_URL` 必须使用生产域名（建议 HTTPS），并与外部访问一致
- 将 `DATA_DIR` 挂载到持久化存储（包含 SQLite 与签名密钥）
- 设置强随机 `ADMIN_TOKEN`，并通过内网/网关限制管理端访问
- 反向代理层补充：HTTPS、HSTS、WAF、真实 IP 透传与更严格的限流策略
