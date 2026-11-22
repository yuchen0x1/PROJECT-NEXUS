import { describe, expect, it } from 'vitest'
import { applySecurityHeaders, createRateLimiter, requestIdFor, safeHttpError } from '../../server/services/http-hardening.mjs'

function responseStub() {
  const headers = new Map()
  return {
    headers,
    setHeader(name, value) { headers.set(name, String(value)) },
    statusCode: 200,
    status(code) { this.statusCode = code; return this },
    json(value) { this.body = value; return this }
  }
}

describe('HTTP hardening', () => {
  it('accepts safe request ids and replaces untrusted values', () => {
    expect(requestIdFor('ui-action_123')).toBe('ui-action_123')
    expect(requestIdFor('bad id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(requestIdFor()).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('applies no-store API and browser hardening headers', () => {
    const response = responseStub()
    applySecurityHeaders(response, { api: true })
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('returns a bounded 429 after the configured request budget', () => {
    let now = 1000
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => now })
    const request = { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } }
    const first = responseStub(); const second = responseStub(); const third = responseStub()
    let nextCalls = 0
    const next = () => { nextCalls += 1 }
    limiter(request, first, next); limiter(request, second, next); limiter(request, third, next)
    expect(nextCalls).toBe(2)
    expect(third.statusCode).toBe(429)
    expect(third.body.code).toBe('RATE_LIMITED')
    now += 1001
    const fourth = responseStub(); limiter(request, fourth, next)
    expect(nextCalls).toBe(3)
  })

  it('redacts unexpected server errors while retaining a trace id', () => {
    expect(safeHttpError(Object.assign(new Error('secret details'), { status: 500 }), 'req-1')).toEqual({
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'The local service could not complete the request.', requestId: 'req-1' }
    })
  })
})
