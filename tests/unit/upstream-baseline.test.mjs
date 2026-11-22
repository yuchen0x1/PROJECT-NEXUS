import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  classifyThreeWay, captureBaseline, runThreeWayComparison, loadBaselineStore,
  getBaseline, baselineFilesFromTree
} from '../../server/services/upstream-baseline.mjs'

const B = { 'keep.js': 'sha-keep', 'user-mod.js': 'sha-base-1', 'up-mod.js': 'sha-base-2', 'conflict.js': 'sha-base-3', 'synced.js': 'sha-base-4', 'user-del.js': 'sha-base-5', 'up-del.js': 'sha-base-6', 'conf-del.js': 'sha-base-7', 'gone.js': 'sha-base-8' }
const C = { 'keep.js': 'sha-keep', 'user-mod.js': 'sha-user-1', 'up-mod.js': 'sha-base-2', 'conflict.js': 'sha-user-3', 'synced.js': 'sha-user-4', 'up-del.js': 'sha-base-6', 'conf-del.js': 'sha-user-7', 'user-add.js': 'sha-user-9' }
const U = { 'keep.js': 'sha-keep', 'user-mod.js': 'sha-base-1', 'up-mod.js': 'sha-up-2', 'conflict.js': 'sha-up-3', 'synced.js': 'sha-user-4', 'user-del.js': 'sha-base-5', 'up-add.js': 'sha-up-10' }

describe('three-way classification matrix', () => {
  const result = classifyThreeWay({ baselineFiles: B, userFiles: C, upstreamFiles: U })
  const paths = (list) => list.entries.map((entry) => typeof entry === 'string' ? entry : entry.path)

  it('classifies every directive §3.2 category', () => {
    expect(paths(result.conflicts).sort()).toEqual(['conf-del.js', 'conflict.js', 'user-del.js'])
    expect(paths(result.upstreamChanges).sort()).toEqual(['up-add.js', 'up-mod.js'])
    expect(paths(result.upstreamDeletes)).toEqual(['up-del.js'])
    expect(paths(result.userChanges).sort()).toEqual(['user-add.js', 'user-mod.js'])
    expect(paths(result.synced)).toEqual(['synced.js'])
    expect(result.unchanged).toBe(1) // keep.js
    expect(result.totals.trackedPaths).toBe(Object.keys({ ...B, ...C, ...U }).length + 0) // union minus both-deleted
  })

  it('marks both-modified and cross deletions as conflicts', () => {
    const kinds = Object.fromEntries(result.conflicts.entries.map((entry) => [entry.path, entry.kind]))
    expect(kinds['conflict.js']).toBe('both-modified')
    expect(kinds['user-del.js']).toBe('user-deleted-upstream-present')
    expect(kinds['conf-del.js']).toBe('user-modified-upstream-deleted')
  })

  it('caps result entry lists but keeps total counts', () => {
    const baselineFiles = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`f${index}.js`, 'base']))
    const userFiles = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`f${index}.js`, `user-${index}`]))
    const upstreamFiles = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`f${index}.js`, `up-${index}`]))
    const capped = classifyThreeWay({ baselineFiles, userFiles, upstreamFiles })
    expect(capped.conflicts.total).toBe(500)
    expect(capped.conflicts.entries).toHaveLength(400)
  })
})

describe('baseline capture and comparison roundtrip', () => {
  let dataDir

  afterEach(async () => {
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
    dataDir = null
  })

  it('persists a baseline and a comparison across reloads', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-baseline-'))
    const fetchTree = async (fullName, ref) => {
      if (fullName === 'original/demo' && ref === 'v1.0.0') {
        return { sha: 'tree-baseline', tree: [{ path: 'src/a.js', type: 'blob', sha: 'sha-a' }, { path: 'lib', type: 'tree', sha: 'x' }] }
      }
      if (fullName === 'original/demo') {
        return { sha: 'tree-upstream', tree: [{ path: 'src/a.js', type: 'blob', sha: 'sha-a2' }, { path: 'src/new.js', type: 'blob', sha: 'sha-new' }] }
      }
      if (fullName === 'user/demo') {
        return { sha: 'tree-user', tree: [{ path: 'src/a.js', type: 'blob', sha: 'sha-a' }, { path: 'src/mine.js', type: 'blob', sha: 'sha-mine' }] }
      }
      throw new Error(`unexpected fetch ${fullName}@${ref}`)
    }
    const fetchRepo = async (fullName) => {
      if (fullName === 'original/demo') return { default_branch: 'main' }
      throw new Error(`unexpected repo fetch ${fullName}`)
    }

    const baseline = await captureBaseline({ dataDir, projectId: 'p1', upstreamFullName: 'original/demo', ref: 'v1.0.0', fetchTree })
    expect(baseline.fileCount).toBe(1)
    expect(baseline.refSha).toBe('tree-baseline')

    const { comparison } = await runThreeWayComparison({
      dataDir, projectId: 'p1', projectFullName: 'user/demo', projectDefaultBranch: 'main', fetchTree, fetchRepo
    })
    expect(comparison.upstreamRef).toBe('main')
    expect(comparison.totals.conflicts).toBe(0)
    expect(comparison.upstreamChanges.entries.sort()).toEqual(['src/a.js', 'src/new.js'])
    expect(comparison.userChanges.entries).toEqual(['src/mine.js'])

    // The comparison survives a reload from disk.
    const store = await loadBaselineStore(dataDir)
    expect(getBaseline(store, 'p1').comparison.totals.upstreamChanges).toBe(2)
  })

  it('requires a baseline before comparing and flags truncated trees', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-baseline-'))
    await expect(runThreeWayComparison({ dataDir, projectId: 'none', projectFullName: 'a/b', fetchTree: async () => ({ tree: [] }) }))
      .rejects.toMatchObject({ code: 'BASELINE_MISSING' })

    await captureBaseline({ dataDir, projectId: 'p2', upstreamFullName: 'o/r', ref: 'main', fetchTree: async () => ({ sha: 't', tree: Array.from({ length: 25000 }, (_, index) => ({ path: `f${index}.txt`, type: 'blob', sha: `s${index}` })) }) })
    const store = await loadBaselineStore(dataDir)
    expect(getBaseline(store, 'p2').truncated).toBe(true)
    expect(getBaseline(store, 'p2').fileCount).toBe(25000)
  })

  it('converts GitHub tree payloads into blob manifests and skips non-blobs', () => {
    const manifest = baselineFilesFromTree({ tree: [
      { path: 'a.js', type: 'blob', sha: 'sha-a' },
      { path: 'submodule', type: 'commit', sha: 'sha-sub' },
      { path: 'folder', type: 'tree', sha: 'sha-tree' }
    ] })
    expect(manifest.files).toEqual({ 'a.js': 'sha-a' })
    expect(manifest.skipped).toBe(2)
  })
})
