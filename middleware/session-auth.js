function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  const requestPath = req.originalUrl || `${req.baseUrl || ''}${req.path || ''}`;
  if (requestPath.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  return res.redirect('/login');
}

module.exports = { requireAuth };
