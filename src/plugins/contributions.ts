import { z } from 'zod'
import type { JSONSchema } from '../core/agent-context/types.js'

const id = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)
const tool = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)
const when = z.object({ session: z.boolean().optional(), workspace: z.boolean().optional(), engineReady: z.boolean().optional() }).strict()
const base = { id, title: z.string().trim().min(1).max(120), scope: z.enum(['global', 'session']).optional(), when: when.optional(), order: z.number().int().min(-1000).max(1000).optional() }
export const PLUGIN_MENU_LOCATIONS = ['message.actions', 'session.context', 'file.context', 'editor.context', 'editor.toolbar', 'app.menu', 'service.context', 'composer.toolbar'] as const
export const PLUGIN_VIEW_LOCATIONS = ['message.inline', 'composer.panel', 'workspace.panel'] as const
export const PLUGIN_EVENTS = ['app.started', 'app.stopping', 'session.opened', 'session.closed', 'session.changed', 'message.created', 'message.completed', 'workspace.changed', 'file.changed', 'editor.selectionChanged', 'composer.changed', 'agent.started', 'agent.completed', 'agent.failed', 'agent.cancelled'] as const
export const pluginEventSchema = z.enum(PLUGIN_EVENTS)
export type PluginEventType = typeof PLUGIN_EVENTS[number]
const page = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('tool'), tool: tool.optional() }).strict(),
  z.object({ ...base, kind: z.literal('webview'), entry: z.string().min(1).max(300), tools: z.array(tool) }).strict(),
  z.object({ ...base, kind: z.literal('native'), entry: z.string().min(1).max(300), tools: z.array(tool).optional() }).strict(),
])
const target = z.object({ ...base, page: id, icon: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional() }).strict()
export const pluginContributionsSchema = z.object({
  pages: z.array(page).optional(), navigation: z.array(target).optional(), workspaceTabs: z.array(target).optional(),
  services: z.array(z.object({ ...base, tool, stopTool: tool.optional(), statusTool: tool.optional(), page: id.optional(), args: z.record(z.unknown()).optional() }).strict()).optional(),
  commands: z.array(z.object({ ...base, tool: tool.optional(), page: id.optional(), args: z.record(z.unknown()).optional(), shortcut: z.string().min(1).max(80).optional() }).strict().refine(value => Boolean(value.tool) !== Boolean(value.page), 'command 需要且只能提供 tool 或 page')).optional(),
  menus: z.array(z.object({ ...base, location: z.enum(PLUGIN_MENU_LOCATIONS), command: id }).strict()).optional(),
  views: z.array(z.object({ ...base, location: z.enum(PLUGIN_VIEW_LOCATIONS), page: id, height: z.number().int().min(40).max(1200).optional() }).strict()).optional(),
  statusBar: z.array(z.object({ ...base, command: id, icon: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional() }).strict()).optional(),
  settings: z.array(z.object({ ...base, page: id }).strict()).optional(),
  editorDecorations: z.array(z.object({ ...base, pattern: z.string().min(1).max(200).optional(), text: z.string().min(1).max(2000), tooltip: z.string().max(4000).optional(), severity: z.enum(['info', 'warning', 'error']).optional() }).strict()).optional(),
  hooks: z.array(z.object({ ...base, event: pluginEventSchema, tool, args: z.record(z.unknown()).optional() }).strict()).optional(),
  background: z.array(z.object({ ...base, tool, args: z.record(z.unknown()).optional(), intervalMs: z.number().int().min(1000).max(604_800_000), runOnStartup: z.boolean().optional() }).strict()).optional(),
}).strict()
export type PluginContributions = z.infer<typeof pluginContributionsSchema>

const idProperty: JSONSchema = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' }
const toolProperty: JSONSchema = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$' }
const baseProperties: Record<string, JSONSchema> = {
  id: idProperty, title: { type: 'string', minLength: 1, maxLength: 120 }, scope: { type: 'string', enum: ['global', 'session'] },
  order: { type: 'integer', minimum: -1000, maximum: 1000 },
  when: { type: 'object', additionalProperties: false, properties: { session: { type: 'boolean' }, workspace: { type: 'boolean' }, engineReady: { type: 'boolean' } } },
}
const targetProperties = { ...baseProperties, page: idProperty, icon: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' } }
function contributionItems(properties: Record<string, JSONSchema>, required: string[]): JSONSchema {
  return { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'title', ...required], properties: { ...baseProperties, ...properties } } }
}
const argsProperty: JSONSchema = { type: 'object', additionalProperties: true }
/** Advertised to AI tools as well as template clients; runtime validation remains the strict Zod contract above. */
export const PLUGIN_CONTRIBUTION_JSON_SCHEMA: JSONSchema = {
  type: 'object', additionalProperties: false, properties: {
    pages: { type: 'array', items: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['id', 'title', 'kind'], properties: { ...baseProperties, kind: { type: 'string', enum: ['tool'] }, tool: toolProperty } },
      { type: 'object', additionalProperties: false, required: ['id', 'title', 'kind', 'entry', 'tools'], properties: { ...baseProperties, kind: { type: 'string', enum: ['webview'] }, entry: { type: 'string', minLength: 1, maxLength: 300 }, tools: { type: 'array', items: toolProperty } } },
      { type: 'object', additionalProperties: false, required: ['id', 'title', 'kind', 'entry'], properties: { ...baseProperties, kind: { type: 'string', enum: ['native'] }, entry: { type: 'string', minLength: 1, maxLength: 300 }, tools: { type: 'array', items: toolProperty } } },
    ] } },
    navigation: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'page'], properties: targetProperties } },
    workspaceTabs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'page'], properties: targetProperties } },
    services: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'tool'], properties: { ...baseProperties, tool: toolProperty, stopTool: toolProperty, statusTool: toolProperty, page: idProperty, args: { type: 'object', additionalProperties: true } } } },
    commands: { type: 'array', items: { oneOf: [
      (contributionItems({ tool: toolProperty, args: argsProperty, shortcut: { type: 'string', minLength: 1, maxLength: 80 } }, ['tool']).items as JSONSchema),
      (contributionItems({ page: idProperty, args: argsProperty, shortcut: { type: 'string', minLength: 1, maxLength: 80 } }, ['page']).items as JSONSchema),
    ] } },
    menus: contributionItems({ location: { type: 'string', enum: [...PLUGIN_MENU_LOCATIONS] }, command: idProperty }, ['location', 'command']),
    views: contributionItems({ location: { type: 'string', enum: [...PLUGIN_VIEW_LOCATIONS] }, page: idProperty, height: { type: 'integer', minimum: 40, maximum: 1200 } }, ['location', 'page']),
    statusBar: contributionItems({ command: idProperty, icon: targetProperties.icon }, ['command']),
    settings: contributionItems({ page: idProperty }, ['page']),
    editorDecorations: contributionItems({ pattern: { type: 'string', minLength: 1, maxLength: 200 }, text: { type: 'string', minLength: 1, maxLength: 2000 }, tooltip: { type: 'string', maxLength: 4000 }, severity: { type: 'string', enum: ['info', 'warning', 'error'] } }, ['text']),
    hooks: contributionItems({ event: { type: 'string', enum: [...PLUGIN_EVENTS] }, tool: toolProperty, args: argsProperty }, ['event', 'tool']),
    background: contributionItems({ tool: toolProperty, args: argsProperty, intervalMs: { type: 'integer', minimum: 1000, maximum: 604_800_000 }, runOnStartup: { type: 'boolean' } }, ['tool', 'intervalMs']),
  },
}

/** This metadata is returned beside templates, so authors and editors use the validated capability vocabulary. */
export const PLUGIN_CONTRIBUTION_CATALOGUE = {
  apiVersion: 1,
  fields: ['pages', 'navigation', 'workspaceTabs', 'services', 'commands', 'menus', 'views', 'statusBar', 'settings', 'editorDecorations', 'hooks', 'background'],
  renderers: ['tool', 'webview', 'native'], scopes: ['global', 'session'],
  menuLocations: PLUGIN_MENU_LOCATIONS, viewLocations: PLUGIN_VIEW_LOCATIONS, events: PLUGIN_EVENTS,
  native: { entry: 'Package-relative .json, {version:1,root:Node}; declarative components only, no executable JavaScript or raw HTML',
    componentTypes: ['text', 'heading', 'stack', 'row', 'divider', 'button', 'input', 'textarea', 'select', 'checkbox', 'card', 'image', 'markdown'],
    fields: ['type', 'id', 'text', 'label', 'value', 'bind', 'placeholder', 'options', 'children', 'action', 'variant', 'src', 'alt'],
    actions: '{command:string,args?:object} or {tool:string,args?:object}; tool must appear in pages[].tools (default []); {$field:"name"} replaces a whole argument value from bound form fields',
    image: 'data:image/png|jpeg|webp|gif;base64 only' },
  hooks: { permission: 'events.subscribe', args: 'Configured args plus host-owned event:{id,type,sessionId,payload,timestamp}; plugins cannot emit host events' },
  background: { permission: 'background.run', persistence: 'Engine-owned schedule; missed intervals coalesce to one run; quitting pauses until next engine start', minIntervalMs: 1000 },
  conditions: ['session', 'workspace', 'engineReady'],
  schema: PLUGIN_CONTRIBUTION_JSON_SCHEMA,
  webview: { entry: 'Package-relative self-contained .html file', bridge: [
    'context', 'call', 'models.list', 'ai.run', 'ai.stream', 'session.messages', 'skills.list', 'skills.get',
    'agents.list', 'agents.tools', 'agents.run', 'agents.stream', 'agents.status', 'agents.cancel', 'workspace.list', 'workspace.read', 'workspace.write',
    'knowledge.list', 'knowledge.search', 'knowledge.get', 'knowledge.create', 'knowledge.update', 'mcp.list', 'mcp.tools', 'mcp.call', 'settings.get', 'settings.set',
    'invoke', 'navigate', 'commands.execute', 'download', 'services.get', 'services.start', 'services.stop', 'services.refresh', 'services.subscribe',
    'ui.dialog', 'ui.notify', 'ui.clipboard.read', 'ui.clipboard.write', 'ui.editor.get', 'ui.editor.replaceSelection', 'ui.editor.reveal',
    'ui.composer.get', 'ui.composer.set', 'ui.composer.insert', 'ui.composer.submit', 'events.subscribe', 'events.unsubscribe',
  ],
    context: '{sessionId:string|null,workspacePath:string|null,engineReady:boolean,pluginId:string,revision:number}',
    invoke: { input: '(localToolName,args)', output: '{result,artifacts,stderr,stderrTruncated?,durationMs,plugin:{id,revision,hash}}', businessResult: 'response.result' },
    themeTokens: ['--bg-app', '--bg-surface', '--bg-elevated', '--bg-input', '--bg-hover', '--bg-active', '--fg', '--fg-strong', '--fg-muted', '--fg-faint', '--accent', '--accent-hover', '--accent-fg', '--accent-soft', '--border', '--border-strong'],
    download: { input: '{fileName:string,content:string,encoding?:"utf8"|"base64"}', output: '{saved:boolean,bytes?:number}', nativeSaveDialog: true }, network: false, hostIPC: false },
  services: { actions: ['tool', 'stopTool', 'statusTool'], result: { status: ['idle', 'running', 'waiting', 'completed', 'stopped', 'error'], detail: 'string', completesAt: 'optional Unix milliseconds; host notifies while the desktop is open' } },
} as const
