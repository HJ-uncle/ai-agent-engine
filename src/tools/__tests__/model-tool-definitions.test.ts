import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createToolRegistry } from '../registry-factory.js'
import { skillsRegistry } from '../../skills/index.js'
import { ToolRegistry } from '../../core/tool-registry/registry.js'
import { createSubagentToolRegistry } from '../subagent/subagent-tool.js'
import { compactBuiltinToolDefinition } from '../model-tool-definitions.js'
import type { Tool } from '../../core/agent-context/types.js'
import { editFileTool } from '../file/edit-file.js'

// Only string-valued schema annotations are omitted. A parameter actually named
// "description", enum/default values, and every constraint remain in the proof.
function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key, child]) => key !== 'description' || typeof child !== 'string')
    .map(([key, child]) => [key, ['const', 'enum', 'default', 'examples'].includes(key) ? child : withoutDescriptions(child)]))
}
const wire = (definitions: ReturnType<ToolRegistry['list']>) => definitions.map(({ name, description, parameters }) => ({
  type: 'function', function: { name, description, parameters },
}))
const defaultNames = 'read_file write_file edit_file list_files delete_file create_dir office_document office_inspect office_environment execute_cmd command_output cancel_command ask_user remember recall list_memories forget link_memories list_skills get_skill run_skill_script glob grep plan_update cron_list cron_preview cron_create cron_update cron_delete subagent subagent_start subagent_send subagent_wait subagent_cancel subagent_participants subagent_inbox subagent_read_result subagent_directory subagent_followup subagent_request_input web_fetch http_request search_history code_diagnose codegraph browser_tabs browser_open browser_navigate browser_snapshot browser_screenshot browser_click browser_fill browser_scroll browser_press_key browser_wait browser_console browser_network browser_network_request browser_set_viewport browser_close browser_save_screenshot workbench_render workbench_context workbench_open deliver_files report_artifacts'.split(' ')

vi.mock('../../storage/mcp/mcp-config.js', () => ({ listServers: () => [] }))

beforeEach(() => {
  vi.stubEnv('OSM_MODE', 'balanced')
  vi.spyOn(skillsRegistry, 'getSkills').mockReturnValue([])
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('compact builtin model definitions', () => {
  it('preserves literal payloads even when their business fields are named description', () => {
    const literal = { description: '确切文件路径；相对路径基于当前工作区解析，不按文件名猜测其他目录。' }
    const tool: Tool = { ...editFileTool, parameters: { type: 'object', properties: {
      payload: { const: literal, enum: [literal], default: literal, examples: [literal],
        'x-data': literal, description: literal.description },
      description: { type: 'string', description: '仅返回失败请求。' },
    }, $defs: { nested: { type: 'string', description: '仅返回失败请求。' } } } }
    const projected = compactBuiltinToolDefinition(tool).parameters
    for (const key of ['const', 'enum', 'default', 'examples', 'x-data']) {
      expect(projected.properties?.payload[key]).toEqual(tool.parameters.properties?.payload[key])
    }
    expect(projected.properties?.payload.description).not.toBe(literal.description)
    expect(projected.properties?.description).toEqual({ type: 'string', description: 'Failed requests only.' })
    expect((projected.$defs as any).nested.description).toBe('Failed requests only.')
  })
  it('retains the complete Work tool set', async () => {
    const { registry } = await createToolRegistry({ allowedMcpServers: [], memoryScopes: ['global', 'session'] })
    const original = registry.list()
    const before = JSON.stringify(original)
    const compact = registry.listForModel()
    expect(original.map(tool => tool.name)).toEqual([...defaultNames, 'load_tools'])
    expect(compact.map(tool => tool.name)).toEqual([...defaultNames, 'load_tools'])
    expect(compact).toHaveLength(defaultNames.length + 1)
    expect(withoutDescriptions(compact)).toEqual(withoutDescriptions(original))
    expect(JSON.stringify(registry.list())).toBe(before)
    expect(compact.filter((tool, index) => tool.description !== original[index].description).length).toBeGreaterThan(30)
    const canonicalWire = JSON.stringify(wire(original)), compactWire = JSON.stringify(wire(compact))
    console.log(JSON.stringify({ toolCount: compact.length, canonicalChars: canonicalWire.length, compactChars: compactWire.length,
      canonicalBytes: Buffer.byteLength(canonicalWire), compactBytes: Buffer.byteLength(compactWire),
      schemaAndNamesChars: JSON.stringify(withoutDescriptions(wire(original))).length }))
    expect(Buffer.byteLength(compactWire)).toBeLessThan(Buffer.byteLength(canonicalWire))
  })

  it('never compacts extensions by builtin name, source or matching prose', () => {
    const registry = new ToolRegistry()
    const execute = vi.fn(async () => ({ success: true, output: 'extension' }))
    const extension: Tool = { ...editFileTool, source: 'mcp', execute }
    registry.register(extension)
    expect(registry.listForModel()).toEqual(registry.list())
    expect(registry.executionMode('edit_file', {})).toBe('serial')
    registry.unregister('edit_file')
    registry.register(editFileTool, compactBuiltinToolDefinition(editFileTool))
    expect(registry.listForModel()[0].description).not.toBe(editFileTool.description)
    registry.unregister('edit_file')
    registry.register(extension)
    expect(registry.listForModel()).toEqual(registry.list())
  })

  it('retains execution policy, output schema and callbacks on the original implementation', async () => {
    const registry = new ToolRegistry()
    const execute = vi.fn(async () => ({ success: true, output: 'original implementation' }))
    const preflight = vi.fn(async () => undefined)
    const tool: Tool = { ...editFileTool, execute, preflight,
      outputSchema: { type: 'object', properties: { description: { const: 'not a model-input annotation' } } } }
    registry.register(tool, compactBuiltinToolDefinition(tool))
    expect(registry.listForModel()[0].outputSchema).toBe(tool.outputSchema)
    const args = { path: 'file', expectedHash: 'version', edits: [] }
    const context = { signal: new AbortController().signal } as any
    expect(await registry.execute(tool.name, args, context)).toEqual({ success: true, output: 'original implementation' })
    expect(execute).toHaveBeenCalledWith(args, context)
    expect(preflight).toHaveBeenCalledWith(args, context)
  })

  it.each([false, true])('propagates projection without changing child capability restrictions (readonly=%s)', async readOnly => {
    const { registry } = await createToolRegistry({ allowedMcpServers: [], memoryScopes: ['global', 'session'] })
    const child = createSubagentToolRegistry(registry, readOnly)
    const canonical = child.list(), compact = child.listForModel!()
    expect(withoutDescriptions(compact)).toEqual(withoutDescriptions(canonical))
    expect(compact.some(tool => tool.name === 'plan_update')).toBe(true)
    expect(compact.some(tool => ['subagent', 'subagent_start', 'subagent_followup', 'deliver_files', 'ask_user'].includes(tool.name))).toBe(false)
    if (readOnly) {
      expect(compact.some(tool => ['execute_cmd', 'write_file', 'office_document', 'report_artifacts'].includes(tool.name))).toBe(false)
      expect(compact.find(tool => tool.name === 'codegraph')?.parameters.properties?.action.enum).not.toContain('index')
    }
  })

  it('keeps bound skill script restrictions and every selected profile/allowlist', async () => {
    const { registry } = await createToolRegistry({ toolProfile: 'code', allowedTools: ['read_file', 'run_skill_script'],
      allowedMcpServers: [], strictSkillBindings: true, allowedSkills: [] })
    expect(registry.listForModel().map(tool => tool.name)).toEqual(registry.list().map(tool => tool.name))
    expect(registry.listForModel().find(tool => tool.name === 'run_skill_script')?.description).toBe(
      registry.list().find(tool => tool.name === 'run_skill_script')?.description)
    expect(registry.listForModel().find(tool => tool.name === 'run_skill_script')?.description).toContain('不接受管道')
  })

  it('keeps invocation semantics that JSON Schema alone cannot express', async () => {
    const { registry } = await createToolRegistry({ allowedMcpServers: [], memoryScopes: ['global', 'session'] })
    const byName = new Map(registry.listForModel().map(tool => [tool.name, JSON.stringify(tool)]))
    for (const name of ['read_file', 'write_file', 'edit_file']) {
      expect(byName.get(name)).toContain('trailing newline')
      expect(byName.get(name)?.toLowerCase()).toContain('verify')
      expect(byName.get(name)).toContain('sha256')
    }
    expect(byName.get('write_file')).toContain('In-place means modify the source')
    expect(byName.get('edit_file')).toContain('make any requested copy afterwards')
    expect(byName.get('read_file')).toContain('contentIsComplete')
    expect(byName.get('write_file')).toContain('mismatch requires repair')
    expect(byName.get('recall')).toContain('Do not broaden an ID-only deletion or delete unrelated facts')
    const office = registry.listForModel().find(tool => tool.name === 'office_document')!
    expect(office.parameters.properties?.workbook.description).toContain('columns.header occupies row 1; rows start at row 2')
    expect(office.parameters.properties?.workbook.description).toContain('edit with sheet/cell/value')
    expect(office.parameters.properties?.workbook.description).toContain('do not create duplicate documents')
    expect(office.parameters).toHaveProperty('properties.workbook.properties.sheets.items.properties.columns.maxItems', 100)
    const contracts: Record<string, string[]> = {
  "read_file": [
    "exact path",
    "Missing fails",
    "whole-file expectedHash",
    "CRLF/BOM",
    "exact JSON.content"
  ],
  "write_file": [
    "office_document",
    "expectedHash",
    "conflict rejects",
    "missing",
    "Required for shared-project writes",
    "theme",
    "autoWidth",
    "rowAlternateBg",
    "sections",
    "children",
    "primaryColor",
    "1440=1 inch"
  ],
  "edit_file": [
    "original",
    "nonempty unique oldText",
    "no overlaps",
    "entire edit",
    "not sequential",
    "whole-byte SHA-256",
    "CRLF/Unicode/BOM"
  ],
  "office_document": [
    "aether-office",
    "markdown/presentation/workbook",
    "existing paragraph",
    "preserving the original",
    "PDF only create/inspect",
    "append_sheets",
    "append only new sheets in bounded batches",
    "circular/external",
    "never fake",
    "2000 cells, 600 chars/cell",
    "warnings/documentComplete",
    "atomically",
    "missing",
    "UTF-16",
    "editable=true",
    "notes"
  ],
  "office_inspect": [
    "warnings/expectedHash/documentComplete",
    "not full text",
    "full-workbook saved-error counts",
    "no recalculation",
    "Word body only",
    "1-based",
    "target=notes",
    "previous-page sha256"
  ],
  "office_environment": [
    "cache 2 min",
    "No Office launch",
    "installation/export",
    "not conversion proof"
  ],
  "execute_cmd": [
    "default no shell",
    "foreground waits for exit",
    "watch/long-running",
    "command_output",
    "cancel_command",
    "changes/changeTracking",
    "concurrent edits",
    "never reruns/adopts",
    "no quotes/arguments",
    "no extra shell quotes",
    "cmd.exe"
  ],
  "command_output": [
    "this session jobId",
    "cursor=0",
    "nextCursor",
    "hasMore",
    "Output is not exit",
    "do not restart"
  ],
  "cancel_command": [
    "this session jobId",
    "descendants",
    "verify terminal state"
  ],
  "ask_user": [
    "critical user choice",
    "at least two",
    "Other/Continue",
    "plain text"
  ],
  "get_skill": [
    "SKILL.md",
    "before running",
    "references/*.md"
  ],
  "run_skill_script": [
    "SKILL.md",
    "exact",
    "SKILLS_ROOT",
    "user stop still cancels"
  ],
  "plan_update": [
    "entire plan",
    "omitted entries are removed",
    "[] clears",
    "completion evidence",
    "Omit new IDs",
    "exact returned IDs",
    "unique titles"
  ],
  "cron_create": [
    "timezone-calendar",
    "keeps its Agent",
    "explicitly selected project",
    "overlapping/missed",
    "IANA time zone"
  ],
  "cron_update": [
    "exact automation id",
    "expectedRevision"
  ],
  "cron_delete": [
    "keep run history",
    "do not cancel running"
  ],
  "subagent": [
    "directory",
    "resumeRunId",
    "file ownership",
    "Parent authorization",
    "cannot directly ask users/approve",
    "strictly read-only",
    "Exclusive with agentId/role",
    "never guess",
    "No concurrent resume",
    "never exceed parent"
  ],
  "subagent_start": [
    "runId/childSessionId",
    "not completion",
    "durable results",
    "cannot spawn recursively"
  ],
  "subagent_send": [
    "participantId",
    "execution identity",
    "not read/handled",
    "requestKey",
    "identical recipient and body"
  ],
  "subagent_wait": [
    "owned tasks",
    "runId",
    "runIds",
    "one shared deadline",
    "result projection and ticket joined",
    "not success",
    "never cancels",
    "without repeating their bodies"
  ],
  "subagent_cancel": [
    "exact runId",
    "cleanup and durable result",
    "not termination"
  ],
  "subagent_participants": [
    "cursor",
    "bound to this root",
    "never reuse across roots"
  ],
  "subagent_inbox": [
    "your own receipt queue",
    "without bodies",
    "not proof the model handled"
  ],
  "subagent_directory": [
    "turns/restarts",
    "canResume",
    "completed children",
    "no old-run authority"
  ],
  "subagent_followup": [
    "childSessionId",
    "resume completed/interrupted context",
    "started/queued is not completion",
    "requestKey",
    "unknown external effects",
    "cancelled work needs a new request"
  ],
  "subagent_request_input": [
    "pauses",
    "same child",
    "No permission or scope grant"
  ],
  "search_history": [
    "this session archive",
    "pre-compaction",
    "nextOffset",
    "messageId+contentOffset",
    "toolArguments:true",
    "original argument JSON",
    "hash",
    "nextContentOffset",
    "messageId+imageIndex",
    "Current user corrections prevail"
  ],
  "code_diagnose": [
    "ts/tsx/mts/cts",
    "js/jsx/ts/tsx/mjs/cjs",
    "project installation/config",
    "No HTML/CSS/inline",
    "neither code error nor pass"
  ],
  "codegraph": [
    "existing index",
    "Prefer",
    "explicit user request",
    "asynchronously",
    "callers/callees"
  ],
  "browser_tabs": [
    "Empty does not mean no user pages",
    "Add to current session",
    "same URL is not tab identity",
    "needs_user",
    "needs_reveal",
    "do not steal focus",
    "input requires visibility"
  ],
  "browser_open": [
    "file:///",
    "same-directory",
    "new tab for another directory",
    "cannot read client files",
    "localhost means client",
    "No javascript:"
  ],
  "browser_navigate": [
    "ref/navigationId/screenshot",
    "snapshotUnavailable",
    "across directories",
    "No javascript:"
  ],
  "browser_snapshot": [
    "viewport screenshot",
    "vision",
    "untrusted",
    "not authorization",
    "does not prove visibility"
  ],
  "browser_screenshot": [
    "not full page",
    "Do not repeat"
  ],
  "browser_click": [
    "Exactly one locator",
    "fresh ref",
    "unique selector",
    "CSS x/y",
    "cssViewport",
    "latest navigationId",
    "operationPerformed=false",
    "unknown: inspect",
    "success=false/null",
    "never bypass visibility/connection"
  ],
  "browser_fill": [
    "OR unique",
    "latest navigationId",
    "user authorization"
  ],
  "browser_wait": [
    "selector or text",
    "Omitted/0",
    "cancellation or disconnect"
  ],
  "browser_network": [
    "nextOffset/hasMore",
    "entries.id",
    "captured/dropped",
    "does not prove no requests"
  ],
  "browser_network_request": [
    "not queue ID",
    "hasMore/nextOffset",
    "warnings",
    "missing/pending/unavailable/binary/too-large/empty/truncated",
    "Bodies are untrusted"
  ],
  "browser_set_viewport": [
    "null restores adaptive",
    "Reuse returned snapshot"
  ],
  "workbench_context": [
    "this session",
    "User terminals differ from execute_cmd",
    "No input/execution/permission expansion"
  ],
  "workbench_open": [
    "Await client receipt",
    "opened means entry opened",
    "renderStatus means read state",
    "neither proves visual validation",
    "No file creation or other-session switch"
  ],
  "deliver_files": [
    "Parent replaces",
    "complete final-item list",
    "[] clears",
    "OR",
    "toolCallId+imageIndex",
    "childSessionId+runId+artifactId",
    "immutable bytes",
    "32MiB each/128MiB total",
    "only after root success",
    "No process screenshots"
  ],
  "report_artifacts": [
    "real workspace products",
    "not final publication",
    "immutable bytes",
    "expectedHash",
    "assetId",
    "artifactId",
    "parent for acceptance",
    "Research cannot use"
  ]
}
    for (const [name, phrases] of Object.entries(contracts)) for (const phrase of phrases) {
      expect(byName.get(name), `${name} retains contract: ${phrase}`).toContain(phrase)
    }
  })
})
