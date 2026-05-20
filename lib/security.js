// Lightweight, dependency-free security helpers for the portal.
// Covers the three Critical hardening items: a non-hardcoded session secret,
// security response headers (helmet-lite), and login rate limiting.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_FILE = path.join(__dirname, '..', 'secrets', 'session-secret.txt');

// Resolve the session secret from the environment first. If absent (typical in
// local/dev), fall back to a persisted random secret so sessions survive
// restarts instead of being signed with a value hardcoded in source.
function resolveSessionSecret() {
  const fromEnv = process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim();
  if (fromEnv) return fromEnv;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set as an environment variable in production.');
  }

  try {
    if (fs.existsSync(SECRET_FILE)) {
      const stored = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (stored) return stored;
    }
    const generated = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    console.log('[SECURITY] Generated a persistent dev session secret at secrets/session-secret.txt');
    return generated;
  } catch (err) {
    console.warn('[SECURITY] Could not persist a session secret, using an ephemeral one:', err.message);
    return crypto.randomBytes(48).toString('hex');
  }
}

// Conservative security headers. Intentionally omits a strict Content-Security-Policy:
// the admin pages still rely on inline scripts, so a CSP needs its own migration
// before it can be enabled without breaking those screens.
function securityHeaders() {
  const isProd = process.env.NODE_ENV === 'production';
  return (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-XSS-Protection', '0'); // legacy auditor is disabled in modern browsers; explicit off is safest
    res.set('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
    if (isProd) {
      res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  };
}

// Per-IP fixed-window limiter for sensitive endpoints (login). In-memory and
// best-effort: it protects a single instance against brute force without adding
// a dependency. A distributed deployment would move this to a shared store.
function loginRateLimiter({ windowMs = 15 * 60 * 1000, max = 20 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Opportunistic cleanup so the map cannot grow unbounded.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(ip);
    }
  }, windowMs);
  if (sweep.unref) sweep.unref();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        message: 'Too many attempts. Please wait a few minutes and try again.'
      });
    }
    next();
  };
}

module.exports = { resolveSessionSecret, securityHeaders, loginRateLimiter };
