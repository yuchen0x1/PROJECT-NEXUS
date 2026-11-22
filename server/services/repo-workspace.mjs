import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// PHASE 1: managed, on-demand local workspaces for hosted GitHub repositories.
//
// Layout (spec PART 3.4, adapted to the existing data directory):
//   <dataDir>/repositories/<owner>__<repo>/cache      — a NEXUS-managed clone
//   <dataDir>/repositories/<owner>__<repo>/worktrees/ — per-task worktrees
//
// The cache clone doubles as the "project path" handed to the existing agent
// runtime, so worktree isolation, rollback and review reuse the PHASE 6
// adapters unchanged. The cache itself is never hand-edited; it is only
// fetched and checked out, so resetting it never touches user data.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const repoLocks = new Map()
const CLONE_TIMEOUT_MS = 600_000
const FETCH_TIMEOUT_MS = 300_000
const GIT_TIMEOUT_MS = 60_000
let proxyConfiguration

async function gitProxy() {
  // Preserve the user's networking route without inheriting hooks, aliases,
  // credential helpers, or URL rewrites into managed repository operations.
  proxyConfiguration ||= new Promise((resolve) => {
    const child = spawn('git', ['config', '--get-urlmatch', 'http.proxy', 'https://github.com/'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(0, 4096) })
    const timer = setTimeout(() => { child.kill(); resolve('') }, 3000)
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => { clearTimeout(timer); resolve(output.trim()) })
  })
  return proxyConfiguration
}

export function repoWorkspaceRoot() {
  return repoWorkspaceRootFor()
}

export function repoWorkspaceRootFor(dataDir) {
  return path.resolve(process.env.NEXUS_REPO_WORKSPACE_ROOT || path.join(dataDir || process.env.NEXUS_DATA_DIR || path.join(projectRoot, 'data'), 'repositories'))
}

function safeSegment(value) {
  const segment = String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)
  if (!segment || segment === '.' || segment === '..') throw Object.assign(new Error('Repository identifier is not a safe path segment.'), { code: 'REPO_KEY_INVALID' })
  return segment
}

export function validateRepoFullName(fullName) {
  const segments = String(fullName || '').split('/')
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]{1,100}$/.test(segment)) || segments.some((segment) => segment === '.' || segment === '..')) {
    throw Object.assign(new Error('Repository must be an owner/name pair.'), { code: 'INVALID_REPOSITORY' })
  }
  return fullName
}

export function repoKeyFor(fullName) {
  const [owner, name] = validateRepoFullName(fullName).split('/')
  return `${safeSegment(owner)}__${safeSegment(name)}`
}

export function repoCachePath(dataDir, fullName) {
  const root = repoWorkspaceRootFor(dataDir)
  return path.join(root, repoKeyFor(fullName), 'cache')
}

export function repoWorktreePath(dataDir, fullName, taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) {
    throw Object.assign(new Error('Task identifier is not a safe workspace path segment.'), { code: 'REPO_TASK_INVALID' })
  }
  return path.join(repoWorkspaceRootFor(dataDir), repoKeyFor(fullName), 'worktrees', safeSegment(taskId))
}

function assertInsideRoot(target, root = repoWorkspaceRootFor()) {
  const resolved = path.resolve(target)
  const rootResolved = path.resolve(root)
  const compare = (value) => process.platform === 'win32' ? value.toLowerCase() : value
  const normalizedTarget = compare(resolved)
  const normalizedRoot = compare(rootResolved)
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw Object.assign(new Error('Repository workspace path escaped the managed root.'), { code: 'REPO_PATH_ESCAPE' })
  }
  return resolved
}

async function assertNoWorkspaceLinks(target, root) {
  assertInsideRoot(target, root)
  let current = path.resolve(root)
  const parts = path.relative(current, path.resolve(target)).split(path.sep).filter(Boolean)
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part)
    const info = await fs.lstat(current).catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
    if (info?.isSymbolicLink()) throw Object.assign(new Error('Managed workspace contains a symbolic link or junction.'), { code: 'REPO_PATH_ESCAPE' })
  }
}

function gitEnvironment(extra = {}) {
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec']
  const env = Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0', ...extra }
}

function authEnv(token) {
  if (!token) return {}
  const env = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  }
  return env
}

function clearAuthEnv(env) {
  if (env.GIT_CONFIG_VALUE_0) env.GIT_CONFIG_VALUE_0 = ''
}

async function git(args, cwd, env = {}, timeoutMs = GIT_TIMEOUT_MS, signal) {
  const proxy = await gitProxy()
  if (proxy) {
    const index = Number(env.GIT_CONFIG_COUNT || 0)
    env = { ...env, GIT_CONFIG_COUNT: String(index + 1), [`GIT_CONFIG_KEY_${index}`]: 'http.proxy', [`GIT_CONFIG_VALUE_${index}`]: proxy }
  }
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd, windowsHide: true, shell: false,
      env: gitEnvironment(env), stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    const append = (target, chunk) => {
      const next = target + chunk.toString('utf8')
      return next.length > 200_000 ? next.slice(-200_000) : next
    }
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    const abort = () => { cancelled = true; child.kill() }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (cancelled) return reject(Object.assign(new Error('Git operation was cancelled.'), { code: 'JOB_CANCELLED' }))
      if (timedOut) return reject(Object.assign(new Error(`git ${args[0]} timed out.`), { code: 'GIT_TIMEOUT' }))
      const output = { stdout: stdout.trim(), stderr: stderr.trim() }
      return code === 0 ? resolve(output) : reject(Object.assign(new Error(`git ${args[0]} failed (${code}): ${output.stderr.slice(0, 2000)}`), { code: 'GIT_FAILED', exitCode: code }))
    })
  })
}

// Async per-repository mutex: clones/fetches for the same repository are
// serialized; different repositories run concurrently.
export async function withRepoLock(key, fn) {
  while (repoLocks.has(key)) await repoLocks.get(key).catch(() => {})
  let release
  const ticket = new Promise((resolve) => { release = resolve })
  repoLocks.set(key, ticket)
  try {
    return await fn()
  } finally {
    repoLocks.delete(key)
    release()
  }
}

async function assertManagedCache(target, dataDir) {
  const root = repoWorkspaceRootFor(dataDir)
  const lexical = assertInsideRoot(target, root)
  const rootStat = await fs.lstat(root).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (rootStat?.isSymbolicLink()) throw Object.assign(new Error('Repository workspace root must not be a symbolic link.'), { code: 'REPO_ROOT_INVALID' })
  const canonicalRoot = await fs.realpath(root).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!canonicalRoot) throw Object.assign(new Error('Repository workspace root does not exist.'), { code: 'REPO_ROOT_MISSING' })
  const canonicalTarget = await fs.realpath(lexical).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (canonicalTarget) {
    const compare = (value) => process.platform === 'win32' ? value.toLowerCase() : value
    const targetValue = compare(canonicalTarget)
    const rootValue = compare(canonicalRoot)
    if (targetValue !== rootValue && !targetValue.startsWith(`${rootValue}${path.sep}`)) {
      throw Object.assign(new Error('Repository workspace path escaped the managed root.'), { code: 'REPO_PATH_ESCAPE' })
    }
  }
  return lexical
}

export async function describeRepoCache({ dataDir, fullName }) {
  const cachePath = repoCachePath(dataDir, fullName)
  const info = await fs.lstat(cachePath).catch(() => null)
  if (!info?.isDirectory()) return { exists: false, path: cachePath, headSha: null, branch: null, dirty: null, checkedOutAt: null }
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cachePath).then((r) => r.stdout).catch(() => null)
  const headSha = await git(['rev-parse', 'HEAD'], cachePath).then((r) => r.stdout).catch(() => null)
  const status = await git(['status', '--porcelain'], cachePath).then((r) => r.stdout).catch(() => null)
  return { exists: true, path: cachePath, headSha, branch, dirty: Boolean(status?.trim()), checkedOutAt: null }
}

// Clone once, then fetch incrementally. `branch` is checked out in the cache
// clone so index/context builders see the intended tree. `remoteUrl` defaults
// to the GitHub HTTPS URL and is injectable for tests and future remotes.
export async function ensureRepoCache({ dataDir, fullName, token, branch, signal, remoteUrl } = {}) {
  validateRepoFullName(fullName)
  const key = repoKeyFor(fullName)
  const root = repoWorkspaceRootFor(dataDir)
  const cachePath = assertInsideRoot(path.join(root, key, 'cache'), root)
  return withRepoLock(key, async () => {
    await assertNoWorkspaceLinks(cachePath, root)
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    const exists = await fs.lstat(cachePath).then((info) => info.isDirectory()).catch(() => false)
    const url = remoteUrl || `https://github.com/${fullName}.git`
    const env = authEnv(token)
    try {
      if (!exists) {
        const branchArgs = branch ? ['--branch', branch] : []
        await git(['clone', '--no-tags', ...branchArgs, url, cachePath], path.dirname(cachePath), env, CLONE_TIMEOUT_MS, signal)
      } else {
        const origin = await git(['remote', 'get-url', 'origin'], cachePath)
        if (origin.stdout.replace(/\.git$/, '').toLowerCase() !== url.replace(/\.git$/, '').toLowerCase()) throw Object.assign(new Error('Managed cache remote does not match this repository.'), { code: 'REPO_REMOTE_MISMATCH' })
        const dirty = await git(['status', '--porcelain'], cachePath)
        if (dirty.stdout) throw Object.assign(new Error('Managed cache has local changes; they were preserved.'), { code: 'REPO_CACHE_DIRTY' })
        await git(['fetch', '--prune', 'origin'], cachePath, env, FETCH_TIMEOUT_MS, signal)
        if (branch) {
          // The cache is NEXUS-managed and never holds user edits; hard-checkout
          // the requested branch to keep the tree in sync with origin.
          await git(['checkout', '--force', branch], cachePath, env, GIT_TIMEOUT_MS, signal)
          await git(['reset', '--hard', `origin/${branch}`], cachePath, env, GIT_TIMEOUT_MS, signal)
        }
      }
    } finally {
      clearAuthEnv(env)
    }
    const head = await git(['rev-parse', 'HEAD'], cachePath).catch(() => ({ stdout: null }))
    const currentBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cachePath).then((r) => r.stdout).catch(() => null)
    return { path: cachePath, headSha: head.stdout || null, branch: currentBranch, cloned: !exists }
  })
}

export async function cacheHasCommitFor(dataDir, fullName, ref) {
  const cachePath = repoCachePath(dataDir, fullName)
  const result = await git(['rev-parse', '--verify', `${ref}^{commit}`], cachePath).catch(() => null)
  return Boolean(result?.stdout)
}

export async function prepareMergedReleaseWorkspace({ dataDir, fullName, token, commitSha, testedSha, signal }) {
  if (!/^[a-f0-9]{40}$/.test(String(commitSha)) || !/^[a-f0-9]{40}$/.test(String(testedSha))) throw Object.assign(new Error('Release commits must be full Git SHAs.'), { code: 'RELEASE_SHA_INVALID' })
  const cachePath = await assertManagedCache(repoCachePath(dataDir, fullName), dataDir)
  const target = repoWorktreePath(dataDir, fullName, `release-${commitSha}`)
  const env = authEnv(token)
  try {
    await git(['fetch', 'origin', commitSha], cachePath, env, FETCH_TIMEOUT_MS, signal)
    // An independent review can be reused only for the exact reviewed tree.
    await git(['diff', '--quiet', testedSha, commitSha], cachePath, {}, GIT_TIMEOUT_MS, signal)
    if (!await fs.lstat(target).catch(() => null)) {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await git(['worktree', 'add', '--detach', target, commitSha], cachePath, {}, GIT_TIMEOUT_MS, signal)
    }
    await assertManagedCache(target, dataDir)
    return { path: target, commitSha }
  } finally { clearAuthEnv(env) }
}

// Commit the task worktree and push its branch to origin (review/PR delivery).
// `targetBranch` optionally republishes the commit under a different, more
// readable branch name (e.g. nexus-fix/issue-12) than the runtime worktree
// branch (nexus-agent/<taskId>).
export async function commitAndPushBranch({ dataDir, worktreePath, branch, targetBranch, token, commitMessage, changedPaths, beforePush = () => {}, performPush = async (_metadata, perform) => perform() } = {}) {
  const target = await assertManagedCache(worktreePath, dataDir)
  if (!token) throw Object.assign(new Error('A GitHub token is required to push the review branch.'), { code: 'GITHUB_NOT_CONFIGURED' })
  const env = authEnv(token)
  const pushBranch = targetBranch || branch
  try {
    if (Array.isArray(changedPaths) && changedPaths.length) {
      await git(['add', '-A', '--', ...changedPaths.map((value) => `./${String(value).replace(/\\/g, '/')}`)], target)
    } else {
      await git(['add', '-A'], target)
    }
    const status = await git(['status', '--porcelain'], target)
    if (!status.stdout) throw Object.assign(new Error('No changes are available to commit.'), { code: 'REPO_NO_CHANGES' })
    const message = String(commitMessage || 'Automated update from PROJECT NEXUS').slice(0, 500)
    await git(['-c', 'user.name=PROJECT NEXUS', '-c', 'user.email=project-nexus@users.noreply.github.com', 'commit', '-m', message], target)
    if (targetBranch && targetBranch !== branch) {
      await git(['branch', targetBranch, 'HEAD'], target)
    }
    const head = await git(['rev-parse', 'HEAD'], target)
    await beforePush()
    await performPush({ branch: pushBranch, commitSha: head.stdout }, () => git(['push', '--set-upstream', 'origin', pushBranch], target, env, 180_000).then(() => ({ commitSha: head.stdout, branch: pushBranch })))
    return { commitSha: head.stdout, branch: pushBranch }
  } finally {
    clearAuthEnv(env)
  }
}

// Remove a finished task worktree and its branch from the cache clone.
export async function disposeRepoWorktree({ dataDir, fullName, taskId, branch } = {}) {
  const root = repoWorkspaceRootFor(dataDir)
  const cachePath = repoCachePath(dataDir, fullName)
  const key = repoKeyFor(fullName)
  return withRepoLock(key, async () => {
    const exists = await fs.lstat(cachePath).then((info) => info.isDirectory()).catch(() => false)
    if (!exists) return { removedWorktree: false, removedBranch: false }
    const worktreePath = assertInsideRoot(path.join(root, key, 'worktrees', safeSegment(taskId)), root)
    await assertNoWorkspaceLinks(worktreePath, root)
    let removedWorktree = false
    const listing = await git(['worktree', 'list', '--porcelain'], cachePath).catch(() => ({ stdout: '' }))
    // git normalizes paths to forward slashes even on Windows.
    if (listing.stdout.includes(worktreePath.replace(/\\/g, '/'))) {
      const removal = await git(['worktree', 'remove', '--force', worktreePath], cachePath).catch(() => null)
      removedWorktree = Boolean(removal)
    }
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {})
    let removedBranch = false
    if (branch) {
      const deletion = await git(['branch', '-D', '--', branch], cachePath).catch(() => null)
      removedBranch = Boolean(deletion)
    }
    return { removedWorktree, removedBranch }
  })
}

// Remove the whole managed workspace (cache + worktrees) for one repository.
// Only ever called for NEXUS-managed paths; never for user-owned projects.
export async function removeRepoWorkspace(dataDir, fullName) {
  validateRepoFullName(fullName)
  const root = repoWorkspaceRootFor(dataDir)
  const key = repoKeyFor(fullName)
  return withRepoLock(key, async () => {
    const dir = assertInsideRoot(path.join(root, key), root)
    await assertNoWorkspaceLinks(dir, root)
    const existed = await fs.lstat(dir).catch(() => null)
    // Prune git registrations first so no clone keeps a dangling worktree link.
    await git(['worktree', 'prune'], path.join(dir, 'cache')).catch(() => {})
    await fs.rm(dir, { recursive: true, force: true })
    return { removed: Boolean(existed) }
  })
}

// Garbage collection: remove managed workspaces for repositories that are no
// longer managed. Returns the removed repository keys.
export async function sweepStaleRepoWorkspaces({ dataDir, keepKeys } = {}) {
  const root = repoWorkspaceRootFor(dataDir)
  const keep = new Set(keepKeys || [])
  const removed = []
  const entries = await fs.readdir(root).catch(() => [])
  for (const entry of entries) {
    if (keep.has(entry)) continue
    const dir = assertInsideRoot(path.join(root, entry), root)
    const info = await fs.lstat(dir).catch(() => null)
    if (!info?.isDirectory()) continue
    await git(['worktree', 'prune'], path.join(dir, 'cache')).catch(() => {})
    await fs.rm(dir, { recursive: true, force: true })
    removed.push(entry)
  }
  return removed
}

export function randomTaskKey(prefix = 'task') {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}
