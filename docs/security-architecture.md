# Security & Sandbox Architecture

> Agent Engine 安全与沙盒体系完整架构文档
> 面向使用者与集成开发者

---

## 整体架构概览

```
+------------------------------------------------------------------+
|                         用户请求入口                                |
+------------------------------------------------------------------+
         |
         v
+------------------+     +-------------------+     +----------------+
|   认证层 (Auth)   | --> |  策略引擎 (Policy) | --> |  执行层 (Tool)  |
+------------------+     +-------------------+     +----------------+
                               |                         |
                               v                         v
                    +--------------------+     +-------------------+
                    |  审计日志 (Audit)   |     | 沙盒环境 (Sandbox) |
                    +--------------------+     +-------------------+
```

整个安全体系采用 **纵深防御** 设计，共 7 个模块协同工作，任何一层被绕过仍有下一层拦截。

---

## 模块 1：认证中间件 (Auth)

**路径**: `src/auth/`

**职责**: 验证请求身份，提取租户信息，为后续模块提供上下文。

### 架构图

```mermaid
flowchart TD
    REQ[用户请求] --> CHECK{检查凭据类型}
    
    CHECK -->|x-api-key Header| APIKEY[API Key 认证]
    CHECK -->|Authorization: Bearer| JWT[JWT 认证]
    CHECK -->|无凭据| DEFAULT[降级为 default 租户]
    
    APIKEY --> HASH[SHA256 哈希]
    HASH --> DB[(SQLite users 表)]
    DB -->|匹配| CTX_OK[AuthContext: tenantId + userId]
    DB -->|不匹配| ERR1[抛出 Invalid API key]
    
    JWT --> VERIFY[jose jwtVerify]
    VERIFY -->|验签通过| CTX_OK
    VERIFY -->|失败| ERR2[抛出 Invalid JWT]
    
    DEFAULT --> CTX_DEF[AuthContext: tenantId=default]
    
    CTX_OK --> NEXT[传递给下游]
    CTX_DEF --> NEXT
```

### 关键接口

```typescript
interface AuthContext {
  tenantId: string       // 租户 ID（隔离依据）
  userId?: string        // 用户 ID
  method: 'api-key' | 'jwt' | 'none'
  roles?: string[]       // 角色列表（预留）
}

interface AuthMiddleware {
  authenticate(request): Promise<AuthContext>
}
```

### 配置项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `JWT_SECRET` | `dev-secret-change-in-production` | JWT 签名密钥 |
| `AUTH_ENABLED` | `true` | 设为 `false` 则跳过认证 |

### 安全要点

- API Key 存储使用 SHA256 单向哈希，数据库不存明文
- JWT 使用 `jose` 库验签，支持标准 claims
- 未携带凭据不报错（降级），但携带了无效凭据会立即拒绝

---

## 模块 2：策略引擎与细粒度审批 (Exec Policy)

**路径**: `src/security/policy-engine.ts`

**职责**: 对命令执行进行三级安全裁决（注入检测 → 路径穿越 → 规则匹配），并在必要时暂停执行流程以获取用户显式授权。

### 架构图

```mermaid
flowchart TD
    INPUT[命令执行请求<br/>command + args] --> INJ{注入检测<br/>detectInjection}
    
    INJ -->|命中 shell 元字符| DENY_INJ[DENY<br/>检测到命令注入]
    INJ -->|安全| PATH{路径穿越检测<br/>detectPathTraversal}
    
    PATH -->|命中 ../ 或敏感路径| ASK_PATH[ASK<br/>疑似路径穿越]
    PATH -->|安全| RULES{规则匹配<br/>按 priority ASC}
    
    RULES --> R1{命中规则?}
    R1 -->|是| DECISION[返回规则 action<br/>allow / ask / deny]
    R1 -->|否| FALLBACK[兜底: ASK]
    
    DECISION -->|allow| CHECK_APPROVED{已在当前会话审批过?}
    DECISION -->|ask| SUSPEND[挂起 Agent Loop<br/>向前端下发 __permission_request__]
    
    SUSPEND --> UI[前端弹出审批卡片]
    UI -->|用户点击 Approve| APPROVED[记录到 session approvedCommands 缓存<br/>恢复执行]
    UI -->|用户点击 Reject| REJECTED[阻断执行<br/>通知大模型寻替代方案]
    
    DENY_INJ --> AUDIT[(审计日志)]
    ASK_PATH --> AUDIT
    DECISION --> AUDIT
    FALLBACK --> AUDIT
```

### 注入检测覆盖模式

```mermaid
graph LR
    subgraph Shell 元字符检测
        A["; & |"] 
        B["反引号 `"]
        C["$( ) 子命令"]
        D["${ } 变量展开"]
        E["> < 重定向"]
        F["|| 逻辑或"]
        G["\\n \\r 换行注入"]
    end
```

### 内置默认规则

| 优先级 | 命令 | 动作 | 说明 |
|--------|------|------|------|
| 5 | sudo | deny | 禁止提权 |
| 5 | shutdown / reboot | deny | 禁止关机重启 |
| 5 | format / mkfs | deny | 禁止格式化磁盘 |
| 10 | rm / del | ask | 删除需确认 |
| 20 | kill / taskkill | ask | 终止进程需确认 |
| 30 | chmod / chown | ask | 修改权限需确认 |
| 200 | ls / dir / cat / echo / grep / find / node / npm / npx | allow | 常用安全命令 |
| 999 | * (通配) | ask | 未知命令默认询问 |

### 规则自定义

规则持久化到 SQLite `security_policies` 表，支持：
- **CRUD 操作** — 新增 / 修改 / 删除 / 重置默认
- **优先级覆盖** — 数字越小越先匹配
- **参数正则** — `argPattern` 字段可对参数序列做细粒度匹配
- **开关控制** — `enabled` 字段可临时禁用规则

---

## 模块 3：命令白名单 (Command Whitelist)

**路径**: `src/security/cmd-whitelist.ts`

**职责**: 作为策略引擎之后的 **第二道关卡**，确保只有预定义的安全命令才能被 spawn 执行。

### 架构图

```mermaid
flowchart TD
    CMD[命令名] --> STRIP[提取 basename<br/>去除路径前缀]
    STRIP --> LOOKUP{在白名单 Map 中查找}
    
    LOOKUP -->|存在| FREQ[频率 +1] --> ALLOW[返回 true]
    LOOKUP -->|不存在| BLOCK[返回 false]
    
    subgraph 白名单管理
        ADD[addToWhitelist] --> MAP[(whitelistMap)]
        DEL[deleteWhitelistItem] --> MAP
        RESET[resetWhitelist] --> MAP
    end
```

### 默认白名单

```
ls, dir, echo, cat, type, pwd, cd, find, grep, where,
date, time, whoami, hostname, node, npm, npx, wc
```

### 与策略引擎的关系

```mermaid
flowchart LR
    A[policyEngine.evaluate] -->|allow| B{isCommandAllowed?}
    B -->|在白名单| C[执行命令]
    B -->|不在白名单| D[拒绝]
    
    style A fill:#e1f5fe
    style B fill:#fff3e0
    style C fill:#e8f5e9
    style D fill:#ffebee
```

> 双重保护：即使策略引擎被绕过放行，白名单仍会拦截非预期命令。

---

## 模块 3.5：DevContainer 与系统级网络隔离

在物理隔离层，Aether Engine 提供了基于 `.devcontainer` 的完整容器化运行规范：

- **Docker Compose 隔离**：每个租户/会话可分配独立的 DevContainer，保证底层文件系统和进程空间与宿主机彻底隔离。
- **iptables / ipset 防火墙**：在 `init-firewall.sh` 中配置了底层的网络出站策略。默认丢弃所有非必须流量，仅对大模型 API（如 `api.openai.com`, `api.deepseek.com`, `dashscope.aliyuncs.com` 等）以及必要的包管理器服务（npm、pip）放行。
- 这一层不依赖 Node.js 的应用层检查，即使 Agent 成功诱导执行了 `curl` 或下载了恶意脚本，也会被内核级网络隔离拦截。

---

## 模块 4：网络策略 (Network Policy)

**路径**: `src/security/network-policy.ts`

**职责**: 对所有出站 HTTP 请求执行完整的 SSRF 防护链路检查。

### 架构图

```mermaid
flowchart TD
    URL[请求 URL] --> PARSE{URL 解析}
    PARSE -->|解析失败| DENY1[DENY: 无效 URL]
    PARSE -->|成功| PROTO{协议检查}
    
    PROTO -->|非 http/https| DENY2[DENY: 协议不允许]
    PROTO -->|通过| WL{白名单模式?}
    
    WL -->|开启且不匹配| DENY3[DENY: 不在白名单]
    WL -->|关闭 or 匹配| BL{黑名单检查}
    
    BL -->|域名命中| DENY4[DENY: 域名被禁]
    BL -->|通过| DNS[DNS 解析]
    
    DNS -->|失败| DENY5[DENY: DNS 解析失败]
    DNS -->|成功| PRIV{私有 IP 检测}
    
    PRIV -->|是私有/保留 IP| DENY6[DENY: SSRF 防护]
    PRIV -->|公网 IP| CIDR{CIDR 黑名单}
    
    CIDR -->|命中| DENY7[DENY: IP 段被禁]
    CIDR -->|通过| ALLOW[ALLOW: 请求放行]
    
    ALLOW --> LIMITS[附加限制<br/>maxResponseBytes + timeoutMs]
```

### 私有 IP 段覆盖

```mermaid
graph TB
    subgraph IPv4 私有/保留段
        A["10.0.0.0/8 — 内网"]
        B["172.16.0.0/12 — 内网"]
        C["192.168.0.0/16 — 内网"]
        D["127.0.0.0/8 — 回环"]
        E["169.254.0.0/16 — 链路本地 / 云 Metadata"]
        F["0.0.0.0/8 — 保留"]
        G["100.64.0.0/10 — CGNAT"]
        H["224.0.0.0/4 — 组播"]
        I["240.0.0.0/4 — 保留"]
    end
    
    subgraph IPv6 私有段
        J["::1 — 回环"]
        K["fe80::/10 — 链路本地"]
        L["fc00::/7 — ULA"]
    end
```

### 默认策略配置

```typescript
{
  allowedProtocols: ['https:', 'http:'],
  denyListEnabled: true,
  denyDomains: ['metadata.google.internal', 'metadata.aws.internal'],
  denyCidrs: [],
  allowListEnabled: false,
  allowDomains: [],
  blockPrivateIP: true,         // SSRF 核心开关
  dnsCacheTtl: 300,             // DNS 缓存 5 分钟
  maxResponseBytes: 5242880,    // 5MB 响应上限
  timeoutMs: 30000,             // 30 秒超时
}
```

### DNS 缓存机制

```mermaid
sequenceDiagram
    participant Tool as HTTP 工具
    participant NP as NetworkPolicy
    participant Cache as DNS Cache
    participant DNS as 系统 DNS

    Tool->>NP: checkNetworkAccess(url)
    NP->>Cache: 查询 hostname
    alt 缓存命中且未过期
        Cache-->>NP: 返回缓存 IP
    else 缓存未命中
        NP->>DNS: dns.lookup(hostname)
        DNS-->>NP: 返回 IP 列表
        NP->>Cache: 存入 (TTL=300s)
    end
    NP->>NP: isPrivateIP(ip) 检查
```

---

## 模块 5：文件系统沙盒 (Workspace Manager)

**路径**: `src/workspace/manager.ts`

**职责**: 按 租户+会话 维度隔离文件访问，防止路径穿越。

### 架构图

```mermaid
flowchart TD
    subgraph 文件系统布局
        ROOT[workspace root] --> T1[tenant-A/]
        ROOT --> T2[tenant-B/]
        T1 --> S1[session-1/]
        T1 --> S2[session-2/]
        T2 --> S3[session-3/]
    end
    
    REQ[文件操作请求<br/>userPath] --> ABS{绝对路径?}
    
    ABS -->|是| CHECK_ABS{遍历所有 bound workspace<br/>前缀匹配}
    CHECK_ABS -->|在范围内| OK[返回路径]
    CHECK_ABS -->|越界| ERR1[抛出: outside workspace]
    
    ABS -->|否 (相对路径)| RESOLVE[path.resolve(base, userPath)]
    RESOLVE --> CHECK_REL{resolved 以 base 开头?}
    CHECK_REL -->|是| OK
    CHECK_REL -->|否| ERR2[抛出: Path traversal detected]
```

### 多工作空间绑定

```mermaid
graph LR
    CTX[AgentContext] --> WM[WorkspaceManager]
    WM --> P1["Primary: {root}/{tenantId}/{sessionId}"]
    WM --> P2["Custom: ctx.workspacePaths[0]"]
    WM --> P3["Custom: ctx.workspacePaths[1]"]
    
    style P1 fill:#e8f5e9
    style P2 fill:#e1f5fe
    style P3 fill:#e1f5fe
```

### 关键方法

| 方法 | 功能 |
|------|------|
| `getPaths(ctx)` | 返回会话绑定的所有工作区路径 |
| `getPath(ctx)` | 返回主工作区路径 |
| `init(ctx)` | 确保工作区目录存在，不存在则递归创建 |
| `resolveSafePath(ctx, userPath)` | 安全解析路径，越界抛异常 |
| `snapshot(ctx)` | 快照（P1 规划中） |
| `restore(path, ctx)` | 恢复快照（P1 规划中） |

---

## 模块 6：终端沙盒 (Workspace Shell)

**路径**: `src/terminal/workspace-shell.mjs` + `src/terminal/index.ts`

**职责**: 提供一个物理隔离的交互式 Shell，所有操作锁定在工作空间内。

### 架构图

```mermaid
flowchart TD
    subgraph TerminalManager [终端管理器 index.ts]
        CREATE[create] --> PTY[node-pty 伪终端]
        PTY --> SHELL[workspace-shell.mjs]
    end
    
    subgraph WorkspaceShell [沙盒 Shell]
        INPUT[用户输入] --> PARSE{解析命令}
        
        PARSE -->|内置命令| BUILTIN[内置命令处理器]
        PARSE -->|外部命令| EXTERNAL[exec 外部命令<br/>cwd 锁定]
        
        BUILTIN --> SAFE{safeResolve 路径检查}
        SAFE -->|在工作空间内| EXEC[执行操作]
        SAFE -->|越界| BLOCK["⛔ 禁止离开工作空间"]
    end
    
    subgraph 安全措施
        ROOTS["WORKSPACE_ROOTS<br/>(多工作空间)"]
        CHECK["inAnyRoot()<br/>路径归属校验"]
        EXIT_DISABLED["exit 命令禁用"]
        ENV_SAFE["env 只显示安全变量"]
    end
```

### 内置命令一览

```mermaid
graph TB
    subgraph 导航
        CD[cd] 
        PWD[pwd]
        WS["ws (工作空间切换)"]
    end
    
    subgraph 文件列表
        LS[ls]
        LL[ll]
        TREE[tree]
    end
    
    subgraph 文件操作
        CAT[cat]
        MKDIR[mkdir]
        TOUCH[touch]
        RM[rm]
        CP[cp]
        MV[mv]
    end
    
    subgraph 搜索
        FIND[find]
        GREP[grep]
    end
    
    subgraph 实用
        ECHO[echo]
        ENV[env]
        CLEAR[clear]
        HELP[help]
    end
```

> 所有内置命令在执行前都调用 `safeResolve(target)` 验证路径合法性。

### 外部命令执行

```mermaid
sequenceDiagram
    participant User as 用户
    participant Shell as workspace-shell
    participant Exec as child_process.exec

    User->>Shell: git status
    Shell->>Shell: 非内置命令，走外部执行
    Shell->>Exec: exec("git status", {cwd: 当前工作空间})
    Note over Exec: cwd 锁定，无法操作外部文件
    Exec-->>Shell: stdout / stderr
    Shell-->>User: 格式化输出 (UTF-8)
```

### 多工作空间支持

```
$ ws
绑定的工作空间：
  ~（主）   /project/workspace/tenant-1/session-abc  ◀ 当前
  @ws2      /home/user/custom-project

$ cd @ws2          # 切换到第二个工作空间
$ cd ~             # 回到主工作空间
$ cd ../../        # ⛔ 禁止离开工作空间
```

---

## 模块 7：审计日志 (Audit Log)

**路径**: `src/security/audit-log.ts`

**职责**: 记录所有安全决策，提供可追溯的审计链路。

### 架构图

```mermaid
flowchart TD
    subgraph 写入来源
        PE[策略引擎] -->|每次裁决| LOG
        NP[网络策略] -->|每次检查| LOG
        FS[文件系统操作] -->|按需| LOG
        LSP[LSP 扫描] -->|按需| LOG
    end
    
    LOG[(AuditLogStore)] --> DB[(SQLite<br/>security_audit_log)]
    
    subgraph 查询与维护
        QUERY[分页查询<br/>按 tenant/category/decision/time]
        PURGE[定期清理<br/>purgeOlderThan(days)]
    end
    
    DB --> QUERY
    DB --> PURGE
```

### 审计记录结构

```mermaid
erDiagram
    security_audit_log {
        int id PK
        string tenant_id
        string session_id
        enum category "cmd | network | fs | lsp"
        string target "命令/URL/路径"
        json details "附加上下文"
        enum decision "allow | ask | deny | error"
        int rule_id FK "关联策略规则"
        string reason "决策理由"
        int created_at "Unix 时间戳"
    }
```

### 设计约束

| 约束 | 实现 |
|------|------|
| 写入不阻塞业务 | `try/catch` 包裹，失败仅 `console.warn` |
| 查询分页 | `limit` 最大 500，支持 `offset` |
| 时间范围过滤 | `since` 参数（Unix 秒） |
| 定期清理 | `purgeOlderThan(days)` 可由定时任务调用 |

---

## 模块间协作：完整数据流

### 命令执行流程

```mermaid
sequenceDiagram
    participant U as 用户/Agent
    participant Auth as 认证层
    participant CMD as cmd-tool
    participant PE as 策略引擎
    participant WL as 命令白名单
    participant WS as Workspace
    participant Audit as 审计日志
    participant OS as 操作系统

    U->>Auth: 请求 (带凭据)
    Auth->>Auth: 验证身份
    Auth->>CMD: AuthContext (tenantId)
    
    CMD->>PE: evaluate({command, args, tenantId})
    PE->>PE: 1. 注入检测
    PE->>PE: 2. 路径穿越检测
    PE->>PE: 3. 规则匹配
    PE->>Audit: 记录决策
    PE-->>CMD: PolicyDecision
    
    alt decision = deny
        CMD-->>U: 拒绝执行
    else decision = ask
        CMD-->>U: 需要用户确认
    else decision = allow
        CMD->>WL: isCommandAllowed(command)
        alt 不在白名单
            CMD-->>U: 命令不允许
        else 在白名单
            CMD->>WS: init(ctx) 获取 cwd
            CMD->>OS: spawn(cmd, args, {shell:false, cwd})
            OS-->>CMD: stdout/stderr
            CMD-->>U: 执行结果
        end
    end
```

### 网络请求流程

```mermaid
sequenceDiagram
    participant Tool as HTTP/Fetch 工具
    participant NP as 网络策略
    participant DNS as DNS 解析
    participant Audit as 审计日志
    participant Net as 外部网络

    Tool->>NP: checkNetworkAccess({url, tenantId})
    NP->>NP: 1. URL 解析
    NP->>NP: 2. 协议白名单
    NP->>NP: 3. 域名黑/白名单
    NP->>DNS: 4. 解析 hostname → IP
    NP->>NP: 5. 私有 IP 检测
    NP->>NP: 6. CIDR 黑名单
    NP->>Audit: 记录决策
    
    alt 放行
        NP-->>Tool: {allowed: true, maxResponseBytes, timeoutMs}
        Tool->>Net: fetch(url)
        Net-->>Tool: 响应
    else 拒绝
        NP-->>Tool: {allowed: false, reason}
        Tool-->>Tool: 中止请求
    end
```

---

## 安全模式（会话级切换）

系统支持三种安全模式，用户可在前端输入框旁的下拉菜单中切换，也可通过 API 设置：

### 模式对比

| 维度 | 安全模式 (safe) | 标准模式 (standard) | 完全访问 (full-access) |
|------|----------------|--------------------|-----------------------|
| **命令注入检测** | deny | deny | 跳过 |
| **路径穿越检测** | ask 确认 | 自动放行 | 跳过 |
| **deny 规则** (sudo/shutdown等) | deny | deny | 跳过 |
| **ask 规则** (rm/kill等) | ask 确认 | 自动放行 | 跳过 |
| **命令白名单** | 检查 | 跳过 | 跳过 |
| **网络 SSRF 防护** | 全检查 | 跳过私有IP检测 | 全跳过 |
| **域名黑名单** | 检查 | 检查 | 跳过 |
| **审计日志** | 记录 | 记录 | 记录 |

### 切换方式

```mermaid
flowchart LR
    subgraph 前端
        A[输入框旁 安全模式下拉] -->|选择| B[调用 PUT /security/mode]
    end
    
    subgraph 后端
        B --> C[sessionSecurityModes Map]
        C --> D[策略引擎 evaluate 读取]
        C --> E[网络策略 checkNetworkAccess 读取]
        C --> F[cmd-tool 白名单检查]
    end
```

### API

```
GET  /api/v1/security/mode?sessionId=xxx
PUT  /api/v1/security/mode  { "sessionId": "xxx", "mode": "standard" }
```

### 设计要点

- **会话级别**：每个 session 独立模式，不影响其他用户/会话
- **切换即时生效**：无需重启，下一条命令立即应用新模式
- **切换写审计**：任何模式变更都记录到审计日志
- **full-access 需二次确认**：前端切换到完全访问时弹出确认对话框
- **默认 safe**：新会话总是以安全模式启动

---

## 安全设计原则

| 原则 | 实现方式 |
|------|----------|
| **纵深防御** | 7 层独立模块，任一层被绕过仍有后续拦截 |
| **最小权限** | 默认拒绝/询问，只有明确白名单才放行 |
| **零信任** | 每次操作独立评估，不信任历史状态 |
| **不可绕过** | shell:false + 路径前缀校验 + DNS 实际解析 |
| **可审计** | 所有决策留痕，支持事后追溯 |
| **容错** | 安全模块故障不崩溃主流程（审计降级警告） |
| **可配置** | 规则/策略存 DB，运行时可调整无需重启 |
| **租户隔离** | 文件系统物理隔离 + 审计按租户分类 |

---

## 快速配置指南

### 环境变量

```bash
# 认证
JWT_SECRET=your-production-secret     # 必须修改
AUTH_ENABLED=true                      # 生产环境必须 true

# 工作空间
WORKSPACE_ROOT=./workspace            # 工作空间根目录

# 命令执行
CMD_TIMEOUT_MS=5000                   # 命令超时毫秒数
```

### 自定义策略规则（通过 API）

```json
// POST /api/security/policies
{
  "name": "allow-docker",
  "command": "docker",
  "action": "allow",
  "priority": 50,
  "enabled": true,
  "description": "允许 Docker 命令"
}
```

### 自定义网络策略

```json
// PUT /api/security/network-policy
{
  "allowListEnabled": true,
  "allowDomains": ["api.openai.com", "github.com"],
  "blockPrivateIP": true,
  "maxResponseBytes": 10485760,
  "timeoutMs": 60000
}
```

---

## 数据库表结构

```sql
-- 策略规则表
CREATE TABLE security_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  arg_pattern TEXT,
  action TEXT NOT NULL,        -- allow / ask / deny
  priority INTEGER DEFAULT 100,
  enabled INTEGER DEFAULT 1,
  description TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- 审计日志表
CREATE TABLE security_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT,
  category TEXT NOT NULL,      -- cmd / network / fs / lsp
  target TEXT NOT NULL,
  details TEXT,                -- JSON
  decision TEXT NOT NULL,      -- allow / ask / deny / error
  rule_id INTEGER,
  reason TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

-- 网络策略表
CREATE TABLE network_policies (
  id INTEGER PRIMARY KEY,
  config TEXT NOT NULL,         -- JSON
  updated_at INTEGER DEFAULT (unixepoch())
);
```
