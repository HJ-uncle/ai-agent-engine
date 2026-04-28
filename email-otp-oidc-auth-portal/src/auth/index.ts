import { env } from '../config.js'
import type { AuthAdapter } from './adapter.js'
import { createSupabaseAdapter } from './supabase.js'
import { createFakeAdapter } from './fake.js'

export function createAuthAdapter(): AuthAdapter {
  if (env.AUTH_PROVIDER === 'fake') return createFakeAdapter().adapter
  return createSupabaseAdapter()
}

