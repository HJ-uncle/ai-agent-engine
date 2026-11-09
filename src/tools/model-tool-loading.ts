import type { IToolRegistry, Message, Tool } from '../core/agent-context/types.js'

type Definition = ReturnType<IToolRegistry['list']>[number]
/** Exposure only, never execution permission. All other trusted builtins remain discoverable. */
export const CORE_MODEL_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'write_file', 'edit_file', 'list_files', 'glob', 'grep',
  'execute_cmd', 'command_output', 'cancel_command', 'plan_update',
  'list_skills', 'get_skill', 'ask_user', 'load_tools',
  'subagent_directory',
])

const groups: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Files', ['read_file', 'write_file', 'edit_file', 'list_files', 'glob', 'grep', 'delete_file', 'create_dir']],
  ['Office', ['office_document', 'office_inspect', 'office_environment']],
  ['Commands', ['execute_cmd', 'command_output', 'cancel_command']],
  ['Planning/questions', ['plan_update', 'ask_user', 'todo_list', 'todo_create', 'todo_update', 'todo_delete']],
  ['Skills', ['list_skills', 'get_skill', 'run_skill_script']],
  ['Memory', ['remember', 'recall', 'list_memories', 'forget', 'link_memories', 'search_memory']],
  ['Automation', ['cron_list', 'cron_preview', 'cron_create', 'cron_update', 'cron_delete']],
  ['Subagents', ['subagent', 'subagent_start', 'subagent_directory', 'subagent_followup', 'subagent_send', 'subagent_wait', 'subagent_cancel', 'subagent_participants', 'subagent_inbox', 'subagent_request_input']],
  ['Web/history', ['web_fetch', 'http_request', 'search_history']],
  ['Code', ['code_diagnose', 'codegraph']],
  ['Browser', ['browser_tabs', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_scroll', 'browser_press_key', 'browser_wait', 'browser_console', 'browser_network', 'browser_network_request', 'browser_set_viewport', 'browser_close']],
  ['Workbench/results', ['workbench_context', 'workbench_open', 'deliver_files', 'report_artifacts']],
  ['Agent configuration', ['agent_list', 'agent_get', 'agent_create', 'agent_do_create', 'agent_update', 'agent_do_update', 'agent_delete', 'agent_do_delete']],
  ['Legacy jobs', ['task_list', 'task_status', 'task_cancel']],
]

function catalogue(definitions: readonly Definition[]): string {
  const names = new Set(definitions.map(tool => tool.name).filter(name => name !== 'load_tools'))
  const lines: string[] = []
  for (const [label, entries] of groups) {
    const present = entries.filter(name => names.delete(name))
    if (present.length) lines.push(`${label}: ${present.join(', ')}`)
  }
  if (names.size) lines.push(`Other: ${[...names].join(', ')}`)
  return lines.join('\n')
}

function restoreSelection(history: readonly Message[], available: ReadonlySet<string>, loaded: Set<string>): void {
  const dispatches = new Map<string, Message['toolCall']>()
  for (const message of history) {
    if (message.role === 'assistant' && message.toolCall) {
      dispatches.set(message.toolCall.id, message.toolCall)
    }
    if (message.role !== 'tool' || !message.toolCallId) continue
    const call = dispatches.get(message.toolCallId)
    // An unoffered/failed call must not silently load itself on the next turn.
    // Legacy rows without a successful execution receipt can use load_tools.
    if (!call || message.metadata?.success === false || message.metadata?.success !== true && message.metadata?.status !== 'succeeded') continue
    if (available.has(call.name)) loaded.add(call.name)
    // A real directory observation is already the delegation decision. Offer
    // the authorized controls next, avoiding a separate load-only model turn.
    if (['subagent_directory', 'subagent_start', 'subagent_followup'].includes(call.name)) {
      for (const name of ['subagent_start', 'subagent_followup', 'subagent_wait']) if (available.has(name)) loaded.add(name)
    }
    if (call?.name !== 'load_tools') continue
    if (typeof message.content !== 'string') continue
    try {
      const receipt = JSON.parse(message.content) as { loaded?: unknown }
      const requested = Array.isArray(call.args?.names) ? new Set(call.args.names) : new Set()
      if (Array.isArray(receipt.loaded)) for (const name of receipt.loaded) {
        if (typeof name === 'string' && requested.has(name) && available.has(name)) loaded.add(name)
      }
    } catch { /* Missing/failed/legacy receipts never manufacture a selection. */ }
  }
}

export function loadModelTools(definitions: readonly Definition[], loaded: Set<string>, names: readonly string[]): string[] {
  const available = new Set(definitions.map(tool => tool.name))
  if (!Array.isArray(names) || !names.length || names.length > 128 || names.some(name => typeof name !== 'string' || !name.trim())) {
    throw new Error('names must contain 1..128 exact nonempty tool names')
  }
  const missing = names.filter(name => !available.has(name))
  if (missing.length) throw new Error(`Tools unavailable in this agent scope: ${[...new Set(missing)].join(', ')}`)
  const selected = [...new Set(names)]
  for (const name of selected) loaded.add(name)
  return selected
}

export function selectRequestTools(definitions: readonly Definition[], candidates: ReadonlySet<string>, loaded: Set<string>, history: readonly Message[] = [], trustedLoader = false, invalidatedHistory: ReadonlySet<string> = new Set()): Definition[] {
  // Legacy registries and core-only allowlists remain fully usable without a loader.
  if (!trustedLoader || !definitions.some(tool => tool.name === 'load_tools')) return [...definitions]
  const available = new Set(definitions.map(tool => tool.name))
  for (const name of loaded) if (!available.has(name)) loaded.delete(name)
  restoreSelection(history, new Set([...available].filter(name => !invalidatedHistory.has(name))), loaded)
  return definitions.filter(tool => !candidates.has(tool.name) || loaded.has(tool.name)).map(tool => tool.name === 'load_tools' ? {
    ...tool,
    description: `${loadToolsTool.description}\nAvailable in this agent scope:\n${catalogue(definitions)}`,
  } : tool)
}

/** No parent registry closure: a child executes this with its own scoped ctx.tools. */
export const loadToolsTool: Tool = {
  name: 'load_tools', displayName: '加载工具定义',
  description: 'Load exact tool names from the available catalogue before calling tools whose typed schemas are absent. Batch related names. Their full schemas appear in the next model request; loading does not execute them or grant permissions. Already visible tools need no load.',
  parameters: { type: 'object', additionalProperties: false, required: ['names'], properties: {
    names: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string', minLength: 1 } },
  } },
  async execute(raw, ctx) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'names')) throw new Error('Provide only names')
      if (!ctx.tools.loadForModel || ctx.tools.hasModelToolLoader?.() !== true) throw new Error('This agent has no trusted scoped tool loader')
      const names = (raw as { names: string[] }).names
      const loaded = ctx.tools.loadForModel(names)
      return { success: true, output: JSON.stringify({ loaded, note: 'Use the typed schemas in the next request; no tools were executed.' }) }
    } catch (error) {
      return { success: false, output: error instanceof Error ? error.message : String(error), metadata: { code: 'TOOL_LOAD_FAILED' } }
    }
  },
}
