import { describe, expect, it } from 'vitest'
import {
  isRealIssue, sanitizeIssueText, issuePublicSummary, listRepositoryIssues, getIssue,
  listIssueComments, createIssueComment, updateIssueState, addIssueLabels
} from '../../server/services/github-issues.mjs'

function fakeRequest(handler) {
  return async (endpoint, options = {}) => {
    const url = new URL(endpoint, 'https://api.github.com')
    return handler(url, options)
  }
}

const fixtureIssues = [
  { number: 1, title: 'App crashes on launch', state: 'open', updated_at: '2026-11-13T10:00:00Z', user: { login: 'alice' }, labels: [{ name: 'bug' }], html_url: 'https://github.com/fixture/repo/issues/1' },
  { number: 2, title: 'A pull request', state: 'open', updated_at: '2026-11-13T09:00:00Z', pull_request: { url: 'x' } },
  { number: 3, title: 'Docs typo', state: 'open', updated_at: '2026-11-13T08:00:00Z', user: { login: 'bob' }, labels: ['documentation'], html_url: 'https://github.com/fixture/repo/issues/3' }
]

describe('github-issues helpers', () => {
  it('separates real issues from pull requests', () => {
    expect(isRealIssue(fixtureIssues[0])).toBe(true)
    expect(isRealIssue(fixtureIssues[1])).toBe(false)
    expect(isRealIssue(null)).toBe(false)
  })

  it('sanitizes and truncates untrusted issue text', () => {
    expect(sanitizeIssueText('line\r\nCRLF')).toBe('line\nCRLF')
    expect(sanitizeIssueText('x'.repeat(100), 10)).toContain('[truncated]')
  })

  it('builds public summaries with normalized labels', () => {
    const summary = issuePublicSummary(fixtureIssues[0])
    expect(summary).toMatchObject({ number: 1, title: 'App crashes on launch', author: 'alice', labels: ['bug'] })
  })

  it('lists issues with pagination and strips pull requests', async () => {
    const requested = []
    const request = fakeRequest((url, options) => {
      requested.push({ url: url.pathname + url.search, options })
      if (url.searchParams.get('page') === '2') return { data: [fixtureIssues[1]], headers: {} }
      return { data: [fixtureIssues[0], fixtureIssues[1], fixtureIssues[2]], next: `https://api.github.com/repos/fixture/repo/issues?page=2&per_page=100`, headers: {} }
    })
    const result = await listRepositoryIssues(request, 'fixture/repo', { state: 'open' })
    expect(result.issues.map((issue) => issue.number)).toEqual([1, 3])
    expect(result.pages).toBe(2)
    expect(result.truncated).toBe(false)
    expect(requested[0].url).toContain('/repos/fixture/repo/issues')
    expect(requested[0].url).toContain('state=open')
  })

  it('fetches an issue and its comments with bounded pages', async () => {
    const request = fakeRequest((url) => {
      if (url.pathname.endsWith('/issues/7')) return { number: 7, title: 'T', state: 'open' }
      if (url.pathname.endsWith('/issues/7/comments')) return { data: [{ id: 'c1', user: { login: 'op' }, body: 'It broke after v2.0', created_at: 'now' }] }
      return null
    })
    expect((await getIssue(request, 'fixture/repo', 7)).number).toBe(7)
    const comments = await listIssueComments(request, 'fixture/repo', 7)
    expect(comments[0]).toMatchObject({ id: 'c1', author: 'op', body: 'It broke after v2.0' })
    await expect(getIssue(request, 'fixture/repo', -3)).rejects.toMatchObject({ code: 'ISSUE_NUMBER_INVALID' })
  })

  it('posts comments with sanitized bodies and validates inputs', async () => {
    const bodies = []
    const request = fakeRequest(async (url, options) => {
      if (options.method === 'POST') {
        bodies.push(JSON.parse(options.body))
        return { id: 'posted' }
      }
      return {}
    })
    expect(await createIssueComment(request, 'fixture/repo', 4, 'Fixed in v1.2.3')).toMatchObject({ id: 'posted' })
    await expect(createIssueComment(request, 'fixture/repo', 4, '   ')).rejects.toMatchObject({ code: 'ISSUE_COMMENT_EMPTY' })
  })

  it('closes and reopens issues with the right payloads', async () => {
    const payloads = []
    const request = fakeRequest(async (url, options) => {
      payloads.push(JSON.parse(options.body))
      return { ok: true }
    })
    await updateIssueState(request, 'fixture/repo', 9, { state: 'closed', notPlanned: true })
    await updateIssueState(request, 'fixture/repo', 9, { state: 'open' })
    await expect(updateIssueState(request, 'fixture/repo', 9, { state: 'weird' })).rejects.toMatchObject({ code: 'ISSUE_STATE_INVALID' })
    expect(payloads[0]).toEqual({ state: 'closed', state_reason: 'not_planned' })
    expect(payloads[1]).toEqual({ state: 'open' })
  })

  it('adds labels and rejects empty label sets', async () => {
    const request = fakeRequest(async () => ({ ok: true }))
    await expect(addIssueLabels(request, 'fixture/repo', 5, ['nexus/bug'])).resolves.toMatchObject({ ok: true })
    await expect(addIssueLabels(request, 'fixture/repo', 5, [])).rejects.toMatchObject({ code: 'ISSUE_LABELS_EMPTY' })
  })
})
