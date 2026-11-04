(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PasswordPolicy = factory();
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const MIN_LENGTH = 8;
  const MAX_LENGTH = 72;
  const MESSAGE = 'Use 8–72 characters, including at least one number and one symbol (such as !, @ or #).';

  function validate(password) {
    if (typeof password !== 'string') return false;
    const length = Array.from(password).length;
    const hasNumber = /\p{Nd}/u.test(password);
    const hasSymbol = /[\p{P}\p{S}]/u.test(password);
    const valid = length >= MIN_LENGTH && length <= MAX_LENGTH && hasNumber && hasSymbol;
    return valid;
  }

  return { MIN_LENGTH, MAX_LENGTH, MESSAGE, codePointLength: value => Array.from(value).length, validate };
}));
