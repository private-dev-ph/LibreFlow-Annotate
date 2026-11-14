/* MCP client access management. Credentials intentionally stay in memory only. */
(async () => {
  const me = await API.getMe();
  if (!me) {
    window.location.href = "/login";
    return;
  }

  const els = {
    avatar: document.getElementById("nav-avatar"),
    username: document.getElementById("nav-username"),
    logout: document.getElementById("btn-logout"),
    status: document.getElementById("page-status"),
    disabled: document.getElementById("disabled-notice"),
    statusBadge: document.getElementById("mcp-status-badge"),
    statusDot: document.getElementById("mcp-status-dot"),
    statusCopy: document.getElementById("mcp-status-copy"),
    localUrl: document.getElementById("local-server-url"),
    open: document.getElementById("connect-client"),
    dialog: document.getElementById("client-dialog"),
    close: document.getElementById("close-dialog"),
    cancel: document.getElementById("dialog-cancel"),
    back: document.getElementById("dialog-back"),
    next: document.getElementById("dialog-next"),
    create: document.getElementById("create-connection"),
    form: document.getElementById("connection-form"),
    dialogError: document.getElementById("dialog-error"),
    transportOptions: document.getElementById("transport-options"),
    remotePrerequisite: document.getElementById("remote-prerequisite"),
    steps: [...document.querySelectorAll(".dialog-step")],
    indicators: [...document.querySelectorAll("[data-step-indicator]")],
    name: document.getElementById("connection-name"),
    search: document.getElementById("project-search"),
    projects: document.getElementById("project-list"),
    projectHelp: document.getElementById("project-help"),
    scopeList: document.getElementById("scope-list"),
    scopeHelp: document.getElementById("scope-help"),
    expiry: document.getElementById("expiry-options"),
    review: document.getElementById("review-summary"),
    tokenPanel: document.getElementById("token-panel"),
    token: document.getElementById("connection-token"),
    copyToken: document.getElementById("copy-token"),
    dismissToken: document.getElementById("dismiss-token"),
    setup: document.getElementById("setup-instructions"),
    list: document.getElementById("connections-list"),
    listSearch: document.getElementById("client-search"),
    count: document.getElementById("connection-count"),
    refresh: document.getElementById("refresh-connections"),
    requests: document.getElementById("requests-list"),
    requestCount: document.getElementById("request-count"),
    refreshRequests: document.getElementById("refresh-requests"),
    requestDialog: document.getElementById("request-dialog"),
    closeRequestDialog: document.getElementById("close-request-dialog"),
    requestDialogError: document.getElementById("request-dialog-error"),
    requestDetail: document.getElementById("request-detail"),
    approveRequest: document.getElementById("approve-request"),
    rejectRequest: document.getElementById("reject-request"),
  };
  const state = {
    config: {},
    capabilities: {},
    scopes: [],
    projects: [],
    connections: [],
    selectedProjects: new Set(),
    selectedScopes: new Set(),
    pendingRevoke: new Set(),
    expiryDays: null,
    step: 1,
    method: "local",
    creating: false,
    tokenVisible: false,
    tokenConnectionId: null,
    lastTrigger: null,
    requests: [],
    activeRequest: null,
    requestTrigger: null,
    requestSubmitting: false,
    requestPreview: { status: "idle", requestId: null, token: 0, data: null },
  };

  els.avatar.textContent = String(me.username || "?")
    .slice(0, 2)
    .toUpperCase();
  els.username.textContent = me.username || "Signed in";
  els.logout.addEventListener("click", async () => {
    els.logout.disabled = true;
    try {
      await API.logout();
    } finally {
      window.location.href = "/login";
    }
  });

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
  }
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }
  function formatDate(value) {
    if (!value) return "Never";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
  }
  function setStatus(message = "", error = true) {
    els.status.textContent = message;
    els.status.classList.toggle("is-error", Boolean(error && message));
  }
  function notify(type, title, message = "") {
    if (typeof Notify !== "undefined" && typeof Notify[type] === "function")
      Notify[type](title, message);
    else setStatus(message || title, type === "error");
  }
  async function request(url, options = {}) {
    const fetcher =
      typeof window.apiFetch === "function"
        ? window.apiFetch
        : window.fetch.bind(window);
    const response = await fetcher(url, {
      credentials: "include",
      ...options,
      headers: options.body
        ? { "Content-Type": "application/json", ...(options.headers || {}) }
        : options.headers,
    });
    if (!response || typeof response.text !== "function") {
      return response;
    }
    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = { error: raw || `HTTP ${response.status}` };
    }
    if (!response.ok) {
      const error = new Error(
        data?.error ||
          data?.message ||
          `Request failed with HTTP ${response.status}.`,
      );
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function caps() {
    const c = state.capabilities || {};
    return {
      local: c.local || {},
      remote: c.remote || {},
      writes: c.writes || {},
      limits: c.limits || {},
    };
  }
  function localEnabled() {
    const c = caps();
    return c.local.enabled !== undefined
      ? c.local.enabled === true
      : state.config.enabled === true;
  }
  function remoteEnabled() {
    const c = caps();
    return c.remote.enabled === true;
  }
  function remoteConfigured() {
    const c = caps();
    return c.remote.configured === true;
  }
  function methodAvailable(method) {
    return method === "local" ? localEnabled() : remoteConfigured();
  }
  function localUrl() {
    return caps().local.url || "http://127.0.0.1:6769";
  }
  function remoteUrl() {
    return caps().remote.url || "";
  }
  function projectName(id) {
    return (
      state.projects.find((project) => String(project.id) === String(id))
        ?.name ||
      id ||
      "Unknown project"
    );
  }
  function selectedProjectIds() {
    return state.projects
      .filter((project) => state.selectedProjects.has(String(project.id)))
      .map((project) => project.id);
  }
  function scopeById(id) {
    return state.scopes.find((scope) => scope.id === id);
  }
  function scopeLabel(id) {
    return scopeById(id)?.label || id;
  }
  function scopeIds() {
    return state.scopes
      .filter((scope) => state.selectedScopes.has(scope.id))
      .map((scope) => scope.id);
  }
  function isWriteScope(scope) {
    const group = String(scope?.group || "").toLowerCase();
    return (
      scope?.action === true ||
      scope?.write === true ||
      ["action", "actions", "write", "writes"].includes(group)
    );
  }
  function requiredScope(scope) {
    return scope?.required === true;
  }
  function scopeRequirements(scope) {
    return Array.isArray(scope?.requires)
      ? scope.requires.filter(Boolean)
      : scope?.requires
        ? [scope.requires]
        : [];
  }
  function dependencyIssues() {
    const issues = [];
    state.scopes
      .filter((scope) => state.selectedScopes.has(scope.id))
      .forEach((scope) =>
        scopeRequirements(scope).forEach((required) => {
          if (!state.selectedScopes.has(required))
            issues.push(
              `${scopeLabel(scope.id)} requires ${scopeLabel(required)}. Select both explicitly.`,
            );
        }),
      );
    return [...new Set(issues)];
  }
  function selectedAccessText() {
    return scopeIds().map(scopeLabel).join(", ") || "No permissions selected";
  }

  function updateStatusCard() {
    const local = localEnabled();
    const remote = remoteConfigured();
    const any = local || remote;
    const c = caps();
    els.localUrl.textContent = localUrl();
    els.statusDot.classList.toggle("is-on", any);
    els.statusDot.classList.toggle("is-off", !any);
    els.statusBadge.className = `status-badge ${any ? "active" : "revoked"}`;
    els.statusBadge.textContent = any
      ? local && remote
        ? "Ready for clients"
        : local
          ? "Local ready"
          : "Remote ready"
      : "Unavailable";
    els.statusCopy.textContent = any
      ? local && remote
        ? "Local bridge access is ready. Remote OAuth is also configured for clients that need HTTPS access."
        : local
          ? `Use the local bridge at ${localUrl()} and keep the one-time token in your client’s protected settings.`
          : "Remote access is configured. Your client will open its own sign-in flow after you provide the server URL."
      : c.remote?.reason ||
        "No client transport is available yet. Ask an administrator to enable local MCP or configure remote access.";
    els.open.disabled = !any || state.tokenVisible;
    els.disabled.hidden = local || remote || !state.configLoaded;
  }

  function renderTransport() {
    clear(els.transportOptions);
    const local = localEnabled();
    const remote = remoteEnabled();
    const configured = remoteConfigured();
    const options = [
      {
        id: "local",
        title: "Local bridge",
        detail: `Use ${localUrl()} from a client on the same machine. Recommended for a local LibreFlow install.`,
        enabled: local,
      },
      {
        id: "remote",
        title: "Remote OAuth",
        detail: configured
          ? `Use the configured HTTPS server at ${remoteUrl() || "the administrator-provided URL"}. Sign in from your client when prompted.`
          : "Unavailable until an administrator configures a remote HTTPS issuer and server URL.",
        enabled: remote && configured,
      },
    ];
    let checked = false;
    options.forEach((option) => {
      const label = node(
        "label",
        `transport-card${option.enabled ? "" : " is-disabled"}`,
      );
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "transport";
      input.value = option.id;
      input.checked = state.method === option.id && option.enabled;
      input.disabled = !option.enabled;
      input.addEventListener("change", () => {
        state.method = option.id;
        renderTransport();
        updateDialogAction();
      });
      const copy = node("span", "transport-copy");
      copy.append(
        node("strong", "", option.title),
        node("small", "", option.detail),
      );
      label.append(input, copy);
      els.transportOptions.append(label);
      if (input.checked) checked = true;
    });
    if (!checked) {
      const fallback = options.find((option) => option.enabled);
      if (fallback) {
        state.method = fallback.id;
        const input = els.transportOptions.querySelector(
          `input[value="${fallback.id}"]`,
        );
        if (input) input.checked = true;
      }
    }
    const reason =
      caps().remote.reason ||
      "Remote access requires administrator configuration before an OAuth grant can be created.";
    els.remotePrerequisite.hidden = configured;
    els.remotePrerequisite.textContent = reason;
  }

  function renderProjects() {
    clear(els.projects);
    const query = els.search.value.trim().toLowerCase();
    const projects = state.projects.filter((project) =>
      String(project.name || "")
        .toLowerCase()
        .includes(query),
    );
    if (!state.projects.length)
      els.projects.append(
        node(
          "p",
          "project-empty",
          "No projects are available. Create a project before granting access.",
        ),
      );
    else if (!projects.length)
      els.projects.append(
        node("p", "project-empty", "No projects match your search."),
      );
    projects.forEach((project) => {
      const label = node("label", "project-choice");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = state.selectedProjects.has(String(project.id));
      input.addEventListener("change", () => {
        if (input.checked) state.selectedProjects.add(String(project.id));
        else state.selectedProjects.delete(String(project.id));
        updateSummary();
      });
      label.append(input, node("span", "", project.name || "Unnamed project"));
      els.projects.append(label);
    });
    updateSummary();
  }

  function renderScopes() {
    clear(els.scopeList);
    const grouped = new Map();
    state.scopes.forEach((scope) => {
      const group = scope.group || "Project access";
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group).push(scope);
    });
    if (!state.scopes.length)
      els.scopeList.append(
        node(
          "p",
          "scope-empty",
          "No permissions were provided by the server. Refresh before creating a connection.",
        ),
      );
    grouped.forEach((scopes, group) => {
      if (grouped.size > 1)
        els.scopeList.append(node("h4", "scope-group-title", group));
      scopes.forEach((scope) => {
        const disabled = isWriteScope(scope) && caps().writes.enabled !== true;
        const label = node(
          "label",
          `scope-row${requiredScope(scope) ? " required-scope" : ""}${disabled ? " is-disabled" : ""}`,
        );
        const input = document.createElement("input");
        input.type = "checkbox";
        input.id = `scope-${String(scope.id).replace(/[^a-z0-9_-]/gi, "-")}`;
        input.checked = state.selectedScopes.has(scope.id);
        input.disabled = requiredScope(scope) || disabled;
        input.dataset.scopeId = scope.id;
        input.addEventListener("change", () => {
          if (input.checked) state.selectedScopes.add(scope.id);
          else state.selectedScopes.delete(scope.id);
          renderScopes();
          updateSummary();
        });
        const copy = node("span", "scope-copy");
        copy.append(
          node(
            "strong",
            "",
            `${scope.label || scope.id}${requiredScope(scope) ? " · Required" : ""}`,
          ),
          node(
            "small",
            "",
            scope.description || "No additional description provided.",
          ),
        );
        const needs = scopeRequirements(scope);
        if (needs.length)
          copy.append(
            node(
              "em",
              "scope-requires",
              `Requires explicit selection: ${needs.map(scopeLabel).join(", ")}`,
            ),
          );
        if (disabled)
          copy.append(
            node(
              "em",
              "scope-unavailable",
              "Write actions are unavailable on this server.",
            ),
          );
        label.append(input, copy);
        els.scopeList.append(label);
      });
    });
    const issues = dependencyIssues();
    els.scopeHelp.textContent = issues.length
      ? issues.join(" ")
      : "Permissions are sent exactly as selected; no dependencies are added automatically.";
    els.scopeHelp.classList.toggle("has-error", issues.length > 0);
  }

  function renderExpiry() {
    clear(els.expiry);
    const limits = caps().limits;
    const max =
      Number(limits.maxExpiryDays || state.config.maxExpiryDays) || 90;
    const defaultDays =
      Number(limits.defaultExpiryDays || state.config.defaultExpiryDays) || 30;
    const choices = [7, 30, 90].filter((days) => days <= max);
    if (!choices.length) choices.push(Math.min(defaultDays, max));
    state.expiryDays = choices.includes(state.expiryDays)
      ? state.expiryDays
      : choices.includes(defaultDays)
        ? defaultDays
        : choices[choices.length - 1];
    choices.forEach((days) => {
      const wrap = node("div", "expiry-option");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "expiresInDays";
      input.id = `expiry-${days}`;
      input.value = String(days);
      input.checked = days === state.expiryDays;
      input.addEventListener("change", () => {
        state.expiryDays = days;
        updateSummary();
      });
      const label = node("label", "", `${days} days`);
      label.htmlFor = input.id;
      wrap.append(input, label);
      els.expiry.append(wrap);
    });
  }

  function updateSummary() {
    const names = selectedProjectIds().map(projectName);
    els.projectHelp.textContent = `${names.length} project${names.length === 1 ? "" : "s"} selected.`;
    els.scopeHelp.classList.toggle("has-error", dependencyIssues().length > 0);
  }
  function validateAccess() {
    const name = els.name.value.trim();
    const projects = selectedProjectIds();
    const issues = dependencyIssues();
    if (!name) return focusError("Enter a name for this connection.", els.name);
    if (!projects.length)
      return focusError("Select at least one project.", els.projects);
    if (!scopeIds().length)
      return focusError("Select at least one permission.", els.scopeList);
    if (issues.length) return focusError(issues[0], els.scopeList);
    if (!methodAvailable(state.method))
      return focusError(
        "This client transport is not currently available.",
        els.transportOptions,
      );
    return true;
  }
  function focusError(message, target) {
    els.dialogError.textContent = message;
    els.dialogError.focus();
    target?.scrollIntoView?.({ block: "nearest" });
    return false;
  }
  function clearError() {
    els.dialogError.textContent = "";
  }
  function updateDialogAction() {
    els.back.hidden = state.step <= 1;
    els.next.hidden = state.step >= 3;
    els.create.hidden = state.step !== 3;
    els.steps.forEach((step) => {
      step.hidden = Number(step.dataset.step) !== state.step;
      step.classList.toggle(
        "is-active",
        Number(step.dataset.step) === state.step,
      );
    });
    els.indicators.forEach((indicator) => {
      const n = Number(indicator.dataset.stepIndicator);
      indicator.classList.toggle("is-current", n === state.step);
      indicator.classList.toggle("is-complete", n < state.step);
    });
  }
  function renderReview() {
    clear(els.review);
    const rows = [
      [
        "Transport",
        state.method === "local"
          ? `Local bridge · ${localUrl()}`
          : `Remote OAuth · ${remoteUrl() || "configured server"}`,
      ],
      ["Name", els.name.value.trim()],
      ["Projects", selectedProjectIds().map(projectName).join(", ")],
      ["Permissions", selectedAccessText()],
      ["Expires", `${state.expiryDays} days`],
    ];
    rows.forEach(([label, value]) => {
      const row = node("div", "review-row");
      row.append(node("dt", "", label), node("dd", "", value));
      els.review.append(row);
    });
  }
  function setStep(step) {
    state.step = Math.max(1, Math.min(3, step));
    clearError();
    if (state.step === 3) renderReview();
    updateDialogAction();
    const first = els.steps
      .find((item) => !item.hidden)
      ?.querySelector("input,button");
    first?.focus();
  }

  function renderSetupInstructions() {
    clear(els.setup);
    const heading = node(
      "h4",
      "",
      state.method === "local" ? "Local stdio setup" : "Remote client setup",
    );
    els.setup.append(heading);
    if (state.method === "remote") {
      const url = remoteUrl();
      const line = node("div", "server-url-row");
      line.append(
        node("code", "server-url", url || "Configured by your administrator"),
      );
      if (url) {
        const copy = node("button", "secondary-action", "Copy URL");
        copy.type = "button";
        copy.addEventListener("click", () =>
          copyText(url, "Server URL copied"),
        );
        line.append(copy);
      }
      els.setup.append(
        line,
        node(
          "p",
          "setup-note",
          "In your generic MCP client, add this server URL and choose Sign in when the client prompts you. LibreFlow does not expose a fake OAuth link here; the client follows the configured issuer.",
        ),
      );
      return;
    }
    const list = node("ol", "setup-steps");
    const addStep = (title, code) => {
      const li = node("li");
      li.append(node("strong", "", title), node("code", "", code));
      list.append(li);
    };
    addStep("Run the bridge", "node /absolute/path/bin/libreflow-mcp.js");
    addStep("Set the endpoint", `LIBREFLOW_MCP_URL=${localUrl()}`);
    addStep("Set the one-time token", "LIBREFLOW_MCP_TOKEN=<TOKEN_FROM_ABOVE>");
    const dockerSnippet = `{
  "command": "docker",
  "args": ["exec", "-i", "-e", "LIBREFLOW_MCP_TOKEN", "-e", "LIBREFLOW_MCP_URL=${localUrl()}", "<container-name>", "node", "/app/bin/libreflow-mcp.js"],
  "env": { "LIBREFLOW_MCP_TOKEN": "<TOKEN_FROM_ABOVE>" }
}`;
    els.setup.append(
      list,
      node("p", "setup-note", "Generic stdio JSON example:"),
      node(
        "pre",
        "setup-code",
        '{\n  "mcpServers": {\n    "libreflow": {\n      "command": "node",\n      "args": ["/absolute/path/bin/libreflow-mcp.js"],\n      "env": { "LIBREFLOW_MCP_URL": "' +
          localUrl() +
          '", "LIBREFLOW_MCP_TOKEN": "<TOKEN_FROM_ABOVE>" }\n    }\n  }\n}',
      ),
      node(
        "p",
        "setup-note",
        "Docker stdio option (keep the token in the client’s protected environment):",
      ),
      node("pre", "setup-code", dockerSnippet),
      node(
        "p",
        "setup-note",
        "The Docker command forwards LIBREFLOW_MCP_TOKEN by name; the token value is never placed in the command arguments.",
      ),
    );
  }
  async function copyText(value, success) {
    try {
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(value);
      else {
        const helper = document.createElement("textarea");
        helper.value = value;
        helper.style.position = "fixed";
        helper.style.opacity = "0";
        document.body.append(helper);
        helper.select();
        if (!document.execCommand("copy")) throw new Error();
        helper.remove();
      }
      notify("success", success);
    } catch {
      notify(
        "error",
        "Could not copy",
        "Select the value and copy it manually.",
      );
    }
  }

  function connectionStatus(connection) {
    if (connection.revokedAt) return { label: "Revoked", className: "revoked" };
    if (
      connection.expiresAt &&
      new Date(connection.expiresAt).getTime() <= Date.now()
    )
      return { label: "Expired", className: "expired" };
    return { label: "Active", className: "active" };
  }
  function renderConnections(focusTarget = null) {
    clear(els.list);
    const query = els.listSearch.value.trim().toLowerCase();
    const connections = state.connections.filter((connection) =>
      String(connection.name || "")
        .toLowerCase()
        .includes(query),
    );
    els.count.textContent = `${connections.length} of ${state.connections.length} client${state.connections.length === 1 ? "" : "s"}`;
    if (!connections.length) {
      els.list.append(
        node(
          "p",
          "muted",
          state.connections.length
            ? "No connected clients match your search."
            : "No connected clients yet.",
        ),
      );
      return;
    }
    connections.forEach((connection) => {
      const status = connectionStatus(connection);
      const card = node("article", "connection-row");
      card.dataset.connectionId = connection.id;
      const head = node("div", "connection-card-head");
      const title = node("div", "connection-main");
      title.append(
        node("h3", "connection-name", connection.name || "Unnamed connection"),
        node(
          "p",
          "connection-meta",
          `Created ${formatDate(connection.createdAt)}`,
        ),
      );
      const actions = node("div", "connection-actions");
      actions.append(
        node("span", `status-badge ${status.className}`, status.label),
      );
      if (status.className === "active") {
        if (state.pendingRevoke.has(String(connection.id))) {
          const confirm = node("div", "revoke-confirm");
          confirm.append(
            node("span", "connection-meta", "Revoke this access?"),
          );
          const yes = node(
            "button",
            "secondary-action danger-action",
            "Revoke",
          );
          yes.type = "button";
          yes.addEventListener("click", () =>
            revokeConnection(connection.id, yes),
          );
          const no = node("button", "secondary-action", "Keep");
          no.type = "button";
          no.addEventListener("click", () => {
            state.pendingRevoke.delete(String(connection.id));
            renderConnections({ id: connection.id, action: "revoke" });
          });
          confirm.append(yes, no);
          actions.append(confirm);
        } else {
          const revoke = node("button", "secondary-action", "Revoke");
          revoke.type = "button";
          revoke.addEventListener("click", () => {
            state.pendingRevoke.add(String(connection.id));
            renderConnections({ id: connection.id, action: "revoke" });
          });
          actions.append(revoke);
        }
      }
      head.append(title, actions);
      card.append(head);
      const details = document.createElement("details");
      details.className = "connection-details";
      const summary = node("summary", "", "View permissions and activity");
      const body = node("div", "details-body");
      const projects = Array.isArray(connection.projectIds)
        ? connection.projectIds.map(projectName).join(", ")
        : "No projects";
      body.append(
        node("p", "connection-detail", `Projects: ${projects}`),
        node(
          "p",
          "connection-detail",
          `Permissions: ${(connection.scopes || []).map(scopeLabel).join(", ") || "None"}`,
        ),
        node(
          "p",
          "connection-detail",
          `Expires: ${formatDate(connection.expiresAt)}`,
        ),
        node(
          "p",
          "connection-detail",
          `Last used: ${formatDate(connection.lastUsedAt)}`,
        ),
      );
      const activity = Array.isArray(connection.activity)
        ? connection.activity.slice(-4).reverse()
        : [];
      if (activity.length) {
        body.append(node("h4", "activity-title", "Recent activity (redacted)"));
        activity.forEach((item) =>
          body.append(
            node(
              "p",
              "activity-row",
              `${[item.tool || "MCP tool", item.outcome || "Completed", item.projectId ? projectName(item.projectId) : ""].filter(Boolean).join(" · ")} · ${formatDate(item.at)}`,
            ),
          ),
        );
      } else
        body.append(node("p", "activity-empty", "No activity recorded yet."));
      details.append(summary, body);
      card.append(details);
      els.list.append(card);
    });
    if (focusTarget) {
      const target = [...els.list.querySelectorAll(".connection-row")].find(
        (item) => String(item.dataset.connectionId) === String(focusTarget.id),
      );
      target?.querySelector("button")?.focus();
    }
  }
  async function revokeConnection(id, button) {
    button.disabled = true;
    try {
      const result = await request(
        `/api/mcp/connections/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      const updated = result?.connection;
      state.connections = updated
        ? state.connections.map((item) =>
            String(item.id) === String(id) ? updated : item,
          )
        : state.connections.filter((item) => String(item.id) !== String(id));
      state.pendingRevoke.delete(String(id));
      renderConnections({ id });
      notify(
        "success",
        "Connection revoked",
        "The token can no longer be used.",
      );
    } catch (error) {
      button.disabled = false;
      notify("error", "Could not revoke connection", error.message);
      renderConnections({ id });
    }
  }

  function getRequestHashId() {
    const hash = window.location.hash.replace(/^#/, "");
    return new URLSearchParams(hash).get("request");
  }

  function requestStatus(request) {
    const status = String(request?.status || "pending").toLowerCase();
    if (status === "pending" && request?.expiresAt) {
      const expiresAt = new Date(request.expiresAt).getTime();
      if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
        return { label: "Expired", className: "expired", canDecide: false };
      }
    }
    if (status === "approved") {
      return { label: "Approved", className: "approved", canDecide: false };
    }
    if (status === "rejected") {
      return { label: "Rejected", className: "rejected", canDecide: false };
    }
    if (status !== "pending") {
      return {
        label: status || "Unavailable",
        className: "expired",
        canDecide: false,
      };
    }
    return {
      label: "Pending review",
      className: "pending",
      canDecide: Boolean(request?.digest),
    };
  }

  function appendRequestSummary(parent, request) {
    const summary = request?.summary || {};
    if (summary.description)
      parent.append(node("p", "request-description", summary.description));

    const counts =
      summary.counts && typeof summary.counts === "object"
        ? summary.counts
        : {};
    const countEntries = Object.entries(counts).filter(
      ([, value]) => value !== null && value !== undefined,
    );
    if (countEntries.length) {
      const countList = node("div", "request-counts");
      countEntries.forEach(([label, value]) => {
        const item = node("span", "request-count");
        item.append(
          node("strong", "", String(value)),
          node("small", "", humanizeCountLabel(label)),
        );
        countList.append(item);
      });
      parent.append(countList);
    }

    if (Array.isArray(summary.details) && summary.details.length) {
      const details = node("dl", "request-settings");
      summary.details.forEach((detail) => {
        if (!detail || detail.label === undefined || detail.value === undefined)
          return;
        details.append(
          node("dt", "", detail.label),
          node("dd", "", detail.value),
        );
      });
      parent.append(details);
    }

    if (Array.isArray(summary.warnings) && summary.warnings.length) {
      const warnings = node("ul", "request-warnings");
      summary.warnings.forEach((warning) =>
        warnings.append(node("li", "", warning)),
      );
      parent.append(warnings);
    }
  }

  function isAnnotationRequest(request) {
    return String(request?.kind || "") === "annotations.append";
  }

  function humanizeCountLabel(value) {
    return String(value || "")
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^./, (character) => character.toUpperCase());
  }

  function safeAnnotatorUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin || !/^\/annotator(?:\/|$)/.test(url.pathname)) return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function shapePoints(shape) {
    const data = shape?.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.points)) return data.points;
    return [];
  }

  function rboxPoints(data) {
    const angle = Number(data?.angle || 0) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const halfWidth = Number(data?.width || 0) / 2, halfHeight = Number(data?.height || 0) / 2;
    return [[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]]
      .map(([x, y]) => ({ x: Number(data?.cx || 0) + x * cos - y * sin, y: Number(data?.cy || 0) + x * sin + y * cos }));
  }

  function drawReviewShape(context, shape) {
    const type = String(shape?.type || "").toLowerCase();
    const data = shape?.data || {};
    let points = [];
    if (type === "bbox") {
      const x = Number(data.x), y = Number(data.y), width = Number(data.width), height = Number(data.height);
      if (![x, y, width, height].every(Number.isFinite)) return;
      points = [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
    } else if (type === "rbox") points = rboxPoints(data);
    else if (["polygon", "line", "point", "keypoint"].includes(type)) points = shapePoints(shape).map(point => ({ x: Number(point?.x), y: Number(point?.y) })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    else if (type === "skeleton") {
      const skeletonPoints = shapePoints(shape).map(point => ({ x: Number(point?.x), y: Number(point?.y) }));
      (Array.isArray(data.edges) ? data.edges : []).forEach(edge => {
        const a = skeletonPoints[edge?.[0]], b = skeletonPoints[edge?.[1]];
        if (!a || !b) return;
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      });
      skeletonPoints.forEach(point => { context.beginPath(); context.arc(point.x, point.y, 4, 0, Math.PI * 2); context.fill(); });
      return;
    } else if (type === "mask") {
      const contours = Array.isArray(data) ? [{ points: data }] : (Array.isArray(data.contours) ? data.contours : []);
      contours.forEach(contour => {
        const contourPoints = Array.isArray(contour.points) ? contour.points : [];
        if (contourPoints.length < 2) return;
        context.beginPath(); contourPoints.forEach((point, index) => index ? context.lineTo(Number(point.x), Number(point.y)) : context.moveTo(Number(point.x), Number(point.y)));
        context.closePath(); context.fill(); context.stroke();
      });
      return;
    } else if (type === "classification") return;
    if (points.length === 0) return;
    context.beginPath(); context.moveTo(points[0].x, points[0].y); points.slice(1).forEach(point => context.lineTo(point.x, point.y));
    if (["bbox", "rbox", "polygon"].includes(type)) context.closePath();
    context.stroke();
    if (["bbox", "rbox", "polygon"].includes(type)) context.fill();
    if (["point", "keypoint"].includes(type)) { context.beginPath(); context.arc(points[0].x, points[0].y, 5, 0, Math.PI * 2); context.fill(); }
  }

  function reviewImagePanel(data) {
    const panel = node("section", "annotation-review-panel");
    panel.setAttribute("aria-labelledby", "annotation-review-title");
    const heading = node("div", "annotation-review-heading");
    heading.append(node("div", "annotation-review-heading-copy", undefined));
    heading.firstChild.append(node("h3", "annotation-review-title", "Visual annotation preview"), node("p", "annotation-review-help", `${Number(data.existingCount) || 0} existing annotation${Number(data.existingCount) === 1 ? "" : "s"} · ${data.shapes.length} proposed`));
    const controls = node("div", "annotation-review-controls");
    const toggle = node("button", "secondary-action annotation-review-toggle", "Hide overlay"); toggle.type = "button"; toggle.setAttribute("aria-pressed", "true");
    const zoomOut = node("button", "secondary-action annotation-review-zoom", "−"); zoomOut.type = "button"; zoomOut.setAttribute("aria-label", "Zoom out");
    const zoomReset = node("button", "secondary-action annotation-review-zoom", "100%"); zoomReset.type = "button"; zoomReset.setAttribute("aria-label", "Reset zoom");
    const zoomIn = node("button", "secondary-action annotation-review-zoom", "+"); zoomIn.type = "button"; zoomIn.setAttribute("aria-label", "Zoom in");
    controls.append(toggle, zoomOut, zoomReset, zoomIn); heading.append(controls); panel.append(heading);
    const viewport = node("div", "annotation-review-viewport");
    const stage = node("div", "annotation-review-stage");
    const image = document.createElement("img"); image.className = "annotation-review-image"; image.alt = data.image?.name || "Source image for annotation review"; image.decoding = "async";
    const canvas = document.createElement("canvas"); canvas.className = "annotation-review-canvas"; canvas.setAttribute("aria-hidden", "true"); stage.append(image, canvas); viewport.append(stage); panel.append(viewport);
    const labels = node("ul", "annotation-review-labels"); labels.setAttribute("aria-label", "Proposed annotation labels");
    data.shapes.forEach((shape, index) => { const item = node("li", "annotation-review-label", `${shape.label || "Unlabeled"}${shape.confidence === undefined ? "" : ` · ${Math.round(Number(shape.confidence) * 100)}% confidence`} · ${shape.type || "shape"}`); item.dataset.shapeIndex = String(index); labels.append(item); });
    if (labels.childElementCount) panel.append(labels);
    const link = safeAnnotatorUrl(data.annotatorUrl);
    if (link) { const open = node("a", "secondary-action annotation-review-link", "Open this image in annotator"); open.href = link; open.target = "_blank"; open.rel = "noopener"; panel.append(open); }
    let zoom = 1, overlayVisible = true;
    const draw = () => {
      if (!image.naturalWidth || !image.naturalHeight) return;
      const ratio = window.devicePixelRatio || 1; canvas.width = Math.min(4096, image.naturalWidth * ratio); canvas.height = Math.min(4096, image.naturalHeight * ratio); canvas.style.width = `${image.naturalWidth}px`; canvas.style.height = `${image.naturalHeight}px`;
      const context = canvas.getContext("2d"); context.setTransform(canvas.width / image.naturalWidth, 0, 0, canvas.height / image.naturalHeight, 0, 0); context.clearRect(0, 0, image.naturalWidth, image.naturalHeight); if (!overlayVisible) return;
      context.lineWidth = Math.max(1.5, image.naturalWidth / 500); context.strokeStyle = "#ffcc33"; context.fillStyle = "rgba(255, 204, 51, 0.18)"; data.shapes.forEach(shape => drawReviewShape(context, shape));
    };
    const applyZoom = () => { zoomReset.textContent = `${Math.round(zoom * 100)}%`; stage.style.transform = `scale(${zoom})`; stage.style.transformOrigin = "top left"; };
    toggle.addEventListener("click", () => { overlayVisible = !overlayVisible; toggle.textContent = overlayVisible ? "Hide overlay" : "Show overlay"; toggle.setAttribute("aria-pressed", String(overlayVisible)); draw(); });
    zoomOut.addEventListener("click", () => { zoom = Math.max(0.75, zoom - 0.25); applyZoom(); });
    zoomIn.addEventListener("click", () => { zoom = Math.min(2.5, zoom + 0.25); applyZoom(); });
    zoomReset.addEventListener("click", () => { zoom = 1; applyZoom(); });
    image.addEventListener("load", draw, { once: true }); image.addEventListener("error", () => { panel.dataset.loadError = "true"; panel.append(node("p", "form-error", "The source image could not be loaded. Approval is disabled until the preview is available.")); state.requestPreview.status = "error"; renderReviewButtons(state.activeRequest); });
    image.src = String(data.image?.url || ""); applyZoom(); return panel;
  }

  function renderReviewButtons(request) {
    const status = requestStatus(request);
    const blocked = isAnnotationRequest(request) && state.requestPreview.requestId === request?.id && state.requestPreview.status !== "ready";
    els.approveRequest.disabled = !status.canDecide || blocked;
    els.rejectRequest.disabled = !status.canDecide;
  }

  function renderAnnotationReview(request) {
    if (!isAnnotationRequest(request)) return;
    const existing = els.requestDetail.querySelector(".annotation-review-panel");
    if (existing && state.requestPreview.requestId === request.id && state.requestPreview.status !== "idle") return;
    const panel = node("section", "annotation-review-panel annotation-review-loading"); panel.append(node("h3", "annotation-review-title", "Visual annotation preview"), node("p", "annotation-review-help", "Loading source image and proposed shapes…")); els.requestDetail.append(panel);
  }

  function requestContext(request) {
    const connection = state.connections.find(
      (item) => String(item.id) === String(request?.connectionId),
    );
    const project = request?.projectId
      ? projectName(request.projectId)
      : "Selected project";
    return {
      connection:
        connection?.name || request?.connectionId || "Connected client",
      project,
    };
  }

  function renderRequests(focusId = null) {
    clear(els.requests);
    els.requestCount.textContent = `${state.requests.length} request${state.requests.length === 1 ? "" : "s"}`;
    if (!state.requests.length) {
      els.requests.append(node("p", "muted", "No pending AI actions."));
      return;
    }

    state.requests.forEach((request) => {
      const status = requestStatus(request);
      const context = requestContext(request);
      const card = node("article", "request-row");
      card.dataset.requestId = request.id;
      const header = node("div", "request-card-head");
      const copy = node("div", "request-main");
      copy.append(
        node(
          "h3",
          "request-title",
          request.summary?.title || "Requested AI action",
        ),
        node("p", "request-meta", `${context.connection} · ${context.project}`),
      );
      const actions = node("div", "request-actions");
      actions.append(
        node(
          "span",
          `status-badge request-status ${status.className}`,
          status.label,
        ),
      );
      const review = node("button", "secondary-action", "Review action");
      review.type = "button";
      review.dataset.requestId = request.id;
      review.disabled = status.label === "Expired";
      review.addEventListener("click", () => openRequest(request.id, review));
      actions.append(review);
      header.append(copy, actions);
      card.append(header);

      const preview = node("div", "request-preview");
      appendRequestSummary(preview, request);
      const expiry = request.expiresAt
        ? `Expires ${formatDate(request.expiresAt)}`
        : "Expiration not provided";
      preview.append(node("p", "request-expiry", expiry));
      card.append(preview);
      els.requests.append(card);
    });

    if (focusId) {
      const card = els.requests.querySelector(
        `[data-request-id="${CSS.escape(String(focusId))}"]`,
      );
      card?.querySelector("button")?.focus();
    }
  }

  function renderRequestDetail(request, { preserveError = false } = {}) {
    clear(els.requestDetail);
    if (!preserveError) els.requestDialogError.textContent = "";
    const status = requestStatus(request);
    const context = requestContext(request);
    const heading = node("div", "request-detail-heading");
    heading.append(
      node(
        "span",
        `status-badge request-status ${status.className}`,
        status.label,
      ),
      node(
        "p",
        "request-detail-context",
        `${context.connection} · ${context.project}`,
      ),
    );
    els.requestDetail.append(
      heading,
      node(
        "h3",
        "request-detail-title",
        request.summary?.title || "Requested AI action",
      ),
    );
    appendRequestSummary(els.requestDetail, request);
    if (request.expiresAt) {
      els.requestDetail.append(
        node("p", "request-expiry", `Expires ${formatDate(request.expiresAt)}`),
      );
    }
    renderAnnotationReview(request);
    renderReviewButtons(request);
    if (!status.canDecide) {
      els.requestDialogError.textContent =
        status.label === "Expired"
          ? "This request expired and cannot be approved. Refresh to see the latest state."
          : "This request is no longer awaiting review.";
    }
  }

  function setRequestError(message) {
    els.requestDialogError.textContent = message;
    els.requestDialogError.focus();
  }

  async function openRequest(id, trigger = null) {
    state.requestTrigger = trigger || document.activeElement;
    const token = state.requestPreview.token + 1;
    state.requestPreview = { status: "loading", requestId: String(id), token, data: null };
    els.requestDialogError.textContent = "Loading request…";
    try {
      const data = await request(
        `/api/mcp/connections/requests/${encodeURIComponent(id)}`,
      );
      if (!data?.request)
        throw new Error("This request is no longer available.");
      state.activeRequest = data.request;
      state.requestPreview = { status: isAnnotationRequest(data.request) ? "loading" : "not-needed", requestId: String(data.request.id), token, data: null };
      renderRequestDetail(state.activeRequest);
      if (typeof els.requestDialog.showModal === "function")
        els.requestDialog.showModal();
      else els.requestDialog.setAttribute("open", "");
      els.closeRequestDialog.focus();
      if (isAnnotationRequest(state.activeRequest)) {
        try {
          const preview = await request(`/api/mcp/connections/requests/${encodeURIComponent(id)}/annotations`);
          if (state.requestPreview.token !== token || String(state.activeRequest?.id) !== String(id)) return;
          if (!preview?.image?.url || !Array.isArray(preview.shapes)) throw new Error("The annotation preview response was incomplete.");
          state.requestPreview = { status: "ready", requestId: String(id), token, data: preview };
          const currentPanel = els.requestDetail.querySelector(".annotation-review-panel");
          currentPanel?.replaceWith(reviewImagePanel(preview));
          renderReviewButtons(state.activeRequest);
        } catch (error) {
          if (state.requestPreview.token !== token || String(state.activeRequest?.id) !== String(id)) return;
          state.requestPreview = { status: "error", requestId: String(id), token, data: null };
          const currentPanel = els.requestDetail.querySelector(".annotation-review-panel");
          currentPanel?.classList.remove("annotation-review-loading");
          currentPanel?.replaceChildren(node("h3", "annotation-review-title", "Visual annotation preview"), node("p", "form-error", error.message || "The annotation preview could not be loaded. Approval is disabled."));
          renderReviewButtons(state.activeRequest);
        }
      }
    } catch (error) {
      setStatus(error.message || "This request could not be loaded.");
      els.requestDialogError.textContent = "";
    }
  }

  function closeRequestDialog() {
    if (els.requestDialog.open) els.requestDialog.close();
    else els.requestDialog.removeAttribute("open");
    state.activeRequest = null;
    state.requestPreview = { status: "idle", requestId: null, token: state.requestPreview.token + 1, data: null };
    els.requestDialogError.textContent = "";
    state.requestTrigger?.focus?.();
    state.requestTrigger = null;
  }

  function trapRequestFocus(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeRequestDialog();
      return;
    }
    if (event.key !== "Tab" || !els.requestDialog.open) return;
    const focusable = [
      ...els.requestDialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((item) => {
      if (item.closest("[hidden], [inert]")) return false;
      const style = window.getComputedStyle(item);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        item.getClientRects().length > 0
      );
    });
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function decideRequest(action) {
    const current = state.activeRequest;
    if (!current || state.requestSubmitting) return;
    const status = requestStatus(current);
    if (!status.canDecide) {
      setRequestError(
        "This request is stale or expired. Refresh to see the latest state.",
      );
      return;
    }
    state.requestSubmitting = true;
    els.approveRequest.disabled = true;
    els.rejectRequest.disabled = true;
    const button =
      action === "approve" ? els.approveRequest : els.rejectRequest;
    const originalText = button.textContent;
    button.textContent = action === "approve" ? "Approving…" : "Rejecting…";
    try {
      const result = await request(
        `/api/mcp/connections/requests/${encodeURIComponent(current.id)}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({ digest: current.digest }),
        },
      );
      const updated = result?.request;
      if (!updated)
        throw new Error("The server did not return the updated request.");
      state.requests = state.requests.map((item) =>
        String(item.id) === String(updated.id) ? updated : item,
      );
      closeRequestDialog();
      if (getRequestHashId() === String(current.id))
        history.replaceState(
          null,
          "",
          `${location.pathname}${location.search}`,
        );
      await loadRequests();
      renderRequests();
      notify(
        "success",
        action === "approve" ? "Action approved" : "Request rejected",
        action === "approve"
          ? "The AI client may now start this exact action."
          : "The AI client cannot start this request.",
      );
    } catch (error) {
      setRequestError(
        error.status === 409
          ? "This request is stale or expired. Refresh to see the latest state."
          : error.message || "The request could not be updated.",
      );
    } finally {
      state.requestSubmitting = false;
      button.textContent = originalText;
      if (state.activeRequest)
        renderRequestDetail(state.activeRequest, { preserveError: true });
    }
  }

  async function loadRequests() {
    els.refreshRequests.disabled = true;
    if (!state.requests.length)
      els.requests.replaceChildren(
        node("p", "muted", "Loading pending requests…"),
      );
    try {
      const data = await request("/api/mcp/connections/requests");
      state.requests = Array.isArray(data?.requests) ? data.requests : [];
      renderRequests();
      const hashId = getRequestHashId();
      if (hashId) await openRequest(hashId);
    } catch (error) {
      if (!state.requests.length)
        els.requests.replaceChildren(
          node("p", "muted", "Pending requests could not be loaded."),
        );
      setStatus(error.message || "Pending requests could not be loaded.");
    } finally {
      els.refreshRequests.disabled = false;
    }
  }

  function resetDialog() {
    state.step = 1;
    state.method = localEnabled() ? "local" : "remote";
    state.selectedProjects.clear();
    state.selectedScopes = new Set(
      state.scopes.filter(requiredScope).map((scope) => scope.id),
    );
    state.expiryDays =
      Number(
        caps().limits.defaultExpiryDays || state.config.defaultExpiryDays,
      ) || 30;
    state.creating = false;
    els.form.reset();
    els.token.value = "";
    els.tokenPanel.hidden = true;
    els.form.hidden = false;
    renderTransport();
    renderProjects();
    renderScopes();
    renderExpiry();
    updateDialogAction();
    clearError();
  }
  function openDialog() {
    if (state.tokenVisible) return;
    state.lastTrigger = document.activeElement;
    resetDialog();
    if (typeof els.dialog.showModal === "function") els.dialog.showModal();
    else els.dialog.setAttribute("open", "");
    els.close.focus();
  }
  function closeDialog() {
    if (state.tokenVisible) {
      focusError(
        "Save or dismiss the one-time token before closing setup.",
        els.dismissToken,
      );
      els.dismissToken.focus();
      return;
    }
    if (els.dialog.open) els.dialog.close();
    else els.dialog.removeAttribute("open");
    resetDialog();
    state.lastTrigger?.focus?.();
  }
  function dismissToken() {
    els.token.value = "";
    state.tokenVisible = false;
    state.tokenConnectionId = null;
    els.tokenPanel.hidden = true;
    closeDialog();
    updateStatusCard();
  }
  function trapFocus(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab" || !els.dialog.open) return;
    const focusable = [
      ...els.dialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((item) => {
      if (item.closest("[hidden], [inert]")) return false;
      const style = window.getComputedStyle(item);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        item.getClientRects().length > 0
      );
    });
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function loadConnections() {
    els.refresh.disabled = true;
    els.list.replaceChildren(node("p", "muted", "Loading connections…"));
    try {
      const data = await request("/api/mcp/connections");
      state.config = data || {};
      state.capabilities = data?.capabilities || {};
      state.projects = Array.isArray(data?.projects) ? data.projects : [];
      state.connections = Array.isArray(data?.connections)
        ? data.connections
        : [];
      state.scopes = Array.isArray(data?.scopes)
        ? data.scopes
        : [
            {
              id: "mcp:projects:read",
              label: "Project and image metadata",
              description:
                "Names, labels, dimensions, batches, and counts in selected projects.",
              required: true,
            },
          ];
      state.selectedScopes = new Set(
        state.scopes.filter(requiredScope).map((scope) => scope.id),
      );
      state.configLoaded = true;
      updateStatusCard();
      renderTransport();
      renderProjects();
      renderScopes();
      renderExpiry();
      renderConnections();
    } catch (error) {
      state.configLoaded = false;
      state.capabilities = {};
      els.list.replaceChildren(
        node("p", "muted", "Connections could not be loaded."),
      );
      setStatus(
        error.status === 401 || error.status === 403
          ? "Your session no longer has access. Sign in again to manage connections."
          : error.message,
      );
      updateStatusCard();
    } finally {
      els.refresh.disabled = false;
    }
  }

  els.open.addEventListener("click", openDialog);
  els.close.addEventListener("click", closeDialog);
  els.cancel.addEventListener("click", closeDialog);
  els.back.addEventListener("click", () => setStep(state.step - 1));
  els.next.addEventListener("click", () => {
    clearError();
    if (state.step === 1) {
      if (!methodAvailable(state.method))
        return focusError(
          "Choose an available transport before continuing.",
          els.transportOptions,
        );
      setStep(2);
    } else if (state.step === 2 && validateAccess()) setStep(3);
  });
  els.dialog.addEventListener("keydown", trapFocus);
  els.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  els.search.addEventListener("input", renderProjects);
  els.listSearch.addEventListener("input", () => renderConnections());
  els.refresh.addEventListener("click", loadConnections);
  els.copyToken.addEventListener("click", () =>
    copyText(els.token.value, "Token copied"),
  );
  els.dismissToken.addEventListener("click", dismissToken);
  els.refreshRequests.addEventListener("click", loadRequests);
  els.closeRequestDialog.addEventListener("click", closeRequestDialog);
  els.approveRequest.addEventListener("click", () => decideRequest("approve"));
  els.rejectRequest.addEventListener("click", () => decideRequest("reject"));
  els.requestDialog.addEventListener("keydown", trapRequestFocus);
  els.requestDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeRequestDialog();
  });
  window.addEventListener("hashchange", () => {
    const requestId = getRequestHashId();
    if (requestId) openRequest(requestId);
  });
  window.addEventListener("pagehide", () => {
    els.token.value = "";
  });
  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.step !== 3 || state.creating || !validateAccess()) return;
    state.creating = true;
    clearError();
    els.create.disabled = true;
    els.create.textContent = "Creating…";
    try {
      const result = await request("/api/mcp/connections", {
        method: "POST",
        body: JSON.stringify({
          name: els.name.value.trim(),
          projectIds: selectedProjectIds(),
          scopes: scopeIds(),
          expiresInDays: state.expiryDays,
        }),
      });
      if (!result?.connection || !result?.token) {
        const error = new Error(
          "Unable to confirm this connection token. Refresh the list, then revoke any connection without a saved token.",
        );
        error.ambiguous = true;
        throw error;
      }
      state.connections = [result.connection, ...state.connections];
      state.tokenVisible = true;
      state.tokenConnectionId = result.connection.id;
      els.token.value = String(result.token);
      els.tokenPanel.hidden = false;
      els.form.hidden = true;
      renderSetupInstructions();
      renderConnections();
      updateStatusCard();
      notify(
        "success",
        "Connection created",
        "Save the token before dismissing this message.",
      );
      els.token.focus();
    } catch (error) {
      const ambiguous = error.ambiguous || !error.status || error.status >= 500;
      focusError(
        ambiguous
          ? "Unable to confirm this connection. Refresh the list, then revoke any connection without a saved token."
          : error.message || "The server rejected this connection.",
        els.create,
      );
      notify(
        "error",
        ambiguous
          ? "Unable to confirm connection"
          : "Connection could not be created",
        error.message,
      );
    } finally {
      state.creating = false;
      els.create.disabled = false;
      els.create.textContent = "Create connection";
    }
  });
  resetDialog();
  await loadConnections();
  await loadRequests();
})();
