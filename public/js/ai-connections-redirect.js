(() => {
  const hash = window.location.hash.replace(/^#/, "");
  const query = hash.startsWith("mcp?") ? hash.slice(4) : hash;
  const requestId = new URLSearchParams(query).get("request");
  const target = requestId
    ? `/jobs#mcp?request=${encodeURIComponent(requestId)}`
    : "/jobs#mcp";
  window.location.replace(target);
})();
