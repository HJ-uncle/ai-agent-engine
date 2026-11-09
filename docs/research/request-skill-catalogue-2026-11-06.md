# “你是谁”请求的技能目录核对（2026-11-06）

## 证据边界

目标 root：`e0e4df0d-1f27-48b3-b980-0bfd5fab4768`；会话：`work-home-ded73bea-694b-48f1-9dfb-5919a199329f`；用户输入时间：2026-11-06 17:51:17（Asia/Shanghai）。

下文完整目录由当前源码 `buildSkillsSystemPrompt` 对打包默认技能真实渲染；同时使用截图前 17:48 的运行构建独立渲染，文本完全相同。只运行纯目录加载/渲染函数，没有启动引擎、调用模型或挂载文件监听。

未找到目标请求的完整 QA 日志。这是可核验的默认目录，不是已恢复的供应商 wire 请求，不能证明当时没有自定义技能根目录或其他资源配置。SQLite 只读连接仅投影目标 root/session 白名单；未读取或导出凭据、长期记忆及整个请求。

## 历史请求保留字段

数据库：`C:\Users\wb.xielin02\AppData\Roaming\Aether Code\engine\state\agent.db`。该库没有 `root_run_inputs` 表；记录位于 `root_runs.state.request`。

| 字段 | 目标记录 |
|---|---|
| `toolProfile` | `general`，长度 7 |
| `workspacePaths` | 指向 `C:\Users\wb.xielin02\wuzu_workspace\test01` |
| `agentId` | 未保留该键 |
| `skills` | 未保留该键 |
| `inlineSkills` | 未保留该键，没有历史名称/描述可提取 |
| `systemPrompt` | 未保留该键 |
| `inlineAgent.systemPrompt` | 未保留该字段 |
| `inlineMemoriesXml` | 未保留该键；未读取记忆正文 |
| `metadata` | 未保留该键 |

保存的 request JSON 长度为 149，仅含 `thinkingMode`、`workspacePaths`、`model`、`toolProfile`。缺少字段不直接证明原始 HTTP 请求没有发送。sessions.agent_id 为 NULL，metadata 无键；对应 JSONL 第 9–10 行的 metadata 也没有这些提示/技能字段。

## 当前与历史构建中的默认技能

- 当前只有 `src/skills/builtin/aether-office/SKILL.md` 这一项打包技能。
- 截图前运行构建：`D:/dev/ai-agent-engine/.tmp/aether-code-dev/2026-11-06T09-48-00-113Z-sYYzeh/dist/skills/builtin/aether-office/SKILL.md`。
- 两份 SKILL.md 的 SHA-256 均为 `ec1a75818f714f9e056360d814fafcddbaba8d2cc5898eec7211b8e76dd6d8f7`。
- 当前目标工作区 `.ae/skills`、`.aether/skills`、`SKILLs`，以及默认全局 `C:\Users\wb.xielin02\.aether\skills` 均不存在。没有检查秘密环境配置，无法排除自定义 `SKILLS_ROOT` 或 `AETHER_GLOBAL_DIR`。
- `registry-factory.ts` 还会应用 OSM 可见性、inline 合并、技能白名单和工具可用性过滤，所以打包目录不等于已经证实的实际请求最终目录。

## 完整默认目录文本

这是系统提示中的技能索引全文（名称与描述），不是 SKILL.md 正文；正文由 `get_skill` 按需读取。

```text
---
# Available Skills Index

你有 1 个外部技能。当用户请求**确实匹配**下列技能时（中文意图需映射到英文技能名，如「查新闻」→ `web-search`）：
1. 先用 `get_skill({name: "<英文技能名>"})` 取回 SKILL.md 并阅读；
2. 按 SKILL.md 的实际说明使用现有工具；只有技能提供并要求执行脚本时才调用 `run_skill_script`。

不匹配任何技能时**忽略本段**，不要为了「走流程」而强行套用技能；不确定是否有匹配可用 `list_skills` 查全量。
禁止凭空编造技能名或工具名。

## Skills Index:
 1. **aether-office** — 在Aether内创建和检查真实DOCX、XLSX、PPTX、PDF，编辑Word/Excel/演示文本，执行内置公式重算与版本保护。用于报告、方案、台账、演示和经营分析，不依赖WPS或其他办公应用。
---
```

## 源码位置

- `src/skills/external-loader.ts:222`：目录渲染。
- `src/skills/builtin-office.ts:8`：打包技能加载。
- `src/tools/registry-factory.ts:274`：过滤与合并。
- `src/api/http/routes/chat.ts:1099`：生成系统提示中的技能段。
- `src/storage/root-runs/index.ts:77`：续跑输入白名单。

## 当前身份与项目上下文核对

2026-11-06 追加限定核对结果：

- 目标工作区 `C:\Users\wb.xielin02\wuzu_workspace\test01` 下的 `.ae/AE.md`、`.aether/AE.md`、根目录 `AE.md` 均不存在。
- 默认全局文件 `C:\Users\wb.xielin02\.aether\AE.md` 不存在。
- 对 `tenant_configs` 只读查询 `tenant_id = 'default' AND key = 'default_identity'`，没有记录。

这些结果描述当前核验时刻，不能证明历史请求当时的文件和配置完全相同，也没有排除未经读取的自定义全局目录。没有可导出的普通身份或项目提示正文，因此未创建空的 `request-context-fulltext-2026-11-06.md`。未读取或导出长期记忆、凭据及无关个人配置。
