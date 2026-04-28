import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthState {
  accessToken: string | null
  idToken: string | null
  expiresAt: number | null
  email: string | null
  isLoggedIn: boolean
  authError?: string

  login: (tokens: { accessToken: string; idToken: string; expiresAt: number; email?: string }) => void
  loginWithCode: (code: string, state?: string) => Promise<void>
  logout: () => void
  checkTokenExpiry: () => boolean
  setAuthError: (message?: string) => void
}

// 防止无限循环的标志
let isLoggingOut = false

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      idToken: null,
      expiresAt: null,
      email: null,
      isLoggedIn: false,
      authError: undefined,

      login: (tokens) => {
        set({
          accessToken: tokens.accessToken,
          idToken: tokens.idToken,
          expiresAt: tokens.expiresAt,
          email: tokens.email || null,
          isLoggedIn: true,
          authError: undefined,
        })
        isLoggingOut = false
      },

      loginWithCode: async (code, state) => {
        const OIDC_ISSUER_URL = process.env.REACT_APP_OIDC_ISSUER_URL ?? 'http://localhost:3000'
        const REDIRECT_URI = window.location.origin + '/callback'
        const CLIENT_ID = process.env.REACT_APP_OIDC_CLIENT_ID || 'multi-agent-console'

        const codeVerifier = localStorage.getItem('pkce_code_verifier') || ('dev-challenge-' + Date.now())
        localStorage.removeItem('pkce_code_verifier')

        const params = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code,
          code_verifier: codeVerifier,
        })

        const response = await fetch(`${OIDC_ISSUER_URL}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params,
        })

        if (!response.ok) {
          throw new Error('获取 token 失败')
        }

        const data = await response.json()
        const expiresAt = Date.now() + (data.expires_in * 1000)
        
        let email = null
        if (data.id_token) {
          const payload = data.id_token.split('.')[1]
          const decoded = JSON.parse(atob(payload))
          email = decoded.email || null
        }

        get().login({
          accessToken: data.access_token,
          idToken: data.id_token,
          expiresAt,
          email,
        })
      },

      logout: () => {
        if (isLoggingOut) return
        isLoggingOut = true
        set({
          accessToken: null,
          idToken: null,
          expiresAt: null,
          email: null,
          isLoggedIn: false,
          authError: undefined,
        })
        // 延迟重置标志，防止立即重复调用
        setTimeout(() => {
          isLoggingOut = false
        }, 1000)
      },

      checkTokenExpiry: () => {
        const { expiresAt } = get()
        if (!expiresAt) return false
        return Date.now() < expiresAt
      },

      setAuthError: (message) => {
        set({ authError: message })
      },
    }),
    {
      name: 'mac-auth-store',
      partialize: (state) => ({
        accessToken: state.accessToken,
        idToken: state.idToken,
        expiresAt: state.expiresAt,
        email: state.email,
        isLoggedIn: state.isLoggedIn,
      }),
    },
  ),
)