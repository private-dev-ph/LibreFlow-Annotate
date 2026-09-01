const { authenticateApiKey } = require('../lib/api-keys');

function authenticateAutomation(req, res, next) {
  if (req.session?.userId) {
    req.authContext = {
      type: 'session',
      userId: req.session.userId,
      username: req.session.username,
      scopes: ['*'],
      projectIds: [],
    };
    return next();
  }

  const authorization = String(req.get('authorization') || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const apiKey = match ? authenticateApiKey(match[1].trim()) : null;
  if (!apiKey) return res.status(401).json({ error: 'A valid session or Bearer API key is required.' });

  req.authContext = {
    type: 'api_key',
    userId: apiKey.userId,
    keyId: apiKey.id,
    scopes: apiKey.scopes,
    projectIds: apiKey.projectIds || [],
  };
  next();
}

function requireScopes(...required) {
  return (req, res, next) => {
    // Routers can also be mounted directly by browser-only callers/tests. A
    // session is equivalent to the existing fully privileged browser path;
    // API keys still have to carry each declared scope.
    if (req.authContext?.type === 'session' || (!req.authContext && req.session?.userId)) return next();
    const granted = req.authContext?.scopes || [];
    if (granted.includes('*') || required.every(scope => granted.includes(scope))) return next();
    return res.status(403).json({ error: `Missing API scope: ${required.filter(scope => !granted.includes(scope)).join(', ')}` });
  };
}

function requireSession(req, res, next) {
  if (req.authContext?.type === 'session' || (!req.authContext && req.session?.userId)) return next();
  return res.status(403).json({ error: 'This operation requires an interactive session.' });
}

module.exports = { authenticateAutomation, requireScopes, requireSession };
