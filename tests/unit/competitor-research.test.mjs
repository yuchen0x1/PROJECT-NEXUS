import { describe, expect, it } from 'vitest'
import {
  normalizeCandidate, buildMetricComparison, parseResearchAnalysis, buildResearchPrompt, discoverCompetitors, runCompetitorResearch, selectResearchSources
} from '../../server/services/competitor-research.mjs'

describe('candidate normalization', () => {
  it('prioritizes runtime code over tooling and excludes hidden instruction directories', () => {
    const files = ['.agents/skills/run.py', 'scripts/helper.js', 'src/core/runtime.ts', 'server/checkpoint.py', 'vendor/runtime.js'].map((path) => ({ path, type: 'blob', size: 100 }))
    expect(selectResearchSources(files, 2).map((item) => item.path)).toEqual(['src/core/runtime.ts', 'server/checkpoint.py'])
  })
  it('excludes itself and records license data', () => {
    const self = normalizeCandidate({ full_name: 'fixture/repo', stargazers_count: 5, license: { spdx_id: 'MIT', name: 'MIT' } }, { fullName: 'fixture/repo' })
    expect(self.isSelf).toBe(true)
    const peer = normalizeCandidate({ full_name: 'other/tool', stargazers_count: 99, open_issues_count: 4, license: { spdx_id: 'Apache-2.0', name: 'Apache' } }, { fullName: 'fixture/repo' })
    expect(peer.isSelf).toBe(false)
    expect(peer.license.spdx).toBe('Apache-2.0')
    expect(peer.stars).toBe(99)
  })
})

describe('metric comparison', () => {
  it('builds an evidence-based table without AI', () => {
    const comparison = buildMetricComparison({
      project: { fullName: 'fixture/repo' },
      researched: [{ fullName: 'other/tool', url: 'https://github.com/other/tool', stars: 12, forks: 2, openIssues: 1, license: { spdx: 'MIT' }, pushedAt: '2026-11-01', recentCommits: [1, 2, 3], releases: [{}] }]
    })
    expect(comparison).toEqual([{
      repository: 'other/tool', url: 'https://github.com/other/tool', license: 'MIT',
      stars: 12, forks: 2, openIssues: 1, lastPush: '2026-11-01', recentActivity: 3, releases: 1, note: null
    }])
  })
})

describe('analysis parsing', () => {
  it('parses valid AI JSON and clamps malicious/oversized values', () => {
    const analysis = parseResearchAnalysis(JSON.stringify({
      candidates: [{ repository: 'other/tool', summary: 'A tool', notableFeatures: ['x'.repeat(1000)], worthAdopting: [{ feature: 'F', rationale: 'R', licenseSafe: true, effort: 'weird' }], risksObserved: ['R1'] }],
      gapAnalysis: [{ dimension: 'testing', self: 'thin', peer: 'deep', recommendation: 'adopt' }],
      upgradeProposals: [{ title: 'T', priority: 'P9', rationale: 'Because', effort: 'low' }],
      noActionRequired: false
    }), { comparison: [] })
    expect(analysis.source).toBeUndefined()
    expect(analysis.candidates[0].notableFeatures[0]).toHaveLength(300)
    expect(analysis.candidates[0].worthAdopting[0].effort).toBe('medium')
    expect(analysis.gapAnalysis[0].dimension).toBe('testing')
    expect(analysis.upgradeProposals[0].priority).toBe('P3')
    expect(analysis.metricComparison).toEqual([])
  })

  it('returns null for non-JSON output', () => {
    expect(parseResearchAnalysis('no json here')).toBeNull()
    expect(parseResearchAnalysis('{broken')).toBeNull()
  })
})

describe('discovery', () => {
  it('builds a query from topics, description and name, and filters self/archived', async () => {
    const project = {
      name: 'nexus',
      fullName: 'fixture/nexus',
      description: 'An AI operations platform for repositories',
      repoMeta: { topics: ['ai', 'automation'] }
    }
    let requested = null
    const request = async (endpoint) => {
      requested = endpoint
      return {
        total_count: 3,
        items: [
          { full_name: 'fixture/nexus', stargazers_count: 1 },
          { full_name: 'other/gone', archived: true, stargazers_count: 50 },
          { full_name: 'alpha/tool', stargazers_count: 30 },
          { full_name: 'beta/tool', stargazers_count: 10 }
        ]
      }
    }
    const { query, candidates } = await discoverCompetitors({ project, request, limit: 2 })
    expect(requested).toContain('/search/repositories?')
    expect(query).toContain('topic:ai')
    expect(candidates.map((candidate) => candidate.fullName)).toEqual(['alpha/tool', 'beta/tool'])
  })
})

describe('full research run', () => {
  it('degrades to metrics-only analysis without a provider', async () => {
    const project = { name: 'nexus', fullName: 'fixture/nexus', description: 'AI ops platform', repoMeta: { topics: ['ai'] } }
    const request = async (endpoint, options = {}) => {
      if (endpoint.includes('/search/repositories')) return { total_count: 1, items: [{ full_name: 'peer/one', stargazers_count: 5, description: 'Peer one' }] }
      if (endpoint.includes('/readme')) return '# Peer One\nA peer project with a deep test suite.'
      if (endpoint.includes('/commits')) return [{ sha: 'abcdef1234', commit: { message: 'fix: crash\nlong body', author: { date: '2026-11-01' } } }]
      if (endpoint.includes('/releases')) return [{ tag_name: 'v1.2.0', name: 'One', published_at: '2026-11-02' }]
      if (endpoint.endsWith('/contents')) return [{ name: 'package.json' }, { name: 'src' }]
      throw new Error(`unexpected ${endpoint}`)
    }
    const outcome = await runCompetitorResearch({ project, request, provider: null })
    expect(outcome.analysis.source).toBe('metrics-only')
    expect(outcome.candidates[0].readmeExcerpt).toContain('# Peer One')
    expect(outcome.candidates[0].recentCommits[0].message).toBe('fix: crash')
    expect(outcome.analysis.metricComparison[0].repository).toBe('peer/one')
  })
})
