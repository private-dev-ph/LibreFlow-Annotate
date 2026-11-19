const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libreflow-batch-flow-'));
  const dataDir = path.join(fixtureRoot, 'data');
  const uploadsDir = path.join(fixtureRoot, 'uploads');
  const versionsDir = path.join(fixtureRoot, 'versions');
  for (const dir of [dataDir, uploadsDir, versionsDir]) fs.mkdirSync(dir);
  process.env.LIBREFLOW_DATA_DIR = dataDir;
  process.env.LIBREFLOW_UPLOADS_DIR = uploadsDir;
  process.env.LIBREFLOW_VERSIONS_DIR = versionsDir;
  process.env.LIBREFLOW_DATASETS_DIR = path.join(fixtureRoot, 'datasets');
  const write = (name, value) => fs.writeFileSync(path.join(dataDir, name + '.json'), JSON.stringify(value));
  const project = { id: 'fixture', userId: 'owner', name: 'Batch selection fixture', labelClasses: [{ name: 'Part', color: '#40a080' }], collaborators: [], modelIds: [] };
  const images = [1, 2, 3, 4].map(n => ({ id: 'image-' + n, projectId: project.id, userId: 'owner', filename: n + '.png', originalName: 'Source ' + n + '.png', width: 16, height: 12, annotated: n < 4, isNull: n === 2, tags: [] }));
  const annotations = [1, 3].map(n => ({ id: 'annotation-' + n, imageId: 'image-' + n, type: 'bbox', label: 'Part', data: { x: 2, y: 2, width: 8, height: 6 } }));
  const batches = [{ id: 'batch-one', projectId: project.id, name: 'Inspection boards', imageIds: ['image-1', 'image-2'], subBatches: [{ id: 'sub-one', name: 'First board', imageIds: ['image-1'] }, { id: 'sub-two', name: 'Background board', imageIds: ['image-2'] }] }, { id: 'batch-two', projectId: project.id, name: 'Other boards', imageIds: ['image-3'], subBatches: [] }];
  write('projects', [project]); write('images', images); write('annotations', annotations); write('batches', batches);
  for (const name of ['datasets', 'dataset_versions', 'reviews', 'annotation-revisions', 'audit-events']) write(name, []);
  for (let n = 1; n <= 4; n++) await sharp({ create: { width: 16, height: 12, channels: 3, background: { r: n * 40, g: 120, b: 100 } } }).png().toFile(path.join(uploadsDir, n + '.png'));
  const sourceBefore = Object.fromEntries(['projects', 'images', 'annotations', 'batches'].map(name => [name, fs.readFileSync(path.join(dataDir, name + '.json'), 'utf8')]));
  const sourceBytes = images.map(image => fs.readFileSync(path.join(uploadsDir, image.filename)));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: 'owner', username: 'Fixture' }; next(); });
  app.get('/api/auth/me', (_req, res) => res.json({ id: 'owner', username: 'Fixture' }));
  app.get('/api/projects/fixture', (_req, res) => res.json(project));
  app.get('/api/images', (_req, res) => res.json(images));
  app.get('/api/batches', (_req, res) => res.json(batches));
  app.use('/api/dataset-lifecycle', require('../../../routes/dataset-lifecycle'));
  app.get('/api/*', (_req, res) => res.json([]));
  app.use('/uploads', express.static(uploadsDir));
  app.use(express.static(path.join(__dirname, '../../../public'), { extensions: ['html'] }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    for (const surface of ['project', 'dataset-lifecycle']) {
      const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      const target = surface === 'project' ? '/project?projectId=fixture#versions' : '/dataset-lifecycle?sourceType=project&sourceId=fixture#versions';
      await page.goto(`http://127.0.0.1:${server.address().port}${target}`);
      await page.locator('input[name="version-source-mode"][value="batches"]').check();
      const create = page.locator(surface === 'project' ? '#version-create' : '#btn-create-version');
      assert.equal(await create.isDisabled(), true, 'empty source cannot create');
      await page.locator('[data-source-sub="sub-two"]').check();
      await page.waitForFunction(selector => !document.querySelector(selector).disabled, surface === 'project' ? '#version-create' : '#btn-create-version');
      if (surface === 'project') {
        await page.waitForFunction(() => document.querySelector('#version-source-count').textContent.startsWith('1 ready'));
        const sampleResponse = page.waitForResponse(response => response.url().endsWith('/versions/sample-preview'));
        await page.locator('[data-preview-operation]').first().click();
        const response = await sampleResponse;
        const sample = await response.json();
        assert.equal(response.status(), 200, JSON.stringify(sample));
        assert.equal(sample.sample.id, 'image-2', 'effect preview uses selected sub-batch');
      }
      const sourceControl = page.locator('[data-source-sub="sub-two"]');
      await sourceControl.focus();
      await page.keyboard.press('Space');
      assert.equal(await create.isDisabled(), true);
      assert.equal(await sourceControl.evaluate(el => document.activeElement === el), true, 'focus stays on checkbox after deselection');
      await page.keyboard.press('Space');
      await page.waitForFunction(selector => !document.querySelector(selector).disabled, surface === 'project' ? '#version-create' : '#btn-create-version');
      assert.equal(await sourceControl.evaluate(el => document.activeElement === el), true, 'focus stays on checkbox after selection');
      for (const width of [375, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, surface + ' fits ' + width);
        for (const mode of ['light', 'dark']) {
          await page.evaluate(mode => { document.documentElement.dataset.mode = mode; }, mode);
          const radioBounds = await page.locator('input[name="version-source-mode"][value="batches"]').boundingBox();
          assert.ok(radioBounds.width <= 24 && radioBounds.height <= 24, 'native radio keeps compact visual size inside touch-sized row');
          await page.evaluate(() => {
            const control = document.getElementById('version-source-controls');
            const nav = document.getElementById('top-nav');
            window.scrollBy(0, control.getBoundingClientRect().top - nav.getBoundingClientRect().bottom - 16);
          });
          await page.locator('#version-source-controls').screenshot({ path: path.join(os.tmpdir(), `libreflow-batch-source-${surface}-${width}-${mode}.png`) });
        }
      }
      await page.evaluate(() => { document.documentElement.dataset.mode = 'light'; });
      await page.locator('#version-name').fill(surface + ' selected batch');
      const createResponse = page.waitForResponse(response => response.url().endsWith('/versions') && response.request().method() === 'POST');
      await create.click();
      const response = await createResponse;
      const version = await response.json();
      assert.equal(response.status(), 201, JSON.stringify(version));
      assert.equal(version.stats.sourceImages, 1);
      assert.deepEqual([...new Set(version.images.map(image => image.sourceImageId))], ['image-2'], 'originals and augmented variants use only the selected source');
      assert.equal(version.selection.sourceScope.subBatches[0].name, 'Background board');
      const history = page.locator(surface === 'project' ? '#version-history-list' : '#versions-list');
      await page.waitForFunction(selector => document.querySelector(selector).textContent.includes('Background board'), surface === 'project' ? '#version-history-list' : '#versions-list');
      assert.match(await history.textContent(), /Background board/);
      assert.deepEqual(pageErrors, []);
      await page.close();
    }
    for (const [name, contents] of Object.entries(sourceBefore)) assert.equal(fs.readFileSync(path.join(dataDir, name + '.json'), 'utf8'), contents, name + ' untouched');
    images.forEach((image, index) => assert.deepEqual(fs.readFileSync(path.join(uploadsDir, image.filename)), sourceBytes[index]));
    console.log('PASS: actual project and lifecycle forms create scoped versions through real backend; sample preview, history, and source preservation verified');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    const absolute = path.resolve(fixtureRoot);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('libreflow-batch-flow-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
