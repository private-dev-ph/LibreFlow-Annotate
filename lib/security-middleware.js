const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function createOriginPolicy({ allowedOrigins = [], production = false } = {}) {
  const allow = new Set(allowedOrigins);
  return {
    corsOrigin(origin, requestOrigin) {
      if (!origin) return true;
      return allow.has(origin) || (!production && origin === requestOrigin);
    },
    csrf(req, res, next) {
      if (!MUTATING_METHODS.has(req.method)) return next();
      const authorization = req.get('authorization') || '';
      const hasBearer = /^Bearer\s+\S+/i.test(authorization);
      const hasCookie = Boolean(req.headers.cookie);
      if (hasBearer && !hasCookie) return next();

      const origin = req.get('origin');
      const hostOrigin = `${req.protocol}://${req.get('host')}`;
      const accepted = origin && (allow.has(origin) || (!production && origin === hostOrigin));
      if (!accepted) return res.status(403).json({ error: 'Request origin is not allowed.' });
      next();
    },
  };
}

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "upgrade-insecure-requests",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

module.exports = { createOriginPolicy, securityHeaders };
