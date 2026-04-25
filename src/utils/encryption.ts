import crypto from 'node:crypto'

// Use a fixed key from environment variables, or generate a random one if not provided (for development).
// In production, this should be managed by a KMS (Key Management Service).
const ENCRYPTION_KEY_HEX = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex')
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
