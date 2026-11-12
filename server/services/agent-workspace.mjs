import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workspaceRoot = path.resolve(process.env.NEXUS_AGENT_WORKSPACE_ROOT || path.join(process.env.NEXUS_DATA_DIR || path.join(projectRoot, 'data'), 'agent-workspaces'))
const locks = new Map()

function safeSegment(value) {
  const segment = String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)
  if (!segment || segment === '.' || segment === '..') throw new Error('Workspace identifier is not a safe path segment.')
  return segment
}

function assertInsideRoot(target) {
  const resolved = path.resolve(target)
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error('Workspace path escaped the managed workspace root.')
  return resolved
}

function gitEnvironment(extra = {}) {
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec']
  const env = Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0', ...extra }
}

function git(args, cwd, env = {}, timeoutMs = 600_000, signal) {
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

export async function assertManagedWorkspace(target, { requireExisting = true } = {}) {
  const lexical = assertInsideRoot(target)
  const rootStat = await fs.lstat(workspaceRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (rootStat?.isSymbolicLink()) throw new Error('Managed workspace root must not be a symbolic link.')
  const canonicalRoot = await fs.realpath(workspaceRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!canonicalRoot) throw new Error('Managed workspace root does not exist.')
  const relative = path.relative(workspaceRoot, lexical)
  let current = workspaceRoot
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stat = await fs.lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (stat?.isSymbolicLink()) throw new Error('Symbolic links are not allowed in managed workspaces.')
  }
  if (requireExisting) {
    const canonicalTarget = await fs.realpath(lexical)
    if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error('Workspace path escaped the managed workspace root.')
  }
  return lexical
}

async function validateFilePath(root, relativePath, { mustExist = false } = {}) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) throw new Error('Workspace file path must be relative.')
  const segments = relativePath.replace(/\\/g, '/').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) throw new Error('Unsafe workspace file path.')
  if (segments.some((segment) => /^\.env(?:\.|$)|\.pem$|\.key$|secret|credential/i.test(segment))) throw new Error('Secret-like files cannot be changed by the integration agent.')
  const target = assertInsideRoot(path.join(root, ...segments))
  let current = root
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index])
    const stat = await fs.lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (stat?.isSymbolicLink()) throw new Error('Symbolic links are not allowed in changed workspace paths.')
    if (index < segments.length - 1 && stat && !stat.isDirectory()) throw new Error('Workspace path parent is not a directory.')
    if (index === segments.length - 1) {
      if (mustExist && !stat) throw new Error(`Workspace file does not exist: ${relativePath}`)
      if (stat && !stat.isFile()) throw new Error(`Workspace path is not a regular file: ${relativePath}`)
    }
  }
  return target
}

export async function createAgentWorkspace({ jobId, project, token, signal }) {
  const repoKey = safeSegment(project.id)
  const jobKey = safeSegment(jobId)
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(String(project.fullName || ''))) throw new Error('Repository name is not a valid owner/name pair.')
  const lockKey = safeSegment(project.githubId || project.id)
  if (locks.has(lockKey)) throw Object.assign(new Error('Another integration job already holds this repository workspace lock.'), { code: 'WORKSPACE_LOCKED' })
  locks.set(lockKey, jobKey)
  try {
    const projectRealPath = await fs.realpath(projectRoot)
    if (projectRealPath !== projectRoot) throw new Error('Project root must not be reached through a symbolic link.')
    await fs.mkdir(workspaceRoot, { recursive: true })
    if ((await fs.lstat(workspaceRoot)).isSymbolicLink()) throw new Error('Managed workspace root must not be a symbolic link.')
    if (await fs.realpath(workspaceRoot) !== workspaceRoot) throw new Error('Managed workspace root must not resolve through a symbolic link.')
    const target = assertInsideRoot(path.join(workspaceRoot, repoKey, jobKey, 'source'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    const branch = `nexus/auto-update-${jobKey}`
    const url = `https://github.com/${project.fullName}.git`
    const authEnv = token ? {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    } : {}
    try {
      await git(['clone', '--depth', '1', '--branch', project.defaultBranch, '--no-tags', url, target], path.dirname(target), authEnv, 600_000, signal)
    } finally {
      if (authEnv.GIT_CONFIG_VALUE_0) authEnv.GIT_CONFIG_VALUE_0 = ''
    }
    await git(['checkout', '-b', branch], target)
    const status = await git(['status', '--porcelain'], target)
    if (status.stdout) throw new Error('Fresh workspace is unexpectedly dirty after clone.')
    const head = await git(['rev-parse', 'HEAD'], target)
    return { id: jobKey, projectId: project.id, repository: project.fullName, path: target, branch, baseCommit: head.stdout, createdAt: new Date().toISOString(), state: 'READY', lockId: crypto.randomUUID() }
  } catch (error) {
    locks.delete(lockKey)
    await fs.rm(assertInsideRoot(path.join(workspaceRoot, repoKey, jobKey)), { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function releaseWorkspaceLock(projectId, jobId) {
  const key = safeSegment(projectId)
  if (locks.get(key) === safeSegment(jobId)) locks.delete(key)
}

export async function workspaceDiff(workspace) {
  const target = await assertManagedWorkspace(workspace.path)
  await git(['add', '--intent-to-add', '--', '.'], target)
  const result = await git(['diff', '--no-ext-diff', '--stat', 'HEAD'], target)
  return result.stdout
}

export async function workspacePatch(workspace) {
  const target = await assertManagedWorkspace(workspace.path)
  await git(['add', '--intent-to-add', '--', '.'], target)
  const result = await git(['diff', '--no-ext-diff', '--no-color', 'HEAD'], target)
  return result.stdout.slice(0, 2_000_000)
}

export async function workspaceStatus(workspace) {
  const target = await assertManagedWorkspace(workspace.path)
  const result = await git(['status', '--short', '--branch'], target)
  return result.stdout
}

export async function applyFileOperations(workspace, operations) {
  const target = await assertManagedWorkspace(workspace.path)
  if (!Array.isArray(operations) || operations.length > 30) throw new Error('File operation list is invalid or exceeds the 30-operation limit.')
  const seen = new Set()
  const validated = []
  for (const operation of operations) {
    if (!['create', 'replace', 'delete'].includes(operation.action) || typeof operation.path !== 'string') throw new Error('Invalid workspace file operation.')
    const key = operation.path.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) throw new Error('A file path may only appear once in a change set.')
    seen.add(key)
    const filePath = await validateFilePath(target, operation.path, { mustExist: operation.action !== 'create' })
    if (operation.action === 'create' && await fs.lstat(filePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))) throw new Error(`Refusing to overwrite existing file: ${operation.path}`)
    if (operation.action !== 'delete' && (typeof operation.content !== 'string' || Buffer.byteLength(operation.content) > 512 * 1024)) throw new Error('File operation content is missing or exceeds 512 KiB.')
    validated.push({ ...operation, filePath })
  }
  const applied = []
  for (const operation of validated) {
    if (operation.action === 'delete') await fs.rm(operation.filePath, { force: true })
    else {
      await fs.mkdir(path.dirname(operation.filePath), { recursive: true })
      const temporary = `${operation.filePath}.${crypto.randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, operation.content, { encoding: 'utf8', flag: 'wx' })
        if (operation.action === 'create') await fs.link(temporary, operation.filePath)
        else await fs.rename(temporary, operation.filePath)
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
    }
    applied.push(operation.path)
  }
  return applied
}

export async function readWorkspaceFiles(workspace, relativePaths, { maxFiles = 20, maxFileBytes = 20_000 } = {}) {
  const root = await assertManagedWorkspace(workspace.path)
  const files = []
  for (const relativePath of [...new Set(relativePaths || [])]) {
    if (files.length >= maxFiles) break
    if (/(^|\/)(\.env[^/]*|.*\.pem|.*\.key|.*secret.*|.*credential.*)$/i.test(relativePath)) continue
    const target = await validateFilePath(root, relativePath, { mustExist: true })
    const stat = await fs.stat(target)
    if (!stat.isFile() || stat.size > maxFileBytes) continue
    files.push({ path: relativePath, content: await fs.readFile(target, 'utf8') })
  }
  return files
}

export async function pushWorkspaceBranch(workspace, token, changedPaths) {
  const target = await assertManagedWorkspace(workspace.path)
  if (!token) throw Object.assign(new Error('A scoped GitHub token is required to push the review branch.'), { code: 'GITHUB_NOT_CONFIGURED' })
  const extra = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  }
  try {
    if (!Array.isArray(changedPaths) || !changedPaths.length) throw new Error('No approved changed-file list was provided.')
    await git(['add', '--all', '--', ...changedPaths.map((value) => `./${value.replace(/\\/g, '/')}`)], target)
    const status = await git(['status', '--porcelain'], target)
    if (!status.stdout) throw new Error('No changes are available to push.')
    await git(['-c', 'user.name=PROJECT NEXUS', '-c', 'user.email=project-nexus@users.noreply.github.com', 'commit', '-m', 'Add verified auto-update integration'], target)
    await git(['push', '--set-upstream', 'origin', workspace.branch], target, extra, 120_000)
    return await git(['rev-parse', 'HEAD'], target)
  } finally { extra.GIT_CONFIG_VALUE_0 = '' }
}

export function getWorkspaceRoot() { return workspaceRoot }
