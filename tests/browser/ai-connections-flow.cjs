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
  const requestSummary = {
    title: "Generate an inference draft",
    description:
      "Run the selected model against the approved image set and return a draft result.",
    warnings: ["The model can use the selected image previews."],
    counts: { images: 12, classes: 3 },
    details: [
      { label: "Model", value: "Fixture detector" },
      { label: "Confidence", value: "0.65" },
    ],
  };
  const state = {
    connections: [],
    postBodies: [],
    requestBodies: [],
    failNextReject: true,
    requests: [
      {
        id: "request-1",
        kind: "inference",
        status: "pending",
        projectId: "project-1",
        connectionId: "connection-1",
        digest: "digest-one",
        summary: requestSummary,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
      {
        id: "request-2",
        kind: "inference",
        status: "pending",
        projectId: "project-1",
        connectionId: "connection-1",
        digest: "digest-two",
        summary: { ...requestSummary, title: "Generate a second draft" },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    ],
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/auth/me")
      return sendJson(response, 200, { username: "fixture" });
    if (url.pathname === "/api/notifications")
      return sendJson(response, 200, []);

    if (url.pathname.startsWith("/api/mcp/connections/browse/")) {
      const project = { id: "project-1", name: "First project" };
      const group = url.pathname.split("/").pop();
      const rows = { clients: state.connections, requests: state.requests, projects: [project] }[group];
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const items = rows.filter(row => (row.name || row.summary?.title || "").toLowerCase().includes(q));
      return sendJson(response, 200, { items, page: 1, total: items.length, totalPages: 1, projects: [project] });
    }
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
      url.pathname === "/api/mcp/connections/requests" &&
      request.method === "GET"
    ) {
      return sendJson(response, 200, { requests: state.requests });
    }

    if (
      url.pathname.startsWith("/api/mcp/connections/requests/") &&
      request.method === "GET"
    ) {
      const id = url.pathname.split("/").pop();
      const found = state.requests.find((item) => item.id === id);
      return found
        ? sendJson(response, 200, { request: found })
        : sendJson(response, 404, { error: "Request not found." });
    }

    if (
      url.pathname.startsWith("/api/mcp/connections/requests/") &&
      request.method === "POST"
    ) {
      const parts = url.pathname.split("/");
      const id = parts[parts.length - 2];
      const action = parts[parts.length - 1];
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw);
        state.requestBodies.push({ id, action, body });
        if (action === "reject" && state.failNextReject) {
          state.failNextReject = false;
          return sendJson(response, 409, { error: "Request is stale." });
        }
        const current = state.requests.find((item) => item.id === id);
        if (!current || body.digest !== current.digest)
          return sendJson(response, 409, { error: "Request is stale." });
        const updated = {
          ...current,
          status: action === "approve" ? "approved" : "rejected",
          [action === "approve" ? "approvedAt" : "rejectedAt"]:
            new Date().toISOString(),
        };
        state.requests = state.requests.map((item) =>
          item.id === id ? updated : item,
        );
        sendJson(response, 200, { request: updated });
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
      url.pathname === "/jobs" ? "jobs.html" : url.pathname.slice(1);
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
    await page.locator(".connection-row").waitFor();
    assert.equal(await page.locator(".connection-row").count(), 1);
    assert.equal(await page.locator(".request-row").count(), 2);
    const firstReview = page.locator(
      '.request-row[data-request-id="request-1"] button',
    );
    await firstReview.click();
    await page.waitForSelector("#request-dialog[open]");
    assert.doesNotMatch(
      await page.locator("#request-detail").textContent(),
      /digest-one/,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page.evaluate(() => document.activeElement.textContent),
      "Review action",
    );
    await page.goto(`${page.url().split("#")[0]}#request=request-1`);
    await page.waitForSelector("#request-dialog[open]");
    await page.locator("#approve-request").click();
    await page.waitForSelector(
      '.request-row[data-request-id="request-1"] .status-badge.approved',
    );
    assert.equal(
      await page.locator("#request-dialog").evaluate((dialog) => dialog.open),
      false,
    );
    const secondReview = page.locator(
      '.request-row[data-request-id="request-2"] button',
    );
    await secondReview.click();
    await page.locator("#reject-request").click();
    assert.equal(
      await page.locator("#request-dialog").evaluate((dialog) => dialog.open),
      true,
    );
    assert.match(
      await page.locator("#request-dialog-error").textContent(),
      /stale/,
    );
    await page.locator("#reject-request").click();
    await page.waitForSelector(
      '.request-row[data-request-id="request-2"] .status-badge.rejected',
    );
    assert.deepEqual(
      fixture.state.requestBodies.map((item) => item.action),
      ["approve", "reject", "reject"],
    );
    await page.locator(".connection-row button", { hasText: "Revoke" }).click();
    await page.locator(".revoke-confirm button", { hasText: "Revoke" }).click();
    await page.waitForSelector(".status-badge.revoked");
    assert.equal(
      await page.locator(".status-badge.revoked").textContent(),
      "Revoked",
    );
    await context.close();
    console.log(
      "ai-connections browser fixture passed: wizard, dependencies, token hygiene, Docker snippet, request approve/reject/deep-link/error, search/revoke, 320/375/768/1440 light/dark, keyboard Escape/focus, reduced motion",
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
