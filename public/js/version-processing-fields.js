/* Processing controls shared by the project version builder. */
window.VersionProcessingFields = (() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const field = (path, label, value, min, max, step = 1) => `<label class="version-field">${esc(label)}<input type="number" data-path="${path}" value="${value}" min="${min}" max="${max}" step="${step}"></label>`;
  const select = (path, label, options, selected) => `<label class="version-field">${esc(label)}<select data-path="${path}">${options.map(option => `<option value="${option[0]}"${option[0] === selected ? ' selected' : ''}>${esc(option[1])}</option>`).join('')}</select></label>`;
  const check = (path, label, checked = false) => `<label class="version-check"><input type="checkbox" data-path="${path}"${checked ? ' checked' : ''}>${esc(label)}</label>`;
  const setting = (path, title, help, fields) => `<details class="version-setting"><summary><label class="version-check"><input type="checkbox" data-path="${path}.enabled" data-enable>${esc(title)}</label><span class="version-setting-hint">${esc(help)}</span></summary><fieldset disabled><div class="version-fields">${fields}</div></fieldset></details>`;
  const group = (title, help, content) => `<details class="version-setting"><summary>${esc(title)}<span class="version-setting-hint">${esc(help)}</span></summary><div class="version-fields">${content}</div></details>`;
  function augmentation(prefix, box = false) {
    let html = group('Flip', 'Choose how often horizontal and vertical flips occur.', field(`${prefix}.horizontalFlip`, 'Horizontal probability (0–1)', 0, 0, 1, 0.05) + field(`${prefix}.verticalFlip`, 'Vertical probability (0–1)', 0, 0, 1, 0.05));
    html += group('90° rotation', 'Randomly choose one of the checked orientations.', [0, 90, 180, 270].map(angle => `<label class="version-check"><input type="checkbox" data-rotate="${prefix}" value="${angle}"${angle === 0 ? ' checked' : ''}>${({ 0: 'Original', 90: 'Clockwise', 180: 'Upside down', 270: 'Counterclockwise' })[angle]}</label>`).join(''));
    html += setting(`${prefix}.crop`, 'Random crop', 'Drop a random portion of the image area.', field(`${prefix}.crop.min`, 'Minimum area removed (%)', 0, 0, 90) + field(`${prefix}.crop.max`, 'Maximum area removed (%)', 20, 0, 90));
    html += setting(`${prefix}.rotation`, 'Rotation', 'Vary the angle clockwise or counterclockwise.', field(`${prefix}.rotation.degrees`, 'Maximum angle (°)', 15, 0, 180));
    html += setting(`${prefix}.shear`, 'Shear', 'Vary horizontal and vertical perspective.', field(`${prefix}.shear.x`, 'Horizontal maximum (°)', 10, 0, 45) + field(`${prefix}.shear.y`, 'Vertical maximum (°)', 10, 0, 45));
    if (!box) {
      html += group('Grayscale', 'Convert this fraction of training variants to grayscale.', field(`${prefix}.grayscale`, 'Probability (0–1)', 0, 0, 1, 0.05));
      html += setting(`${prefix}.hue`, 'Hue', 'Shift colors around the color wheel.', field(`${prefix}.hue.degrees`, 'Maximum shift (°)', 15, 0, 180));
      html += setting(`${prefix}.saturation`, 'Saturation', 'Decrease or increase color intensity.', field(`${prefix}.saturation.min`, 'Minimum change (%)', -25, -100, 100) + field(`${prefix}.saturation.max`, 'Maximum change (%)', 25, -100, 100));
    }
    html += setting(`${prefix}.brightness`, 'Brightness', 'Add or subtract a uniform amount of light.', field(`${prefix}.brightness.min`, 'Minimum change (%)', -10, -100, 100) + field(`${prefix}.brightness.max`, 'Maximum change (%)', 10, -100, 100));
    html += setting(`${prefix}.exposure`, 'Exposure', 'Adjust the tonal response with gamma.', field(`${prefix}.exposure.min`, 'Minimum change (%)', -10, -100, 100) + field(`${prefix}.exposure.max`, 'Maximum change (%)', 10, -100, 100));
    html += setting(`${prefix}.blur`, 'Blur', 'Simulate changes in focus.', field(`${prefix}.blur.pixels`, 'Maximum blur (px)', 3, 0, 25, 0.5));
    html += setting(`${prefix}.noise`, 'Noise', 'Add random salt-and-pepper pixels.', field(`${prefix}.noise.percent`, 'Affected pixels (%)', 1, 0, 25, 0.1));
    html += setting(`${prefix}.cameraGain`, 'Camera gain', 'Simulate sensor noise in low light.', field(`${prefix}.cameraGain.variance`, 'Variance multiplier', 0.01, 0, 1, 0.001));
    html += setting(`${prefix}.motionBlur`, 'Motion blur', 'Simulate camera or subject movement.', field(`${prefix}.motionBlur.length`, 'Length (px)', 15, 1, 100) + field(`${prefix}.motionBlur.angle`, 'Direction (°)', 0, -180, 180) + field(`${prefix}.motionBlur.frames`, 'Frames per blur length', 3, 1, 30));
    if (!box) {
      html += setting(`${prefix}.cutout`, 'Cutout', 'Cover random areas with black boxes.', field(`${prefix}.cutout.percent`, 'Area per box (%)', 10, 0, 100) + field(`${prefix}.cutout.count`, 'Number of boxes', 3, 1, 50));
      html += setting(`${prefix}.mosaic`, 'Mosaic', 'Combine training images. Avoid applying mosaic again during training.', select(`${prefix}.mosaic.tiles`, 'Images per mosaic', [['4', '4 images (2 × 2)'], ['9', '9 images (3 × 3)']], '4'));
    }
    return html;
  }
  function mount(container, classes = [], tags = []) {
    const p = 'preprocessing';
    let pre = `<div class="version-fields">${check(`${p}.autoOrient`, 'Auto-orient images', true)}${check(`${p}.grayscale`, 'Convert all images to grayscale')}${check(`${p}.isolateObjects`, 'Isolate bounding boxes as classification images')}</div>`;
    pre += setting(`${p}.crop`, 'Static crop', 'Crop the same percentage-based region in every image.', field(`${p}.crop.xMin`, 'Left (%)', 0, 0, 99) + field(`${p}.crop.xMax`, 'Right (%)', 100, 1, 100) + field(`${p}.crop.yMin`, 'Top (%)', 0, 0, 99) + field(`${p}.crop.yMax`, 'Bottom (%)', 100, 1, 100));
    pre += setting(`${p}.tile`, 'Tile images', 'Split images before resizing. Overlap helps preserve objects at tile edges.', select(`${p}.tile.mode`, 'Tile mode', [['grid', 'Grid'], ['fixed', 'Fixed size'], ['aspect', 'Fixed aspect ratio']], 'grid') +
      `<div class="version-fields version-span" data-tile-mode="grid">${field(`${p}.tile.rows`, 'Rows', 2, 1, 32)}${field(`${p}.tile.columns`, 'Columns', 2, 1, 32)}</div>` +
      `<div class="version-fields version-span" data-tile-mode="fixed" hidden>${field(`${p}.tile.width`, 'Tile width (px)', 640, 224, 16384)}${field(`${p}.tile.height`, 'Tile height (px)', 640, 224, 16384)}</div>` +
      `<div class="version-fields version-span" data-tile-mode="aspect" hidden>${field(`${p}.tile.ratio`, 'Width ÷ height', 1, 0.1, 10, 0.1)}${select(`${p}.tile.span`, 'Span', [['width', 'Full image width'], ['height', 'Full image height']], 'width')}</div>` +
      `<div class="version-fields version-span" data-tile-mode="fixed aspect" hidden>${field(`${p}.tile.overlapPercent`, 'Overlap (%)', 0, 0, 90)}${select(`${p}.tile.background`, 'Padding', [['#000000', 'Black'], ['#ffffff', 'White']], '#000000')}</div>`);
    pre += setting(`${p}.resize`, 'Resize', 'Choose output dimensions and how to handle the aspect ratio.', field(`${p}.resize.width`, 'Width (px)', 640, 1, 16384) + field(`${p}.resize.height`, 'Height (px)', 640, 1, 16384) + select(`${p}.resize.mode`, 'Resize method', [['stretch', 'Stretch'], ['fill', 'Fill with center crop'], ['fit', 'Fit within'], ['reflect', 'Fit with reflected edges'], ['black', 'Fit with black edges'], ['white', 'Fit with white edges']], 'black') + check(`${p}.resize.withoutEnlargement`, 'Only downsize source pixels', true));
    pre += setting(`${p}.contrast`, 'Auto-adjust contrast', 'Improve contrast consistently across every split.', select(`${p}.contrast.mode`, 'Method', [['stretch', 'Contrast stretching (2–98%)'], ['equalize', 'Histogram equalization'], ['clahe', 'Adaptive equalization (CLAHE)']], 'stretch') + field(`${p}.contrast.tileSize`, 'Adaptive tile size (px)', 64, 2, 1024) + field(`${p}.contrast.clipLimit`, 'Adaptive contrast limit', 3, 1, 100));
    pre += group('Modify classes', 'Rename, merge or omit classes in this version. Original labels stay unchanged.', classes.length ? classes.map((entry, i) => {
      const name = typeof entry === 'string' ? entry : entry.name;
      return `<div class="version-class-row version-span" data-class="${esc(name)}"><span>${esc(name)}</span><label>Action<select data-class-action aria-label="Action for ${esc(name)}"><option value="keep">Keep</option><option value="rename">Rename / merge</option><option value="omit">Omit</option></select></label><label hidden data-class-rename>New class name<input type="text" maxlength="120" value="${esc(name)}" aria-label="New name for ${esc(name)}" disabled></label></div>`;
    }).join('') : '<p>No label classes yet.</p>');
    pre += setting(`${p}.filterNull`, 'Filter background images', 'Limit images without labels, including those made empty by class changes.', field(`${p}.filterNull.maxPercent`, 'Maximum background share (%)', 10, 0, 100));
    pre += group('Filter by tag', 'All required tags must match; any excluded tag removes the image.', tags.length ? tags.map(tag => `<label class="version-field">${esc(tag)}<select data-tag="${esc(tag)}"><option value="allow">Allow</option><option value="require">Require</option><option value="exclude">Exclude</option></select></label>`).join('') : '<p>No image tags yet.</p>');
    container.innerHTML = `<section class="version-stage"><h3>3. Preprocessing</h3><p>Applied to training, validation and test images.</p>${pre}</section><section class="version-stage"><h3>4. Augmentation</h3><p>New variants are created from training images only. Start with zero copies for an unchanged baseline.</p><div class="version-fields">${field('augmentation.count', 'Additional copies per training image', 0, 0, 10)}<label class="version-field">Augmentation seed<input type="text" data-path="augmentation.seed" value="libreflow-augmentation" maxlength="120"></label></div><details class="version-settings-group"><summary>Image augmentations · 16 types</summary>${augmentation('augmentation')}</details><details class="version-settings-group"><summary><label class="version-check"><input type="checkbox" data-path="augmentation.boundingBox.enabled" data-enable>Bounding-box augmentations</label></summary><fieldset disabled><p>Change only the contents of bounding boxes. Overlapping boxes are processed in a consistent order. For boxes overlapping masks, polygons or other spatial labels, use image-level geometric augmentation.</p>${augmentation('augmentation.boundingBox', true)}</fieldset></details></section>`;
    const syncTileMode = () => {
      const mode = container.querySelector('[data-path="preprocessing.tile.mode"]').value;
      container.querySelectorAll('[data-tile-mode]').forEach(node => {
        node.hidden = !node.dataset.tileMode.split(' ').includes(mode);
        node.querySelectorAll('input,select').forEach(input => { input.disabled = node.hidden; });
      });
    };
    syncTileMode();
    container.addEventListener('change', event => {
      const input = event.target;
      if (input.matches('[data-enable]')) {
        const details = input.closest('details');
        details.querySelector(':scope > fieldset').disabled = !input.checked;
        if (input.checked) details.open = true;
      }
      if (input.dataset.path === 'preprocessing.tile.mode') syncTileMode();
      if (input.matches('[data-class-action]')) {
        const rename = input.closest('[data-class]').querySelector('[data-class-rename]');
        rename.hidden = input.value !== 'rename';
        rename.querySelector('input').disabled = rename.hidden;
        rename.querySelector('input').required = !rename.hidden;
      }
    });
  }
  function read(container) {
    const result = { preprocessing: {}, augmentation: {} };
    const set = (path, value) => {
      const keys = path.split('.');
      let node = result;
      keys.slice(0, -1).forEach(key => { node = node[key] ||= {}; });
      node[keys[keys.length - 1]] = value;
    };
    container.querySelectorAll('[data-path]').forEach(input => set(input.dataset.path, input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value));
    for (const prefix of ['augmentation', 'augmentation.boundingBox']) {
      const choices = [...container.querySelectorAll(`[data-rotate="${prefix}"]:checked`)].map(input => Number(input.value));
      set(`${prefix}.rotate`, choices.length ? choices : [0]);
      set(`${prefix}.brightness.mode`, 'additive');
      set(`${prefix}.noise.mode`, 'salt-pepper');
    }
    result.augmentation.mosaic.tiles = Number(result.augmentation.mosaic.tiles);
    result.preprocessing.crop.unit = 'percent';
    result.preprocessing.modifyClasses = Object.create(null);
    container.querySelectorAll('[data-class]').forEach(row => {
      const action = row.querySelector('[data-class-action]').value;
      if (action !== 'keep') result.preprocessing.modifyClasses[row.dataset.class] = action === 'omit' ? '' : row.querySelector('input').value.trim();
    });
    result.preprocessing.filterTags = { required: [], excluded: [] };
    container.querySelectorAll('[data-tag]').forEach(input => {
      if (input.value === 'require') result.preprocessing.filterTags.required.push(input.dataset.tag);
      if (input.value === 'exclude') result.preprocessing.filterTags.excluded.push(input.dataset.tag);
    });
    return result;
  }
  return { mount, read };
})();
