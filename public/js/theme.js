// theme.js - shared LibreFlow appearance settings

(function initThemeSettings() {
  const STORAGE_KEY = 'libreflow_theme';
  const MODE_KEY = 'libreflow_theme_mode';
  const themes = [
    {
      id: 'rose-navy',
      name: 'Rose & Navy',
      description: 'Soft coral surfaces with confident navy contrast.',
      colors: ['#EDC7B7', '#EEE2DC', '#BAB2B5', '#123C69', '#AC3B61'],
    },
    {
      id: 'clay-coral',
      name: 'Clay & Coral',
      description: 'Warm neutrals with a focused coral signal.',
      colors: ['#EAE7DC', '#D8C3A5', '#8E8D8A', '#E98074', '#E85A4F'],
    },
    {
      id: 'mint-sun',
      name: 'Mint & Sun',
      description: 'Clear teal structure with optimistic yellow accents.',
      colors: ['#026670', '#9FEDD7', '#FEF9C7', '#FCE181', '#EDEAE5'],
    },
    {
      id: 'purple-pop',
      name: 'Purple Pop',
      description: 'Playful purple, yellow, coral, cream, and electric teal.',
      colors: ['#A64AC9', '#FCCD04', '#FFB48F', '#F5E6CC', '#17E9E0'],
    },
  ];

  const root = document.documentElement;
  const button = document.getElementById('btn-theme-settings');

  const getTheme = id => themes.find(theme => theme.id === id) || themes[0];
  const savedTheme = localStorage.getItem(STORAGE_KEY);
  let activeTheme = getTheme(savedTheme || 'clay-coral');
  if (savedTheme && !themes.some(theme => theme.id === savedTheme)) {
    localStorage.setItem(STORAGE_KEY, activeTheme.id);
  }
  let activeMode = localStorage.getItem(MODE_KEY) === 'dark' ? 'dark' : 'light';

  function applyTheme(theme, persist = true) {
    activeTheme = getTheme(theme.id || theme);
    root.dataset.theme = activeTheme.id;
    if (persist) localStorage.setItem(STORAGE_KEY, activeTheme.id);
    updateThemeControls();
  }

  function applyMode(mode, persist = true) {
    activeMode = mode === 'dark' ? 'dark' : 'light';
    root.dataset.mode = activeMode;
    if (persist) localStorage.setItem(MODE_KEY, activeMode);
    updateThemeControls();
  }

  function updateThemeControls() {
    button?.setAttribute('aria-label', `Theme settings: ${activeTheme.name}, ${activeMode} mode`);
    button?.setAttribute('title', `${activeTheme.name} · ${activeMode} mode`);
    const modeToggle = document.getElementById('theme-mode-toggle');
    if (modeToggle) {
      modeToggle.setAttribute('aria-checked', String(activeMode === 'dark'));
      modeToggle.dataset.mode = activeMode;
      modeToggle.querySelector('.theme-mode-knob')?.setAttribute('aria-label', `${activeMode} mode`);
    }
    document.querySelectorAll('.theme-option').forEach(option => {
      const selected = option.dataset.theme === activeTheme.id;
      option.classList.toggle('active', selected);
      option.setAttribute('aria-checked', String(selected));
    });
  }

  // Pages without authenticated navigation still inherit the saved palette.
  if (!button) {
    applyTheme(activeTheme, false);
    applyMode(activeMode, false);
    return;
  }

  function buildModal() {
    const modal = document.createElement('div');
    modal.id = 'theme-modal';
    modal.className = 'theme-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'theme-modal-title');
    modal.innerHTML = `
      <section class="theme-panel">
        <div class="theme-panel-header">
          <div>
            <h2 id="theme-modal-title">Appearance</h2>
            <p>Choose a palette, then switch between light and dark mode.</p>
          </div>
          <button class="theme-close" type="button" aria-label="Close theme settings">×</button>
        </div>
        <div class="theme-mode-row">
          <span class="theme-mode-caption">Light</span>
          <button class="theme-mode-toggle" id="theme-mode-toggle" type="button" role="switch" aria-label="Toggle dark mode" aria-checked="false">
            <span class="theme-mode-track" aria-hidden="true"><span class="theme-mode-knob"></span></span>
          </button>
          <span class="theme-mode-caption">Dark</span>
        </div>
        <div class="theme-options" role="radiogroup" aria-label="Color themes">
          ${themes.map(theme => `
            <button class="theme-option" type="button" role="radio" data-theme="${theme.id}" aria-label="${theme.name}">
              <span class="theme-swatches" aria-hidden="true">
                ${theme.colors.map(color => `<span class="theme-swatch" style="background:${color}"></span>`).join('')}
              </span>
              <span class="theme-option-name">${theme.name}</span>
              <span class="theme-option-desc">${theme.description}</span>
              <span class="theme-option-hex">${theme.colors.join(' · ')}</span>
              <span class="theme-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></span>
            </button>
          `).join('')}
        </div>
        <div class="theme-panel-footer">Your selection is saved in this browser.</div>
      </section>
    `;
    document.body.appendChild(modal);
    return modal;
  }

  const modal = buildModal();
  const closeButton = modal.querySelector('.theme-close');
  const modeToggle = modal.querySelector('#theme-mode-toggle');

  function closeModal() {
    modal.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
  }

  function openModal() {
    modal.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    modal.querySelector(`.theme-option[data-theme="${activeTheme.id}"]`)?.focus();
  }

  button.addEventListener('click', () => {
    if (modal.classList.contains('hidden')) openModal();
    else closeModal();
  });
  closeButton.addEventListener('click', closeModal);
  modeToggle.addEventListener('click', () => applyMode(activeMode === 'dark' ? 'light' : 'dark'));
  modal.addEventListener('click', event => {
    if (event.target === modal) closeModal();
    const option = event.target.closest('.theme-option');
    if (option) applyTheme(option.dataset.theme);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });

  applyTheme(activeTheme, false);
  applyMode(activeMode, false);
})();
