import { describe, it, expect } from 'vitest'
import { deliveryGate, maybeMergePullRequest, shouldCloseIssue } from '../../server/services/delivery-stage.mjs'

const verification = { attempted: true, passed: true, results: [{ label: 'test', attempted: true, ok: true }] }
const review = { verdict: 'approve', findings: [] }

describe('delivery evidence gates', () => {
  it('requires actual runtime verification and independent review', () => {
    expect(deliveryGate(verification, review)).toBeNull()
    for (const check of [null, { status: 'PASS' }, { ...verification, passed: false }, { ...verification, results: [] }]) expect(deliveryGate(check, review)).toBeTruthy()
    for (const check of [null, { findings: [] }, { verdict: 'request_changes' }, { ...review, findings: [{ severity: 'CRITICAL' }] }]) expect(deliveryGate(verification, check)).toBeTruthy()
  })
  it('pins merges to the tested SHA and rejects a non-confirmed merge', async () => {
    const result = await maybeMergePullRequest({
      repository: 'owner/repo', policy: { autoMerge: true }, pullRequest: { number: 1, headSha: 'tested-sha' }, verification, review,
      request: async (endpoint, options = {}) => {
        if (endpoint.endsWith('/pulls/1')) return { head: { sha: 'tested-sha' } }
        if (endpoint.includes('check-runs')) return { check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] }
        if (!options.method) return { statuses: [] }
        expect(JSON.parse(options.body).sha).toBe('tested-sha'); return { status: 200, merged: false }
      }
    })
    expect(result.merged).toBe(false)
  })
  it('never closes after branch push alone or implicit merge-only permission', () => {
    const base = { policy: { closeIssueAfterRelease: true }, verification, review, delivery: { pushed: true, issueCommented: true } }
    expect(shouldCloseIssue(base).close).toBe(false)
    base.delivery.merged = { merged: true }
    expect(shouldCloseIssue(base).close).toBe(false)
    expect(shouldCloseIssue({ ...base, policy: { ...base.policy, closeIssueAfterMerge: true } }).close).toBe(true)
  })
})
