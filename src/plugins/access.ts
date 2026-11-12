import type { AuthContext } from '../auth/types.js'
import { PluginError } from './types.js'

export function assertPluginManagementAccess(tenantId: string, principal?: Readonly<AuthContext>): void {
  if (principal && principal.tenantId !== tenantId) throw new PluginError('PLUGIN_FORBIDDEN', '插件身份与租户不匹配', 403)
  if (process.env.AUTH_ENABLED === 'false' && (!principal || principal.method === 'none' || principal.roles?.includes('tenant-admin'))) return
  if (principal?.method !== 'none' && principal?.roles?.some(role => role === 'admin' || role === 'plugin-manager')) return
  throw new PluginError('PLUGIN_FORBIDDEN', '插件管理需要 admin 或 plugin-manager 权限', 403)
}
