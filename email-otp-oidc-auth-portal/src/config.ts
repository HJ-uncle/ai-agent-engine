import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  ISSUER_URL: z.string().url().default('http://localhost:3000'),
  DATA_DIR: z.string().default('./data'),
  SESSION_TTL_SECONDS: z.coerce.number().default(60 * 60 * 12),
  AUTH_CODE_TTL_SECONDS: z.coerce.number().default(60 * 5),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(60 * 15),
  ID_TOKEN_TTL_SECONDS: z.coerce.number().default(60 * 15),
  ADMIN_TOKEN: z.string().min(16).optional(),
  AUTH_PROVIDER: z.enum(['supabase', 'fake']).default('supabase'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional()
})

export const env = envSchema.parse(process.env)

