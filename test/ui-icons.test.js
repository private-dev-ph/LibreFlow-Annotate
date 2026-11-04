const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadIcons() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve('public/js/icons.js'), 'utf8'), context);
  return context.window.LibreFlowIcons;
}

const ICON_NAMES = 'check close warning info clock users package brain folder file image trash arrowRight search upload download briefcase grid list camera arrowLeft rotateLeft rotateRight expand plus minus chevronLeft chevronRight chevronDown chevronUp eye eyeOff bell sun moon monitor logOut moreVertical pencil refresh loader play pause square circle circleSlash mousePointer box rotatedBox polygon point mask polyline skeleton sparkles undo redo zoomIn zoomOut save tag keyboard filter externalLink copy link shieldCheck key database layers inbox settings checkCircle xCircle fileArchive folderOpen github'.split(' ');

test('shared icon registry covers the public catalog with consistent SVG attributes', () => {
  const icons = loadIcons();
  assert.deepEqual(Array.from(icons.names), ICON_NAMES);
  for (const name of ICON_NAMES) {
    const svg = icons.icon(name);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.match(svg, /stroke-width="2"/);
    assert.match(svg, /aria-hidden="true"/);
    assert.match(svg, /focusable="false"/);
  }
  assert.match(icons.icon('box'), /<rect/);
  assert.match(icons.icon('rotatedBox'), /rotate\(18 12 12\)/);
});

test('icon labels escape markup and unknown names cannot inject class markup', () => {
  const icons = loadIcons();
  const labeled = icons.icon('check', `&<>"'`);
  assert.match(labeled, /role="img"/);
  assert.match(labeled, /aria-label="&amp;&lt;&gt;&quot;&#39;"/);
  assert.match(labeled, /<title>&amp;&lt;&gt;&quot;&#39;<\/title>/);
  assert.doesNotMatch(labeled, /aria-hidden/);

  const fallback = icons.icon('unknown"><script>alert(1)</script>');
  assert.match(fallback, /lf-icon-info/);
  assert.doesNotMatch(fallback, /lf-icon-unknown|<script/);
});

test('hydrate accepts an explicit dynamic root and replaces only icon placeholders', () => {
  const icons = loadIcons();
  let rendered = '';
  const node = {
    getAttribute(name) {
      return name === 'data-lf-icon' ? 'folder' : name === 'data-lf-icon-label' ? 'Project' : null;
    },
    set innerHTML(value) { rendered = value; },
  };
  icons.hydrate({ querySelectorAll: () => [node] });
  assert.match(rendered, /lf-icon-folder/);
  assert.match(rendered, /<title>Project<\/title>/);
});
