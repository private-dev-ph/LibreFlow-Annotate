const crypto = require('crypto');

function encryptionKey() {
  const source = process.env.AUTOMATION_SECRET_KEY || process.env.SESSION_SECRET || 'libreflow-dev-secret-change-in-production';
  return crypto.createHash('sha256').update(source).digest();
}

function encryptSecret(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

function decryptSecret(envelope) {
  if (!envelope) return '';
  if (typeof envelope === 'string') return envelope; // Legacy development records.
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(envelope.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function signPayload(secret, timestamp, serializedPayload) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${serializedPayload}`).digest('hex')}`;
}

module.exports = { encryptSecret, decryptSecret, signPayload };
