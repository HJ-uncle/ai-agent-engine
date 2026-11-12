// Headless Electron bridge: secrets travel only through private parent/child pipes.
const { app, safeStorage } = require('electron')
const { createDecipheriv } = require('node:crypto')
app.setPath('userData', process.env.PLUGIN_CREDENTIAL_PROFILE)
let phase = 'ready'
app.whenReady().then(async () => {
  const input = JSON.parse(process.env.PLUGIN_CREDENTIAL_INPUT || '{}')
  delete process.env.PLUGIN_CREDENTIAL_INPUT
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption unavailable')
  phase = 'decrypt OS-protected engine key'
  const key = input.keyRecord.encrypted ? safeStorage.decryptString(Buffer.from(input.keyRecord.encryptionKey, 'base64')) : input.keyRecord.encryptionKey
  phase = 'decrypt configured API key'
  const [iv, tag, data] = input.encryptedApiKey.split(':')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  const apiKey = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8')
  process.stdout.write('PLUGIN_CREDENTIAL_RESULT:' + JSON.stringify({ apiKey, encryptedTestKey: safeStorage.encryptString(input.testKey).toString('base64') }) + '\n', () => app.exit(0))
}).catch(error => { process.stderr.write(`Credential bridge ${phase}: ${error.message}\n`); app.exit(1) })
