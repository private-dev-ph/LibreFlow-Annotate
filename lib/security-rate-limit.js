function createAuthRateLimiter({ windowMs = 15 * 60 * 1000, maxAttempts = 10, maxKeys = 10000 } = {}) {
  const attempts = new Map();
  return function authRateLimit(req, res, next) {
    const identity = String(req.rateLimitIdentity || '').slice(0, 254).toLowerCase();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const keys = [`ip:${ip}`, `identity:${identity || '(missing)'}`];
    const now = Date.now();
    let blocked = null;
    for (const key of keys) {
      let item = attempts.get(key);
      if (!item || item.resetAt <= now) item = { count: 0, resetAt: now + windowMs };
      item.count += 1;
      attempts.set(key, item);
      if (!blocked || item.count > blocked.count) blocked = item;
    }
    if (attempts.size > maxKeys) {
      for (const [storedKey, stored] of attempts) if (stored.resetAt <= now) attempts.delete(storedKey);
      while (attempts.size > maxKeys) attempts.delete(attempts.keys().next().value);
    }
    res.setHeader('RateLimit-Limit', String(maxAttempts));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, maxAttempts - blocked.count)));
    if (blocked.count > maxAttempts) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((blocked.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Too many authentication attempts. Try again later.' });
    }
    next();
  };
}

module.exports = { createAuthRateLimiter };
