import { describe, expect, it } from 'vitest'
import {
  deriveUpstreamProfile, applyDeclaration, mergeUpstreamProfile, profileFromGitHubRepo,
  probeCommonHistory, normalizeUpstreamFullName, emptyUpstreamProfile
} from '../../server/services/upstream-profile.mjs'

const project = { fullName: 'user/demo', defaultBranch: 'main' }

describe('upstream profile derivation', () => {
  it('verifies type A from the GitHub fork parent', async () => {
    const fetchRepo = async () => ({ default_branch: 'main', parent: { full_name: 'original/demo', default_branch: 'main' }, source: { full_name: 'original/demo', default_branch: 'main' } })
    const profile = await deriveUpstreamProfile({ project, profile: null, fetchRepo, fetchCompare: async () => { throw new Error('must not compare') } })
    expect(profile.type).toBe('fork-verified')
    expect(profile.upstreamFullName).toBe('original/demo')
    expect(profile.confidence).toBe(1)
    expect(profile.evidence.some((entry) => entry.kind === 'github-parent')).toBe(true)
  })

  it('verifies type B through the compare API when a candidate is given', async () => {
    const fetchRepo = async (fullName) => fullName === 'user/demo'
      ? { default_branch: 'main' }
      : { default_branch: 'master' }
    const fetchCompare = async (basehead) => {
      expect(basehead).toBe('original:master...user:main')
      return { status: 'diverged', merge_base_commit: { sha: 'a'.repeat(40) }, ahead_by: 12, behind_by: 30, total_commits: 42 }
    }
    const profile = await deriveUpstreamProfile({ project, profile: null, candidateUpstream: 'original/demo', fetchRepo, fetchCompare })
    expect(profile.type).toBe('clone-common-history')
    expect(profile.upstreamFullName).toBe('original/demo')
    expect(profile.mergeBase).toMatchObject({ status: 'diverged', aheadBy: 12, behindBy: 30 })
    expect(profile.confidence).toBeGreaterThan(0.5)
  })

  it('refuses to bind an unrelated candidate and records the failed proof', async () => {
    const fetchRepo = async (fullName) => (fullName === 'user/demo' ? { default_branch: 'main' } : { default_branch: 'main' })
    const fetchCompare = async () => { throw Object.assign(new Error('No common ancestor'), { status: 404 }) }
    const profile = await deriveUpstreamProfile({ project, profile: null, candidateUpstream: 'other/project', fetchRepo, fetchCompare })
    expect(profile.type).toBe('unknown')
    expect(profile.upstreamFullName).toBeNull()
    expect(profile.confidence).toBe(0)
    expect(profile.evidence.some((entry) => entry.kind === 'no-common-ancestor')).toBe(true)
  })

  it('keeps a declared ZIP baseline when histories are unrelated, and upgrades to proof when history exists', async () => {
    const declared = applyDeclaration(emptyUpstreamProfile(), { upstreamFullName: 'original/demo', kind: 'zip-reupload', version: '1.0.0' })
    expect(declared.type).toBe('zip-reupload-declared')
    expect(declared.declared.upstreamFullName).toBe('original/demo')

    const noHistory = await deriveUpstreamProfile({
      project, profile: declared,
      fetchRepo: async () => ({ default_branch: 'main' }),
      fetchCompare: async () => { throw Object.assign(new Error('No common ancestor'), { status: 404 }) }
    })
    expect(noHistory.type).toBe('zip-reupload-declared')
    expect(noHistory.evidence.some((entry) => entry.kind === 'no-common-ancestor')).toBe(true)

    const withHistory = await deriveUpstreamProfile({
      project, profile: declared,
      fetchRepo: async (fullName) => (fullName === 'user/demo' ? { default_branch: 'main' } : { default_branch: 'main' }),
      fetchCompare: async () => ({ status: 'ahead', merge_base_commit: { sha: 'b'.repeat(40) }, ahead_by: 3, behind_by: 9, total_commits: 12 })
    })
    expect(withHistory.type).toBe('clone-common-history')
    expect(withHistory.declared.upstreamFullName).toBe('original/demo')
  })

  it('a verified fork outranks an earlier declaration', () => {
    const declared = applyDeclaration(emptyUpstreamProfile(), { upstreamFullName: 'fork/repo', kind: 'third-party' })
    const fork = profileFromGitHubRepo({ parent: { full_name: 'origin/repo', default_branch: 'main' } })
    const merged = mergeUpstreamProfile(declared, fork)
    expect(merged.type).toBe('fork-verified')
    expect(merged.upstreamFullName).toBe('origin/repo')
    expect(merged.declared.upstreamFullName).toBe('fork/repo')
    expect(merged.evidence).toHaveLength(2)
  })

  it('probeCommonHistory treats compare failures as not proven', async () => {
    const result = await probeCommonHistory({ fetchCompare: async () => { throw new Error('network') }, userRepo: 'a/b', upstreamRepo: 'c/d', userBranch: 'main', upstreamBranch: 'main' })
    expect(result).toBeNull()
  })

  it('rejects malformed upstream identifiers', () => {
    expect(() => normalizeUpstreamFullName('not-a-repo')).toThrow(/owner\/repo/)
    expect(() => applyDeclaration(emptyUpstreamProfile(), { upstreamFullName: '../etc', kind: 'zip-reupload' })).toThrow()
  })
})
