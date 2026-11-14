// auth.js – handles login/register form logic on the login page

(async () => {
  const requestedReturn = new URLSearchParams(window.location.search).get('returnTo');
  const returnTo = /^\/ai-authorize\/[A-Za-z0-9_-]{1,128}$/.test(requestedReturn || '') ? requestedReturn : '/dashboard';
  // If already logged in, go straight to dashboard
  try {
    const me = await fetch('/api/auth/me', { credentials: 'include' });
    if (me.ok) { window.location.href = returnTo; return; }
  } catch {}

  const tabs      = document.querySelectorAll('.auth-tab');
  const formLogin = document.getElementById('form-login');
  const formReg   = document.getElementById('form-register');
  const errorDiv  = document.getElementById('auth-error');
  const regPassword = document.getElementById('reg-password');
  const regPasswordGuidance = document.getElementById('reg-password-guidance');
  const regPasswordError = document.getElementById('reg-password-error');
  const passwordPolicy = window.PasswordPolicy;
  const passwordMessage = passwordPolicy?.MESSAGE || 'Use 8–72 characters, including at least one number and one symbol (such as !, @ or #).';

  regPasswordGuidance.textContent = passwordMessage;

  // ── Tab switching ──────────────────────────────────────────────────────────
  function switchTab(name) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    formLogin.classList.toggle('hidden', name !== 'login');
    formReg.classList.toggle('hidden', name !== 'register');
    errorDiv.classList.add('hidden');
  }

  tabs.forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  document.querySelectorAll('[data-switch]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); switchTab(a.dataset.switch); });
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function showError(msg) {
    errorDiv.textContent = msg;
    errorDiv.classList.remove('hidden');
  }

  function setLoading(btn, loading) {
    btn.disabled = loading;
    btn.querySelector('.btn-label').classList.toggle('hidden', loading);
    btn.querySelector('.btn-spinner').classList.toggle('hidden', !loading);
  }

  function clearPasswordValidation() {
    regPassword.removeAttribute('aria-invalid');
    regPasswordGuidance.classList.remove('hidden');
    regPasswordError.textContent = '';
    regPasswordError.classList.add('hidden');
  }

  function validateRegistrationPassword({ focus = false } = {}) {
    const valid = passwordPolicy?.validate?.(regPassword.value) === true;
    if (valid) {
      clearPasswordValidation();
      return true;
    }

    regPassword.setAttribute('aria-invalid', 'true');
    regPasswordGuidance.classList.add('hidden');
    regPasswordError.textContent = passwordMessage;
    regPasswordError.classList.remove('hidden');
    if (focus) regPassword.focus();
    return false;
  }

  regPassword.addEventListener('blur', () => {
    if (regPassword.value) validateRegistrationPassword();
  });
  regPassword.addEventListener('input', () => {
    if (regPassword.getAttribute('aria-invalid') === 'true' && passwordPolicy?.validate?.(regPassword.value)) {
      clearPasswordValidation();
    }
  });

  // ── Login ──────────────────────────────────────────────────────────────────
  formLogin.addEventListener('submit', async e => {
    e.preventDefault();
    errorDiv.classList.add('hidden');
    const btn = document.getElementById('btn-login');
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    setLoading(btn, true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Login failed.'); return; }
      window.location.href = returnTo;
    } catch {
      showError('Network error. Please try again.');
    } finally {
      setLoading(btn, false);
    }
  });

  // ── Register ───────────────────────────────────────────────────────────────
  formReg.addEventListener('submit', async e => {
    e.preventDefault();
    errorDiv.classList.add('hidden');
    const btn      = document.getElementById('btn-register');
    const username = document.getElementById('reg-username').value.trim();
    const email    = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;

    if (!validateRegistrationPassword({ focus: true })) return;

    setLoading(btn, true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, email, password }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Registration failed.'); return; }
      window.location.href = returnTo;
    } catch {
      showError('Network error. Please try again.');
    } finally {
      setLoading(btn, false);
    }
  });
})();
