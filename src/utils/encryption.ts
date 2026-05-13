import crypto from 'node:crypto'

// Use a fixed key from environment variables.
// WARNING: If ENCRYPTION_KEY is not provided, we use a stable fallback for development
// to prevent data loss on every restart. In production, this MUST be set.
let ENCRYPTION_KEY_HEX = process.env.ENCRYPTION_KEY

if (!ENCRYPTION_KEY_HEX) {
  // Use a stable but insecure fallback for development to avoid "losing" keys on every restart.
  // This is better than crypto.randomBytes(32) which causes decryption failure after restart.
  ENCRYPTION_KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
  console.warn('\x1b[33m%s\x1b[0m', '⚠️  WARNING: ENCRYPTION_KEY is not set in .env! Using a default insecure key for development.')
  console.warn('\x1b[33m%s\x1b[0m', '   This will cause your API keys to be unstable if you change this key later.')
  console.warn('\x1b[33m%s\x1b[0m', '   Please set a 64-character hex string as ENCRYPTION_KEY in your .env file for production.\n')
}

const ENCRYPTION_KEY = Buffer.from(ENCRYPTION_KEY_HEX, 'hex')
const ALGORITHM = 'aes-256-gcm'

if (ENCRYPTION_KEY.length !== 32) {
  throw new Error('ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters)')
}

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(12) // GCM standard IV size
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv)
  
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')
  
  // Format: iv:authTag:encryptedText
  return `${iv.toString('hex')}:${authTag}:${encrypted}`
}

export function decrypt(encryptedData: string): string {
  const parts = encryptedData.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format')
  }
  
  const iv = Buffer.from(parts[0], 'hex')
  const authTag = Buffer.from(parts[1], 'hex')
  const encryptedText = parts[2]
  
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv)
  decipher.setAuthTag(authTag)
  
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  
  return decrypted
}
