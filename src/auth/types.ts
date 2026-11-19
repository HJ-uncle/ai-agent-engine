export interface AuthContext {
  tenantId: string
  userId?: string
  method: 'api-key' | 'jwt' | 'session' | 'none'
  /** Set only after verifying a JWT whose tenantId claim explicitly names the default tenant. */
  readonly jwtDeclaresDefaultTenant?: true
  sessionId?: string
  authenticatedAt?: number
  roles?: string[]
}

export interface AuthMiddleware {
  authenticate(request: { headers: Record<string, string | string[] | undefined> }): Promise<AuthContext>
}
