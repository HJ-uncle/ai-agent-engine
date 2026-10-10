import type { Message, ToolResult } from '../agent-context/types.js'

type Performed = boolean | 'unknown'
const emptyOutput = (value: unknown): boolean => value == null ||
  typeof value === 'string' && ['', 'null', 'undefined'].includes(value.trim())

function reasonFor(result: ToolResult): string {
  if (typeof result.error === 'string' && result.error.trim()) return result.error.trim()
  if (!emptyOutput(result.output)) {
    try {
      const body: unknown = JSON.parse(result.output)
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const error = (body as Record<string, unknown>).error
        if (typeof error === 'string' && error.trim()) return error.trim()
      }
    } catch { /* A plain-language tool failure is already useful evidence. */ }
    return result.output
  }
  return '浏览器操作失败，客户端未返回具体原因；不能据此认定页面操作已完成。'
}

function classify(reason: string, metadata: ToolResult['metadata']): { code: string; operationPerformed: Performed } {
  const supplied = metadata?.operationPerformed
  const explicit = typeof supplied === 'boolean' || supplied === 'unknown' ? supplied : undefined
  let code = typeof metadata?.code === 'string' && /^BROWSER_[A-Z_]+$/.test(metadata.code)
    ? metadata.code : 'BROWSER_OPERATION_FAILED'
  let knownBeforeDispatch = false
  if (['浏览器标签已关闭，请重新打开', '浏览器标签已关闭，尚未执行页面操作'].includes(reason)) {
    code = 'BROWSER_TAB_CLOSED'; knownBeforeDispatch = true
  } else if ([
    '请先打开并显示这个浏览器标签，再进行页面操作',
    '目标浏览器标签未能显示，尚未执行页面操作；请关闭遮挡窗口或恢复编辑器后重试',
    '目标浏览器标签当前不可见，尚未执行页面操作；请重新显示目标页面后重试',
    '编辑器窗口已关闭，尚未执行页面操作',
    '编辑器窗口已最小化，尚未执行页面操作；请恢复窗口后重试',
    '编辑器窗口当前不可见，尚未执行页面操作；请显示窗口后重试',
  ].includes(reason)) {
    code = 'BROWSER_TAB_NOT_VISIBLE'; knownBeforeDispatch = true
  } else if (reason === '页面已经变化，请重新读取快照后操作') {
    code = 'BROWSER_STALE_NAVIGATION'; knownBeforeDispatch = true
  } else if (['BROWSER_INVALID_ARGUMENTS', 'BROWSER_UNKNOWN_ACTION', 'BROWSER_CLIENT_UNAVAILABLE',
    'BROWSER_QUEUE_FULL', 'BROWSER_VISION_UNAVAILABLE'].includes(code)) knownBeforeDispatch = true
  return { code, operationPerformed: explicit ?? (knownBeforeDispatch ? false : 'unknown') }
}

function recoveryFor(code: string, performed: Performed): string {
  if (code === 'BROWSER_NAVIGATION_FAILED') return '页面加载失败时标签可能已经创建。使用返回的 tabId，或先调用 browser_tabs 找到该标签，再用 browser_navigate 修正地址并读取快照；不要反复 browser_open 创建重复标签。'
  if (code === 'BROWSER_TAB_CLOSED') return '先调用 browser_tabs 重新取得当前会话的有效 tabId；目标已关闭时用 browser_open 打开原地址，再读取快照。不要猜 tabId 或复用旧 ref/navigationId。'
  if (code === 'BROWSER_TAB_NOT_VISIBLE') return '客户端会自动显示操作目标标签；请恢复 Aether 窗口、关闭遮挡弹窗，再用 browser_tabs 确认目标并重新读取快照。不要靠换坐标或修改项目网页解决浏览器可见性失败。'
  if (code === 'BROWSER_CLIENT_UNAVAILABLE' || code === 'BROWSER_CLIENT_DISCONNECTED') return '恢复 Aether 客户端连接并启用浏览器 AI 操作；用 browser_tabs 确认连接和有效标签，再读取实际页面状态。已交付的操作可能已生效，不要盲目重复提交。'
  if (code === 'BROWSER_STALE_NAVIGATION' || code === 'BROWSER_INVALID_ARGUMENTS') return '重新读取 browser_snapshot，使用返回的 tabId/navigationId/ref 修正参数；不要修改项目源码来掩盖工具调用失败。'
  if (performed !== false) return '执行状态不确定；先重新读取页面状态确认是否已经生效，不要盲目重复点击、填写或提交。工具失败本身不是网页缺陷证据。'
  return '修复上述工具或连接条件后重新读取页面状态，再决定下一步；不要把工具失败当作网页缺陷或已完成的交互。'
}

function failedTabIdentity(output: string): { tabId?: string; url?: string; navigationId?: number } {
  try {
    const body: unknown = JSON.parse(output)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
    const record = body as Record<string, unknown>
    const tabId = typeof record.tabId === 'string' && record.tabId.length > 0 && record.tabId.length <= 128 ? record.tabId : undefined
    if (!tabId) return {}
    const navigationId = typeof record.navigationId === 'number' && Number.isSafeInteger(record.navigationId) && record.navigationId >= 0 ? record.navigationId : undefined
    const url = typeof record.url === 'string' && JSON.stringify(record.url).length <= 2048 && /^https?:\/\//i.test(record.url) ? record.url : undefined
    return { tabId, ...(navigationId !== undefined ? { navigationId } : {}), ...(url ? { url } : {}) }
  } catch { return {} }
}

/** Browser errors belong in provider-visible content, not only UI-only metadata. */
export function normalizeBrowserFailure(result: ToolResult, action?: string, tabId?: unknown): ToolResult {
  if (result.success) return result
  const reason = reasonFor(result)
  const classified = classify(reason, result.metadata)
  const { operationPerformed } = classified
  const code = (action === 'open' || action === 'navigate') && classified.code === 'BROWSER_OPERATION_FAILED'
    ? 'BROWSER_NAVIGATION_FAILED' : classified.code
  const identity = failedTabIdentity(result.output)
  const payload = { success: false, error: reason.slice(0, 2800), code, operationPerformed,
    recovery: recoveryFor(code, operationPerformed), ...identity,
    ...(action ? { action } : {}), ...(typeof tabId === 'string' ? { tabId: tabId.slice(0, 128) } : {}) }
  // The ordinary 4K tool cap must not cut the failure JSON in half. Escape-heavy
  // exception text can expand when encoded, so bound the encoded representation.
  while (JSON.stringify(payload).length > 3800 && payload.error.length > 64) payload.error = payload.error.slice(0, Math.floor(payload.error.length * 0.7))
  return { ...result, output: JSON.stringify(payload), error: reason,
    metadata: { ...result.metadata, code, operationPerformed } }
}

export function isFailedBrowserMessage(message: Message): boolean {
  return message.role === 'tool' && typeof message.toolName === 'string' && message.toolName.startsWith('browser_') &&
    (message.metadata?.success === false || ['failed', 'cancelled', 'interrupted'].includes(message.metadata?.status))
}

/** Repair old null-only browser results when replaying, without rewriting archived UI evidence. */
export function legacyBrowserFailureContent(message: Message, content: Message['content']): string | undefined {
  if (!isFailedBrowserMessage(message) || !emptyOutput(content)) return undefined
  const metadata = message.metadata as Record<string, unknown>
  const error = typeof metadata.error === 'string' ? metadata.error : undefined
  return normalizeBrowserFailure({ success: false, output: typeof content === 'string' ? content : '', error, metadata },
    message.toolName!.slice('browser_'.length)).output
}
