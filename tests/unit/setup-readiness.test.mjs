import { describe, expect, it } from 'vitest'
import { readinessFingerprint, validateReadiness } from '../../server/services/setup-readiness.mjs'

describe('setup evidence binding', () => {
  it('expires and invalidates after repository, policy, account, key or host changes', () => {
    const context = { project: { id: 'one', fullName: 'a/one', hosting: { strategy: 'maintain' } }, provider: { id: 'p', model: 'm', apiKey: 'fixture' }, account: 'a', credential: 'fixture-gh', epoch: 'host-1' }
    const fingerprint = readinessFingerprint(context)
    const record = { id: 'ready', fingerprint, expiresAt: new Date(2000).toISOString() }
    expect(validateReadiness(record, { id: 'ready', fingerprint, now: 1000 })).toBe(true)
    expect(() => validateReadiness(record, { id: 'ready', fingerprint, now: 2000 })).toThrow(/expired/)
    for (const changed of [
      { ...context, project: { ...context.project, id: 'two' } },
      { ...context, project: { ...context.project, archived: true } },
      { ...context, project: { ...context.project, repoMeta: { archived: true } } },
      { ...context, project: { ...context.project, hosting: { strategy: 'autonomous' } } },
      { ...context, account: 'b' }, { ...context, credential: 'new' },
      { ...context, provider: { ...context.provider, apiKey: 'new' } }, { ...context, epoch: 'host-2' }
    ]) expect(() => validateReadiness(record, { id: 'ready', fingerprint: readinessFingerprint(changed), now: 1000 })).toThrow(/changed/)
  })
})
