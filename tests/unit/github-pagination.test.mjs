import { describe, expect, it } from 'vitest'
import { fetchAllPages, githubNextLink } from '../../server/services/github-pagination.mjs'
import { repositoryApiPath, repositoryTreePath } from '../../server/services/github-paths.mjs'

describe('GitHub repository paths and bounded pagination', () => {
  it('encodes repository components as separate path segments', () => {
    expect(repositoryApiPath('acme/team.repo')).toBe('/repos/acme/team.repo')
    expect(repositoryTreePath('acme/tool', 'abc1234567', true)).toBe('/repos/acme/tool/git/trees/abc1234567?recursive=1')
    expect(() => repositoryApiPath('owner/repo/extra')).toThrow()
    expect(() => repositoryApiPath('../repo')).toThrow()
  })

  it('collects every page until the provider returns a short page', async () => {
    const calls = []
    const request = async (endpoint) => {
      calls.push(endpoint)
      const page = Number(new URL(endpoint, 'https://api.github.com').searchParams.get('page'))
      return page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }]
    }
    const result = await fetchAllPages(request, '/user/repos?sort=updated', { perPage: 2 })
    expect(result).toEqual({ items: [{ id: 1 }, { id: 2 }, { id: 3 }], pages: 2, truncated: false })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('page=1')
    expect(calls[1]).toContain('page=2')
  })

  it('reports a page cap instead of silently dropping remaining results', async () => {
    const request = async () => [{ id: 1 }]
    const result = await fetchAllPages(request, '/user/repos', { perPage: 1, maxPages: 2 })
    expect(result).toEqual({ items: [{ id: 1 }, { id: 1 }], pages: 2, truncated: true })
  })

  it('reads paged installation collections and rejects malformed pages', async () => {
    const result = await fetchAllPages(async (endpoint) => {
      const page = Number(new URL(endpoint, 'https://api.github.com').searchParams.get('page'))
      return { repositories: page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }] }
    }, '/installation/repositories', { collection: 'repositories', perPage: 2 })
    expect(result.items.map((repo) => repo.id)).toEqual([1, 2, 3])
    await expect(fetchAllPages(async () => ({ repositories: null }), '/installation/repositories', { collection: 'repositories' })).rejects.toMatchObject({ code: 'GITHUB_RESPONSE_INVALID' })
  })

  it('follows a provider Link header next URL and rejects cross-origin links', async () => {
    const calls = []
    const result = await fetchAllPages(async (endpoint) => {
      calls.push(endpoint)
      if (calls.length === 1) return {
        data: [{ id: 1 }, { id: 2 }],
        next: githubNextLink('<https://api.github.com/user/repos?page=2&per_page=2>; rel="next", <https://api.github.com/user/repos?page=1&per_page=2>; rel="prev"')
      }
      return { data: [{ id: 3 }] }
    }, '/user/repos', { perPage: 2 })
    expect(result).toEqual({ items: [{ id: 1 }, { id: 2 }, { id: 3 }], pages: 2, truncated: false })
    expect(calls[1]).toBe('https://api.github.com/user/repos?page=2&per_page=2')
    expect(() => githubNextLink('<https://evil.example/user/repos?page=2>; rel="next"')).toThrow(/outside the configured API origin/)
  })

  it('fails closed on a repeated provider next link', async () => {
    const link = 'https://api.github.com/user/repos?page=2&per_page=1'
    await expect(fetchAllPages(async () => ({ data: [{ id: 1 }], next: link }), '/user/repos', { perPage: 1, maxPages: 3 })).rejects.toMatchObject({ code: 'GITHUB_PAGINATION_LOOP' })
  })
})
