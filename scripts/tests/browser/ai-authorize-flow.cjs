// Isolated remote-consent fixture. No provider, login, or production grant is used.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const publicRoot = path.resolve(__dirname, "../../../public");
const chromePath =
  process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function detailsFor(uid) {
  const loginStep = uid === "login";
  return {
    client: { name: `Trusted client ${uid} <script>` },
    user: { username: "reviewer" },
    projects: [
      { id: "project-1", name: "Project alpha <script>" },
      { id: "project-2", name: "Project beta" },
    ],
    scopes: [
      {
        id: "mcp:projects:read",
        label: "Project metadata",
        description: "Names and dataset settings.",
        required: true,
        group: "Read",
      },
      {
        id: "mcp:images:preview",
        label: "Image previews",
        description: "Reduced-size previews.",
        required: false,
        requires: ["mcp:annotations:read"],
      },
      {
        id: "mcp:annotations:read",
        label: "Annotation content",
        description: "Annotation geometry and labels.",
        required: false,
      },
      {
        id: "mcp:annotations:write",
        label: "Apply annotation changes",
        description: "Action permission.",
        required: false,
        action: true,
      },
    ],
    expiresInDays: 30,
    loginStep,
    writesEnabled: false,
  };
}

function startFixture() {
  const state = { approveAttempts: 0, bodies: [] };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const match = url.pathname.match(
      /^\/ai-authorize\/([^/]+)(?:\/(details|approve|deny))?$/,
    );
    if (match) {
      const uid = match[1];
      const action = match[2];
      if (!action) {
        const filename = path.join(publicRoot, "ai-authorize.html");
        response.writeHead(200, { "Content-Type": "text/html" });
        return response.end(fs.readFileSync(filename));
      }
      if (action === "details" && request.method === "GET")
        return sendJson(response, 200, detailsFor(uid));
      if (
        request.method === "POST" &&
        (action === "approve" || action === "deny")
      ) {
        let raw = "";
        request.on("data", (chunk) => {
          raw += chunk;
        });
        request.on("end", () => {
          const body = raw ? JSON.parse(raw) : {};
          state.bodies.push({ uid, action, body });
          if (
            uid === "uid" &&
            action === "approve" &&
            state.approveAttempts++ === 0
          )
            return sendJson(response, 500, {
              error: "simulated approval failure",
            });
          const pathName =
            action === "deny"
              ? "/oauth/denied"
              : uid === "login"
                ? "/oauth/login"
                : "/oauth/success";
          sendJson(response, 200, {
            redirectTo: `${pathName}?uid=${encodeURIComponent(uid)}`,
          });
        });
        return;
      }
    }
    if (url.pathname.startsWith("/oauth/")) {
      response.writeHead(200, { "Content-Type": "text/html" });
      return response.end(
        "<!doctype html><title>OAuth fixture</title><p>OAuth fixture complete.</p>",
      );
    }
    const relative =
      url.pathname === "/" ? "ai-authorize.html" : url.pathname.slice(1);
    const filename = path.resolve(publicRoot, relative);
    if (!filename.startsWith(publicRoot) || !fs.existsSync(filename))
      return sendJson(response, 404, { error: "not found" });
    const ext = path.extname(filename);
    const contentType =
      ext === ".js"
        ? "text/javascript"
        : ext === ".css"
          ? "text/css"
          : "text/html";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(fs.readFileSync(filename));
  });
  return { server, state };
}

async function openPage(browser, port, uid, width, mode) {
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
  await page.goto(`http://127.0.0.1:${port}/ai-authorize/${uid}`);
  await page.waitForFunction(
    () =>
      document.querySelector("#authorize-title")?.textContent ===
      "Authorize an AI client",
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
  assert.equal(await page.evaluate(() => window.__injected), undefined);
  assert.deepEqual(
    errors,
    [],
    `page errors at ${width}px/${mode}: ${errors.join(" | ")}`,
  );
  return { context, page };
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
    for (const width of [320, 375, 768, 1280]) {
      for (const mode of ["light", "dark"]) {
        const { context, page } = await openPage(
          browser,
          fixture.server.address().port,
          "uid",
          width,
          mode,
        );
        assert.match(
          await page.locator("#client-name").textContent(),
          /Trusted client uid <script>/,
        );
        assert.match(
          await page.locator("#project-list").textContent(),
          /Project alpha <script>/,
        );
        assert.equal(
          await page.locator("#scope-mcp-annotations-write").isDisabled(),
          true,
        );
        await context.close();
      }
    }

    const { context, page } = await openPage(
      browser,
      fixture.server.address().port,
      "uid",
      375,
      "light",
    );
    await page.locator("#approve-consent").click();
    assert.match(
      await page.locator("#page-error").textContent(),
      /Select at least one project/,
    );
    await page.locator("#project-list input").first().check();
    await page.locator("#scope-mcp-images-preview").check();
    await page.locator("#approve-consent").click();
    assert.match(
      await page.locator("#page-error").textContent(),
      /requires Annotation content/,
    );
    await page.locator("#scope-mcp-annotations-read").check();
    await page.locator("#expiry-7").check();
    await page.keyboard.press("Tab");
    await page.locator("#approve-consent").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#page-error")
        ?.textContent.includes("simulated approval failure"),
    );
    assert.match(
      await page.locator("#page-error").textContent(),
      /simulated approval failure/,
    );
    assert.equal(
      await page.locator("#project-list input").first().isChecked(),
      true,
    );
    assert.equal(
      await page.locator("#scope-mcp-images-preview").isChecked(),
      true,
    );
    assert.equal(
      await page.locator("#scope-mcp-annotations-read").isChecked(),
      true,
    );
    assert.equal(await page.locator("#expiry-7").isChecked(), true);
    await page.locator("#approve-consent").click();
    await page.waitForURL(/\/oauth\/success\?uid=uid$/);
    assert.deepEqual(fixture.state.bodies[0], {
      uid: "uid",
      action: "approve",
      body: {
        projectIds: ["project-1"],
        scopes: [
          "mcp:projects:read",
          "mcp:images:preview",
          "mcp:annotations:read",
        ],
        expiresInDays: 7,
      },
    });
    await context.close();

    const login = await openPage(
      browser,
      fixture.server.address().port,
      "login",
      375,
      "dark",
    );
    assert.equal(await login.page.locator("#consent-form").isVisible(), false);
    assert.equal(
      await login.page.locator("#continue-login").textContent(),
      "Continue as reviewer",
    );
    await login.page.locator("#continue-login").click();
    await login.page.waitForURL(/\/oauth\/login\?uid=login$/);
    await login.context.close();

    const deny = await openPage(
      browser,
      fixture.server.address().port,
      "deny",
      375,
      "light",
    );
    await deny.page.locator("#project-list input").first().check();
    await deny.page.locator("#deny-consent").click();
    await deny.page.waitForURL(/\/oauth\/denied\?uid=deny$/);
    await deny.context.close();

    console.log(
      "ai-authorize browser fixture passed: escaped text injection, required/dependency/action scopes, failed-submit preservation, login handshake, deny/redirect validation, 320/375/768/1280 light/dark, keyboard, reduced motion",
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
