/**
 * 统一工具注册工厂
 *
 * 所有路由（chat / messages / tools）都通过此函数创建一致的 ToolRegistry。
 * 新增或移除工具只需修改这一处。
 */
import { ToolRegistry } from '../core/tool-registry/index.js'
import { SQLiteMemoryStore } from '../storage/memory-store/index.js'
import { registerBuiltinSkills, skillsRegistry } from '../skills/index.js'
import { fileTools } from './file/index.js'
import { cmdTool } from './cmd/index.js'
import { askUserTool } from './ask-user/index.js'
import { createMemoryTools } from './memory/index.js'
import { registerMCPTools } from './mcp/loader.js'
import { createSkillTools, runSkillScriptTool } from './skill/index.js'
import { globTool } from './search/glob-tool.js'
import { grepTool } from './search/grep-tool.js'
import { todoTools } from './todo/todo-tool.js'
import { cronTools } from './cron/cron-tool.js'
import { taskControlTools } from './task/task-tool.js'
import type { ExternalSkill } from '../skills/external-loader.js'

export interface RegistryFactoryOptions {
  /** 允许的 skill 列表，undefined = 全部，[] = 全部，传入列表则过滤 */
  allowedSkills?: string[] | null
}

/**
 * 创建并返回一个已注册所有内置工具的 ToolRegistry。
 * 同时返回 skillsPrompt（供 system prompt 使用）和实际注册的 skills 列表。
 */
export async function createToolRegistry(opts: RegistryFactoryOptions = {}): Promise<{
  registry: ToolRegistry
  memory: SQLiteMemoryStore
  externalSkills: ExternalSkill[]
}> {
  const registry = new ToolRegistry()
  const memory = new SQLiteMemoryStore()

  // 1. 内置 Skill（list_skills / get_skill）
  registerBuiltinSkills(registry)

  // 2. 文件工具（read_file / write_file / list_files / delete_file / create_dir / read_image）
  fileTools.forEach((t) => registry.register(t))

  // 3. 命令行工具
  registry.register(cmdTool)

  // 4. 向用户提问工具
  registry.register(askUserTool)

  // 5. 记忆工具（remember / recall / search_memory）
  createMemoryTools(memory).forEach((t) => registry.register(t))

  // 6. 外部 Skill 工具（按 allowedSkills 过滤）
  let externalSkills = skillsRegistry.getSkills()
  if (opts.allowedSkills && opts.allowedSkills.length > 0) {
    externalSkills = externalSkills.filter((s) => opts.allowedSkills!.includes(s.name))
  }
  createSkillTools(externalSkills).forEach((t) => registry.register(t))
  registry.register(runSkillScriptTool)

  // 7. 搜索工具（glob / grep）
  registry.register(globTool)
  registry.register(grepTool)

  // 8. 待办任务工具（todo_list / todo_create / todo_update / todo_delete）
  todoTools.forEach((t) => registry.register(t))

  // 9. 定时任务工具（cron_list / cron_create / cron_update / cron_delete）
  cronTools.forEach((t) => registry.register(t))

  // 10. 后台任务控制工具（task_list / task_cancel / task_status）
  taskControlTools.forEach((t) => registry.register(t))

  // 11. MCP 工具（动态加载，顺序在最后）
  await registerMCPTools(registry)

  return { registry, memory, externalSkills }
}
