import { describe, expect, it } from 'vitest'
import {
  nextVersionFromTag, buildReleaseNotes, shouldCloseIssue, maybeMergePullRequest, maybePublishRelease, maybeCloseIssue
} from '../../server/services/delivery-stage.mjs'

describe('version management', () => {
  it('bumps patch/minor/major from the latest tag', () => {
    expect(nextVersionFromTag('v1.2.3').tag).toBe('v1.2.4')
    expect(nextVersionFromTag('v1.2.3', 'minor').tag).toBe('v1.3.0')
    expect(nextVersionFromTag('v1.2.3', 'major').tag).toBe('v2.0.0')
    expect(nextVersionFromTag('v1.2.3-beta.1').tag).toBe('v1.2.4')
    expect(nextVersionFromTag(null).tag).toBe('v0.0.1')
    expect(() => nextVersionFromTag('not-a-version')).toThrow()
  })
})

describe('release notes', () => {
  it('includes issue reference, verification and review evidence', () => {
    const notes = buildReleaseNotes({
      issue: { number: 7, title: 'Crash on save', url: 'https://github.com/fixture/repo/issues/7', analysis: 'Frozen state mutated' },
      tagName: 'v1.2.4',
      delivery: { branch: 'nexus-fix/issue-7-abc' },
      verification: { status: 'PASS', summary: '12 tests passed' },
      review: { status: 'PASS' },
      commitSha: 'abcdef123456'
    })
    expect(notes).toContain('issue #7')
    expect(notes).toContain('12 tests passed')
    expect(notes).toContain('v1.2.4')
    expect(notes).toContain('Resolves https://github.com/fixture/repo/issues/7')
    expect(notes).toContain('abcdef123456'.slice(0, 12))
  })
})

describe('merge gates', () => {
  const verification = { attempted: true, passed: true, summary: 'ok', results: [{ label: 'test', attempted: true, ok: true }] }

  it('merges only when every gate passes', async () => {
    let mergeCalled = false
    const request = async (endpoint, options = {}) => {
      if (endpoint.endsWith('/pulls/5')) return { head: { sha: 'abc123' } }
      if (endpoint.includes('check-runs')) return { check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] }
      if (endpoint.endsWith('/status?per_page=100')) return { statuses: [] }
      if (endpoint.includes('/merge')) { mergeCalled = true; return { merged: true, sha: 'abc123' } }
      throw new Error(`unexpected ${endpoint}`)
    }
    const result = await maybeMergePullRequest({
      request, repository: 'fixture/repo', pullRequest: { number: 5, headSha: 'abc123' }, policy: { autoMerge: true }, verification, review: { verdict: 'approve', findings: [] }
    })
    expect(result.merged).toBe(true)
    expect(mergeCalled).toBe(true)
  })

  it('refuses to merge on policy, verification or review failures', async () => {
    const request = async () => { throw new Error('must not be called') }
    expect((await maybeMergePullRequest({ request, repository: 'r', pullRequest: { number: 1 }, policy: { autoMerge: false }, verification, review: { verdict: 'approve', findings: [] } })).merged).toBe(false)
    expect((await maybeMergePullRequest({ request, repository: 'r', pullRequest: { number: 1 }, policy: { autoMerge: true }, verification: { status: 'FAIL' }, review: { verdict: 'approve', findings: [] } })).merged).toBe(false)
    expect((await maybeMergePullRequest({ request, repository: 'r', pullRequest: { number: 1 }, policy: { autoMerge: true }, verification, review: { findings: [{ severity: 'high' }] } })).merged).toBe(false)
    expect((await maybeMergePullRequest({ request, repository: 'r', pullRequest: null, policy: { autoMerge: true }, verification, review: { verdict: 'approve', findings: [] } })).merged).toBe(false)
  })
})

describe('issue close decision (PART 9.2)', () => {
  const policy = { closeIssueAfterRelease: true, autoMerge: true, autoPublish: true }
  const base = {
    policy,
    delivery: { pushed: true, issueCommented: true, merged: { merged: true }, released: { published: true } },
    verification: { attempted: true, passed: true, results: [{ label: 'test', attempted: true, ok: true }] },
    review: { verdict: 'approve', findings: [] }
  }

  it('closes only when every condition holds', () => {
    expect(shouldCloseIssue(base).close).toBe(true)
  })

  it.each([
    ['policy disabled', { ...base, policy: { ...policy, closeIssueAfterRelease: false } }],
    ['verification failed', { ...base, verification: { status: 'FAIL' } }],
    ['not pushed', { ...base, delivery: { ...base.delivery, pushed: false } }],
    ['no reply posted', { ...base, delivery: { ...base.delivery, issueCommented: false } }],
    ['merge failed', { ...base, delivery: { ...base.delivery, merged: { merged: false, reason: 'x' } } }],
    ['release failed', { ...base, delivery: { ...base.delivery, released: { published: false, reason: 'x' } } }]
  ])('stays open when %s', (_label, scenario) => {
    expect(shouldCloseIssue(scenario).close).toBe(false)
  })

  it('permits merge-only close without autoPublish', async () => {
    const request = async (endpoint, options = {}) => {
      if (endpoint.endsWith('/issues/11')) return { state: 'closed' }
      throw new Error(`unexpected ${endpoint}`)
    }
    const scenario = { ...base, policy: { closeIssueAfterRelease: true, autoMerge: true, autoPublish: false, closeIssueAfterMerge: true }, delivery: { pushed: true, issueCommented: true, merged: { merged: true } } }
    expect((await maybeCloseIssue({ request, repository: 'r', issueNumber: 11, ...scenario })).closed).toBe(true)
  })
})

describe('release publishing', () => {
  it('skips without the policy gate', async () => {
    const request = async () => { throw new Error('must not be called') }
    const result = await maybePublishRelease({ request, repository: 'r', token: 't', policy: { autoPublish: false }, issue: { number: 1 }, delivery: { merged: { merged: true } }, worktreePath: '/tmp' })
    expect(result.published).toBe(false)
    expect(result.reason).toContain('autoPublish disabled')
  })

  it('refuses an unverified merged checkout and an unmerged PR', async () => {
    const request = async () => { throw new Error('must not call GitHub') }
    const result = await maybePublishRelease({ request, policy: { autoPublish: true }, delivery: { pullRequest: { number: 1 } } })
    expect(result.published).toBe(false)
    expect(result.reason).toContain('nothing merged')
  })
})
