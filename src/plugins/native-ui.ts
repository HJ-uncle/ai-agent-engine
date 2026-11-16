import { z } from 'zod'
import { PluginError } from './types.js'

const action = z.union([
  z.object({ command: z.string().min(1).max(48), args: z.record(z.unknown()).optional() }).strict(),
  z.object({ tool: z.string().min(1).max(32), args: z.record(z.unknown()).optional() }).strict(),
])
const node = z.object({
  type: z.enum(['text', 'heading', 'stack', 'row', 'divider', 'button', 'input', 'textarea', 'select', 'checkbox', 'card', 'image', 'markdown']),
  id: z.string().min(1).max(80).optional(), text: z.string().optional(), label: z.string().optional(),
  value: z.union([z.string(), z.number().finite(), z.boolean()]).optional(), bind: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/).refine(value => !['constructor', 'prototype'].includes(value)).optional(),
  placeholder: z.string().optional(), options: z.array(z.object({ label: z.string(), value: z.string() }).strict()).optional(),
  children: z.array(z.unknown()).optional(), action: action.optional(), variant: z.enum(['primary', 'secondary', 'danger']).optional(),
  src: z.string().regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/).optional(), alt: z.string().optional(),
}).strict()
/** Validate each node iteratively, so deeper documents do not exhaust the validator stack. */
export function validateNativePluginDocument(source: string, tools: ReadonlySet<string>, commands: ReadonlySet<string>): void {
  let value: unknown
  try { value = JSON.parse(source) } catch { throw new PluginError('PLUGIN_MANIFEST', 'native 页面需要有效 JSON') }
  const document = z.object({ version: z.literal(1), root: z.unknown() }).strict().safeParse(value)
  if (!document.success) throw new PluginError('PLUGIN_MANIFEST', 'native 页面需要 version:1 和 root 组件')
  const queue: unknown[] = [document.data.root], argumentsQueue: unknown[] = [], binds = new Set<string>()
  while (queue.length) {
    const parsed = node.safeParse(queue.pop())
    if (!parsed.success) throw new PluginError('PLUGIN_MANIFEST', 'native 页面组件或属性不受支持：' + parsed.error.issues[0]?.path.join('.'))
    const current = parsed.data
    if (current.bind) {
      if (binds.has(current.bind)) throw new PluginError('PLUGIN_MANIFEST', 'native 页面表单字段标识重复')
      binds.add(current.bind)
    }
    if (current.action) {
      if ('tool' in current.action && !tools.has(current.action.tool)) throw new PluginError('PLUGIN_MANIFEST', 'native 页面引用了未声明的工具')
      if ('command' in current.action && !commands.has(current.action.command)) throw new PluginError('PLUGIN_MANIFEST', 'native 页面引用了不存在的命令')
      if (current.action.args) argumentsQueue.push(current.action.args)
    }
    for (const child of current.children ?? []) queue.push(child)
  }
  while (argumentsQueue.length) {
    const current = argumentsQueue.pop()
    if (current && typeof current === 'object') for (const [key, child] of Object.entries(current)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new PluginError('PLUGIN_MANIFEST', 'native 动作参数包含保留字段')
      argumentsQueue.push(child)
    }
  }
}
