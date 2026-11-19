/** A management credential is never a business API key or bearer, even in anonymous business mode. */
export const ADMIN_HEADER = 'x-aether-admin-key'
export const ADMIN_KEY_PREFIX = 'aether_admin_'
export const isAdminKey = (value: unknown): value is string => typeof value === 'string' && /^aether_admin_[A-Za-z0-9_-]{43}$/.test(value)

type Header = string | string[] | undefined
const reservedKey = (value: string) => value.startsWith(ADMIN_KEY_PREFIX)
const reservedAuthorization = (value: string) => reservedKey(value) || /^Bearer[ \t]+aether_admin_/i.test(value)
const matches = (value: Header, check: (s: string) => boolean) => typeof value === 'string' ? check(value) : Array.isArray(value) && value.some(check)
/** Reject accidental scope mixing even on public/anonymous workload routes and when another valid credential is present. */
export function adminKeyInWorkloadHeaders(headers: Record<string, Header>): boolean {
  return matches(headers['x-api-key'],reservedKey) || matches(headers.authorization,reservedAuthorization)
}
