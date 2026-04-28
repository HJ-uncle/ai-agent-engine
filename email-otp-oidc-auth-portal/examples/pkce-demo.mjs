import { createHash, randomBytes } from 'node:crypto'

function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const verifier = base64Url(randomBytes(32))
const challenge = base64Url(createHash('sha256').update(verifier).digest())

const issuer = process.env.ISSUER_URL ?? 'http://localhost:3000'
const clientId = process.env.CLIENT_ID ?? 'your-client-id'
const redirectUri = process.env.REDIRECT_URI ?? 'http://localhost:4000/callback'
const state = base64Url(randomBytes(16))

const authorizeUrl = new URL(`${issuer.replace(/\/$/, '')}/authorize`)
authorizeUrl.searchParams.set('response_type', 'code')
authorizeUrl.searchParams.set('client_id', clientId)
authorizeUrl.searchParams.set('redirect_uri', redirectUri)
authorizeUrl.searchParams.set('scope', 'openid email')
authorizeUrl.searchParams.set('state', state)
authorizeUrl.searchParams.set('code_challenge', challenge)
authorizeUrl.searchParams.set('code_challenge_method', 'S256')

process.stdout.write(`authorize_url=${authorizeUrl.toString()}\n`)
process.stdout.write(`code_verifier=${verifier}\n`)

