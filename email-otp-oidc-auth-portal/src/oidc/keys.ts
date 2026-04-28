import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from 'jose'
import { env } from '../config.js'

type StoredKeys = {
  kid: string
  privateJwk: JWK
  publicJwk: JWK
}

function keysPath() {
  return path.join(env.DATA_DIR, 'keys.json')
}

export async function loadOrCreateKeys(): Promise<StoredKeys> {
  const p = keysPath()
  if (fs.existsSync(p)) {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as StoredKeys
    return parsed
  }

  const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
  const publicJwk = await exportJWK(publicKey)
  const privateJwk = await exportJWK(privateKey)
  const kid = randomUUID()
  publicJwk.kid = kid
  publicJwk.use = 'sig'
  publicJwk.alg = 'RS256'
  privateJwk.kid = kid
  privateJwk.use = 'sig'
  privateJwk.alg = 'RS256'

  const stored: StoredKeys = { kid, publicJwk, privateJwk }
  fs.mkdirSync(env.DATA_DIR, { recursive: true })
  fs.writeFileSync(p, JSON.stringify(stored, null, 2))
  return stored
}

export async function createJwtSigner(stored: StoredKeys) {
  const privateKey = await importJWK(stored.privateJwk, 'RS256')
  return (claims: Record<string, unknown>, ttlSeconds: number, audience: string | string[]) => {
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: stored.kid, typ: 'JWT' })
      .setIssuer(env.ISSUER_URL)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .sign(privateKey)
  }
}

export function jwks(stored: StoredKeys) {
  return { keys: [stored.publicJwk] }
}
