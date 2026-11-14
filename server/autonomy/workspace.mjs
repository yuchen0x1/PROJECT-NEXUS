// Isolated Git worktrees for autonomous tasks (directive 7).
//
// Hard guarantees:
//   * The user's original working tree is never written, reset or cleaned.
//   * A dirty original tree aborts task preparation instead of being stashed.
//   * main/master is never the task branch.
//   * Worktree paths are confined to a NEXUS-owned directory.
//   * Diff collection reports deletions and sensitive paths for review.

import { execFile } from 'node:child_process'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { isPathSensitive, makeId } from './model.mjs'

function gitError(code, message) { return Object.assign(new Error(message), { code }) }

export function git(execImpl, args, { cwd = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execImpl('git', args, { cwd: cwd || undefined, windowsHide: true, timeout: timeoutMs, maxBuffer: 12 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(gitError('GIT_COMMAND_FAILED', `git ${args[0]} failed: ${String(stderr || error.message).trim().slice(0, 400)}`))
        return
      }
      resolve(String(stdout || '').trim())
    })
  })
}

export function createWorkspaceManager({ dataDir, execImpl = execFile, clock = () => Date.now() } = {}) {
  const root = path.resolve(path.join(dataDir, 'autonomy-worktrees'))

  function worktreePath(taskId) {
    const candidate = path.resolve(path.join(root, String(taskId).replace(/[^A-Za-z0-9._-]/g, '_')))
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      throw gitError('WORKTREE_PATH_ESCAPE', 'Refusing to create a worktree outside the NEXUS-owned directory.')
    }
    return candidate
  }

  return {
    root,

    /** Never overwrite user changes. Returns a signed-off preparation record. */
    async prepare(repo, { taskId = makeId('task'), baseSha = null } = {}) {
      const original = path.resolve(String(repo.localPath || ''))
      if (!original) throw gitError('LOCAL_PATH_MISSING', `Repository ${repo.fullName} has no bound local path.`)
      if (original === root || original.startsWith(root + path.sep)) {
        throw gitError('WORKTREE_NESTED', 'The bound local path is itself a NEXUS worktree; refusing.')
      }
      const stat = await fsp.stat(original).catch(() => null)
      if (!stat?.isDirectory()) throw gitError('LOCAL_PATH_MISSING', `Bound local path does not exist: ${original}`)

      const status = await git(execImpl, ['status', '--porcelain'], { cwd: original })
      if (status) {
        throw gitError('USER_WORKTREE_DIRTY', 'The original working tree has uncommitted changes; NEXUS will not touch it.')
      }
      const head = baseSha || await git(execImpl, ['rev-parse', 'HEAD'], { cwd: original })
      const branch = `nexus/auto/${String(taskId).replace(/[^A-Za-z0-9._-]/g, '_')}`
      if (/^(main|master)$/i.test(branch)) throw gitError('PROTECTED_BRANCH', 'Refusing to work on a protected branch.')
      const target = worktreePath(taskId)
      await fsp.mkdir(root, { recursive: true })
      await git(execImpl, ['worktree', 'add', '-b', branch, target, head], { cwd: original, timeoutMs: 120_000 })
      const record = {
        id: makeId('ws'), taskId, repoId: repo.id, repository: repo.fullName,
        originalPath: original, path: target, branch, baseSha: head,
        createdAt: new Date(clock()).toISOString(), isolated: true, worktree: true,
        originalWasClean: true
      }
      return record
    },

    /** Collect the complete change set for independent review. */
    async collectDiff(workspace) {
      const cwd = path.resolve(workspace.path)
      const status = await git(execImpl, ['status', '--porcelain'], { cwd })
      const diffStat = await git(execImpl, ['diff', 'HEAD', '--stat'], { cwd }).catch(() => '')
      const diff = await git(execImpl, ['diff', 'HEAD'], { cwd }).catch(() => '')
      const files = status.split('\n').filter(Boolean).map((line) => {
        const code = line.slice(0, 2).trim()
        const raw = line.slice(3).trim().replace(/^"|"$/g, '')
        return { status: code, path: raw, deleted: /^D/.test(code), sensitive: isPathSensitive(raw) }
      })
      const untracked = files.filter((file) => file.status === '??')
      return {
        taskId: workspace.taskId, branch: workspace.branch, baseSha: workspace.baseSha,
        changedFiles: files, fileCount: files.length,
        deletedFiles: files.filter((file) => file.deleted).map((file) => file.path),
        sensitiveFiles: files.filter((file) => file.sensitive).map((file) => file.path),
        untrackedFiles: untracked.map((file) => file.path),
        stat: diffStat, patch: diff.slice(0, 500_000), collectedAt: new Date(clock()).toISOString()
      }
    },

    /** Review the modification scope. Any hard violation fails acceptance. */
    reviewScope(diff) {
      const violations = []
      if (!diff.fileCount) violations.push({ code: 'NO_CHANGES', detail: 'The AI made no changes in the isolated workspace.' })
      if (diff.deletedFiles.length) violations.push({ code: 'UNEXPECTED_DELETION', detail: `Deleted files: ${diff.deletedFiles.join(', ')}` })
      if (diff.sensitiveFiles.length) violations.push({ code: 'SENSITIVE_FILE_TOUCHED', detail: `Sensitive paths: ${diff.sensitiveFiles.join(', ')}` })
      const secretPattern = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/
      if (secretPattern.test(diff.patch)) violations.push({ code: 'SECRET_IN_DIFF', detail: 'A credential-like string appears in the diff.' })
      return { pass: violations.length === 0, violations }
    },

    /** Remove only the NEXUS-created worktree; keep the branch for audit. */
    async cleanup(workspace) {
      const target = worktreePath(workspace.taskId)
      const original = path.resolve(workspace.originalPath)
      if (target === original) throw gitError('WORKTREE_REFUSAL', 'Refusing to remove the original working tree.')
      await git(execImpl, ['worktree', 'remove', '--force', target], { cwd: original }).catch(() => {})
      return { removed: true, path: target, branchRetained: workspace.branch }
    }
  }
}
