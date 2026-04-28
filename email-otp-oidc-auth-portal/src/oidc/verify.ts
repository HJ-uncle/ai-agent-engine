import { importJWK, jwtVerify } from 'jose'
import type { JWK } from 'jose'
import { env } from '../config.js'

export async function verifyAccessToken(token: string, publicJwk: JWK) {
  const key = await importJWK(publicJwk, 'RS256')
  const { payload } = await jwtVerify(token, key, { issuer: env.ISSUER_URL })
  return payload
}

