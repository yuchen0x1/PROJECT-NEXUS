import { describe, expect, it } from 'vitest'
import { GithubDelivery } from '../../server/autonomy/github-delivery.mjs'

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }
}

describe('GitHub delivery gates', () => {
  it('reads branch, PR, reviews and Actions evidence without writing', async () => {
    const calls = []
    const delivery = new GithubDelivery({ token: 'test', fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options?.method || 'GET' })
      if (String(url).endsWith('/git/ref/heads/main')) return response({ object: { sha: 'abc123' } })
      if (String(url).endsWith('/pulls?state=all&head=acme%3Amain&per_page=20')) return response([])
      if (String(url).endsWith('/actions/runs?branch=main&per_page=20')) return response({ workflow_runs: [] })
      return response({ full_name: 'acme/widget', default_branch: 'main', permissions: { push: false } })
    } })
    const result = await delivery.inspect({ fullName: 'acme/widget', defaultBranch: 'main' })
    expect(result.branch.sha).toBe('abc123')
    expect(result.pullRequest).toBeNull()
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('refuses PR creation until both remote writes and explicit confirmation are present', async () => {
    const delivery = new GithubDelivery({ token: 'test', fetchImpl: async () => response({}) })
    await expect(delivery.createPullRequest({ fullName: 'acme/widget' }, { branch: 'nexus/auto/task', remoteWritesEnabled: false, confirm: true }))
      .rejects.toMatchObject({ code: 'REMOTE_WRITES_DISABLED' })
  })
})
