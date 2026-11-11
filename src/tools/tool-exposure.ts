import { MANAGEMENT_TOOL_NAMES } from './toolkits.js'

/** Model-facing defaults only. Optional tools remain selectable; this is not an authorization policy. */
export interface OptionalToolExposure {
  readonly defaultEnabled: false
  readonly reason: string
}

export const OPTIONAL_TOOL_EXPOSURES = {
  agent_list: { defaultEnabled: false, reason: '仅在查找或管理已配置的 Agent 时需要；普通任务不默认展开管理目录。' },
  agent_get: { defaultEnabled: false, reason: '仅在查看 Agent 配置时需要；不影响用户直接选择已配置的 Agent。' },
  agent_create: { defaultEnabled: false, reason: 'Agent 配置创建预览，属于按需管理操作；不属于普通任务执行。' },
  agent_update: { defaultEnabled: false, reason: 'Agent 配置更新预览，属于按需管理操作；不用于修改当前任务内容。' },
  agent_delete: { defaultEnabled: false, reason: 'Agent 配置删除预览，属于按需管理操作；不用于停止当前任务。' },
  todo_list: { defaultEnabled: false, reason: '兼容旧版待办读取；当前会话计划由引擎恢复，新计划使用 plan_update。' },
  todo_create: { defaultEnabled: false, reason: '兼容旧版单项待办创建；新计划使用 plan_update 批量维护。' },
  todo_update: { defaultEnabled: false, reason: '兼容旧版单项待办更新；新计划使用 plan_update 批量维护。' },
  todo_delete: { defaultEnabled: false, reason: '兼容旧版单项待办删除；新计划使用 plan_update 批量维护。' },
  task_list: { defaultEnabled: false, reason: '读取旧版后台队列，不是当前命令任务或子代理列表。' },
  task_status: { defaultEnabled: false, reason: '查询旧版后台队列，不适用于 execute_cmd 或子代理的执行身份。' },
  task_cancel: { defaultEnabled: false, reason: '仅能取消旧队列中尚未执行的任务，不能停止运行中的命令或子代理。' },
} as const satisfies Readonly<Record<string, OptionalToolExposure>>

export type OptionalToolName = keyof typeof OPTIONAL_TOOL_EXPOSURES

/** Removed public identities cannot be reintroduced by an extension or an explicit tool selection. */
export const REMOVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'install_package', 'list_packages', 'get_time', 'calculate', 'get_tool_details', 'get_current_context',
  'glob_search', 'grep_search',
  'agent_do_create', 'agent_do_update', 'agent_do_delete',
])

export function isDefaultTool(name: string): boolean {
  return !REMOVED_TOOL_NAMES.has(name) && !MANAGEMENT_TOOL_NAMES.has(name) && !Object.hasOwn(OPTIONAL_TOOL_EXPOSURES, name)
}
