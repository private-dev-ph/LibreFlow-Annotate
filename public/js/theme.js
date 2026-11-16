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
  const renderIcon = (name, label = '') => window.LibreFlowIcons?.icon(name, label) || '';

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
          <button class="theme-close" type="button" aria-label="Close theme settings">${renderIcon('close')}</button>
        </div>
        <div class="theme-mode-row">
          <span class="theme-mode-caption">${renderIcon('sun')}<span>Light</span></span>
          <button class="theme-mode-toggle" id="theme-mode-toggle" type="button" role="switch" aria-label="Toggle dark mode" aria-checked="false">
            <span class="theme-mode-track" aria-hidden="true"><span class="theme-mode-knob"></span></span>
          </button>
          <span class="theme-mode-caption">${renderIcon('moon')}<span>Dark</span></span>
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
              <span class="theme-check" aria-hidden="true">${renderIcon('check')}</span>
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
    const mobileMenuToggle = document.getElementById('mobile-nav-toggle');
    const compactMenuClosed = mobileMenuToggle
      && window.matchMedia('(max-width: 1000px)').matches
      && mobileMenuToggle.getAttribute('aria-expanded') !== 'true';
    (compactMenuClosed ? mobileMenuToggle : button).focus();
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

// Responsive navigation keeps the authenticated controls and their existing
// listeners intact while presenting one compact, branded header on small
// screens. This is intentionally outside the theme IIFE so pages without a
// theme control (including login) can safely use the guard below.
(function initResponsiveNavigation() {
  const nav = document.getElementById('top-nav');
  const navLeft = nav?.querySelector('.nav-left');
  const navLinks = nav?.querySelector('.nav-links');
  const navRight = nav?.querySelector('.nav-right');
  if (!nav || !navLeft || !navLinks || !navRight) return;

  const mobileQuery = window.matchMedia('(max-width: 1000px)');
  const renderIcon = name => window.LibreFlowIcons?.icon(name) || '';
  const menuButton = document.createElement('button');
  menuButton.id = 'mobile-nav-toggle';
  menuButton.className = 'mobile-nav-toggle';
  menuButton.type = 'button';
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-controls', 'mobile-nav-panel');
  menuButton.innerHTML = `${renderIcon('list')}<span>Menu</span>`;

  const panel = document.createElement('div');
  panel.id = 'mobile-nav-panel';
  panel.className = 'mobile-nav-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Mobile navigation');

  const primarySection = document.createElement('section');
  primarySection.className = 'mobile-nav-section mobile-nav-primary';
  primarySection.setAttribute('aria-labelledby', 'mobile-nav-primary-title');
  primarySection.innerHTML = '<h2 id="mobile-nav-primary-title" class="mobile-nav-section-title">Workspace</h2>';
  primarySection.append(navLinks);

  const accountSection = document.createElement('section');
  accountSection.className = 'mobile-nav-section mobile-nav-account';
  accountSection.setAttribute('aria-labelledby', 'mobile-nav-account-title');
  accountSection.innerHTML = '<h2 id="mobile-nav-account-title" class="mobile-nav-section-title">Account</h2>';
  accountSection.append(navRight);
  panel.append(primarySection, accountSection);

  navLeft.append(menuButton);
  nav.append(panel);

  let mobileLayout = false;
  let panelOpen = false;

  function setPanelVisibility(open, { restoreFocus = false } = {}) {
    panelOpen = Boolean(open && mobileLayout);
    panel.hidden = !panelOpen;
    panel.toggleAttribute('inert', !panelOpen);
    panel.setAttribute('aria-hidden', String(!panelOpen));
    menuButton.setAttribute('aria-expanded', String(panelOpen));
    menuButton.setAttribute('aria-label', panelOpen ? 'Close menu' : 'Open menu');
    menuButton.title = panelOpen ? 'Close menu' : 'Open menu';
    menuButton.classList.toggle('is-open', panelOpen);
    if (restoreFocus) menuButton.focus();
  }

  function restoreDesktopLayout() {
    setPanelVisibility(false);
    navLeft.insertBefore(navLinks, menuButton);
    nav.append(navRight);
    mobileLayout = false;
  }

  function applyResponsiveLayout() {
    if (mobileQuery.matches) {
      if (!mobileLayout) {
        mobileLayout = true;
        primarySection.append(navLinks);
        accountSection.append(navRight);
        panel.append(primarySection, accountSection);
        setPanelVisibility(false);
      }
      return;
    }
    if (mobileLayout || navLinks.parentElement !== navLeft || navRight.parentElement !== nav) restoreDesktopLayout();
    else setPanelVisibility(false);
  }

  menuButton.addEventListener('click', () => setPanelVisibility(!panelOpen));
  panel.addEventListener('click', event => {
    if (event.target.closest('a, #btn-logout')) setPanelVisibility(false);
  });
  // Close before the theme button's target-phase listener opens the modal;
  // this avoids stealing the modal's intentional focus.
  navRight.addEventListener('click', event => {
    if (event.target.closest('#btn-theme-settings')) setPanelVisibility(false);
  }, true);
  document.addEventListener('click', event => {
    if (panelOpen && !nav.contains(event.target)) setPanelVisibility(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panelOpen) setPanelVisibility(false, { restoreFocus: true });
  });
  const handleViewportChange = () => applyResponsiveLayout();
  if (typeof mobileQuery.addEventListener === 'function') mobileQuery.addEventListener('change', handleViewportChange);
  else mobileQuery.addListener(handleViewportChange);

  applyResponsiveLayout();
})();

// Keep project tabs usable without wrapping the page at phone and tablet
// widths. The project page owns tab state; this initializer only observes it.
(function initProjectTabScrolling() {
  const tabBar = document.querySelector('.project-tabs');
  if (!tabBar) return;
  const tabs = [...tabBar.querySelectorAll('.tab-btn')];
  if (!tabs.length) return;
  const compactQuery = window.matchMedia('(max-width: 1000px)');
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  function scrollActiveTab(behavior = 'auto') {
    if (!compactQuery.matches) return;
    const active = [...tabBar.querySelectorAll('.tab-btn')].find(tab => tab.classList.contains('active'));
    if (!active) return;
    const maxScroll = Math.max(0, tabBar.scrollWidth - tabBar.clientWidth);
    const target = active.offsetLeft - Math.max(0, (tabBar.clientWidth - active.offsetWidth) / 2);
    tabBar.scrollTo({
      left: Math.max(0, Math.min(maxScroll, target)),
      behavior: behavior === 'smooth' && !reducedMotionQuery.matches ? 'smooth' : 'auto',
    });
  }

  tabs.forEach(tab => tab.addEventListener('click', () => {
    window.requestAnimationFrame(() => scrollActiveTab('smooth'));
  }));
  window.addEventListener('hashchange', () => window.requestAnimationFrame(() => scrollActiveTab('auto')));
  const activeObserver = new MutationObserver(records => {
    if (records.some(record => record.attributeName === 'class')) {
      window.requestAnimationFrame(() => scrollActiveTab('auto'));
    }
  });
  activeObserver.observe(tabBar, { subtree: true, attributes: true, attributeFilter: ['class'] });
  const handleCompactChange = () => window.requestAnimationFrame(() => scrollActiveTab('auto'));
  if (typeof compactQuery.addEventListener === 'function') compactQuery.addEventListener('change', handleCompactChange);
  else compactQuery.addListener(handleCompactChange);
  window.requestAnimationFrame(() => scrollActiveTab('auto'));
})();
