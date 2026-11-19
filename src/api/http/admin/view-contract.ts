/** Browser-side extension contract. A page script runs in the credential-owning closure only through this scoped API.
 * Export ADMIN_RULES_JS from ./rules-ui.ts as String.raw`registerAdminPage('rules', async ({ body, actions, api, can, reload, signal, confirm, announce }) => { ... });`.
 * api('rules', {method:'POST', body:{...}}) addresses /admin/rules, returns JSON envelope.data or throws Error with status/code.
 * body/actions are fresh, detached on navigation; signal aborts on refresh, navigation or disconnect. No secrets are passed into view code.
 * confirm({title, description, confirmLabel, danger}) => Promise<boolean>; reload() refreshes the current view; can('rules.manage') checks server-issued capabilities.
 */
export interface AdminViewContext {
  body: HTMLElement
  actions: HTMLElement
  api: (path: string, options?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal }) => Promise<unknown>
  can: (permission: string) => boolean
  reload: () => Promise<void>
  signal: AbortSignal
  confirm: (options: { title: string; description: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>
  announce: (text: string) => void
}