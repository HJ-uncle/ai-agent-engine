# 统一工具注册工厂

## 概述

`src/tools/registry-factory.ts` 是所有工具注册逻辑的**唯一入口**。

之前每个路由（`chat.ts` / `messages.ts` / `tools.ts`）各自手动注册工具，容易出现某个路由漏注册工具的问题（如 `ask_user` 在 chat 路由中缺失，导致 AI 用文字提问而非弹出交互卡片）。

重构后，所有路由统一调用 `createToolRegistry()`，工具集始终一致。

---

## 注册顺序与工具列表

```typescript
export async function createToolRegistry(opts = {}): Promise<{ registry, memory, externalSkills }>
```

| 顺序 | 工具组 | 包含工具 |
|---|---|---|
| 1 | 内置 Skill | `list_skills` / `get_skill` |
| 2 | 文件工具 | `read_file` / `write_file` / `list_files` / `delete_file` / `create_dir` / `read_image` |
| 3 | 命令行工具 | `run_command` |
| 4 | 提问工具 | `ask_user` |
| 5 | 记忆工具 | `remember` / `recall` / `search_memory` |
| 6 | 外部 Skill 工具 | 动态加载（支持 `allowedSkills` 过滤） |
| 7 | MCP 工具 | 动态加载（所有已注册 MCP 服务器的工具） |

---

## 使用方法

### 路由中使用

```typescript
import { createToolRegistry } from '../../../tools/registry-factory.js'

// chat.ts：支持 allowedSkills 过滤（Agent 绑定的 Skill 列表）
const { registry, memory, externalSkills } = await createToolRegistry({ allowedSkills })

// messages.ts / tools.ts：不过滤，加载全部工具
const { registry, memory, externalSkills } = await createToolRegistry()
```

### 添加新工具

只需在 `registry-factory.ts` 中添加一行，所有路由自动生效：

```typescript
// 1. 导入工具
import { myNewTool } from './my-tool/index.js'

// 2. 注册（在合适的位置插入）
registry.register(myNewTool)
```

---

## 选项说明

```typescript
interface RegistryFactoryOptions {
  /**
   * 允许的 Skill 名称列表。
   * - undefined / null / [] → 加载全部外部 Skills
   * - ['skill-a', 'skill-b'] → 只加载指定的 Skills（Agent 绑定场景）
   */
  allowedSkills?: string[] | null
}
```

---

## 返回值

```typescript
{
  registry: ToolRegistry          // 已注册所有工具的注册表
  memory: SQLiteMemoryStore       // 记忆存储实例（供 AgentContext 使用）
  externalSkills: ExternalSkill[] // 已加载的外部 Skill 列表（供 buildSkillsSystemPrompt 使用）
}
```
