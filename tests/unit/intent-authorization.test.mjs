import { afterEach, describe, expect, it } from 'vitest'
import { openAutonomyStore } from '../../server/autonomy/db.mjs'
import { IntentAuthorizer, INTENT_ACTIONS } from '../../server/services/intent-authorization.mjs'

const stores = []
function fixture(role = 'Administrator') {
  const store = openAutonomyStore({ file: ':memory:' })
  stores.push(store)
  let now = Date.parse('2026-11-23T00:00:00.000Z')
  const authorizer = new IntentAuthorizer({ store, actor: { id: 'user-1', role, source: 'test' }, clock: () => now })
  return { store, authorizer, advance: (ms) => { now += ms } }
}
afterEach(() => { for (const store of stores.splice(0)) store.close() })

describe('action intent authorization', () => {
  it('fails closed before a grant and requires exact scope/confirmation', () => {
    const { authorizer } = fixture()
    expect(() => authorizer.authorize({ action: INTENT_ACTIONS.PULL_REQUEST_CREATE, scope: { repository: 'acme/app', branch: 'nexus/auto/t1' }, confirm: true })).toThrowError(/No active intent/)
    const grant = authorizer.grant({ action: INTENT_ACTIONS.PULL_REQUEST_CREATE, scope: { repository: 'acme/app', branch: 'nexus/auto/t1' }, reason: 'fixture', duration: 'once' })
    expect(() => authorizer.authorize({ action: INTENT_ACTIONS.PULL_REQUEST_CREATE, scope: { repository: 'acme/app', branch: 'nexus/auto/t2' }, confirm: true })).toThrowError(/No active intent/)
    expect(() => authorizer.authorize({ action: INTENT_ACTIONS.PULL_REQUEST_CREATE, scope: { repository: 'acme/app', branch: 'nexus/auto/t1' }, confirm: false })).toThrowError(/confirm=true/)
    const allowed = authorizer.authorize({ action: INTENT_ACTIONS.PULL_REQUEST_CREATE, scope: { repository: 'acme/app', branch: 'nexus/auto/t1' }, confirm: true })
    expect(allowed.grant.id).toBe(grant.id)
    expect(authorizer.complete(allowed.record.id, { outcome: 'SUCCEEDED' })).toMatchObject({ status: 'SUCCEEDED' })
    expect(() => authorizer.authorize({ action: INTENT_ACTIONS.PULL_REQUEST_CREATE, scope: { repository: 'acme/app', branch: 'nexus/auto/t1' }, confirm: true })).toThrowError(/already been used/)
    expect(authorizer.store.count('intent_uses')).toBe(1)
  })

  it('does not widen a branch-scoped grant when the request omits its branch', () => {
    const { authorizer } = fixture()
    authorizer.grant({ action: INTENT_ACTIONS.GIT_COMMIT, scope: { repository: 'acme/app', branch: 'nexus/auto/t1' }, duration: 'session' })
    expect(() => authorizer.authorize({ action: INTENT_ACTIONS.GIT_COMMIT, scope: { repository: 'acme/app' }, confirm: true })).toThrowError(/No active intent/)
  })

  it('expires and revokes grants, and records durable audit events', () => {
    const { authorizer, advance, store } = fixture()
    const grant = authorizer.grant({ action: INTENT_ACTIONS.LOCAL_FILE_WRITE, scope: { repository: '__global__' }, duration: 'once' })
    advance(10 * 60_000 + 1)
    expect(() => authorizer.authorize({ action: INTENT_ACTIONS.LOCAL_FILE_WRITE, scope: { repository: '__global__' }, confirm: true })).toThrowError(/No active intent/)
    const second = authorizer.grant({ action: INTENT_ACTIONS.LOCAL_FILE_WRITE, scope: { repository: '__global__' }, duration: 'session' })
    expect(authorizer.revoke(second.id)).toMatchObject({ status: 'REVOKED' })
    expect(() => authorizer.authorize({ action: INTENT_ACTIONS.LOCAL_FILE_WRITE, scope: { repository: '__global__' }, confirm: true })).toThrowError(/No active intent/)
    expect(store.count('audit_log')).toBeGreaterThanOrEqual(3)
    expect(grant.status).toBe('ACTIVE')
  })

  it('does not let a Viewer grant or use writable actions', () => {
    const { authorizer } = fixture('Viewer')
    expect(() => authorizer.grant({ action: INTENT_ACTIONS.GIT_COMMIT, scope: { repository: 'acme/app' } })).toThrowError(/Only an Administrator/)
    expect(() => authorizer.authorize({ action: INTENT_ACTIONS.GIT_COMMIT, scope: { repository: 'acme/app' }, confirm: true })).toThrowError(/requires Operator/)
  })
})
