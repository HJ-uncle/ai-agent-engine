import { createClient } from '@supabase/supabase-js'
import { env } from '../config.js'
import type { AuthAdapter, VerifiedUser } from './adapter.js'

function normalizeSupabaseUrl(url: string) {
  return url.replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/g, '')
}

export function createSupabaseAdapter(): AuthAdapter {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required when AUTH_PROVIDER=supabase')
  }

  const supabase = createClient(normalizeSupabaseUrl(env.SUPABASE_URL), env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  })

  return {
    async sendEmailOtp(email: string) {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { 
          shouldCreateUser: true
        }
      })
      if (error) throw error
    },

    async verifyEmailOtp(email: string, token: string): Promise<VerifiedUser> {
      const { data, error } = await supabase.auth.verifyOtp({
        email,
        token,
        type: 'email'
      })
      if (error) throw error
      if (!data.user?.id || !data.user.email) throw new Error('Missing user in verifyOtp response')
      return { sub: data.user.id, email: data.user.email }
    }
  }
}
