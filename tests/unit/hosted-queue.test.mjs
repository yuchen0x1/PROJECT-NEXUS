import { describe, it, expect } from 'vitest'
import { queueHostedJob, nextHostedJobIndex, recoverHostedJobs } from '../../server/services/hosted-queue.mjs'

describe('durable hosted queue', () => {
  it('queues multiple issues in one repo, deduplicates deliveries, and isolates repos', () => {
    const state = {}
    const first = queueHostedJob(state, { projectId: 'a', repository: 'owner/a', issueNumber: 1 })
    queueHostedJob(state, { projectId: 'a', repository: 'owner/a', issueNumber: 2 })
    queueHostedJob(state, { projectId: 'b', repository: 'owner/b', issueNumber: 1 })
    expect(queueHostedJob(state, { repository: 'owner/a', issueNumber: 1 }).job.id).toBe(first.job.id)
    expect(state.hostedJobs).toHaveLength(3)
    const restored = JSON.parse(JSON.stringify(state))
    expect(recoverHostedJobs(restored)).toHaveLength(3)
  })
  it('selects by priority while holding active repository locks', () => {
    const pending = [
      { repoKey: 'a', job: { priority: 'P0' } },
      { repoKey: 'b', job: { priority: 'P3' } },
      { repoKey: 'c', job: { priority: 'P1' } }
    ]
    expect(nextHostedJobIndex(pending, new Set(['a']))).toBe(2)
    expect(nextHostedJobIndex(pending, new Set(['a', 'c']))).toBe(1)
    expect(nextHostedJobIndex(pending, new Set(['a', 'b', 'c']))).toBe(-1)
  })
  it('retains uncertain remote writes rather than replaying after a crash', () => {
    const state = { hostedJobs: [{ id: 'job', status: 'Running', outcome: { pushed: true } }] }
    expect(recoverHostedJobs(state)).toEqual([])
    expect(state.hostedJobs[0]).toMatchObject({ status: 'Interrupted', outcome: { pushed: true } })
  })
  it('does not enqueue a second fix over an incomplete remote delivery', () => {
    const state = { hostedJobs: [{ id: 'delivery', repository: 'a/b', issueNumber: 1, status: 'Blocked', operations: [{ status: 'Uncertain' }] }] }
    expect(queueHostedJob(state, { projectId: 'p', repository: 'a/b', issueNumber: 1 }).reused).toBe(true)
  })
})
