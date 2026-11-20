/*
 * Shared, dependency-free inline SVG icons.
 *
 * The paths are the small, vendored subset of lucide-static documented in
 * public/assets/lucide-icons.LICENSE.txt. Keep this module free of runtime
 * dependencies so it can be used by every plain HTML page.
 */
window.LibreFlowIcons = (() => {
  const paths = Object.freeze({
    check: "<path d=\"M20 6 9 17l-5-5\"/>",
    close: "<path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/>",
    warning: "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/><path d=\"M12 9v4\"/><path d=\"M12 17h.01\"/>",
    info: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 16v-4\"/><path d=\"M12 8h.01\"/>",
    clock: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><polyline points=\"12 6 12 12 16 14\"/>",
    users: "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"/><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/>",
    package: "<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\"/><path d=\"M12 22V12\"/><path d=\"m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7\"/><path d=\"m7.5 4.27 9 5.15\"/>",
    brain: "<path d=\"M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z\"/><path d=\"M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z\"/><path d=\"M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4\"/><path d=\"M17.599 6.5a3 3 0 0 0 .399-1.375\"/><path d=\"M6.003 5.125A3 3 0 0 0 6.401 6.5\"/><path d=\"M3.477 10.896a4 4 0 0 1 .585-.396\"/><path d=\"M19.938 10.5a4 4 0 0 1 .585.396\"/><path d=\"M6 18a4 4 0 0 1-1.967-.516\"/><path d=\"M19.967 17.484A4 4 0 0 1 18 18\"/>",
    folder: "<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/>",
    file: "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/>",
    image: "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\"/><circle cx=\"9\" cy=\"9\" r=\"2\"/><path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\"/>",
    trash: "<path d=\"M3 6h18\"/><path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"/><path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"/>",
    arrowRight: "<path d=\"M5 12h14\"/><path d=\"m12 5 7 7-7 7\"/>",
    search: "<circle cx=\"11\" cy=\"11\" r=\"8\"/><path d=\"m21 21-4.3-4.3\"/>",
    upload: "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><polyline points=\"17 8 12 3 7 8\"/><line x1=\"12\" x2=\"12\" y1=\"3\" y2=\"15\"/>",
    download: "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><polyline points=\"7 10 12 15 17 10\"/><line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\"/>",
    briefcase: "<path d=\"M12 12h.01\"/><path d=\"M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2\"/><path d=\"M22 13a18.15 18.15 0 0 1-20 0\"/><rect width=\"20\" height=\"14\" x=\"2\" y=\"6\" rx=\"2\"/>",
    grid: "<path d=\"M12 3v18\"/><path d=\"M3 12h18\"/><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/>",
    list: "<path d=\"M3 12h.01\"/><path d=\"M3 18h.01\"/><path d=\"M3 6h.01\"/><path d=\"M8 12h13\"/><path d=\"M8 18h13\"/><path d=\"M8 6h13\"/>",
    camera: "<path d=\"M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z\"/><circle cx=\"12\" cy=\"13\" r=\"3\"/>",
    arrowLeft: "<path d=\"m12 19-7-7 7-7\"/><path d=\"M19 12H5\"/>",
    rotateLeft: "<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\"/><path d=\"M3 3v5h5\"/>",
    rotateRight: "<path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/>",
    expand: "<path d=\"m21 21-6-6m6 6v-4.8m0 4.8h-4.8\"/><path d=\"M3 16.2V21m0 0h4.8M3 21l6-6\"/><path d=\"M21 7.8V3m0 0h-4.8M21 3l-6 6\"/><path d=\"M3 7.8V3m0 0h4.8M3 3l6 6\"/>",
    plus: "<path d=\"M5 12h14\"/><path d=\"M12 5v14\"/>",
    minus: "<path d=\"M5 12h14\"/>",
    chevronLeft: "<path d=\"m15 18-6-6 6-6\"/>",
    chevronRight: "<path d=\"m9 18 6-6-6-6\"/>",
    chevronDown: "<path d=\"m6 9 6 6 6-6\"/>",
    chevronUp: "<path d=\"m18 15-6-6-6 6\"/>",
    eye: "<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
    eyeOff: "<path d=\"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49\"/><path d=\"M14.084 14.158a3 3 0 0 1-4.242-4.242\"/><path d=\"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143\"/><path d=\"m2 2 20 20\"/>",
    bell: "<path d=\"M10.268 21a2 2 0 0 0 3.464 0\"/><path d=\"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326\"/>",
    sun: "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2\"/><path d=\"M12 20v2\"/><path d=\"m4.93 4.93 1.41 1.41\"/><path d=\"m17.66 17.66 1.41 1.41\"/><path d=\"M2 12h2\"/><path d=\"M20 12h2\"/><path d=\"m6.34 17.66-1.41 1.41\"/><path d=\"m19.07 4.93-1.41 1.41\"/>",
    moon: "<path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\"/>",
    monitor: "<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\"/><line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\"/><line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\"/>",
    logOut: "<path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4\"/><polyline points=\"16 17 21 12 16 7\"/><line x1=\"21\" x2=\"9\" y1=\"12\" y2=\"12\"/>",
    moreVertical: "<circle cx=\"12\" cy=\"12\" r=\"1\"/><circle cx=\"12\" cy=\"5\" r=\"1\"/><circle cx=\"12\" cy=\"19\" r=\"1\"/>",
    pencil: "<path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\"/><path d=\"m15 5 4 4\"/>",
    refresh: "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/><path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"/><path d=\"M8 16H3v5\"/>",
    loader: "<path d=\"M12 2v4\"/><path d=\"m16.2 7.8 2.9-2.9\"/><path d=\"M18 12h4\"/><path d=\"m16.2 16.2 2.9 2.9\"/><path d=\"M12 18v4\"/><path d=\"m4.9 19.1 2.9-2.9\"/><path d=\"M2 12h4\"/><path d=\"m4.9 4.9 2.9 2.9\"/>",
    play: "<polygon points=\"6 3 20 12 6 21 6 3\"/>",
    pause: "<rect x=\"14\" y=\"4\" width=\"4\" height=\"16\" rx=\"1\"/><rect x=\"6\" y=\"4\" width=\"4\" height=\"16\" rx=\"1\"/>",
    square: "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/>",
    circle: "<circle cx=\"12\" cy=\"12\" r=\"10\"/>",
    circleSlash: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><line x1=\"9\" x2=\"15\" y1=\"15\" y2=\"9\"/>",
    mousePointer: "<path d=\"M12.586 12.586 19 19\"/><path d=\"M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z\"/>",
    box: "<rect width=\"20\" height=\"12\" x=\"2\" y=\"6\" rx=\"2\"/>",
    rotatedBox: "<g transform=\"rotate(18 12 12)\"><rect width=\"20\" height=\"12\" x=\"2\" y=\"6\" rx=\"2\"/></g>",
    polygon: "<path d=\"M10.83 2.38a2 2 0 0 1 2.34 0l8 5.74a2 2 0 0 1 .73 2.25l-3.04 9.26a2 2 0 0 1-1.9 1.37H7.04a2 2 0 0 1-1.9-1.37L2.1 10.37a2 2 0 0 1 .73-2.25z\"/>",
    point: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><line x1=\"22\" x2=\"18\" y1=\"12\" y2=\"12\"/><line x1=\"6\" x2=\"2\" y1=\"12\" y2=\"12\"/><line x1=\"12\" x2=\"12\" y1=\"6\" y2=\"2\"/><line x1=\"12\" x2=\"12\" y1=\"22\" y2=\"18\"/>",
    mask: "<path d=\"m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08\"/><path d=\"M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z\"/>",
    polyline: "<circle cx=\"12\" cy=\"4.5\" r=\"2.5\"/><path d=\"m10.2 6.3-3.9 3.9\"/><circle cx=\"4.5\" cy=\"12\" r=\"2.5\"/><path d=\"M7 12h10\"/><circle cx=\"19.5\" cy=\"12\" r=\"2.5\"/><path d=\"m13.8 17.7 3.9-3.9\"/><circle cx=\"12\" cy=\"19.5\" r=\"2.5\"/>",
    skeleton: "<rect x=\"16\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\"/><rect x=\"2\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\"/><rect x=\"9\" y=\"2\" width=\"6\" height=\"6\" rx=\"1\"/><path d=\"M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3\"/><path d=\"M12 12V8\"/>",
    sparkles: "<path d=\"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z\"/><path d=\"M20 3v4\"/><path d=\"M22 5h-4\"/><path d=\"M4 17v2\"/><path d=\"M5 18H3\"/>",
    undo: "<path d=\"M3 7v6h6\"/><path d=\"M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13\"/>",
    redo: "<path d=\"M21 7v6h-6\"/><path d=\"M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7\"/>",
    zoomIn: "<circle cx=\"11\" cy=\"11\" r=\"8\"/><line x1=\"21\" x2=\"16.65\" y1=\"21\" y2=\"16.65\"/><line x1=\"11\" x2=\"11\" y1=\"8\" y2=\"14\"/><line x1=\"8\" x2=\"14\" y1=\"11\" y2=\"11\"/>",
    zoomOut: "<circle cx=\"11\" cy=\"11\" r=\"8\"/><line x1=\"21\" x2=\"16.65\" y1=\"21\" y2=\"16.65\"/><line x1=\"8\" x2=\"14\" y1=\"11\" y2=\"11\"/>",
    save: "<path d=\"M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z\"/><path d=\"M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7\"/><path d=\"M7 3v4a1 1 0 0 0 1 1h7\"/>",
    tag: "<path d=\"M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z\"/><circle cx=\"7.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/>",
    keyboard: "<path d=\"M10 8h.01\"/><path d=\"M12 12h.01\"/><path d=\"M14 8h.01\"/><path d=\"M16 12h.01\"/><path d=\"M18 8h.01\"/><path d=\"M6 8h.01\"/><path d=\"M7 16h10\"/><path d=\"M8 12h.01\"/><rect width=\"20\" height=\"16\" x=\"2\" y=\"4\" rx=\"2\"/>",
    filter: "<polygon points=\"22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3\"/>",
    externalLink: "<path d=\"M15 3h6v6\"/><path d=\"M10 14 21 3\"/><path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\"/>",
    copy: "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\"/><path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"/>",
    link: "<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\"/><path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\"/>",
    shieldCheck: "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"/><path d=\"m9 12 2 2 4-4\"/>",
    key: "<path d=\"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z\"/><circle cx=\"16.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/>",
    database: "<ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\"/><path d=\"M3 5V19A9 3 0 0 0 21 19V5\"/><path d=\"M3 12A9 3 0 0 0 21 12\"/>",
    layers: "<path d=\"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z\"/><path d=\"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12\"/><path d=\"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17\"/>",
    inbox: "<polyline points=\"22 12 16 12 14 15 10 15 8 12 2 12\"/><path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\"/>",
    settings: "<path d=\"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
    checkCircle: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"m9 12 2 2 4-4\"/>",
    xCircle: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"m15 9-6 6\"/><path d=\"m9 9 6 6\"/>",
    fileArchive: "<path d=\"M10 12v-1\"/><path d=\"M10 18v-2\"/><path d=\"M10 7V6\"/><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/><path d=\"M15.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v16a2 2 0 0 0 .274 1.01\"/><circle cx=\"10\" cy=\"20\" r=\"2\"/>",
    folderOpen: "<path d=\"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2\"/>",
    github: "<path d=\"M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4\"/><path d=\"M9 18c-4.51 2-5-2-7-2\"/>",
    pin: "<path d=\"M7 3h10l-1.5 5L19 11v2H5v-2l3.5-3z\"/><path d=\"M12 13v8\"/>",
    pinFilled: "<path d=\"M7 3h10l-1.5 5L19 11v2H5v-2l3.5-3z\" fill=\"currentColor\"/><path d=\"M12 13v8\"/>",
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

  // Primary navigation is shared by several plain HTML pages. Keep its icon
  // markup in one place so pages cannot drift into text-only navigation.
  const navigationIcons = Object.freeze({
    '/dashboard': ['grid', 'Dashboard'],
    '/jobs': ['briefcase', 'Jobs'],
    '/models': ['brain', 'Models'],
    '/datasets': ['package', 'Datasets'],
  });

  function hydrateNavigation(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    scope.querySelectorAll('.nav-link').forEach(link => {
      const href = link.getAttribute('href') || '';
      let pathname;
      try {
        pathname = new URL(href, document.baseURI).pathname;
      } catch {
        pathname = href.split(/[?#]/, 1)[0];
      }
      pathname = pathname.replace(/\/$/, '') || '/';
      const entry = navigationIcons[pathname];
      if (!entry) return;
      const [name, label] = entry;
      if (!link.querySelector('svg')) {
        link.insertAdjacentHTML('afterbegin', icon(name));
      }
      if (!link.querySelector('.nav-link-label')) {
        const labelNode = document.createElement('span');
        labelNode.className = 'nav-link-label';
        labelNode.textContent = label;
        [...link.childNodes]
          .filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
          .forEach(node => node.remove());
        const badge = link.querySelector('.nav-badge');
        if (badge) link.insertBefore(labelNode, badge);
        else link.append(labelNode);
      }
      if (!link.getAttribute('aria-label')) link.setAttribute('aria-label', label);
      if (!link.getAttribute('title')) link.setAttribute('title', label);
    });
  }

  if (typeof document !== 'undefined') {
    const hydrateAll = () => {
      hydrate(document);
      hydrateNavigation(document);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hydrateAll, { once: true });
    else hydrateAll();
  }

  return { icon, hydrate, hydrateNavigation, names };
})();
