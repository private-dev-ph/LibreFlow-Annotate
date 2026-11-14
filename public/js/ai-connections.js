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
    const response = await fetch(url, {
      credentials: "include",
      ...options,
      headers: options.body
        ? { "Content-Type": "application/json", ...(options.headers || {}) }
        : options.headers,
    });
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
})();
