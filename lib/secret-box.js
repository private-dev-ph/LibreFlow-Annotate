const crypto = require('crypto');
const { loadSecurityConfig } = require('./security-config');

function encryptionKey(source) {
  if (!source) throw new Error('No automation encryption key is configured.');
  return crypto.createHash('sha256').update(source).digest();
}

function encryptSecret(value) {
  if (!value) return null;
  const config = loadSecurityConfig();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(config.automationKeys[config.automationKeyId]), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return {
    version: 2,
    keyId: config.automationKeyId,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

function decryptSecret(envelope) {
  if (!envelope) return '';
  const config = loadSecurityConfig();
  if (typeof envelope === 'string') {
    if (config.production) throw new Error('Plaintext legacy secrets are disabled in production; migrate them before startup.');
    return envelope;
  }
  let key;
  if (envelope.version === 2) {
    key = config.automationKeys[envelope.keyId];
    if (!key) throw new Error(`Automation encryption key ${envelope.keyId} is unavailable.`);
  } else if (envelope.version === 1) {
    if (!config.legacyAutomationKey) throw new Error('Legacy encrypted secrets require AUTOMATION_LEGACY_KEY for migration.');
    key = config.legacyAutomationKey;
  } else {
    throw new Error('Unsupported encrypted secret format.');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(key),
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
