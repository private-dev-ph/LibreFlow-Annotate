'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const SCRYPT_FORMAT = /^scrypt\$1\$([0-9a-f]{32})\$([0-9a-f]{128})$/;

async function hashPassword(password) {
  if (typeof password !== 'string') throw new TypeError('Password must be a string.');
  const salt = crypto.randomBytes(SALT_BYTES);
  const derivedKey = await scrypt(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$1$${salt.toString('hex')}$${Buffer.from(derivedKey).toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;

  const match = SCRYPT_FORMAT.exec(encoded);
  if (match && match[0] === encoded) {
    try {
      const salt = Buffer.from(match[1], 'hex');
      const expected = Buffer.from(match[2], 'hex');
      const actual = await scrypt(password, salt, KEY_BYTES, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAXMEM,
      });
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  // bcrypt truncates input after 72 bytes. Reject longer legacy inputs so
  // two distinct passwords cannot authenticate as the same old account.
  if (/^\$2[aby]?\$/.test(encoded) && Buffer.byteLength(password, 'utf8') <= 72) {
    try { return await bcrypt.compare(password, encoded); } catch { return false; }
  }
  return false;
}

module.exports = { hashPassword, verifyPassword };
