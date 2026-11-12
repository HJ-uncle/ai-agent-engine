import { z } from 'zod'
import type { JSONSchema } from '../core/agent-context/types.js'

const id = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)
const tool = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)
const when = z.object({ session: z.boolean().optional(), workspace: z.boolean().optional(), engineReady: z.boolean().optional() }).strict()
const base = { id, title: z.string().trim().min(1).max(120), scope: z.enum(['global', 'session']).optional(), when: when.optional(), order: z.number().int().min(-1000).max(1000).optional() }
const page = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('tool'), tool: tool.optional() }).strict(),
  z.object({ ...base, kind: z.literal('webview'), entry: z.string().min(1).max(300), tools: z.array(tool).max(32) }).strict(),
])
const target = z.object({ ...base, page: id, icon: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional() }).strict()
export const pluginContributionsSchema = z.object({
  pages: z.array(page).max(16).optional(), navigation: z.array(target).max(16).optional(), workspaceTabs: z.array(target).max(16).optional(),
  services: z.array(z.object({ ...base, tool, stopTool: tool.optional(), statusTool: tool.optional(), page: id.optional(), args: z.record(z.unknown()).optional() }).strict()).max(16).optional(),
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
/** Advertised to AI tools as well as template clients; runtime validation remains the strict Zod contract above. */
export const PLUGIN_CONTRIBUTION_JSON_SCHEMA: JSONSchema = {
  type: 'object', additionalProperties: false, properties: {
    pages: { type: 'array', maxItems: 16, items: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['id', 'title', 'kind'], properties: { ...baseProperties, kind: { type: 'string', enum: ['tool'] }, tool: toolProperty } },
      { type: 'object', additionalProperties: false, required: ['id', 'title', 'kind', 'entry', 'tools'], properties: { ...baseProperties, kind: { type: 'string', enum: ['webview'] }, entry: { type: 'string', minLength: 1, maxLength: 300 }, tools: { type: 'array', maxItems: 32, items: toolProperty } } },
    ] } },
    navigation: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'page'], properties: targetProperties } },
    workspaceTabs: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'page'], properties: targetProperties } },
    services: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'tool'], properties: { ...baseProperties, tool: toolProperty, stopTool: toolProperty, statusTool: toolProperty, page: idProperty, args: { type: 'object', additionalProperties: true } } } },
  },
}

/** This metadata is returned beside templates, so authors and editors use the validated capability vocabulary. */
export const PLUGIN_CONTRIBUTION_CATALOGUE = {
  apiVersion: 1,
  fields: ['pages', 'navigation', 'workspaceTabs', 'services'],
  renderers: ['tool', 'webview'], scopes: ['global', 'session'],
  conditions: ['session', 'workspace', 'engineReady'],
  schema: PLUGIN_CONTRIBUTION_JSON_SCHEMA,
  webview: { entry: 'Package-relative self-contained .html file', bridge: ['context', 'invoke', 'navigate', 'download', 'service.start', 'service.stop', 'service.status', 'service.get'],
    context: '{sessionId:string|null,workspacePath:string|null,engineReady:boolean,pluginId:string,revision:number}',
    invoke: { input: '(localToolName,args)', output: '{result,artifacts,stderr,durationMs,plugin:{id,revision,hash}}', businessResult: 'response.result' },
    themeTokens: ['--bg-app', '--bg-surface', '--bg-elevated', '--bg-input', '--bg-hover', '--bg-active', '--fg', '--fg-strong', '--fg-muted', '--fg-faint', '--accent', '--accent-hover', '--accent-fg', '--accent-soft', '--border', '--border-strong'],
    download: { input: '{fileName:string,content:string,encoding?:"utf8"|"base64"}', output: '{saved:boolean,bytes?:number}', maxBytes: 16777216, nativeSaveDialog: true }, network: false, hostIPC: false },
  services: { actions: ['tool', 'stopTool', 'statusTool'], result: { status: ['idle', 'running', 'waiting', 'completed', 'stopped', 'error'], detail: 'string', completesAt: 'optional Unix milliseconds; host notifies while the desktop is open' } },
} as const
