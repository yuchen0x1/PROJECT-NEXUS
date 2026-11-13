import { describe, expect, it } from 'vitest'
import { assertHostingWrite, hostingOperation, hostedResult, automaticFixDecision } from '../../server/services/hosting-gates.mjs'

describe('hosting acceptance gates', () => {
  it('keeps a failed release distinct from successful execution', () => {
    const outcome = { status: 'Succeeded', delivery: { pushed: true, pullRequest: { number: 1 }, merged: { merged: true }, released: { published: false } } }
    expect(hostedResult(outcome, { autoPush: true, autoMerge: true, autoPublish: true })).toMatchObject({ status: 'Blocked', executionStatus: 'Succeeded', deliveryStatus: 'Incomplete', missing: ['release', 'close'] })
    expect(hostedResult(outcome, {})).toMatchObject({ status: 'Succeeded', deliveryStatus: 'NotRequested' })
  })
  it('rechecks individual permissions after revocation', () => {
    const project = { hosting: { enabled: true, strategy: 'autonomous', autoMerge: true } }
    const check = () => assertHostingWrite({ project, enabled: true, paused: false, operation: 'merge' })
    expect(check).not.toThrow()
    project.hosting.autoMerge = false
    expect(check).toThrow(/revoked/)
    expect(hostingOperation('/repos/a/b/pulls/1/merge', { method: 'PUT' })).toBe('merge')
    expect(hostingOperation('/repos/a/b/releases', {})).toBeNull()
  })
  it('requires review for fallback, low-confidence and high-risk triage', () => {
    const policy = { enabled: true, strategy: 'autonomous', requireApprovalForHighRisk: true }
    const triage = { source: 'ai', confidence: 0.9, category: 'BUG', severity: 'P2' }
    expect(automaticFixDecision(policy, triage, {})).toBeNull()
    expect(automaticFixDecision(policy, { ...triage, source: 'heuristic' }, {})).toBe('triage_requires_review')
    expect(automaticFixDecision(policy, { ...triage, severity: 'P0' }, {})).toBe('high_risk_requires_review')
  })
})
