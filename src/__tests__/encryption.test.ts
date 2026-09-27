import { describe, it, expect } from 'vitest'
import { encrypt, decrypt } from '../utils/encryption.js'

describe('Encryption Utils', () => {
  it('should encrypt and decrypt a string correctly', () => {
    const plainText = 'sk-1234567890abcdef'
    const cipherText = encrypt(plainText)
    
    expect(cipherText).not.toBe(plainText)
    expect(cipherText).toContain(':') // Should have iv and auth tag

    const decrypted = decrypt(cipherText)
    expect(decrypted).toBe(plainText)
  })

  it('should throw error for invalid encrypted data', () => {
    expect(() => decrypt('invalid:format')).toThrow()
  })
})