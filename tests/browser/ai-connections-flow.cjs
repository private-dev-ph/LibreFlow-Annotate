// Isolated AI-connections UI fixture. No production server or client credentials are used.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const publicRoot = path.resolve(__dirname, "../../public");
const chromePath =
  process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const scopes = [
  {
    id: "mcp:projects:read",
    label: "Project metadata",
    description: "Selected project metadata.",
    required: true,
    group: "Read",
  },
  {
    id: "mcp:annotations:read",
    label: "Annotations",
    description: "Annotation content.",
    required: false,
    group: "Read",
  },
  {
    id: "mcp:images:preview",
    label: "Image previews",
    description: "Reduced-size previews.",
    required: false,
    group: "Read",
    requires: ["mcp:annotations:read"],
  },
  {
    id: "mcp:annotations:write",
    label: "Apply annotation changes",
    description: "Action scope supplied by the server.",
    required: false,
    group: "Actions",
    action: true,
  },
];

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function startFixture() {
  const state = { connections: [], postBodies: [] };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/auth/me")
      return sendJson(response, 200, { username: "fixture" });
    if (url.pathname === "/api/notifications")
      return sendJson(response, 200, []);

    if (url.pathname === "/api/mcp/connections" && request.method === "GET") {
      return sendJson(response, 200, {
        enabled: true,
        capabilities: {
          local: { enabled: true, url: "http://127.0.0.1:6769" },
          remote: {
            enabled: false,
            configured: false,
            reason: "Remote OAuth is not configured.",
          },
          writes: { enabled: false },
          limits: { defaultExpiryDays: 30, maxExpiryDays: 90 },
        },
        scopes,
        projects: [{ id: "project-1", name: "First project" }],
        connections: state.connections,
      });
    }

    if (url.pathname === "/api/mcp/connections" && request.method === "POST") {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw);
        state.postBodies.push(body);
        const connection = {
          id: "connection-1",
          name: body.name,
          projectIds: body.projectIds,
          scopes: body.scopes,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        };
        state.connections = [connection];
        sendJson(response, 201, { connection, token: "fixture-secret-token" });
      });
      return;
    }

    if (
      request.method === "DELETE" &&
      url.pathname === "/api/mcp/connections/connection-1"
    ) {
      const connection = {
        ...state.connections[0],
        revokedAt: new Date().toISOString(),
      };
      state.connections = [connection];
      return sendJson(response, 200, { connection });
    }

    const relative =
      url.pathname === "/" ? "ai-connections.html" : url.pathname.slice(1);
    const filename = path.resolve(publicRoot, relative);
    if (!filename.startsWith(publicRoot) || !fs.existsSync(filename))
      return sendJson(response, 404, { error: "not found" });
    const contentType =
      path.extname(filename) === ".js"
        ? "text/javascript"
        : path.extname(filename) === ".css"
          ? "text/css"
          : "text/html";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(fs.readFileSync(filename));
  });
  return { server, state };
}

async function openPage(browser, port, width, mode) {
  const context = await browser.newContext({
    viewport: { width, height: 820 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    (selectedMode) =>
      localStorage.setItem("libreflow_theme_mode", selectedMode),
    mode,
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/ai-connections.html`);
  await page.waitForFunction(
    () =>
      document.querySelector("#mcp-status-badge")?.textContent ===
      "Local ready",
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.mode),
    mode,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    true,
    `horizontal overflow at ${width}px`,
  );
  assert.deepEqual(
    errors,
    [],
    `page errors at ${width}px/${mode}: ${errors.join(" | ")}`,
  );
  return { context, page, errors };
}

async function run() {
  const fixture = startFixture();
  await new Promise((resolve) =>
    fixture.server.listen(0, "127.0.0.1", resolve),
  );
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });
  try {
    for (const width of [320, 375, 768, 1440]) {
      for (const mode of ["light", "dark"]) {
        const { context, page } = await openPage(
          browser,
          fixture.server.address().port,
          width,
          mode,
        );
        await page.close();
        await context.close();
      }
    }

    const { context, page } = await openPage(
      browser,
      fixture.server.address().port,
      375,
      "light",
    );
    await page.locator("#connect-client").click();
    assert.equal(
      await page.locator("#client-dialog").evaluate((dialog) => dialog.open),
      true,
    );
    assert.match(
      await page.locator("#remote-prerequisite").textContent(),
      /Remote OAuth is not configured/,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("#client-dialog").evaluate((dialog) => dialog.open),
      false,
    );
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "connect-client",
    );

    await page.locator("#connect-client").click();
    await page.locator("#dialog-next").click();
    await page.locator("#connection-name").fill("Fixture client");
    await page.locator("#project-list input").check();
    assert.equal(
      await page.locator("#scope-mcp-annotations-write").isDisabled(),
      true,
    );
    await page.locator("#scope-mcp-images-preview").check();
    await page.locator("#dialog-next").click();
    assert.match(
      await page.locator("#dialog-error").textContent(),
      /requires Annotations/,
    );
    assert.equal(
      await page.locator('.dialog-step[data-step="3"]').isVisible(),
      false,
    );
    await page.locator("#scope-mcp-annotations-read").check();
    await page.locator("#dialog-next").click();
    assert.equal(await page.locator("#review-summary").isVisible(), true);
    await page.locator("#create-connection").click();
    await page.waitForSelector("#token-panel:not([hidden])");
    assert.equal(
      await page.locator("#connection-token").inputValue(),
      "fixture-secret-token",
    );
    assert.doesNotMatch(
      await page.locator("#setup-instructions").textContent(),
      /fixture-secret-token/,
    );
    assert.equal(
      await page.evaluate(() =>
        Object.values(localStorage).some((value) =>
          value.includes("fixture-secret-token"),
        ),
      ),
      false,
    );
    assert.match(
      await page.locator("#setup-instructions").textContent(),
      /"exec", "-i", "-e", "LIBREFLOW_MCP_TOKEN"/,
    );
    assert.match(
      await page.locator("#setup-instructions").textContent(),
      /"LIBREFLOW_MCP_URL=http:\/\/127\.0\.0\.1:6769"/,
    );
    assert.deepEqual(fixture.state.postBodies[0], {
      name: "Fixture client",
      projectIds: ["project-1"],
      scopes: [
        "mcp:projects:read",
        "mcp:annotations:read",
        "mcp:images:preview",
      ],
      expiresInDays: 30,
    });

    await page.locator("#dismiss-token").click();
    await page.locator("#client-search").fill("Fixture");
    assert.equal(await page.locator(".connection-row").count(), 1);
    await page.locator(".connection-row button", { hasText: "Revoke" }).click();
    await page.locator(".revoke-confirm button", { hasText: "Revoke" }).click();
    await page.waitForSelector(".status-badge.revoked");
    assert.equal(
      await page.locator(".status-badge.revoked").textContent(),
      "Revoked",
    );
    await context.close();
    console.log(
      "ai-connections browser fixture passed: wizard, dependencies, token hygiene, Docker snippet, search/revoke, 320/375/768/1440 light/dark, keyboard Escape, reduced motion",
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => fixture.server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
