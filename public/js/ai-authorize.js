/* Remote OAuth consent. Only server-requested summary fields enter the DOM. */
(async () => {
  const els = {
    avatar: document.getElementById("nav-avatar"),
    username: document.getElementById("nav-username"),
    status: document.getElementById("page-status"),
    error: document.getElementById("page-error"),
    login: document.getElementById("login-step"),
    loginCopy: document.getElementById("login-copy"),
    continueLogin: document.getElementById("continue-login"),
    form: document.getElementById("consent-form"),
    client: document.getElementById("client-name"),
    user: document.getElementById("user-name"),
    clientNote: document.getElementById("client-note-name"),
    projects: document.getElementById("project-list"),
    scopes: document.getElementById("scope-list"),
    scopeHelp: document.getElementById("scope-help"),
    expiry: document.getElementById("expiry-options"),
    approve: document.getElementById("approve-consent"),
    deny: document.getElementById("deny-consent"),
  };
  const state = {
    details: null,
    selectedProjects: new Set(),
    selectedScopes: new Set(),
    expiryDays: 30,
    submitting: false,
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }
  function setStatus(message = "") {
    els.status.textContent = message;
  }
  function setError(message = "") {
    els.error.textContent = message;
    if (message) els.error.focus();
  }
  function scopeById(id) {
    return state.details?.scopes?.find((scope) => scope.id === id);
  }
  function scopeLabel(id) {
    return scopeById(id)?.label || id;
  }
  function scopeRequirements(scope) {
    if (Array.isArray(scope?.requires)) return scope.requires.filter(Boolean);
    return scope?.requires ? [scope.requires] : [];
  }
  function dependencyIssues() {
    const issues = [];
    state.details.scopes
      .filter((scope) => state.selectedScopes.has(scope.id))
      .forEach((scope) => {
        scopeRequirements(scope).forEach((required) => {
          if (!scopeById(required)) {
            issues.push(
              `${scopeLabel(scope.id)} requires an unavailable permission.`,
            );
          } else if (!state.selectedScopes.has(required)) {
            issues.push(
              `${scopeLabel(scope.id)} requires ${scopeLabel(required)}. Select both explicitly.`,
            );
          }
        });
      });
    return [...new Set(issues)];
  }
  function isActionScope(scope) {
    return scope?.action === true;
  }
  function isRequiredScope(scope) {
    return scope?.required === true || scope?.id === "mcp:projects:read";
  }
  function isScopeDisabled(scope) {
    return isActionScope(scope) && state.details.writesEnabled !== true;
  }
  function selectedScopeIds() {
    return state.details.scopes
      .filter((scope) => state.selectedScopes.has(scope.id))
      .map((scope) => scope.id);
  }
  function selectedProjectIds() {
    return state.details.projects
      .filter((project) => state.selectedProjects.has(String(project.id)))
      .map((project) => project.id);
  }
  function requestBase() {
    return window.location.pathname.replace(/\/$/, "");
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
    if (!response || typeof response.text !== "function") return response;
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
  function safeRedirect(redirectTo) {
    try {
      const destination = new URL(redirectTo, window.location.origin);
      if (
        destination.origin !== window.location.origin ||
        !destination.pathname.startsWith("/oauth/")
      )
        throw new Error();
      return destination.href;
    } catch {
      throw new Error(
        "The provider returned an unsafe redirect. Return to AI connections and try again.",
      );
    }
  }
  function navigate(result) {
    if (!result?.redirectTo)
      throw new Error("The provider did not return a continuation.");
    window.location.assign(safeRedirect(result.redirectTo));
  }
  function renderProjects() {
    clear(els.projects);
    if (!state.details.projects.length) {
      els.projects.append(
        node("p", "project-empty", "No project access was requested."),
      );
      return;
    }
    state.details.projects.forEach((project) => {
      const label = node("label", "project-choice");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = state.selectedProjects.has(String(project.id));
      input.addEventListener("change", () => {
        if (input.checked) state.selectedProjects.add(String(project.id));
        else state.selectedProjects.delete(String(project.id));
      });
      label.append(input, node("span", "", project.name || "Unnamed project"));
      els.projects.append(label);
    });
  }
  function renderScopes() {
    clear(els.scopes);
    const scopes = Array.isArray(state.details.scopes)
      ? state.details.scopes
      : [];
    if (!scopes.length) {
      els.scopes.append(
        node("p", "scope-empty", "No permissions were requested."),
      );
      return;
    }
    scopes.forEach((scope) => {
      const disabled = isScopeDisabled(scope);
      const required = isRequiredScope(scope);
      const label = node(
        "label",
        `scope-row${required ? " required-scope" : ""}${disabled ? " is-disabled" : ""}`,
      );
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `scope-${String(scope.id).replace(/[^a-z0-9_-]/gi, "-")}`;
      input.checked = state.selectedScopes.has(scope.id);
      input.disabled = required || disabled;
      input.addEventListener("change", () => {
        if (input.checked) state.selectedScopes.add(scope.id);
        else state.selectedScopes.delete(scope.id);
        updateScopeHelp();
      });
      const copy = node("span", "scope-copy");
      copy.append(
        node(
          "strong",
          "",
          `${scope.label || scope.id}${required ? " · Required" : ""}`,
        ),
      );
      if (scope.description) copy.append(node("small", "", scope.description));
      const requirements = scopeRequirements(scope);
      if (requirements.length)
        copy.append(
          node(
            "em",
            "",
            `Requires explicit selection: ${requirements.map(scopeLabel).join(", ")}`,
          ),
        );
      if (disabled)
        copy.append(
          node(
            "em",
            "scope-unavailable",
            "Action permissions are unavailable for this client.",
          ),
        );
      label.append(input, copy);
      els.scopes.append(label);
    });
    updateScopeHelp();
  }
  function updateScopeHelp() {
    const issues = dependencyIssues();
    els.scopeHelp.textContent = issues.length
      ? issues.join(" ")
      : "Permissions are shared exactly as selected; dependencies are never added automatically.";
    els.scopeHelp.classList.toggle("has-error", issues.length > 0);
  }
  function renderExpiry() {
    clear(els.expiry);
    state.expiryDays = [1, 7, 30].includes(Number(state.details.expiresInDays))
      ? Number(state.details.expiresInDays)
      : 30;
    [1, 7, 30].forEach((days) => {
      const wrapper = node("div", "expiry-option");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "expiresInDays";
      input.id = `expiry-${days}`;
      input.value = String(days);
      input.checked = state.expiryDays === days;
      input.addEventListener("change", () => {
        state.expiryDays = days;
      });
      const label = node("label", "", `${days} day${days === 1 ? "" : "s"}`);
      label.htmlFor = input.id;
      wrapper.append(input, label);
      els.expiry.append(wrapper);
    });
  }
  function validateConsent() {
    if (!selectedProjectIds().length) {
      setError("Select at least one project before approving access.");
      return false;
    }
    if (!selectedScopeIds().length) {
      setError("Select at least one permission before approving access.");
      return false;
    }
    const issues = dependencyIssues();
    if (issues.length) {
      setError(issues[0]);
      return false;
    }
    return true;
  }
  function setSubmitting(submitting, label, button = els.approve) {
    state.submitting = submitting;
    els.approve.disabled = submitting;
    els.deny.disabled = submitting;
    if (label) button.textContent = label;
  }
  function renderDetails(data) {
    state.details = data;
    state.selectedProjects.clear();
    state.selectedScopes = new Set(
      state.details.scopes.filter(isRequiredScope).map((scope) => scope.id),
    );
    els.client.textContent = data.client?.name || "Unnamed client";
    els.clientNote.textContent = data.client?.name || "this client";
    els.user.textContent = data.user?.username || "this LibreFlow user";
    els.avatar.textContent = String(data.user?.username || "?")
      .slice(0, 2)
      .toUpperCase();
    els.username.textContent = data.user?.username || "Signed in";
    if (data.loginStep) {
      els.login.hidden = false;
      els.form.hidden = true;
      els.loginCopy.textContent = `Continue as ${data.user?.username || "this LibreFlow user"} to complete the provider sign-in handshake.`;
      els.continueLogin.textContent = `Continue as ${data.user?.username || "this LibreFlow user"}`;
    } else {
      els.login.hidden = true;
      els.form.hidden = false;
      renderProjects();
      renderScopes();
      renderExpiry();
    }
  }
  async function submitLogin() {
    if (state.submitting) return;
    setError("");
    state.submitting = true;
    els.continueLogin.disabled = true;
    els.continueLogin.textContent = "Continuing…";
    try {
      navigate(
        await request(`${requestBase()}/approve`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
      );
    } catch (error) {
      setError(error.message || "The provider sign-in could not continue.");
      state.submitting = false;
      els.continueLogin.disabled = false;
      els.continueLogin.textContent = `Continue as ${state.details.user?.username || "this LibreFlow user"}`;
    }
  }
  async function denyConsent() {
    if (state.submitting) return;
    setError("");
    setSubmitting(true, "Denying…", els.deny);
    try {
      navigate(
        await request(`${requestBase()}/deny`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
      );
    } catch (error) {
      setError(error.message || "The provider could not record your decision.");
      setSubmitting(false, "Approve access", els.approve);
    }
  }
  els.continueLogin.addEventListener("click", submitLogin);
  els.deny.addEventListener("click", denyConsent);
  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");
    if (state.submitting || !validateConsent()) return;
    setSubmitting(true, "Approving…");
    try {
      navigate(
        await request(`${requestBase()}/approve`, {
          method: "POST",
          body: JSON.stringify({
            projectIds: selectedProjectIds(),
            scopes: selectedScopeIds(),
            expiresInDays: state.expiryDays,
          }),
        }),
      );
    } catch (error) {
      setError(error.message || "The provider could not record your approval.");
      setSubmitting(false, "Approve access");
    }
  });

  try {
    const data = await request(`${requestBase()}/details`);
    if (
      !data?.client ||
      !data?.user ||
      !Array.isArray(data.projects) ||
      !Array.isArray(data.scopes)
    )
      throw new Error("Authorization details are incomplete.");
    renderDetails(data);
    setStatus("");
    if (data.loginStep) els.continueLogin.focus();
    else els.projects.querySelector("input")?.focus();
  } catch (error) {
    setStatus("");
    setError(error.message || "Authorization details could not be loaded.");
  }
})();
