import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// repo-workspace reads its root at import time, so the environment is set
// before the module is imported below.
const temporaryDirectories = []
const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-repo-ws-root-'))
process.env.NEXUS_REPO_WORKSPACE_ROOT = repoRoot

const { ensureRepoCache, commitAndPushBranch, describeRepoCache, removeRepoWorkspace, sweepStaleRepoWorkspaces, repoKeyFor, withRepoLock, validateRepoFullName } = await import('../../server/services/repo-workspace.mjs')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

let originRepo
let originBare

async function makeOriginRepository({ withSecondCommit = false } = {}) {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-repo-origin-'))
  temporaryDirectories.push(workdir)
  git(workdir, ['init', '-b', 'main'])
  await fs.writeFile(path.join(workdir, 'README.md'), '# fixture repo\n', 'utf8')
  await fs.writeFile(path.join(workdir, 'src.txt'), 'const answer = 41\n', 'utf8')
  git(workdir, ['add', '.'])
  git(workdir, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'initial commit'])
  if (withSecondCommit) {
    await fs.writeFile(path.join(workdir, 'src.txt'), 'const answer = 42\n', 'utf8')
    git(workdir, ['add', '.'])
    git(workdir, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'second commit'])
  }
  return workdir
}

beforeAll(async () => {
  originRepo = await makeOriginRepository()
  originBare = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-repo-bare-'))
  temporaryDirectories.push(originBare)
  git(originBare, ['init', '--bare', '-b', 'main', '.'])
  git(originRepo, ['remote', 'add', 'origin', path.join(originBare, '.')])
  git(originRepo, ['push', 'origin', 'main'])
})

afterAll(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true }).catch(() => {})
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('repo workspace keys and validation', () => {
  it('rejects invalid repository identifiers', () => {
    expect(() => validateRepoFullName('not-a-pair')).toThrow()
    expect(() => validateRepoFullName('../escape/repo')).toThrow()
    expect(() => validateRepoFullName('ok/repo')).not.toThrow()
  })

  it('derives safe on-disk keys from owner/name pairs', () => {
    expect(repoKeyFor('Owner.Name/Repo-1')).toBe('Owner.Name__Repo-1')
    expect(repoKeyFor('owner/repo')).not.toContain('/')
  })
})

describe('ensureRepoCache', () => {
  it('clones once, reuses the cache, and fast-forwards to new commits', async () => {
    const fullName = 'fixture/cache-repo'
    const remoteUrl = path.join(originBare, '.')
    const first = await ensureRepoCache({ dataDir: repoRoot, fullName, remoteUrl, branch: 'main' })
    expect(first.cloned).toBe(true)
    expect(first.branch).toBe('main')
    expect(first.headSha).toBeTruthy()

    const reused = await ensureRepoCache({ dataDir: repoRoot, fullName, remoteUrl, branch: 'main' })
    expect(reused.cloned).toBe(false)
    expect(reused.headSha).toBe(first.headSha)

    // New commit on origin; a refetch must move the cache to the new HEAD.
    await fs.writeFile(path.join(originRepo, 'src.txt'), 'const answer = 42\n', 'utf8')
    git(originRepo, ['add', '.'])
    git(originRepo, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'second commit'])
    git(originRepo, ['push', 'origin', 'main'])
    const updated = await ensureRepoCache({ dataDir: repoRoot, fullName, remoteUrl, branch: 'main' })
    expect(updated.headSha).not.toBe(first.headSha)

    const description = await describeRepoCache({ dataDir: repoRoot, fullName })
    expect(description.exists).toBe(true)
    expect(description.dirty).toBe(false)
    expect(description.headSha).toBe(updated.headSha)
  })

  it('serializes concurrent ensure calls for the same repository', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const tasks = Array.from({ length: 4 }, () => withRepoLock('serialized-key', async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 20))
      concurrent -= 1
      return true
    }))
    expect(await Promise.all(tasks)).toEqual([true, true, true, true])
    expect(maxConcurrent).toBe(1)
  })
})

describe('commitAndPushBranch', () => {
  it('commits worktree changes and pushes the branch to origin', async () => {
    const fullName = 'fixture/push-repo'
    const remoteUrl = path.join(originBare, '.')
    const cache = await ensureRepoCache({ dataDir: repoRoot, fullName, remoteUrl, branch: 'main' })
    // Simulate the agent runtime: a dedicated worktree with edits.
    const worktreePath = path.join(repoRoot, repoKeyFor(fullName), 'worktrees', 'task-1')
    git(cache.path, ['worktree', 'add', '-b', 'nexus-fix/task-1', worktreePath, 'main'])
    await fs.writeFile(path.join(worktreePath, 'src.txt'), 'const answer = 42\n', 'utf8')
    await fs.writeFile(path.join(worktreePath, 'new-file.txt'), 'added\n', 'utf8')

    const result = await commitAndPushBranch({ dataDir: repoRoot, worktreePath, branch: 'nexus-fix/task-1', token: 'test-token', commitMessage: 'fix: bump answer' })
    expect(result.commitSha).toBeTruthy()
    const pushed = git(originBare, ['rev-parse', 'nexus-fix/task-1'])
    expect(pushed.trim()).toBe(result.commitSha)
  })

  it('refuses to push without any changes or without a token', async () => {
    const fullName = 'fixture/push-repo'
    const worktreePath = path.join(repoRoot, repoKeyFor(fullName), 'worktrees', 'task-1')
    await expect(commitAndPushBranch({ dataDir: repoRoot, worktreePath, branch: 'nexus-fix/none', token: 'test-token' })).rejects.toMatchObject({ code: 'REPO_NO_CHANGES' })
    await expect(commitAndPushBranch({ dataDir: repoRoot, worktreePath, branch: 'nexus-fix/none', token: '' })).rejects.toMatchObject({ code: 'GITHUB_NOT_CONFIGURED' })
  })
})

describe('workspace lifecycle', () => {
  it('removes a managed workspace and sweeps stale ones', async () => {
    const fullName = 'fixture/sweep-repo'
    await ensureRepoCache({ dataDir: repoRoot, fullName, remoteUrl: path.join(originBare, '.'), branch: 'main' })
    const staleKey = repoKeyFor(fullName)
    const keepKey = repoKeyFor('fixture/cache-repo')
    const removed = await sweepStaleRepoWorkspaces({ dataDir: repoRoot, keepKeys: [keepKey] })
    expect(removed).toContain(staleKey)
    const description = await describeRepoCache({ dataDir: repoRoot, fullName })
    expect(description.exists).toBe(false)
    expect((await describeRepoCache({ dataDir: repoRoot, fullName: 'fixture/cache-repo' })).exists).toBe(true)

    const removal = await removeRepoWorkspace(repoRoot, 'fixture/cache-repo')
    expect(removal.removed).toBe(true)
    expect((await describeRepoCache({ dataDir: repoRoot, fullName: 'fixture/cache-repo' })).exists).toBe(false)
  })
})

describe('disposeRepoWorktree', () => {
  it('removes task worktrees and branches from the cache clone', async () => {
    const fullName = 'fixture/push-repo'
    const cache = await ensureRepoCache({ dataDir: repoRoot, fullName, remoteUrl: path.join(originBare, '.'), branch: 'main' })
    const worktreePath = path.join(repoRoot, repoKeyFor(fullName), 'worktrees', 'task-2')
    git(cache.path, ['worktree', 'add', '-b', 'nexus-fix/task-2', worktreePath, 'main'])
    const { disposeRepoWorktree } = await import('../../server/services/repo-workspace.mjs')
    const result = await disposeRepoWorktree({ dataDir: repoRoot, fullName, taskId: 'task-2', branch: 'nexus-fix/task-2' })
    expect(result.removedWorktree).toBe(true)
    expect(result.removedBranch).toBe(true)
    await expect(fs.lstat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
    const branches = git(cache.path, ['branch', '--list', 'nexus-fix/task-2'])
    expect(branches.trim()).toBe('')
  })
})
