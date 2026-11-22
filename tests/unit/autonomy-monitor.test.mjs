import { describe, expect, it } from 'vitest'
import { openAutonomyStore } from '../../server/autonomy/db.mjs'
import { RepositoryMonitor, parseNextLink, backoffMs, escapeRepoPath } from '../../server/autonomy/monitor.mjs'

function headers(values = {}) {
  return { get: (key) => values[key.toLowerCase()] ?? null }
}

function fakeFetch(responder) {
  const calls = []
  const impl = async (url, options = {}) => {
    const result = await responder(url, options, calls)
    calls.push({ url, headers: options.headers || {} })
    if (result.status === 304) return { status: 304, ok: false, headers: headers(result.headers) }
    return {
      status: result.status || 200, ok: (result.status || 200) < 300,
      headers: headers(result.headers), json: async () => result.body
    }
  }
  impl.calls = calls
  return impl
}

function setup(responder, { clock = () => Date.parse('2026-01-01T00:00:00Z') } = {}) {
  const store = openAutonomyStore({ file: ':memory:' })
  const fetchImpl = fakeFetch(responder)
  const monitor = new RepositoryMonitor({ store, token: 'test-token', fetchImpl, clock })
  const repo = store.put('repositories', 'r1', {
    id: 'r1', fullName: 'acme/widget', localPath: '', defaultBranch: 'main',
    pollIntervalMs: 900_000, enabled: true, monitorItems: ['issues'], webhookEnabled: false
  })
  return { store, monitor, repo, fetchImpl, clock }
}

const issue = (id, version) => ({ id, number: id, title: `Issue ${id}`, state: 'open', updated_at: version, html_url: `https://github.com/acme/widget/issues/${id}` })

describe('repository monitoring engine', () => {
  it('parses pagination links and computes exponential backoff', () => {
    expect(parseNextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'))
      .toBe('https://api.github.com/x?page=2')
    expect(parseNextLink('<https://api.github.com/x>; rel="prev"')).toBeNull()
    expect(backoffMs(1)).toBe(30_000)
    expect(backoffMs(3)).toBe(120_000)
    expect(backoffMs(2, '600', null, 0)).toBe(600_000)
    expect(() => escapeRepoPath('bad/../../etc')).toThrow()
    expect(escapeRepoPath('acme/widget')).toBe('acme/widget')
  })

  it('establishes a baseline without replaying history, then short-circuits on 304', async () => {
    let etagRequested = false
    const { store, monitor, repo, fetchImpl } = setup(async (_url, options, calls) => {
      const first = calls.length === 0
      if (!first) etagRequested = Boolean(options.headers['If-None-Match'])
      if (!first && etagRequested) return { status: 304 }
      return { status: 200, headers: { etag: 'W/"etag-1"', 'x-ratelimit-remaining': '4999' }, body: [issue(300, '2025-01-01'), issue(299, '2024-12-01')] }
    })
    const first = await monitor.syncRepository(repo, { resources: ['issues'] })
    expect(first.verdict).toBe('PASS')
    expect(first.eventCount).toBe(0) // baseline only
    expect(store.count('events')).toBe(0)
    const cursor = store.get('sync_cursors', 'r1:issues')
    expect(cursor.etag).toBe('W/"etag-1"')
    expect(cursor.lastSeenExternalId).toBe('300')

    const second = await monitor.syncRepository(repo, { resources: ['issues'] })
    expect(second.resources[0].notModified).toBe(true)
    expect(second.eventCount).toBe(0)
    expect(fetchImpl.calls.length).toBe(2)
  })

  it('detects a NEW issue exactly once and creates a traceable finding', async () => {
    let items = [issue(300, '2025-01-01')]
    const { store, monitor, repo } = setup(async () => ({
      status: 200, headers: { etag: 'W/"x"' }, body: items
    }))
    await monitor.syncRepository(repo, { resources: ['issues'] })
    items = [issue(301, '2026-01-01'), issue(300, '2025-01-01')]
    const second = await monitor.syncRepository(repo, { resources: ['issues'] })
    expect(second.eventCount).toBe(1)
    expect(store.count('events')).toBe(1)
    expect(store.count('findings')).toBe(1)
    const finding = store.list('findings')[0]
    expect(finding).toMatchObject({ kind: 'bug', priority: 'P2', status: 'OPEN' })

    const third = await monitor.syncRepository(repo, { resources: ['issues'] })
    expect(third.eventCount).toBe(0) // durable de-duplication
    expect(store.count('events')).toBe(1)
  })

  it('backs off on rate limiting and never loses the cursor', async () => {
    const { store, monitor, repo } = setup(async () => ({
      status: 429, headers: { 'retry-after': '120', 'x-ratelimit-remaining': '0' }, body: { message: 'API rate limit exceeded' }
    }))
    const run = await monitor.syncRepository(repo, { resources: ['issues'] })
    expect(run.verdict).toBe('PARTIAL')
    expect(run.errors).toHaveLength(1)
    const cursor = store.get('sync_cursors', 'r1:issues')
    expect(cursor.failures).toBe(1)
    expect(Date.parse(cursor.nextAttemptAt)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'))
  })

  it('de-duplicates webhook deliveries and falls back to polling when stale', async () => {
    const { store, monitor, repo } = setup(async () => ({ status: 200, headers: {}, body: [] }))
    const first = await monitor.ingestWebhook(repo, 'issues', 'delivery-1', { action: 'opened' })
    expect(first.duplicate).toBe(false)
    const second = await monitor.ingestWebhook(repo, 'issues', 'delivery-1', { action: 'opened' })
    expect(second.duplicate).toBe(true)
    expect(store.count('events')).toBe(1)

    const repoWithoutWebhook = { ...repo }
    expect(monitor.webhookHealthy(repoWithoutWebhook)).toBe(false)
    const healthy = store.get('repositories', 'r1')
    healthy.webhookEnabled = true
    expect(monitor.webhookHealthy(healthy)).toBe(true)
    healthy.lastWebhookAt = '2020-01-01T00:00:00.000Z'
    expect(monitor.webhookHealthy(healthy)).toBe(false)
  })

  it('requires PR, merge, branch, test and review evidence before resolving an issue', async () => {
    const responses = {
      issue: { state: 'closed', title: 'Crash' },
      timeline: [{ event: 'cross-referenced', source: { issue: { number: 12, pull_request: {} } } }],
      pr: { merged: true, merge_commit_sha: 'fixsha', base: { sha: 'basesha' } },
      reviews: [{ state: 'APPROVED' }],
      compare: { status: 'ahead', commits: [{ sha: 'fixsha' }] },
      comments: [],
      runs: { workflow_runs: [{ conclusion: 'success' }] }
    }
    const { store, monitor, repo } = setup(async (url) => {
      if (/\/issues\/7\/timeline/.test(url)) return { body: responses.timeline }
      if (/\/issues\/7\/comments/.test(url)) return { body: responses.comments }
      if (/\/issues\/7$/.test(url)) return { body: responses.issue }
      if (/\/pulls\/12\/reviews/.test(url)) return { body: responses.reviews }
      if (/\/pulls\/12$/.test(url)) return { body: responses.pr }
      if (/\/compare\//.test(url)) return { body: responses.compare }
      if (/\/actions\/runs/.test(url)) return { body: responses.runs }
      return { body: [] }
    })
    // A closed issue alone is never resolved; an independent regression test
    // must explicitly confirm the problem is no longer reproducible.
    const withoutRegression = await monitor.assessIssue(repo, 7)
    expect(withoutRegression.lifecycle).toBe('UNCONFIRMABLE')
    const result = await monitor.assessIssue(repo, 7, { regressionTestResult: 'not-reproducible' })
    expect(result.lifecycle).toBe('VERIFIED_RESOLVED')
    expect(result.evidence.pullRequestMerged).toBe(true)
    expect(result.evidence.fixPresentInTargetBranch).toBe(true)
    expect(result.evidence.testsPassed).toBe(true)
    expect(store.get('issues', 'r1:7').lifecycle).toBe('VERIFIED_RESOLVED')

    // A closed issue with no evidence must never be marked resolved.
    const empty = setup(async () => ({ body: { state: 'closed', title: 'Crash' } }))
    const unverified = await empty.monitor.assessIssue(empty.repo, 8)
    expect(unverified.lifecycle).toBe('UNCONFIRMABLE')
  })
})
