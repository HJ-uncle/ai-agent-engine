// The public exceptions are fixed, inert documents. Keep all /admin data routes behind both gates.
export const adminShell = { redirect: '/admin', page: '/admin/', script: '/admin/app.js', style: '/admin/app.css' } as const
const publicPaths = new Set<string>(Object.values(adminShell))

export function isPublicAdminShell(method: string, pathname: string): boolean {
  return (method === 'GET' || method === 'HEAD') && publicPaths.has(pathname)
}

export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/')
}

export const adminHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}
