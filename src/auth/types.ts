export interface AuthContext {
  tenantId: string
  userId?: string
  method: 'api-key' | 'jwt' | 'session' | 'none'
  sessionId?: string
  authenticatedAt?: number
  roles?: string[]
}

export interface AuthMiddleware {
  authenticate(request: { headers: Record<string, string | string[] | undefined> }): Promise<AuthContext>
}
