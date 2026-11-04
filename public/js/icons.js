/*
 * Shared, dependency-free inline SVG icons.
 *
 * The paths are the small, vendored subset of lucide-static documented in
 * public/assets/lucide-icons.LICENSE.txt. Keep this module free of runtime
 * dependencies so it can be used by every plain HTML page.
 */
window.LibreFlowIcons = (() => {
  const paths = Object.freeze({
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    warning: '<path d="M21.73 18 13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    package: '<path d="m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.27 6.96 12 12l8.73-5.04M12 22.08V12"/>',
    brain: '<path d="M9.5 4.5A3.5 3.5 0 0 0 6 8v.2A3.8 3.8 0 0 0 7 15.6V17a3 3 0 0 0 5 2.2A3 3 0 0 0 17 17v-1.4A3.8 3.8 0 0 0 18 8.2V8a3.5 3.5 0 0 0-6-2.5 3.5 3.5 0 0 0-2.5-1Z"/><path d="M12 5.5V19M8 10h1.5M14.5 10H16M8.5 14H10M14 14h1.5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    folderOpen: '<path d="m3 7 2-2h4l2 2h8a2 2 0 0 1 2 2v1H5a2 2 0 0 0-1.9 1.4L2 16.5V7Z"/><path d="M3.1 12.4A2 2 0 0 1 5 11h17l-2.1 7.1A2 2 0 0 1 18 19H5a2 2 0 0 1-1.9-2.6l.8-2.7"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
    fileArchive: '<path d="M3 4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M7 2v4M17 2v4M7 6h10M10 10h4M10 14h4M10 18h4"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/>',
    arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    arrowLeft: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    upload: '<path d="M12 16V3M7 8l5-5 5 5M5 21h14"/>',
    download: '<path d="M12 3v13M7 11l5 5 5-5M5 21h14"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    camera: '<path d="M4 7h3l2-3h6l2 3h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="3.5"/>',
    rotateLeft: '<path d="M3 7v6h6"/><path d="M3 13A9 9 0 1 0 6 6.7L3 13Z"/>',
    rotateRight: '<path d="M21 7v6h-6"/><path d="M21 13A9 9 0 1 1 18 6.7L21 13Z"/>',
    expand: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronUp: '<path d="m18 15-6-6-6 6"/>',
    eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7C3.12 8.2 7.2 5 12 5s8.88 3.2 9.94 6.65a1 1 0 0 1 0 .7C20.88 15.8 16.8 19 12 19s-8.88-3.2-9.94-6.65Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c4.8 0 8.88 3.2 9.94 6.65a1 1 0 0 1 0 .7 10.66 10.66 0 0 1-4.17 5.1M6.61 6.61A10.66 10.66 0 0 0 2.06 11.3a1 1 0 0 0 0 .7C3.12 15.8 7.2 19 12 19a10.43 10.43 0 0 0 3.12-.47M2 2l20 20"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    moon: '<path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36A5.5 5.5 0 0 1 12.36 3H12Z"/>',
    monitor: '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    moreVertical: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    pencil: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 3 21l.5-4.5Z"/><path d="m15 5 4 4"/>',
    refresh: '<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4"/>',
    loader: '<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>',
    play: '<path d="m6 3 14 9-14 9V3Z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    circleSlash: '<circle cx="12" cy="12" r="9"/><path d="m5 5 14 14"/>',
    mousePointer: '<path d="m3 3 7.07 17 2.51-7.42L20 10.07 3 3Z"/><path d="m13.5 13.5 4.5 4.5"/>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.27 6.96 8.73 5.05 8.73-5.05M12 22.08V12"/>',
    rotatedBox: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.27 6.96 8.73 5.05 8.73-5.05M12 22.08V12M7 4.5l10 5.75"/>',
    polygon: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
    point: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
    mask: '<path d="M4 7.5A3.5 3.5 0 0 1 7.5 4h9A3.5 3.5 0 0 1 20 7.5v9a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 16.5v-9Z"/><path d="M8 10h.01M16 10h.01M8 15c2.5 2 5.5 2 8 0"/>',
    polyline: '<path d="m3 17 6-6 4 4 8-8"/>',
    skeleton: '<circle cx="12" cy="5" r="2"/><path d="M9 9h6M12 7v10M9 21l3-4 3 4M8 13l4 1 4-1"/>',
    sparkles: '<path d="m12 3-1.5 4.5L6 9l4.5 1.5L12 15l1.5-4.5L18 9l-4.5-1.5L12 3ZM5 16l-.75 2.25L2 19l2.25.75L5 22l.75-2.25L8 19l-2.25-.75L5 16ZM19 14l-.75 2.25L16 17l2.25.75L19 20l.75-2.25L22 17l-2.25-.75L19 14Z"/>',
    undo: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-6.7L3 13Z"/>',
    redo: '<path d="M21 7v6h-6"/><path d="M21 13a9 9 0 1 1-3-6.7L21 13Z"/>',
    zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/>',
    zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.83 8.83a2 2 0 0 0 2.828 0l6.172-6.172a2 2 0 0 0 0-2.828Z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
    keyboard: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h.01M11 9h.01M15 9h.01M7 13h.01M11 13h6M15 13h.01"/>',
    filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3Z"/>',
    externalLink: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    shieldCheck: '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"/><path d="m9 12 2 2 4-4"/>',
    key: '<path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777ZM15.5 7.5 18 5m-2 4 3-3m-3.5 1.5L18 5"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12v7c0 1.66 3.58 3 8 3s8-1.34 8-3v-7"/>',
    layers: '<path d="m12.83 2.18 8.4 4.2a1 1 0 0 1 0 1.79l-8.4 4.2a1 1 0 0 1-.9 0l-8.4-4.2a1 1 0 0 1 0-1.79l8.4-4.2a1 1 0 0 1 .9 0Z"/><path d="m3.27 12 8.28 4.14a1 1 0 0 0 .9 0L20.73 12M3.27 16.5l8.28 4.14a1 1 0 0 0 .9 0l8.28-4.14"/>',
    inbox: '<path d="M4 4h16v16H4z"/><path d="M4 13h4l2 3h4l2-3h4"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
    checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
    xCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
    github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3 0 6.7-1.6 6.7-7A5.4 5.4 0 0 0 19.2 4 5 5 0 0 0 19 1.5S17.7 1.1 15 3.1a13.4 13.4 0 0 0-6 0C6.3 1.1 5 1.5 5 1.5A5 5 0 0 0 4.8 4a5.4 5.4 0 0 0-1.5 3.7c0 5.4 3.4 7 6.7 7A4.8 4.8 0 0 0 9 18v4"/><path d="M9 18c-4.5 2-5-2-7-2"/>',
  });

  const names = Object.freeze(Object.keys(paths));

  function escapeMarkup(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }

  function icon(name, label = '') {
    const requestedName = String(name ?? '');
    const canonicalName = Object.prototype.hasOwnProperty.call(paths, requestedName) ? requestedName : 'info';
    const accessibleLabel = label == null ? '' : String(label);
    const title = accessibleLabel ? `<title>${escapeMarkup(accessibleLabel)}</title>` : '';
    const accessibility = accessibleLabel
      ? ` role="img" aria-label="${escapeMarkup(accessibleLabel)}"`
      : ' aria-hidden="true"';
    return `<svg class="lf-icon lf-icon-${canonicalName}" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"${accessibility}>${title}${paths[canonicalName]}</svg>`;
  }

  function hydrate(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    const nodes = [];
    if (typeof scope.matches === 'function' && scope.matches('[data-lf-icon]')) nodes.push(scope);
    scope.querySelectorAll('[data-lf-icon]').forEach(node => nodes.push(node));
    nodes.forEach(node => {
      const name = node.getAttribute('data-lf-icon') || '';
      const label = node.getAttribute('data-lf-icon-label') || '';
      node.innerHTML = icon(name, label);
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => hydrate(document), { once: true });
    else hydrate(document);
  }

  return { icon, hydrate, names };
})();
