// Runs in the document head before stylesheets so a saved appearance never flashes.
(() => {
  const themes = new Set(['rose-navy', 'clay-coral', 'mint-sun', 'purple-pop']);
  let theme = 'clay-coral';
  let mode = 'light';
  try {
    const savedTheme = localStorage.getItem('libreflow_theme');
    const savedMode = localStorage.getItem('libreflow_theme_mode');
    if (themes.has(savedTheme)) theme = savedTheme;
    if (savedMode === 'dark' || savedMode === 'light') mode = savedMode;
  } catch { /* Storage can be unavailable in private or restricted contexts. */ }
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.mode = mode;
})();
