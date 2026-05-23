# System Tools

Agent Engine 内置一套**系统级工具**，让 AI Agent 具备任务管理、定时调度和文件搜索能力。这些工具均通过 `registry-factory.ts` 统一注册，Agent 可在对话中直接调用。

---

## 工具总览

| 工具名 | 类别 | 描述 |
|--------|------|------|
| `todo_list` | Todo | 列出当前会话的待办任务 |
| `todo_create` | Todo | 创建待办任务 |
| `todo_update` | Todo | 更新待办状态/标题/优先级 |
| `todo_delete` | Todo | 删除待办任务 |
| `cron_list` | Cron | 列出所有定时任务 |
| `cron_create` | Cron | 创建定时任务 |
| `cron_update` | Cron | 更新定时任务（含启用/禁用） |
| `cron_delete` | Cron | 删除定时任务 |
| `task_list` | Task | 列出后台任务队列 |
| `task_cancel` | Task | 取消一个 pending 任务 |
| `task_status` | Task | 查看指定任务详情 |
| `glob_search` | Search | 用 glob 模式匹配文件路径 |
| `grep_search` | Search | 在文件内容中搜索文本/正则 |
| `web_fetch` | Web | 获取网页内容（支持安全域名过滤） |
| `http_request` | Web | 发起 HTTP 请求 |
| `get_context` | Context | 获取当前 Agent 上下文信息 |
| `agent` | Agent | 创建和管理子 Agent |
| `subagent` | Agent | 调用子 Agent 执行任务 |
| `install_package` | Package | 安装 npm 包到工作区 |
| `read_file` | File | 读取文件内容 |
| `write_file` | File | 写入文件内容 |
| `smart_read` | File | **智能文件读取**（自动识别类型、Excel/CSV预览、代码摘要提取） |
| `list_files` | File | 列出目录文件 |
| `delete_file` | File | 删除文件或目录 |
| `create_dir` | File | 创建目录 |
| `read_image` | File | 读取并解析图片 |
| `remember` | Memory | 存储记忆条目 |
| `recall` | Memory | 根据 Key 回忆记忆 |
| `search_memory` | Memory | 搜索记忆内容 |
| `run_command` | System | 执行 Shell 命令（经安全策略引擎校验） |
| `ask_user` | Interaction | 向用户提问 |
| `list_skills` | Skill | 列出可用技能 |
| `get_skill` | Skill | 获取技能详情 |
| `run_skill_script` | Skill | 运行技能脚本 |
| `code_diagnose` | LSP | 对工作区文件运行 TypeScript/ESLint 诊断 |

> **注：** DeepSeek 专有功能（FIM、Prefix Completion、JSON Mode）通过 `/api/v1/deepseek/*` REST 接口暴露，不作为 Agent 工具注册；DeepSeek KV Cache / Reasoning 指标由 `DeepSeekAdapter` 自动采集，在 Token Badge 中可视化展示。
>
> **工具调用语义：** Agent Engine 默认设置 `tool_choice='auto'`，模型可根据上下文自主决定是否调用工具。对于不遵循标准 OpenAI `tool_calls` JSON 协议的模型（如 Qwen、vLLM），引擎内置 **XML `<tool_call>` 回退解析器**：
> - 当 API 返回的 `tool_calls` 为空时，自动扫描 `content` 文本中的 `<tool_call>...</tool_call>` 块
> - 支持两种内部格式：JSON `{"name":"...","arguments":{...}}` 和 XML `<function=toolName><parameter=key>value</parameter></function>`
> - 当 `<function=>` name 为空时，根据参数键名推断工具名（如 `{command}` → `run_skill_script`、`{query}` → `search_memory` 等）
> - 解析成功后，`<tool_call>` 块从可见内容中自动剥离，确保用户看到的是干净文本

---

## Todo 工具

### `todo_list`

列出当前会话（`sessionId`）的所有待办任务，支持按状态过滤。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `status` | string | 否 | 按状态过滤：`pending` / `in_progress` / `done` / `cancelled` |

**示例（AI 调用）**

```
请帮我列出所有未完成的任务
→ 调用 todo_list({ status: "pending" })
```

---

### `todo_create`

创建一条新的待办任务。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | ✅ | 任务标题 |
| `description` | string | 否 | 详细描述 |
| `priority` | string | 否 | `low` / `medium` / `high`，默认 `medium` |
| `dueAt` | string | 否 | 截止时间，ISO 8601，如 `"2026-05-01T18:00:00"` |

**示例**

```
帮我创建一个高优先级任务：明天下午6点前完成代码审查
→ 调用 todo_create({ title: "完成代码审查", priority: "high", dueAt: "2026-04-28T18:00:00" })
```

---

### `todo_update`

更新待办任务的任意字段，支持用 ID 前8位短引用。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 任务 ID（支持前8位短码） |
| `title` | string | 否 | 新标题 |
| `description` | string | 否 | 新描述 |
| `status` | string | 否 | 新状态 |
| `priority` | string | 否 | 新优先级 |
| `dueAt` | string | 否 | 新截止时间 |

---

### `todo_delete`

删除指定待办任务。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 任务 ID（支持前8位短码） |

---

## Cron 工具

### `cron_create`

创建定时任务。到期时，调度器会向指定会话自动发起 AI 对话。

**Cron 表达式格式（5字段）**

```
分  时  日  月  周
*   *   *   *   *
│   │   │   │   └─ 星期 (0=日, 1=一 ... 6=六)
│   │   │   └───── 月份 (1-12)
│   │   └───────── 日期 (1-31)
│   └───────────── 小时 (0-23)
└───────────────── 分钟 (0-59)
```

**常用示例**

| 表达式 | 含义 |
|--------|------|
| `* * * * *` | 每分钟 |
| `0 9 * * 1-5` | 工作日每天9点 |
| `30 18 * * *` | 每天18:30 |
| `0 0 1 * *` | 每月1号0点 |
| `*/5 * * * *` | 每5分钟 |

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 任务名称 |
| `cronExpr` | string | ✅ | Cron 表达式 |
| `message` | string | ✅ | 触发时发给 AI 的消息 |
| `sessionId` | string | 否 | 目标会话（默认当前会话） |
| `agentId` | string | 否 | 使用的 Agent ID |
| `description` | string | 否 | 描述 |

**示例**

```
帮我创建一个每天早上9点的日报任务
→ 调用 cron_create({
    name: "每日日报",
    cronExpr: "0 9 * * 1-5",
    message: "请总结昨日工作进展，列出今日计划",
    sessionId: "my-session"
  })
```

---

### Cron 调度原理

```
CronScheduler
  ↓ 每分钟整点轮询
  ↓ 比对 cron 表达式
  ↓ 匹配 → POST /api/v1/chat (loopback)
  ↓ 触发完整 ReAct 循环
  ↓ 更新 lastRunAt
```

- 调度器对齐到系统时钟分钟边界，无漂移
- 使用 `AbortSignal.timeout(120s)` 防止 hung 请求
- 若 auth 开启，内部请求通过 `X-Request-ID: cron-{id}` 头绕过验证

---

## Search 工具

### `glob_search`

用 glob 通配符模式在工作区中搜索匹配的文件路径。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | string | ✅ | Glob 模式，如 `**/*.ts`、`src/**/*.json` |
| `cwd` | string | 否 | 搜索基准目录（相对工作区根目录） |
| `limit` | number | 否 | 最多返回结果数，默认 100 |

**通配符速查**

| 符号 | 含义 |
|------|------|
| `*` | 匹配单层路径中的任意字符 |
| `**` | 跨目录递归匹配 |
| `?` | 匹配单个字符 |
| `{a,b}` | 匹配 a 或 b |

**示例**

```
帮我找出所有 TypeScript 测试文件
→ 调用 glob_search({ pattern: "**/*.test.ts" })

帮我找出 src 目录下所有 JSON 配置文件
→ 调用 glob_search({ pattern: "src/**/*.json" })
```

---

### `grep_search`

在工作区文件中搜索包含指定文本或正则表达式的行。优先使用 [ripgrep](https://github.com/BurntSushi/ripgrep)，若未安装则自动降级为 Node.js 内置实现。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pattern` | string | ✅ | 要搜索的文本或正则表达式 |
| `path` | string | 否 | 搜索目录或文件（相对工作区根目录） |
| `filePattern` | string | 否 | 文件名过滤，如 `*.ts`（仅 ripgrep 模式支持） |
| `caseSensitive` | boolean | 否 | 是否区分大小写，默认 `false` |
| `maxResults` | number | 否 | 最多返回结果数，默认 50 |

**返回格式**

```
文件相对路径:行号:匹配内容
src/tools/search/grep-tool.ts:14:async function hasRipgrep(): Promise<boolean> {
```

**示例**

```
帮我找出所有含 TODO 的代码行
→ 调用 grep_search({ pattern: "TODO" })

在 src 目录下搜索所有导出函数定义
→ 调用 grep_search({ pattern: "export function", path: "src", filePattern: "*.ts" })
```

---

## Task Control 工具

用于 Agent 自主监控和管理后台任务队列（`SQLiteTaskQueue`）。

### `task_list`

列出当前租户的后台任务。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `status` | string | 否 | 按状态过滤：`pending` / `running` / `done` / `failed` / `cancelled` |
| `limit` | number | 否 | 返回条数，默认 20 |

---

### `task_cancel`

取消一个 `pending` 状态的任务。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 任务 ID（支持前8位短码） |

---

### `task_status`

查看指定任务的详细状态，包括 `type`、`payload`、`createdAt` 等字段。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 任务 ID（支持前8位短码） |

---

## Web 工具

### `web_fetch`

获取网页内容，支持 HTML 转 Markdown 和安全域名过滤。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | ✅ | 要获取的网页 URL |
| `format` | string | 否 | 返回格式：`markdown`（默认）/ `html` / `text` |

**安全配置**

通过系统设置的 `webFetch` 字段配置域名策略：
- `enabled`: 是否启用 Web 获取
- `allowedDomains`: 允许的域名列表（支持通配符 `*`）
- `blockedDomains`: 阻止的域名列表

**示例**

```
帮我获取这个页面的内容：https://example.com/article
→ 调用 web_fetch({ url: "https://example.com/article", format: "markdown" })
```

---

### `http_request`

发起 HTTP 请求，可用于调用外部 API。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | ✅ | 请求 URL |
| `method` | string | 否 | HTTP 方法：`GET`（默认）/ `POST` / `PUT` / `DELETE` 等 |
| `headers` | object | 否 | 请求头 |
| `body` | string / object | 否 | 请求体 |
| `timeout` | number | 否 | 超时毫秒数，默认 30000 |

**示例**

```
调用天气 API 获取北京天气
→ 调用 http_request({
    url: "https://api.weather.com/v3/weather?city=beijing",
    headers: { "X-API-Key": "your-key" }
  })
```

---

## Agent 工具

### `get_context`

获取当前 Agent 的运行时上下文信息，包括系统提示词、工具列表等。

**参数**

无

**返回字段**

| 字段 | 类型 | 说明 |
|------|------|------|
| `systemPrompt` | string | 当前系统提示词 |
| `tools` | array | 可用工具列表 |
| `allowedTools` | array | 允许的工具名称 |
| `skills` | array | 已加载的技能 |
| `sessionId` | string | 当前会话 ID |
| `agentId` | string | 当前 Agent ID |

**示例**

```
查看当前 Agent 有哪些可用工具
→ 调用 get_context({})
```

---

### `agent`

创建和管理子 Agent，支持在当前对话中发起子任务。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | string | ✅ | 操作：`create` / `list` / `info` / `terminate` |
| `name` | string | 否 | 子 Agent 名称（create 时必填） |
| `model` | string | 否 | 使用的模型（默认继承父 Agent） |
| `systemPrompt` | string | 否 | 子 Agent 系统提示词 |
| `message` | string | 否 | 发送给子 Agent 的消息（create 时必填） |
| `agentId` | string | 否 | 子 Agent ID（info/terminate 时必填） |
| `maxTurns` | number | 否 | 最大对话轮次，默认 10 |

**示例**

```
创建一个子 Agent 帮我分析这段代码
→ 调用 agent({
    action: "create",
    name: "code-analyzer",
    message: "请分析这段代码的性能瓶颈"
  })
```

---

### `subagent`

调用已存在的子 Agent 执行特定任务。支持可选 `role` 参数启用方法论角色预设（仅在 `methodology` / `max` 模式下生效）。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task` | string | ✅ | 子代理任务描述 |
| `systemPrompt` | string | 否 | 自定义系统提示词（覆盖角色预设模板） |
| `model` | string | 否 | 使用的模型名 |
| `maxSteps` | number | 否 | 最大迭代步数，默认 10 |
| `role` | string | 否 | ⭐ 方法论角色预设：`implementer` / `spec-reviewer` / `code-quality-reviewer`（仅 `methodology` / `max` 模式；其余模式降级为默认行为并记录 warn 日志） |

**role 参数说明：**

| 角色 | 对应 Prompt 模板 | 用途 |
|------|-----------------|------|
| `implementer` | `SKILLs/superpower-subagent-driven-dev/implementer-prompt.md` | TDD 驱动的代码实现 |
| `spec-reviewer` | `SKILLs/superpower-subagent-driven-dev/spec-reviewer-prompt.md` | 对照 spec 审查实现 |
| `code-quality-reviewer` | `SKILLs/superpower-subagent-driven-dev/code-quality-reviewer-prompt.md` | 代码质量审查 |

设置 `role` 时，对应模板会自动加载为默认系统提示词；若同时提供 `systemPrompt`，则 append 到模板之后。模板缺失时自动降级为内置默认提示词并记录 warn。

**示例**

```
让代码审查子代理按 TDD 流程实现用户认证模块
→ 调用 subagent({
    task: "用 TDD 实现用户认证模块（注册/登录/令牌刷新）",
    role: "implementer",
    maxSteps: 20
  })

让子代理对照 spec 审查实现
→ 调用 subagent({
    task: "审查 src/auth/ 目录下的实现是否满足 docs/superpower/specs/auth.md",
    role: "spec-reviewer"
  })

通用子代理调用（不指定 role，使用默认行为）
→ 调用 subagent({
    task: "分析这段代码的性能瓶颈",
    maxSteps: 10
  })
```

---

## Package 工具

### `install_package`

在工作区中安装 npm 包。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `packageName` | string | ✅ | 包名，可指定版本如 `lodash@4.17.21` |
| `saveDev` | boolean | 否 | 是否作为 devDependencies，默认 `false` |
| `workspace` | string | 否 | 工作区路径，默认当前工作区 |

**示例**

```
安装 lodash 到当前项目
→ 调用 install_package({ packageName: "lodash" })

安装 typescript 作为开发依赖
→ 调用 install_package({ packageName: "typescript", saveDev: true })
```

---

## LSP 诊断工具

### `code_diagnose`

对工作区内的文件运行静态代码分析，支持 TypeScript 编译器（`tsc --noEmit`）和 ESLint。结果按文件内容哈希缓存，相同文件内容不会重复分析。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | ✅ | 相对于工作区根目录的文件路径 |
| `language` | string | 否 | `typescript` / `javascript`，默认自动检测 |

**返回**

```json
{
  "file": "src/index.ts",
  "diagnostics": [
    {
      "severity": "error",
      "message": "Type 'string' is not assignable to type 'number'",
      "line": 42,
      "column": 5,
      "source": "typescript"
    }
  ]
}
```

**示例**

```
帮我检查 src/utils/parser.ts 有没有类型错误
→ 调用 code_diagnose({ path: "src/utils/parser.ts" })
```

**安全说明**

- 只能分析工作区内的文件，不能访问工作区外路径
- 分析过程完全在服务器本地执行，不向外部发送代码

---

## REST API

系统工具均对应独立的 REST 接口，可绕过 AI 层直接调用。

### Todo API

```
POST   /api/v1/todos                 创建
GET    /api/v1/todos?sessionId=&status=  列出（支持分页）
PUT    /api/v1/todos/:id             更新
DELETE /api/v1/todos/:id             删除
```

### Cron API

```
POST   /api/v1/cron                  创建
GET    /api/v1/cron                  列出（支持分页）
PUT    /api/v1/cron/:id              更新
DELETE /api/v1/cron/:id              删除
POST   /api/v1/cron/:id/enable       启用
POST   /api/v1/cron/:id/disable      禁用
```

### Task API

```
POST   /api/v1/tasks                 入队（type + payload）
GET    /api/v1/tasks                 列出
GET    /api/v1/tasks/:jobId          查状态
DELETE /api/v1/tasks/:jobId          取消
```

---

## TodoPanel UI

`multi-agent-console` 中内置了 **TodoPanel** 组件，显示在聊天输入框上方。

- 实时展示当前会话的 Todo 列表
- 支持直接在面板中标记完成、删除任务
- Agent 调用 `todo_create` / `todo_update` 后面板自动刷新
- 使用 `TodoPanel.module.css` 实现独立样式隔离

```
┌─────────────────────────────────┐
│  📋 Todo  [ + 新建 ]            │
│  ○ 完成代码审查  HIGH  ⏰明天   │
│  ✓ 更新文档      LOW            │
│  ○ 修复 Bug #42  MED            │
└─────────────────────────────────┘
[          聊天输入框              ]
```

---

## 典型应用场景：工具组合拳

### 场景 A：从零构建并部署一个项目
1. **规划**：AI 调用 `todo_create` 拆解项目步骤。
2. **编码**：AI 调用 `create_dir` 和 `write_file` 生成代码结构。
3. **自检**：AI 调用 `code_diagnose` 检查代码语法和类型错误。
4. **运行**：AI 调用 `run_command` 启动本地服务器，并提供预览链接。

### 场景 B：深度调研与知识库构建
1. **搜索**：AI 调用 `web_fetch` 获取多个网页的最新技术文档。
2. **存储**：AI 调用 `remember` 将核心技术指标存入长期记忆。
3. **整合**：AI 调用 `write_file` 生成一份完整的技术调研报告。

### 场景 C：多 Agent 协同办公
1. **分发**：主 Agent 调用 `subagent` 创建一个“UI 设计专家”子智能体。
2. **产出**：子智能体在同一个工作区内生成 CSS 样式文件。
3. **汇总**：主 Agent 读取子智能体的产出，并通知用户任务完成。

---

## 终端（Terminal）

`multi-agent-console` 集成了完整的浏览器内 PTY 终端，由服务器端 `node-pty` 驱动，通过 WebSocket 与前端 `xterm.js` 互联。

### 架构概述

```
前端 XTerminal.tsx (xterm.js)
       ↕  WebSocket
后端 terminal.ts  (Fastify WS 路由)
       ↕  EventEmitter
    TerminalManager (node-pty sessions)
       ↕  PTY
  workspace-shell.mjs (沙箱 Shell)
```

### 沙箱 Shell 内置命令

`workspace-shell.mjs` 是一个纯 Node.js 实现的受限 Shell，`cd` 越界直接拒绝，无需系统 Bash。

| 命令 | 说明 |
|------|------|
| `ls [-a]` | 列出目录（多列对齐） |
| `ll [-a]` | 详细列表（大小 + 时间） |
| `cd <dir>` | 切换目录（`~` 回主工作区，`@ws2` 切第二工作区） |
| `pwd` | 打印当前目录 |
| `cat <file>` | 输出文件内容 |
| `mkdir <dir>` | 创建目录（`-p` 递归） |
| `touch <file>` | 创建空文件 / 更新时间戳 |
| `rm [-rf] <path>` | 删除文件/目录 |
| `cp <src> <dst>` | 复制文件 |
| `mv <src> <dst>` | 移动/重命名 |
| `find [-name <pat>]` | 递归查找文件 |
| `grep <pat> [file]` | 全文搜索 |
| `tree [dir]` | 目录树（最深 3 级） |
| `echo <text>` | 输出文本 |
| `env` | 列出环境变量 |
| `clear` | 清屏 |
| `help` | 显示帮助 |
| 其他命令 | 透传给操作系统执行（UTF-8 编码） |

### 安全机制

- `cd` 及所有文件操作均经过 `safeResolve()` 检查，路径必须在 `WORKSPACE_ROOTS` 之内
- 越界请求直接输出 `⛔ 禁止离开工作空间`，不执行
- 多工作空间通过 `WORKSPACE_ROOTS` 环境变量传入，支持 `@ws2`、`@ws3` 等别名跳转
- Windows 启动时自动切换代码页至 UTF-8（`chcp 65001`），避免乱码

### 前端组件

| 组件 | 说明 |
|------|------|
| `XTerminal.tsx` | xterm.js 实例封装，处理 WebSocket 连接 / 断线重连 / resize |
| `TerminalPanel.tsx` | 多 Tab 面板容器，支持新建、关闭、切换终端 Tab |
| `useTerminalStore` | Zustand store，管理 Tab 列表 / 活跃终端 / 面板高度 |

---

## VS Code–style Explorer

`multi-agent-console` 内置类 VS Code 文件浏览器，提供完整 IDE 侧边栏体验。

### 组件概览

| 组件 | 说明 |
|------|------|
| `explorer/index.tsx` | 顶层容器，集成文件树 + 编辑区 + 终端面板 |
| `explorer/FileTree.tsx` | 文件树（懒加载 + 虚拟滚动），支持展开/折叠/选中 |
| `explorer/ContextMenu.tsx` | 右键菜单（新建文件/目录、重命名、移至回收站、复制路径） |
| `explorer/QuickOpenPanel.tsx` | `Ctrl+P` 快速打开，模糊匹配，由 Web Worker 构建索引 |
| `editor/EditorTabs.tsx` | Tab 栏，脏状态指示点，关闭前弹确认对话框 |
| `editor/MonacoEditor.tsx` | Monaco 编辑器，支持语言自动检测、格式化、保存（`Ctrl+S`） |
| `editor/ImagePreview.tsx` | 图片预览（PNG / JPG / GIF / WebP / SVG） |
| `editor/VideoPreview.tsx` | 视频播放器，走 `/workspace/file/stream` Range 流 |
| `editor/HexEditor.tsx` | 二进制 Hex 查看器 |
| `editor/UnsavedDialog.tsx` | 关闭未保存 Tab 时弹出的确认对话框 |

### 状态管理

| Store | 说明 |
|-------|------|
| `useExplorerStore` | Tab 列表、活跃 Tab、脏状态、撤销日志、Quick Open 可见性 |
| `dirtyContentCache` | 模块级 `Map<path, content>`，编辑时仅写此 Map，**绕开 Zustand** 不触发重渲，保存时再写回 store |
| `useTerminalStore` | 终端 Tab 列表、活跃终端 ID、面板高度 |
| `useFileIndex` | Web Worker 驱动的文件路径索引，供 Quick Open 模糊搜索 |

### 文件操作流

```
右键菜单 → ContextMenu
  ├─ 新建文件   → POST /workspace/file/create
  ├─ 新建目录   → POST /workspace/folder/create
  ├─ 重命名     → POST /workspace/file/move
  ├─ 移至回收站 → POST /workspace/file/trash
  └─ 复制路径   → clipboard.writeText()

编辑器保存 (Ctrl+S)
  → dirtyContentCache.get(path)
  → PUT /workspace/file (multipart upload)
  → markSaved(path, content)

Quick Open (Ctrl+P)
  → fileIndex.worker.ts 构建路径列表
  → 模糊匹配 → openTab(path)
```

### Undo Log

删除 / 重命名操作写入 `undoLog`（最多保留 50 条，持久化到 `localStorage`），方便后续实现撤销还原功能。
