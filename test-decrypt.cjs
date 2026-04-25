const crypto = require('crypto');
const ENCRYPTION_KEY = Buffer.from('7c164e2ca4c04a320af328294b2a928779c5484149644beea753e4ffb36fa1fa', 'hex');
const encrypted = '7a2231b27b4af376619bc2d9:8cad871b81ecba2a1296ada1c00abdbb:edf37af1807d5c8c8ba98cae825bdcb6cb4aaaac71d419b2624899c6f3f81570a2a373';
const [ivHex, authTagHex, encryptedHex] = encrypted.split(':');
const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
let decrypted = decipher.update(Buffer.from(encryptedHex, 'hex'), undefined, 'utf8');
decrypted += decipher.final('utf8');
console.log(decrypted);
