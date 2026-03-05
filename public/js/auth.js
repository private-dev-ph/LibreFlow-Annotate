// auth.js – handles login/register form logic on the login page

(async () => {
  // If already logged in, go straight to dashboard
  try {
    const me = await fetch('/api/auth/me', { credentials: 'include' });
    if (me.ok) { window.location.href = '/dashboard'; return; }
  } catch {}

  const tabs      = document.querySelectorAll('.auth-tab');
  const formLogin = document.getElementById('form-login');
  const formReg   = document.getElementById('form-register');
  const errorDiv  = document.getElementById('auth-error');

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
      window.location.href = '/dashboard';
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

    if (password.length < 6) { showError('Password must be at least 6 characters.'); return; }

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
      window.location.href = '/dashboard';
    } catch {
      showError('Network error. Please try again.');
    } finally {
      setLoading(btn, false);
    }
  });
})();
