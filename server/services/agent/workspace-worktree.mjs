import fs from 'node:fs/promises'
import path from 'node:path'
import { runCommand } from './executor.mjs'
import {
  createLocalAgentWorkspace,
  readLocalAgentFiles,
  applyLocalAgentOperations,
  listLocalAgentChanges,
  deleteLocalAgentFile,
  restoreLocalAgentFile,
  restoreAllLocalAgentFiles
} from '../local-agent-workspace.mjs'
import { repoWorktreePath } from '../repo-workspace.mjs'

// Unified agent workspace adapters.
//
// - worktree: a dedicated `git worktree` on branch nexus-agent/<taskId> created
//   from the project's HEAD. Changes are reviewed via git diff; rollback is a
//   reset plus worktree removal. The user's own working tree (including
//   uncommitted changes) is never touched.
// - copy: the PHASE 4 bounded snapshot workspace with baseline manifest,
//   symlink refusal and gitignore policy, extended with delete/restore.
//
// Both adapters expose the same surface so the agent runtime is mode-agnostic.

const GIT_TIMEOUT_MS = 30_000

function workspaceError(code, message) {
  return Object.assign(new Error(message), { code })
}

function validateTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) {
    throw workspaceError('AGENT_WORKSPACE_INVALID_ID', 'Workspace task id is invalid.')
  }
  return taskId
}

function validateAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw workspaceError('AGENT_WORKSPACE_INVALID_PATH', `${label} must be an absolute path.`)
  return path.resolve(value)
}

function validateWorkspacePath(value, rootBase) {
  const target = validateAbsolutePath(value, 'workspacePath')
  const relative = path.relative(rootBase, target)
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw workspaceError('AGENT_WORKSPACE_INVALID_PATH', 'workspacePath must be a child of workspaceRoot.')
  }
  return target
}

function gitQuote(value) {
  const token = String(value)
  return /[ \t]/.test(token) ? `"${token}"` : token
}

async function git(cwd, args, { signal = null } = {}) {
  const result = await runCommand({
    cwd,
    command: `git ${args.map(gitQuote).join(' ')}`,
    timeoutMs: GIT_TIMEOUT_MS,
    outputLimitBytes: 2 * 1024 * 1024,
    signal
  })
  if (!result.ok && !result.cancelled && result.exitCode !== 0) {
    const detail = `${result.stderr || result.stdout || ''}`.trim().slice(0, 1_000)
    throw workspaceError('AGENT_GIT_FAILED', `git ${args[0]} failed (${result.exitCode ?? 'no exit'}): ${detail || 'no output'}`)
  }
  return result.stdout
}

const secretLikeSegments = /(?:^|\/)\.env(?:$|[._-])|(?:^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|\.npmrc|\.pypirc|\.netrc|credentials\.json)$|(?:^|\/)[^\/]*\.(?:pem|key|p12|pfx)$/i

function safeReadSegments(relativePath) {
  const clean = String(relativePath || '').replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.' && segment !== '..')
  if (!clean.length) return null
  if (clean.some((segment) => secretLikeSegments.test('/' + clean.join('/')) || segment === '.git')) return null
  return clean
}

function parsePorcelain(output) {
  const changes = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const action = line.slice(0, 2).trim()
    const filePath = line.slice(3).replace(/^"|"$/g, '').replace(/\\\\/g, '\\').trim()
    if (!filePath) continue
    changes.push({
      path: filePath.split('\\').join('/'),
      action: action === '??' ? 'added' : action === 'D' || action.includes('D') ? 'deleted' : 'modified',
      indexStatus: action
    })
  }
  return changes
}

// ---- Worktree adapter ----

export async function createWorktreeWorkspace({ projectPath, taskId, workspaceRoot, workspacePath = null, signal = null } = {}) {
  const id = validateTaskId(taskId)
  const source = validateAbsolutePath(projectPath, 'projectPath')
  const rootBase = validateAbsolutePath(workspaceRoot, 'workspaceRoot')
  const branch = `nexus-agent/${id.replace(/[._]/g, '-')}`
  const root = workspacePath
    ? validateWorkspacePath(workspacePath, rootBase)
    : path.join(rootBase, 'worktree', branch.replace(/\//g, '__'))
  await fs.mkdir(path.dirname(root), { recursive: true })
  const existing = await fs.lstat(root).catch(() => null)
  if (existing) throw workspaceError('AGENT_WORKSPACE_EXISTS', `A worktree directory already exists for this task: ${root}`)

  // Confirm this is a real git repository with at least one commit.
  const check = await runCommand({ cwd: source, command: 'git rev-parse --is-inside-work-tree', timeoutMs: GIT_TIMEOUT_MS })
  if (!check.ok || !check.stdout.includes('true')) throw workspaceError('AGENT_NOT_A_GIT_REPO', 'The project is not a git working tree.')
  const head = await runCommand({ cwd: source, command: 'git rev-parse --verify HEAD', timeoutMs: GIT_TIMEOUT_MS })
  if (!head.ok) throw workspaceError('AGENT_GIT_NO_COMMITS', 'The repository has no commits; a worktree cannot be created.')

  await git(source, ['worktree', 'add', '--quiet', '-b', branch, root, 'HEAD'], { signal })
  try {
    const meta = {
      kind: 'worktree',
      id,
      branch,
      projectId: null,
      projectPath: source,
      workspaceRoot: rootBase,
      root,
      source: root,
      createdAt: new Date().toISOString()
    }
    const status = await git(root, ['status', '--porcelain'], { signal })
    return { ...meta, cleanAtCreation: status.trim().length === 0 }
  } catch (error) {
    await runCommand({ cwd: source, command: `git worktree remove --force ${root}`, timeoutMs: GIT_TIMEOUT_MS }).catch(() => {})
    throw error
  }
}

async function listWorktreeChanges(adapter) {
  const status = await git(adapter.source, ['status', '--porcelain'], {})
  const changes = parsePorcelain(status)
  // Materialize content for review: stage everything in the isolated worktree
  // so the diff includes added files, then diff against HEAD.
  if (changes.length) await git(adapter.source, ['add', '-A'], {})
  return changes
}

async function worktreeDiff(adapter, { signal = null } = {}) {
  const changes = await listWorktreeChanges(adapter)
  if (!changes.length) return { changes, diff: '' }
  const diff = await git(adapter.source, ['diff', '--cached', 'HEAD', '--'], { signal })
  return { changes, diff }
}

async function restoreWorktreeFile(adapter, relativePath) {
  const clean = safeReadSegments(relativePath)
  if (!clean) throw workspaceError('AGENT_WORKSPACE_INVALID_PATH', 'A workspace-relative file path is required.')
  const relative = clean.join('/')
  // If the file exists in HEAD, restore it; if it was newly added, delete it.
  const check = await runCommand({ cwd: adapter.source, command: `git cat-file -e "HEAD:${relative}"`, timeoutMs: GIT_TIMEOUT_MS })
  if (check.ok) await git(adapter.source, ['checkout', 'HEAD', '--', relative], {})
  else {
    await fs.rm(path.join(adapter.source, ...clean), { force: true }).catch(() => {})
    const result = await runCommand({ cwd: adapter.source, command: `git status --porcelain -- ${gitQuote(relative)}`, timeoutMs: GIT_TIMEOUT_MS })
    if (result.stdout.trim()) await git(adapter.source, ['rm', '--cached', '--quiet', '--', relative], {}).catch(() => {})
  }
  return { path: relative }
}

async function restoreAllWorktree(adapter) {
  await git(adapter.source, ['reset', '--quiet', 'HEAD', '--'], {})
  await git(adapter.source, ['checkout', '--quiet', 'HEAD', '--', '.'], {})
  await git(adapter.source, ['clean', '-qfd'], {})
  return { reset: true }
}

async function disposeWorktree(adapter) {
  const result = await runCommand({ cwd: adapter.projectPath, command: `git worktree remove --force ${adapter.root}`, timeoutMs: GIT_TIMEOUT_MS })
  const removedWorktree = result.ok
  const branchResult = await runCommand({ cwd: adapter.projectPath, command: `git branch -D ${adapter.branch}`, timeoutMs: GIT_TIMEOUT_MS })
  await fs.rm(adapter.root, { recursive: true, force: true }).catch(() => {})
  return { removedWorktree, removedBranch: branchResult.ok }
}

// ---- Copy adapter (PHASE 4 workspace, extended) ----

function copyAdapter(workspaceHandle) {
  return {
    kind: 'copy',
    id: workspaceHandle.id,
    branch: null,
    projectPath: null,
    workspaceRoot: workspaceHandle.workspaceRoot,
    root: workspaceHandle.root,
    source: workspaceHandle.source,
    baselinePath: workspaceHandle.baselinePath,
    baselineFiles: workspaceHandle.baselineFiles,
    limits: workspaceHandle.limits,
    stats: workspaceHandle.stats,
    createdAt: workspaceHandle.createdAt,
    readFiles: (paths, options) => readLocalAgentFiles(workspaceHandle, paths, options),
    readAllFiles: (options) => readLocalAgentFiles(workspaceHandle, undefined, options),
    applyOperations: (operations) => applyLocalAgentOperations(workspaceHandle, operations),
    listChanges: () => listLocalAgentChanges(workspaceHandle),
    deleteFile: (relativePath) => deleteLocalAgentFile(workspaceHandle, relativePath),
    restoreFile: (relativePath) => restoreLocalAgentFile(workspaceHandle, relativePath),
    restoreAll: () => restoreAllLocalAgentFiles(workspaceHandle),
    diff: async () => {
      const changes = await listLocalAgentChanges(workspaceHandle)
      return { changes, diff: buildUnifiedDiff(changes) }
    },
    dispose: async () => {
      await fs.rm(workspaceHandle.root, { recursive: true, force: true })
      return { removedWorktree: false, removedBranch: false }
    }
  }
}

function worktreeAdapter(adapter) {
  return {
    ...adapter,
    readFiles: async (paths, options = {}) => {
      const maxBytes = options?.maxBytes || 2 * 1024 * 1024
      const maxFiles = options?.maxFiles || 20
      const files = []
      let total = 0
      for (const relativePath of (paths || []).slice(0, maxFiles)) {
        const clean = safeReadSegments(relativePath)
        if (!clean) continue
        const target = path.join(adapter.source, ...clean)
        const info = await fs.stat(target).catch(() => null)
        if (!info?.isFile() || info.size > maxFileWindowBytes()) continue
        if (total + info.size > maxBytes) break
        const bytes = await fs.readFile(target)
        files.push({ path: clean.join('/'), content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })
        total += info.size
      }
      return files
    },
    readAllFiles: async () => { throw workspaceError('AGENT_WORKSPACE_UNSUPPORTED', 'readAllFiles is not supported for worktree workspaces; use the index and readFiles.') },
    applyOperations: async (operations) => {
      const applied = []
      for (const operation of operations) {
        if (!operation || !['create', 'replace'].includes(operation.action) || typeof operation.path !== 'string' || typeof operation.content !== 'string') {
          throw workspaceError('AGENT_OPERATION_INVALID', 'Worktree operations must be create or replace with path and content.')
        }
        const clean = safeReadSegments(operation.path)
        if (!clean) throw workspaceError('AGENT_PATH_INVALID', `Unsafe or secret-like worktree path: ${operation.path}`)
        const target = path.join(adapter.source, ...clean)
        if (path.relative(adapter.source, target).startsWith('..')) throw workspaceError('AGENT_PATH_ESCAPE', 'Worktree path escaped the worktree root.')
        await fs.mkdir(path.dirname(target), { recursive: true })
        if (operation.action === 'create') {
          const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          const handle = await fs.open(target, flags).catch((error) => {
            if (error.code === 'EEXIST') throw workspaceError('AGENT_FILE_EXISTS', `Refusing to overwrite an existing file: ${operation.path}`)
            throw error
          })
          try { await handle.writeFile(Buffer.from(operation.content, 'utf8')) } finally { await handle.close() }
        } else {
          const info = await fs.lstat(target).catch(() => null)
          if (!info || info.isSymbolicLink() || !info.isFile()) throw workspaceError('AGENT_FILE_MISSING', `Replace target must be an existing regular file: ${operation.path}`)
          await fs.writeFile(target, Buffer.from(operation.content, 'utf8'))
        }
        applied.push(clean.join('/'))
      }
      return applied
    },
    listChanges: () => listWorktreeChanges(adapter),
    deleteFile: async (relativePath) => {
      const clean = safeReadSegments(relativePath)
      if (!clean) throw workspaceError('AGENT_PATH_INVALID', `Unsafe or secret-like worktree path: ${relativePath}`)
      const target = path.join(adapter.source, ...clean)
      if (path.relative(adapter.source, target).startsWith('..')) throw workspaceError('AGENT_PATH_ESCAPE', 'Worktree path escaped the worktree root.')
      const info = await fs.lstat(target).catch(() => null)
      if (!info?.isFile()) throw workspaceError('AGENT_FILE_MISSING', `File does not exist: ${relativePath}`)
      await fs.rm(target, { force: true })
      return clean.join('/')
    },
    restoreFile: (relativePath) => restoreWorktreeFile(adapter, relativePath),
    restoreAll: () => restoreAllWorktree(adapter),
    diff: (options) => worktreeDiff(adapter, options),
    dispose: () => disposeWorktree(adapter)
  }
}

function maxFileWindowBytes() {
  return 512 * 1024
}

function buildUnifiedDiff(changes) {
  const lines = []
  for (const change of changes) {
    lines.push(`--- ${change.action === 'added' ? '/dev/null' : `a/${change.path}`}`)
    lines.push(`+++ ${change.action === 'deleted' ? '/dev/null' : `b/${change.path}`}`)
    if (change.before && change.after) {
      lines.push(`@@ modified: ${change.path}`)
      lines.push(...simpleLineDiff(change.before, change.after))
    } else if (change.after) {
      lines.push(`@@ added: ${change.path}`)
      lines.push(...change.after.split('\n').map((line) => `+${line}`))
    } else if (change.before) {
      lines.push(`@@ deleted: ${change.path}`)
      lines.push(...change.before.split('\n').map((line) => `-${line}`))
    } else {
      lines.push('@@ content omitted (size limit)')
    }
  }
  return lines.join('\n')
}

function simpleLineDiff(before, after) {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const result = []
  const max = Math.max(beforeLines.length, afterLines.length)
  for (let index = 0; index < max && index < 400; index += 1) {
    const oldLine = beforeLines[index]
    const newLine = afterLines[index]
    if (oldLine === newLine) result.push(` ${oldLine ?? ''}`)
    else {
      if (oldLine !== undefined) result.push(`-${oldLine}`)
      if (newLine !== undefined) result.push(`+${newLine}`)
    }
  }
  if (max > 400) result.push(`... (${max - 400} more line changes)`)
  return result
}

// ---- Factory ----

export async function createAgentWorkspace({ project, taskId, mode = 'auto', workspaceRoot, workspacePath = null, dataDir, limits, signal = null } = {}) {
  const id = validateTaskId(taskId)
  const requestedMode = ['auto', 'worktree', 'copy'].includes(mode) ? mode : 'auto'
  if (requestedMode === 'worktree' || requestedMode === 'auto') {
    try {
      const adapter = worktreeAdapter(await createWorktreeWorkspace({ projectPath: project.path, taskId: id, workspaceRoot, workspacePath, signal }))
      return { adapter, mode: 'worktree', fallbackReason: null }
    } catch (error) {
      if (requestedMode === 'worktree') throw error
      // auto: fall back to the bounded copy workspace with a recorded reason.
      const copyHandle = await createLocalAgentWorkspace({ dataDir, project, taskId: id, workspaceRoot, limits })
      return { adapter: copyAdapter(copyHandle), mode: 'copy', fallbackReason: String(error.message || error).slice(0, 300) }
    }
  }
  const copyHandle = await createLocalAgentWorkspace({ dataDir, project, taskId: id, workspaceRoot, limits })
  return { adapter: copyAdapter(copyHandle), mode: 'copy', fallbackReason: null }
}

// Rebuild an adapter for an existing workspace after the runtime finished
// (rollback / apply endpoints). Throws when the workspace is gone.
export async function reconstructAdapter({ taskId, projectId, repository = null, mode, dataDir, workspaceRoot }) {
  const id = validateTaskId(taskId)
  if (mode === 'worktree') {
    const rootBase = validateAbsolutePath(workspaceRoot, 'workspaceRoot')
    const root = repository
      ? repoWorktreePath(dataDir, repository, id)
      : path.join(rootBase, 'worktree', `nexus-agent__${id.replace(/[._]/g, '-')}`)
    const info = await fs.lstat(root).catch(() => null)
    if (!info?.isDirectory()) throw workspaceError('AGENT_WORKSPACE_GONE', `The worktree for this task no longer exists: ${root}`)
    const projectPath = await readWorktreeProjectPath(root)
    return worktreeAdapter({ kind: 'worktree', id, branch: `nexus-agent/${id.replace(/[._]/g, '-')}`, projectPath, workspaceRoot: rootBase, root, source: root, createdAt: null })
  }
  const manifestPath = path.join(dataDir, 'agent-workspaces', 'agent', String(projectId || ''), id, 'baseline.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const handle = {
    id,
    projectId,
    projectName: manifest.project?.name || '',
    workspaceRoot: path.join(dataDir, 'agent-workspaces', 'agent'),
    root: path.join(dataDir, 'agent-workspaces', 'agent', String(projectId || ''), id),
    source: path.join(dataDir, 'agent-workspaces', 'agent', String(projectId || ''), id, 'source'),
    baselinePath: path.join(dataDir, 'agent-workspaces', 'agent', String(projectId || ''), id, 'baseline.json'),
    baselineFiles: path.join(dataDir, 'agent-workspaces', 'agent', String(projectId || ''), id, 'baseline-files'),
    limits: manifest.limits,
    stats: manifest.stats
  }
  return copyAdapter(handle)
}

async function readWorktreeProjectPath(worktreeRoot) {
  const { runCommand } = await import('./executor.mjs')
  const result = await runCommand({ cwd: worktreeRoot, command: 'git rev-parse --show-toplevel', timeoutMs: 15_000 })
  if (!result.ok) throw workspaceError('AGENT_WORKSPACE_GONE', 'The worktree is no longer a valid git worktree.')
  return path.resolve(result.stdout.trim())
}

export { buildUnifiedDiff, parsePorcelain }
