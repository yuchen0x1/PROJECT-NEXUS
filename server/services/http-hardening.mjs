import crypto from 'node:crypto'

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,96}$/

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

export function requestIdFor(value) {
  const candidate = typeof value === 'string' ? value.trim() : ''
  return REQUEST_ID_PATTERN.test(candidate) ? candidate : crypto.randomUUID()
}

/**
 * Apply headers that are safe for both the loopback API and the static app.
 * CSP remains owned by the desktop-only host because Vite development and
 * non-desktop deployments may need a different script/connect policy.
 */
export function applySecurityHeaders(res, { api = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()')
  if (api) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
  }
}

/**
 * Small in-memory fixed-window limiter for the single-process local service.
 * It is intentionally bounded and fail-open only for cleanup failures; it is
 * a resource guard, not a replacement for an authenticated multi-user edge.
 */
export function createRateLimiter({
  windowMs = 60_000,
  max = 600,
  maxEntries = 4096,
  now = () => Date.now()
} = {}) {
  const window = normalizePositiveInteger(windowMs, 60_000, { max: 86_400_000 })
  const limit = normalizePositiveInteger(max, 600, { max: 1_000_000 })
  const entries = new Map()

  function prune(current) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= current) entries.delete(key)
    }
    if (entries.size <= maxEntries) return
    const oldest = [...entries.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)
    for (const [key] of oldest.slice(0, entries.size - maxEntries)) entries.delete(key)
  }

  return function rateLimit(req, res, next) {
    const current = now()
    prune(current)
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128)
    let entry = entries.get(key)
    if (!entry || entry.resetAt <= current) {
      entry = { count: 0, resetAt: current + window }
      entries.set(key, entry)
    }
    entry.count += 1
    const remaining = Math.max(0, limit - entry.count)
    res.setHeader('X-RateLimit-Limit', String(limit))
    res.setHeader('X-RateLimit-Remaining', String(remaining))
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)))
    if (entry.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - current) / 1000))
      res.setHeader('Retry-After', String(retryAfter))
      return res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many local API requests. Retry after the indicated delay.' })
    }
    return next()
  }
}

export function apiNotFound(res, requestId) {
  return res.status(404).json({ code: 'API_NOT_FOUND', message: 'The requested API route does not exist.', requestId })
}

export function safeHttpError(error, requestId) {
  const status = Number(error?.statusCode || error?.status)
  const normalizedStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500
  const code = typeof error?.code === 'string' && /^[A-Z0-9_:-]{2,80}$/.test(error.code) ? error.code : 'INTERNAL_ERROR'
  return {
    status: normalizedStatus,
    body: {
      code,
      message: normalizedStatus >= 500 ? 'The local service could not complete the request.' : String(error?.message || 'Request failed').slice(0, 500),
      requestId
    }
  }
}
