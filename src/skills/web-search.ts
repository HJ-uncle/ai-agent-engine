import type { Tool, AgentContext, ToolResult } from '../core/agent-context/index.js'

const BRIDGE_URL = process.env.WEB_SEARCH_SERVER ?? 'http://127.0.0.1:8923'

// 缓存 connectionId，跨请求复用浏览器连接
let cachedConnectionId: string | null = null

async function ensureConnection(): Promise<string> {
  // 如果有缓存的连接，先验证是否还有效
  if (cachedConnectionId) {
    try {
      const res = await fetch(`${BRIDGE_URL}/api/page/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: cachedConnectionId }),
        signal: AbortSignal.timeout(3000),
      })
      const data = await res.json() as { success: boolean }
      if (data.success) return cachedConnectionId
    } catch {
      // 连接失效，重新建立
    }
    cachedConnectionId = null
  }

  // 启动浏览器
  await fetch(`${BRIDGE_URL}/api/browser/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10000),
  })

  // 建立连接
  const connectRes = await fetch(`${BRIDGE_URL}/api/browser/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10000),
  })
  const connectData = await connectRes.json() as { success: boolean; connectionId: string }
  if (!connectData.success) throw new Error('Failed to connect to browser')

  cachedConnectionId = connectData.connectionId
  return cachedConnectionId
}
