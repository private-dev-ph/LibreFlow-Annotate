'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const bcrypt = require('bcryptjs');
const PasswordPolicy = require('../public/js/password-policy.js');
const { hashPassword, verifyPassword } = require('../lib/passwords.js');

test('password policy uses code points and requires a number and symbol', () => {
  assert.equal(PasswordPolicy.validate('a'.repeat(6) + '1!'), true);
  assert.equal(PasswordPolicy.validate('a'.repeat(5) + '1!'), false);
  assert.equal(PasswordPolicy.validate('a'.repeat(70) + '1!'), true);
  assert.equal(PasswordPolicy.validate('a'.repeat(71) + '1!'), false);
  assert.equal(PasswordPolicy.validate('a'.repeat(7) + '!'), false);
  assert.equal(PasswordPolicy.validate('a'.repeat(7) + '1'), false);
  assert.equal(PasswordPolicy.validate('abcdef1 '), false);
  assert.equal(PasswordPolicy.validate('ééééééé1'), false);
});

test('browser and CommonJS policy implementations agree', () => {
  const source = fs.readFileSync(require.resolve('../public/js/password-policy.js'), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window, Array });
  assert.ok(window.PasswordPolicy);
  for (const password of ['a'.repeat(6) + '1!', 'a'.repeat(5) + '1!', '😀'.repeat(70) + '1!', 'abcdef1 ']) {
    assert.equal(window.PasswordPolicy.validate(password), PasswordPolicy.validate(password));
  }
});

test('scrypt hashes round-trip with random salts and reject wrong passwords', async () => {
  const password = 'é'.repeat(35) + '1!';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^scrypt\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password + 'x', first), false);
});

test('scrypt does not truncate passwords after 72 UTF-8 bytes', async () => {
  const first = 'a'.repeat(72) + 'x';
  const second = 'a'.repeat(72) + 'y';
  const hash = await hashPassword(first);
  assert.equal(await verifyPassword(first, hash), true);
  assert.equal(await verifyPassword(second, hash), false);
});

test('legacy bcrypt hashes remain compatible but reject overlong UTF-8 input', async () => {
  const password = 'old-pass';
  const hash = await bcrypt.hash(password, 4);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('wrong-pass', hash), false);

  const legacyPrefix = 'a'.repeat(71);
  const legacyHash = await bcrypt.hash(legacyPrefix + 'x', 4);
  assert.equal(await verifyPassword(legacyPrefix + 'x', legacyHash), true);
  assert.equal(await verifyPassword(legacyPrefix + 'y', legacyHash), false);
  assert.equal(await verifyPassword('😀'.repeat(19) + 'a', legacyHash), false);
});

test('malformed or unsupported password hashes return false', async () => {
  assert.equal(await verifyPassword('password', ''), false);
  assert.equal(await verifyPassword('password', 'scrypt$1$bad$hash'), false);
  assert.equal(await verifyPassword('password', 'argon2$1$bad'), false);
});
