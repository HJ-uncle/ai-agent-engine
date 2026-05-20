# Agent Engine 系统架构与模块关系网

本文档旨在帮助开发者和用户理解 AI Agent Engine 的内部构造，以及各核心模块之间是如何协作以提供强大的 AI 自动化能力的。

## 核心架构概览

AI Agent Engine 采用了典型的**分层解耦架构**，由后端 API 指挥、存储层支撑、ReAct 循环驱动推理、前端控制台提供实时交互。

```mermaid
graph TD
    subgraph Frontend [前端展示层]
        UI[React/Zustand 控制台]
        Explorer[VS Code 风格文件树]
        Terminal[xterm.js 终端]
    end

    subgraph API_Layer [API 与调度层]
        API[Fastify HTTP/WS]
        Auth[多租户/权限校验]
        Cron[定时任务调度器]
    end

    subgraph Reasoning [AI 推理心脏]
        Loop[ReAct 思考循环]
        Adapter[LLM 适配器: DeepSeek/Claude/GPT/Qwen]
        SubAgent[多智能体协作网络]
    end

    subgraph Tools_Execution [执行与集成层]
        SysTools[内置系统工具]
        MCP[MCP 协议服务器]
        Skills[自定义脚本技能]
    end

    subgraph Persistence [数据与物理层]
        SQLite[(SQLite 结构化数据)]
        Workspace[[租户隔离工作区]]
    end

    UI <--> API
    API <--> Auth
    Auth <--> SQLite
    API --> Loop
    Cron --> API
    Loop <--> Adapter
    Loop <--> SubAgent
    Loop --> SysTools
    Loop --> MCP
    Loop --> Skills
    SysTools <--> Workspace
    Skills <--> Workspace
    Terminal <--> Workspace
    Explorer <--> Workspace
```

---

## 核心关系网分析：它是如何运转的？

### 1. 意图与执行的闭环：API $\leftrightarrow$ ReAct $\leftrightarrow$ Tools
- **后端 API** 是系统的指挥中心。当你发送一条消息时，API 会根据 **Agent 配置**（来自 SQLite）启动一个 **ReAct 推理循环**。
- **ReAct 循环** 是 AI 的“思考过程”。它通过“思考 (Thought) -> 行动 (Action) -> 观察 (Observation)”的循环来拆解任务。
- **工具 (Tools)** 是 AI 的手脚。无论是读写文件（Workspace）、查询数据库、调用 MCP 服务器，还是执行 Shell 命令，都是通过标准化的工具接口实现的。

### 2. 实时感知：SSE $\to$ 前端状态
- 系统使用 **SSE (Server-Sent Events)** 技术。AI 每产生一个“念头”或执行一个“动作”，后端都会立即推送到前端。
- **前端 Zustand Store** 像雷达一样捕捉这些信号，并实时更新 UI（如流式文字、工具执行动画、进度条），确保用户始终知道 AI 在做什么。

### 3. 多智能体协作：SubAgents 关系网
- 系统支持 **Parent-Child Agent** 模型。一个复杂的任务（如“重构整个项目”）可以由一个主 Agent 拆分给多个专门的 **SubAgent**（如“代码审查专家”、“测试编写专家”）协同完成。
- 每个子 Agent 拥有独立的上下文，但共享同一个 **Workspace**，确保产出物的一致性。

### 4. 开放协议：MCP 与 Skills
- **MCP (Model Context Protocol)**：允许系统接入外部数据源（如 GitHub、Google Drive）或外部工具。
- **Skills**：用户可以用 TypeScript/Python 编写自定义脚本，直接扩展 Agent 的能力。

### 5. 隔离与安全：多租户与工作区
- **可选鉴权**：请求携带 `X-API-Key` 或 `Authorization: Bearer <jwt>` 时自动验证；不携带则降级为默认租户 `"default"`，零配置即可启动。外部平台通过 `POST /auth/user` 同步用户 token，后续请求自动隔离。
- **多租户隔离**：每个用户（租户）的数据在数据库中逻辑隔离，在磁盘上通过独立的 **Workspace** 目录物理隔离。
- **安全沙箱**：所有的 Shell 命令和网络请求都经过**安全策略引擎**的正则过滤和 SSRF 防护。

---

## 用户看得懂的“任务生命周期”示例

如果你对 AI 说：**“帮我写一个贪吃蛇游戏，并运行它”**，系统内部会发生什么？

1. **接收指令**：API 接收到请求，确认你的身份，并找到你当前的 Agent。
2. **制定计划**：AI 进入 ReAct 循环，第一步是“思考”：*“我需要先创建一个目录，然后编写 HTML/JS 代码，最后通过终端预览。”*
3. **执行行动**：
   - AI 调用 `create_dir` 创建工作目录。
   - AI 调用 `write_file` 写入游戏代码。
   - AI 调用 `run_command` 启动一个本地 Web 服务器。
4. **实时反馈**：你在前端会看到：
   - 聊天框里流出的“思考过程”。
   - 自动跳出的“工具执行卡片”。
   - 右侧 **Explorer** 里自动出现的新文件。
   - 下方 **Terminal** 里自动运行的命令输出。
5. **任务完成**：AI 告诉你游戏已准备好，你可以点击预览链接直接玩。

---

## 总结
AI Agent Engine 不仅仅是一个对话框，它是一个**具备感知、思考、行动能力的数字化工作空间**。通过将 AI 的推理能力与系统的物理操作权限安全地结合在一起，它能够像人类助手一样真正地“完成工作”。
