import { describe, expect, it } from 'vitest'
import { upsertIssueActivity } from '../../server/services/issue-activity.mjs'

describe('live Issue activity identity', () => {
  it('keeps task state updates visible after repeated classification', () => {
    const store = { activity: [] }
    const running = upsertIssueActivity(store, { number: 1, seenAt: 'first', fixState: 'running' })
    const refreshed = upsertIssueActivity(store, { number: 1, seenAt: 'second', title: 'updated report' })
    expect(refreshed).toBe(running)
    running.fixState = 'blocked'
    expect(store.activity[0]).toMatchObject({ seenAt: 'first', fixState: 'blocked', title: 'updated report' })
  })
})
