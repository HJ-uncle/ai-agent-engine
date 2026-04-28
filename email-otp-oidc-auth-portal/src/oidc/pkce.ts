import { createHash } from 'node:crypto'

export function codeChallengeS256(verifier: string) {
  const hash = createHash('sha256').update(verifier).digest()
  return base64UrlEncode(hash)
}

function base64UrlEncode(buf: Buffer) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

