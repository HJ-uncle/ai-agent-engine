export interface AuthContext {
  tenantId: string
  userId?: string
  method: 'api-key' | 'jwt' | 'none'
  roles?: string[]
}

export interface AuthMiddleware {
  authenticate(request: { headers: Record<string, string | string[] | undefined> }): Promise<AuthContext>
}
