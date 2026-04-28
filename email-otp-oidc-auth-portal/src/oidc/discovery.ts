import { env } from '../config.js'

export function openidConfiguration() {
  const base = env.ISSUER_URL.replace(/\/$/, '')
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    userinfo_endpoint: `${base}/userinfo`,
    jwks_uri: `${base}/jwks.json`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['openid', 'email', 'profile'],
    claims_supported: ['sub', 'email', 'email_verified']
  }
}

