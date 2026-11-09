import { REMOVED_TOOL_NAMES } from './tool-exposure.js'

/** Profiles select executable capabilities; OSM remains a separate prompt/methodology setting. */
export type ToolProfile = 'general' | 'code'

const LEGACY_TOOL_NAMES: Readonly<Record<string, string>> = {
  run_command: 'execute_cmd',
  smart_read: 'read_file',
}

/** Normalize configuration names, without registering aliases that could bypass profile checks. */
export function normalizeToolName(name: string): string {
  return Object.hasOwn(LEGACY_TOOL_NAMES, name) ? LEGACY_TOOL_NAMES[name] : name
}

export function normalizeAllowedTools(names?: readonly string[] | null): string[] | undefined {
  return names == null ? undefined : [...new Set(names.map(normalizeToolName))]
}

export const CODE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'write_file', 'edit_file', 'list_files', 'delete_file', 'create_dir',
  'glob', 'grep', 'execute_cmd', 'code_diagnose', 'codegraph',
  'command_output', 'cancel_command',
  'workbench_context', 'workbench_open',
  'deliver_files',
  'report_artifacts',
  'office_inspect',
  'subagent', 'subagent_start', 'subagent_send', 'subagent_wait', 'subagent_cancel', 'subagent_participants', 'subagent_inbox',
  'subagent_directory', 'subagent_followup', 'subagent_request_input', 'subagent_read_result',
  'plan_update', 'todo_list', 'todo_create', 'todo_update', 'todo_delete',
  'list_skills', 'get_skill', 'run_skill_script',
  'web_fetch', 'http_request', 'ask_user', 'search_history',
  'browser_tabs', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_screenshot',
  'browser_click', 'browser_fill', 'browser_scroll', 'browser_press_key', 'browser_wait',
  'browser_console', 'browser_network', 'browser_network_request', 'browser_set_viewport', 'browser_close',
])

const GENERAL_SERVICE_TOOLS: ReadonlySet<string> = new Set([
  'remember', 'recall', 'search_memory', 'list_memories', 'forget', 'link_memories',
  'office_document', 'office_environment',
])

/** Extension namespaces may add configured tools, but cannot impersonate excluded builtins or old aliases. */
export function isCodeProfileTool(tool: { name: string; source?: string }): boolean {
  const name = tool.name
  if (REMOVED_TOOL_NAMES.has(name) || normalizeToolName(name) !== name || GENERAL_SERVICE_TOOLS.has(name) || /^(?:cron|agent|task)_/.test(name)) return false
  return CODE_BUILTIN_TOOLS.has(name) || tool.source === 'skill' || name.startsWith('mcp_')
}
