// Headless OS-credential bridge. Its stdout is consumed privately by the runner.
const { app, safeStorage } = require('electron')
const { createDecipheriv } = require('node:crypto')
app.setPath('userData', process.env.PLUGIN_CREDENTIAL_PROFILE)
app.whenReady().then(() => {
  const input = JSON.parse(process.env.PLUGIN_CREDENTIAL_INPUT)
  delete process.env.PLUGIN_CREDENTIAL_INPUT
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable')
  const key = input.keyRecord.encrypted ? safeStorage.decryptString(Buffer.from(input.keyRecord.encryptionKey, 'base64')) : input.keyRecord.encryptionKey
  const [iv, tag, data] = input.encryptedApiKey.split(':')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  const apiKey = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8')
  const testKey = input.encryptedTestKey ? safeStorage.decryptString(Buffer.from(input.encryptedTestKey, 'base64')) : input.testKey
  process.stdout.write('PLUGIN_CREDENTIAL_RESULT:' + JSON.stringify({ apiKey, testKey, encryptedTestKey: safeStorage.encryptString(testKey).toString('base64') }) + '\n', () => app.exit(0))
}).catch(() => { process.stderr.write('Read-only OS credential bridge failed\n'); app.exit(1) })
