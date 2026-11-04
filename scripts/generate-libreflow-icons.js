#!/usr/bin/env node
/*
 * Regenerates only the path registry in public/js/icons.js from a pinned
 * lucide-static package. Runtime pages do not load lucide-static.
 *
 * Usage:
 *   node scripts/generate-libreflow-icons.js C:/path/to/package
 */
const fs = require('node:fs');
const path = require('node:path');

const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error('Pass the unpacked lucide-static package path');
const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
if (packageJson.name !== 'lucide-static' || packageJson.version !== '0.468.0') {
  throw new Error(`Expected lucide-static@0.468.0, got ${packageJson.name}@${packageJson.version}`);
}

const sourceNames = {
  check: 'check', close: 'x', warning: 'triangle-alert', info: 'info', clock: 'clock',
  users: 'users', package: 'package', brain: 'brain', folder: 'folder', file: 'file',
  image: 'image', trash: 'trash', arrowRight: 'arrow-right', search: 'search', upload: 'upload',
  download: 'download', briefcase: 'briefcase-business', grid: 'grid-2x2', list: 'list', camera: 'camera',
  arrowLeft: 'arrow-left', rotateLeft: 'rotate-ccw', rotateRight: 'rotate-cw', expand: 'expand',
  plus: 'plus', minus: 'minus', chevronLeft: 'chevron-left', chevronRight: 'chevron-right',
  chevronDown: 'chevron-down', chevronUp: 'chevron-up', eye: 'eye', eyeOff: 'eye-off', bell: 'bell',
  sun: 'sun', moon: 'moon', monitor: 'monitor', logOut: 'log-out', moreVertical: 'ellipsis-vertical',
  pencil: 'pencil', refresh: 'refresh-cw', loader: 'loader', play: 'play', pause: 'pause', square: 'square',
  circle: 'circle', circleSlash: 'circle-slash', mousePointer: 'mouse-pointer', box: 'rectangle-horizontal',
  // Annotation aliases intentionally use the nearest published Lucide geometry.
  rotatedBox: 'rectangle-horizontal', polygon: 'pentagon', point: 'crosshair', mask: 'brush',
  polyline: 'waypoints', skeleton: 'network',
  sparkles: 'sparkles', undo: 'undo', redo: 'redo', zoomIn: 'zoom-in', zoomOut: 'zoom-out', save: 'save',
  tag: 'tag', keyboard: 'keyboard', filter: 'filter', externalLink: 'external-link', copy: 'copy', link: 'link',
  shieldCheck: 'shield-check', key: 'key-round', database: 'database', layers: 'layers', inbox: 'inbox',
  settings: 'settings', checkCircle: 'circle-check', xCircle: 'circle-x', fileArchive: 'file-archive',
  folderOpen: 'folder-open', github: 'github',
};

function readBody(iconName) {
  const filename = path.join(sourceRoot, 'icons', `${iconName}.svg`);
  const svg = fs.readFileSync(filename, 'utf8');
  const match = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
  if (!match) throw new Error(`No SVG body found in ${filename}`);
  return match[1].replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').replace(/>\s+</g, '><').replace(/\s+\/>/g, '/>').trim();
}

const transforms = {
  rotatedBox: body => `<g transform="rotate(18 12 12)">${body}</g>`,
};
const entries = Object.entries(sourceNames).map(([name, source]) => {
  const body = readBody(source);
  return `    ${name}: ${JSON.stringify(transforms[name] ? transforms[name](body) : body)},`;
}).join('\n');
const iconPath = path.resolve(__dirname, '..', 'public/js/icons.js');
const current = fs.readFileSync(iconPath, 'utf8');
const registryPattern = /const paths = Object\.freeze\(\{[\s\S]*?\n  \}\);/;
if (!registryPattern.test(current)) throw new Error('Could not locate the paths registry in icons.js');
const replacement = `const paths = Object.freeze({\n${entries}\n  });`;
const updated = current.replace(registryPattern, replacement);
if (updated === current) {
  console.log(`Icon registry already current (${Object.keys(sourceNames).length} paths)`);
  process.exit(0);
}
fs.writeFileSync(iconPath, updated);
console.log(`Generated ${Object.keys(sourceNames).length} icon paths from lucide-static`);
