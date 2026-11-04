// Synthetic browser regression for the shared navigation at phone/tablet sizes.
// No application server, account, or project data is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '../..');
const widths = [320, 375, 390, 430, 667, 768, 820, 1024];
const heights = new Map([[667, 375]]);
const navMarkup = `
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <base href="http://fixture.test/">
  <nav id="top-nav">
    <div class="nav-left">
      <a class="nav-logo" href="/dashboard"><img class="nav-logo-icon" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E"><span class="nav-logo-name">LibreFlow Annotate</span></a>
      <div class="nav-links">
        <a class="nav-link active" href="/dashboard">Dashboard</a>
        <a class="nav-link" href="/jobs">Jobs<span class="nav-badge hidden">0</span></a>
        <a class="nav-link" href="/models">Models</a>
        <a class="nav-link" href="/datasets">Datasets</a>
      </div>
    </div>
    <div class="nav-right">
      <div class="nav-notif-wrap"><button class="nav-notif-btn" type="button" aria-label="Notifications"><span data-lf-icon="bell" aria-hidden="true"></span></button></div>
      <div class="nav-user"><div class="nav-avatar">U</div><span class="nav-username">Preview</span></div>
      <button class="btn-theme-settings" type="button" aria-label="Theme settings" title="Theme settings"><span data-lf-icon="settings" aria-hidden="true"></span><span class="btn-theme-label">Theme</span></button>
      <button class="btn-logout" type="button">Sign Out</button>
    </div>
  </nav>`;

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  });
  try {
    const context = await browser.newContext({ isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<!doctype html>${navMarkup}`);
    for (const file of ['nav.css', 'icons.css', 'theme.css']) {
      await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'public/css', file), 'utf8') });
    }
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/icons.js'), 'utf8') });

    for (const mode of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.dataset.mode = value, mode);
      for (const width of widths) {
        await page.setViewportSize({ width, height: heights.get(width) || (width <= 600 ? 667 : 1024) });
        await page.waitForTimeout(20);
        const result = await page.evaluate(() => {
          const nav = document.getElementById('top-nav');
          const links = [...document.querySelectorAll('.nav-link')];
          const viewport = document.documentElement.clientWidth;
          return {
            viewport,
            bodyScrollWidth: document.body.scrollWidth,
            navScrollWidth: nav.scrollWidth,
            navRight: nav.getBoundingClientRect().right,
            links: links.map(link => {
              const svg = link.querySelector('svg');
              const label = link.querySelector('.nav-link-label');
              const rect = link.getBoundingClientRect();
              return {
                href: link.getAttribute('href'),
                svg: Boolean(svg),
                svgDisplay: svg ? getComputedStyle(svg).display : 'missing',
                svgRect: svg ? svg.getBoundingClientRect().toJSON() : null,
                labelVisible: Boolean(label && getComputedStyle(label).display !== 'none'),
                accessibleName: link.getAttribute('aria-label') || link.textContent.trim(),
                rect: rect.toJSON(),
              };
            }),
          };
        });
        assert.equal(result.bodyScrollWidth, result.viewport, `${mode} ${width}: page does not overflow horizontally`);
        assert.equal(result.navScrollWidth, result.viewport, `${mode} ${width}: navigation does not overflow horizontally`);
        assert.ok(result.navRight <= result.viewport + 1, `${mode} ${width}: navigation stays in viewport`);
        assert.deepEqual(result.links.map(link => link.svg), [true, true, true, true], `${mode} ${width}: all primary links have registry icons`);
        for (const link of result.links) {
          assert.notEqual(link.svgDisplay, 'none', `${mode} ${width} ${link.href}: icon is rendered`);
          assert.ok(link.svgRect.width >= 14 && link.svgRect.height >= 14, `${mode} ${width} ${link.href}: icon has a visible box`);
          if (width <= 1000) assert.ok(link.rect.width >= 44 && link.rect.height >= 44, `${mode} ${width} ${link.href}: link has a touch target`);
          assert.ok(link.accessibleName, `${mode} ${width} ${link.href}: link has an accessible name`);
        }
      }
    }
    assert.deepEqual(errors, [], 'navigation fixture has no runtime errors');
    console.log('PASS: primary navigation icons, labels/accessibility, touch targets, and overflow across light/dark mobile matrix.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
