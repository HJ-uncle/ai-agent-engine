type Listener = (change: { root: string; tenantId: string; pluginId: string }) => void
const listeners = new Set<Listener>()
export function onPluginChanged(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function notifyPluginChanged(root: string, tenantId: string, pluginId: string): void {
  for (const listener of listeners) listener({ root, tenantId, pluginId })
}
