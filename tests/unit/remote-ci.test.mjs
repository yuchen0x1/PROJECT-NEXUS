import { describe, expect, it } from 'vitest'
import { inspectRemoteCI, waitForRemoteCI } from '../../server/services/remote-ci.mjs'

describe('remote CI merge barrier', () => {
  const args = { repository: 'a/b', pullRequest: { number: 1, headSha: 'tested' }, policy: { requiredChecks: ['test'] } }
  const provider = (runs = [], statuses = [], head = 'tested') => async (endpoint) => endpoint.includes('/pulls/') ? { head: { sha: head } } : endpoint.includes('check-runs') ? { total_count: runs.length, check_runs: runs } : { total_count: statuses.length, statuses }
  it('accepts successful required checks and rejects failed, pending and changed heads', async () => {
    const run = { id: 1, name: 'test', status: 'completed', conclusion: 'success' }
    expect((await inspectRemoteCI({ ...args, request: provider([run]) })).passed).toBe(true)
    expect((await inspectRemoteCI({ ...args, request: provider([{ ...run, conclusion: 'failure' }]) })).passed).toBe(false)
    expect((await inspectRemoteCI({ ...args, request: provider([{ ...run, status: 'in_progress' }]) })).passed).toBe(false)
    expect((await inspectRemoteCI({ ...args, request: provider([run], [], 'new') })).passed).toBe(false)
  })
  it('requires explicit permission when CI is absent, and never masks a failed check', async () => {
    expect((await inspectRemoteCI({ ...args, policy: {}, request: provider() })).passed).toBe(false)
    expect((await inspectRemoteCI({ ...args, policy: { allowNoCI: true }, request: provider() })).passed).toBe(true)
    expect((await inspectRemoteCI({ ...args, policy: { allowNoCI: true }, request: provider([], [{ id: 1, context: 'test', state: 'failure' }]) })).passed).toBe(false)
  })
  it('waits for queued CI and stops at its timeout without merging', async () => {
    let reads = 0
    const request = async (endpoint) => {
      if (endpoint.includes('/pulls/')) return { head: { sha: 'tested' } }
      if (endpoint.includes('check-runs')) return { check_runs: [{ id: 1, name: 'test', status: ++reads > 1 ? 'completed' : 'in_progress', conclusion: reads > 1 ? 'success' : null }] }
      return { statuses: [] }
    }
    expect((await waitForRemoteCI({ ...args, request }, { timeoutMs: 100, intervalMs: 1 })).passed).toBe(true)
    expect((await waitForRemoteCI({ ...args, request: provider() }, { timeoutMs: 2, intervalMs: 1 })).passed).toBe(false)
  })
})
