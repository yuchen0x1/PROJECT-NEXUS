import express from 'express'
import cors from 'cors'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadStateFile, saveStateFile, emptyState } from './services/state-store.mjs'
import { adapters } from './integrations/registry.mjs'
import { scanRepository } from './services/repository-scanner.mjs'
import { fetchAllPages, githubNextLink } from './services/github-pagination.mjs'
import { repositoryApiPath } from './services/github-paths.mjs'
import { aiProviderStatus, diagnoseWithAI, generateIntegrationOperations, generateLocalAgentOperations, listAIProviders, redactSecrets } from './services/ai-provider.mjs'
import { createAgentWorkspace, releaseWorkspaceLock, workspaceDiff, workspacePatch, workspaceStatus, applyFileOperations, readWorkspaceFiles, pushWorkspaceBranch } from './services/agent-workspace.mjs'
import { runSandboxed } from './services/sandbox-runner.mjs'
import { beginAgentAttempt, createAgentRun, transitionAgentRun } from './services/agent-runner.mjs'
import { listLocalProjects } from './services/local-projects.mjs'
import { createLocalAgentTask as persistLocalAgentTask, getLocalAgentTask, listLocalAgentTasks, recoverLocalAgentTaskStore, updateLocalAgentTask } from './services/local-agent-tasks.mjs'
import { applyLocalAgentOperations, createLocalAgentWorkspace, listLocalAgentChanges, readLocalAgentFiles } from './services/local-agent-workspace.mjs'
import fs from 'node:fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const dataDir = path.resolve(process.env.NEXUS_DATA_DIR || path.join(root, 'data'))
const stateFile = path.resolve(process.env.NEXUS_STATE_FILE || path.join(dataDir, 'state.json'))
const port = Number(process.env.PORT || 4317)
const host = process.env.NEXUS_HOST || '127.0.0.1'
const githubApiUrl = process.env.GITHUB_API_URL || 'https://api.github.com'
const githubUploadsUrl = process.env.GITHUB_UPLOADS_URL || 'https://uploads.github.com'
const appConfig = {
  id: process.env.GITHUB_APP_ID || '',
  clientId: process.env.GITHUB_APP_CLIENT_ID || '',
  clientSecret: process.env.GITHUB_APP_CLIENT_SECRET || '',
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY || '',
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || ''
}
const activeRole = String(process.env.NEXUS_ROLE || 'Administrator')
const allowRoleHeader = process.env.NEXUS_ALLOW_ROLE_HEADER === 'true'
const corsOrigins = new Set(
  String(process.env.NEXUS_CORS_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',').map((value) => value.trim()).filter(Boolean)
)

let state = structuredClone(emptyState)
const integrationControllers = new Map()
const agentWorkspacePaths = new Map()
const localAgentControllers = new Map()
const localAgentQueue = []
let localAgentWorkerRunning = false
const pendingGitHubAppInstallStates = new Map()
let stateWriteQueue = Promise.resolve()

const GITHUB_APP_INSTALL_STATE_TTL_MS = 10 * 60 * 1000

async function loadState() {
  state = await loadStateFile(stateFile)
}

async function saveState() {
  const snapshot = structuredClone(state)
  stateWriteQueue = stateWriteQueue.catch(() => {}).then(() => saveStateFile(stateFile, snapshot))
  return stateWriteQueue
}

function now() {
  return new Date().toISOString()
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
}

function pruneGitHubAppInstallStates() {
  const cutoff = Date.now()
  for (const [token, record] of pendingGitHubAppInstallStates) {
    if (record.expiresAt <= cutoff) pendingGitHubAppInstallStates.delete(token)
  }
}

function issueGitHubAppInstallState() {
  pruneGitHubAppInstallStates()
  const token = crypto.randomBytes(24).toString('hex')
  pendingGitHubAppInstallStates.set(token, { expiresAt: Date.now() + GITHUB_APP_INSTALL_STATE_TTL_MS })
  return token
}

function consumeGitHubAppInstallState(value) {
  pruneGitHubAppInstallStates()
  if (typeof value !== 'string' || !value) return false
  const record = pendingGitHubAppInstallStates.get(value)
  if (!record || record.expiresAt <= Date.now()) {
    pendingGitHubAppInstallStates.delete(value)
    return false
  }
  pendingGitHubAppInstallStates.delete(value)
  return true
}

function githubConfigured() {
  return Boolean(process.env.GITHUB_TOKEN)
}

function projectGithubConfigured(project) {
  return githubConfigured() || Boolean(project?.installationId)
}

function githubAppConfigured() {
  return Boolean(appConfig.id && appConfig.privateKey)
}

function currentRole(req) {
  if (allowRoleHeader && req.get('x-nexus-role')) return req.get('x-nexus-role')
  return activeRole
}

const roleRank = { Viewer: 1, Operator: 2, Administrator: 3 }

function requireRole(req, res, required) {
  const role = currentRole(req)
  if ((roleRank[role] || 0) < roleRank[required]) {
    res.status(403).json({ code: 'INSUFFICIENT_ROLE', required, role })
    return false
  }
  return true
}

function audit(req, action, target, result, risk = 'low', detail = {}) {
  state.auditLogs.unshift({
    id: id('audit'), actor: currentRole(req), action, target, result, risk, detail, at: now()
  })
  state.auditLogs = state.auditLogs.slice(0, 500)
}

function redactToken(value) {
  if (!value) return null
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function githubAppJwt() {
  if (!githubAppConfigured()) throw Object.assign(new Error('GitHub App credentials are not configured'), { code: 'GITHUB_APP_NOT_CONFIGURED' })
  const issuedAt = Math.floor(Date.now() / 1000) - 30
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: appConfig.id }))
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${signer.sign(appConfig.privateKey, 'base64url')}`
}

async function githubAppFetch(endpoint, options = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${githubAppJwt()}`,
    ...(options.headers || {})
  }
  const response = await fetch(githubRequestUrl(endpoint), { ...options, headers })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { message: text } }
  if (!response.ok) throw Object.assign(new Error(body?.message || `GitHub App API returned ${response.status}`), { status: response.status, body })
  return body
}

async function installationFetch(installationId, endpoint, options = {}) {
  const { returnPageMetadata = false, ...fetchOptions } = options
  const installation = state.githubInstallations.find((item) => String(item.installationId) === String(installationId))
  if (!installation?.accessToken || new Date(installation.expiresAt || 0) <= new Date(Date.now() + 60_000)) {
    if (!githubAppConfigured()) throw Object.assign(new Error('GitHub App credentials are not configured'), { code: 'GITHUB_APP_NOT_CONFIGURED' })
    const token = await githubAppFetch(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { method: 'POST' })
    const updated = { ...(installation || { installationId: String(installationId) }), accessToken: token.token, expiresAt: token.expires_at, updatedAt: now() }
    const index = state.githubInstallations.findIndex((item) => String(item.installationId) === String(installationId))
    if (index >= 0) state.githubInstallations[index] = updated
    else state.githubInstallations.push(updated)
    await saveState()
    return installationFetch(installationId, endpoint, options)
  }
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${installation.accessToken}`, ...(options.headers || {}) }
  const response = await fetch(githubRequestUrl(endpoint), { ...fetchOptions, headers })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { message: text } }
  if (!response.ok) throw Object.assign(new Error(body?.message || `GitHub installation API returned ${response.status}`), { status: response.status, body })
  return returnPageMetadata ? { data: body, next: githubNextLink(response.headers.get('link'), githubApiUrl) } : body
}

async function githubFetch(endpoint, options = {}) {
  const { returnPageMetadata = false, ...fetchOptions } = options
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers || {})
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const response = await fetch(githubRequestUrl(endpoint), { ...fetchOptions, headers })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { message: text } }
  if (!response.ok) {
    const error = new Error(body?.message || `GitHub API returned ${response.status}`)
    error.status = response.status
    error.body = body
    throw error
  }
  return returnPageMetadata ? { data: body, next: githubNextLink(response.headers.get('link'), githubApiUrl) } : body
}

function githubRequestUrl(endpoint) {
  if (/^https?:\/\//i.test(endpoint)) {
    const base = new URL(githubApiUrl)
    const requested = new URL(endpoint)
    if (requested.origin !== base.origin) throw new Error('GitHub pagination link points outside the configured API origin.')
    return requested.toString()
  }
  return `${githubApiUrl.replace(/\/$/, '')}${endpoint}`
}

async function githubFetchForProject(project, endpoint, options = {}) {
  if (project?.installationId) return installationFetch(project.installationId, endpoint, options)
  return githubFetch(endpoint, options)
}

async function githubTokenForProject(project) {
  if (!project?.installationId) return process.env.GITHUB_TOKEN || ''
  const installation = state.githubInstallations.find((item) => String(item.installationId) === String(project.installationId))
  if (!installation?.accessToken || new Date(installation.expiresAt || 0) <= new Date(Date.now() + 60_000)) {
    await installationFetch(project.installationId, '/installation/repositories?per_page=1')
  }
  return state.githubInstallations.find((item) => String(item.installationId) === String(project.installationId))?.accessToken || ''
}

function notConfigured(res) {
  return res.status(424).json({
    ok: false,
    code: 'GITHUB_NOT_CONFIGURED',
    message: 'Configure GITHUB_TOKEN or a GitHub App installation before using live GitHub operations.'
  })
}

function repoFromProject(project) {
  return project.fullName || `${project.owner}/${project.name}`
}

function classifyRepo(repo) {
  const language = (repo.language || '').toLowerCase()
  const topics = repo.topics || []
  if (topics.some((item) => ['desktop', 'electron', 'tauri'].includes(item))) return 'Desktop software'
  if (topics.some((item) => ['ai', 'llm', 'machine-learning'].includes(item))) return 'AI tools'
  if (['javascript', 'typescript', 'html', 'css'].includes(language)) return 'Websites'
  if (['python', 'go', 'rust', 'java', 'c#'].includes(language)) return 'Backend services'
  return 'Other'
}

function normalizeRepo(repo) {
  return {
    id: `repo_${repo.id}`,
    githubId: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner?.login || repo.full_name?.split('/')[0],
    description: repo.description || '',
    url: repo.html_url,
    defaultBranch: repo.default_branch || 'main',
    visibility: repo.visibility || (repo.private ? 'private' : 'public'),
    language: repo.language || 'Unknown',
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    openIssues: repo.open_issues_count || 0,
    updatedAt: repo.updated_at,
    pushedAt: repo.pushed_at,
    group: classifyRepo(repo),
    stack: [repo.language].filter(Boolean),
    latestRelease: null,
    workflows: [],
    lastSyncedAt: now()
  }
}

function decodeGithubContent(body) {
  if (!body?.content) return ''
  try { return Buffer.from(body.content, 'base64').toString('utf8') } catch { return '' }
}

async function readRepoFile(project, filePath) {
  try {
    const body = await githubFetchForProject(project, `/repos/${repoFromProject(project)}/contents/${filePath}`)
    return { path: filePath, content: decodeGithubContent(body), htmlUrl: body.html_url }
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}

function semverFrom(text) {
  const match = String(text || '').match(/(?:version|tag_name)?[^0-9]*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i)
  return match?.[1] || null
}

function checkUpdateSecurity({ updateUrl, manifestUrl, signatureConfigured, digestConfigured, version }) {
  const checks = []
  if (updateUrl || manifestUrl) checks.push({ key: 'https', status: String(updateUrl || manifestUrl).startsWith('https://') ? 'PASS' : 'FAIL', detail: 'Remote update endpoint uses HTTPS.' })
  else checks.push({ key: 'https', status: 'BLOCKED', detail: 'No remote update endpoint was found.' })
  checks.push({ key: 'sha256', status: digestConfigured ? 'PASS' : 'WARNING', detail: digestConfigured ? 'A digest or checksum field was found.' : 'No digest evidence was found.' })
  checks.push({ key: 'signature', status: signatureConfigured ? 'PASS' : 'BLOCKED', detail: signatureConfigured ? 'Framework signature configuration was found.' : 'Framework signature configuration is missing.' })
  checks.push({ key: 'version', status: version ? 'PASS' : 'WARNING', detail: version ? `Detected version ${version}.` : 'No project version was detected.' })
  const hasFail = checks.some((item) => item.status === 'FAIL')
  const hasBlocked = checks.some((item) => item.status === 'BLOCKED')
  const hasWarning = checks.some((item) => item.status === 'WARNING')
  return { checks, status: hasFail ? 'FAIL' : hasBlocked ? 'BLOCKED' : hasWarning ? 'WARNING' : 'READY' }
}

async function inspectUpdateConfig(project) {
  const candidates = [
    'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod',
    'tauri.conf.json', 'src-tauri/tauri.conf.json', 'latest.yml', 'latest-mac.yml',
    'app-update.yml', 'update.json', 'appcast.xml', 'updates/update.json',
    '.github/workflows/release.yml', '.github/workflows/build.yml'
  ]
  const files = (await Promise.all(candidates.map((filePath) => readRepoFile(project, filePath)))).filter(Boolean)
  const byPath = new Map(files.map((file) => [file.path, file.content]))
  const packageJson = byPath.get('package.json') || ''
  let packageData = null
  try { packageData = packageJson ? JSON.parse(packageJson) : null } catch { packageData = null }
  const hasElectron = Boolean(packageData?.dependencies?.['electron-updater'] || packageData?.devDependencies?.['electron-builder'] || byPath.has('latest.yml') || byPath.has('latest-mac.yml'))
  const hasTauri = files.some((file) => /tauri-plugin-updater|createUpdaterArtifacts|updater\s*[:=]/i.test(file.content))
  const hasPython = Boolean(byPath.has('pyproject.toml') || byPath.has('requirements.txt'))
  const hasVelopack = files.some((file) => /velopack|Velopack/i.test(file.content))
  const hasPwa = files.some((file) => /serviceWorker|workbox|vite-plugin-pwa|registerSW/i.test(file.content))
  const framework = hasElectron ? 'Electron' : hasTauri ? 'Tauri' : hasVelopack ? '.NET / Velopack' : hasPython ? 'Python desktop candidate' : hasPwa ? 'Web / PWA' : 'Unknown'
  const updateUrlMatch = files.map((file) => file.content.match(/https?:\/\/[^\s"']+(?:latest\.yml|appcast\.xml|update\.json|releases?)[^\s"']*/i)).find(Boolean)
  const updateUrl = updateUrlMatch?.[0]?.replace(/[),}]+$/, '') || null
  const manifestUrl = byPath.has('latest.yml') ? 'repository:latest.yml' : byPath.has('appcast.xml') ? 'repository:appcast.xml' : byPath.has('update.json') ? 'repository:update.json' : null
  const signatureConfigured = files.some((file) => /publisherName|signing|signature|publicKey|pubkey|ed25519|WIN_CSC_LINK|TAURI_SIGNING_PRIVATE_KEY/i.test(file.content))
  const digestConfigured = files.some((file) => /sha256|checksum|blockmap|digest/i.test(file.content))
  const version = semverFrom(packageData?.version || files.map((file) => file.content).join('\n'))
  const security = checkUpdateSecurity({ updateUrl, manifestUrl, signatureConfigured, digestConfigured, version })
  const config = {
    id: `update_${project.id}`, projectId: project.id, projectName: project.fullName, framework,
    evidence: files.map((file) => file.path), currentVersion: version, latestVersion: null,
    channel: /beta/i.test(files.map((file) => file.content).join('\n')) ? 'Beta' : 'Stable', updateUrl, manifestUrl,
    security, completeness: Math.round((security.checks.filter((item) => ['PASS', 'READY'].includes(item.status)).length / security.checks.length) * 100), checkedAt: now()
  }
  return config
}

function verifyWebhookSignature(rawBody, signature) {
  if (!appConfig.webhookSecret) return false
  if (!signature?.startsWith('sha256=')) return false
  const expected = `sha256=${crypto.createHmac('sha256', appConfig.webhookSecret).update(rawBody).digest('hex')}`
  const expectedBuffer = Buffer.from(expected)
  const receivedBuffer = Buffer.from(signature)
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
}

async function processWebhookEvent(eventRecord) {
  const payload = eventRecord.payload || {}
  const repoName = payload.repository?.full_name
  const project = state.projects.find((item) => item.fullName === repoName)
  if (project) {
    project.lastWebhookAt = now()
    if (eventRecord.event === 'release' && payload.release) project.latestRelease = payload.release
    if (eventRecord.event === 'push' && payload.after) project.latestCommit = payload.after
  }
  state.activity.unshift({ id: id('activity'), type: 'webhook', message: `${eventRecord.event} event received${repoName ? ` for ${repoName}` : ''}`, at: now() })
  state.activity = state.activity.slice(0, 100)
  eventRecord.status = 'COMPLETED'
  eventRecord.completedAt = now()
  await saveState()
}

async function syncRepositories() {
  if (!githubConfigured()) {
    const error = new Error('GITHUB_TOKEN is not configured')
    error.code = 'GITHUB_NOT_CONFIGURED'
    throw error
  }
  const endpoint = process.env.GITHUB_OWNER
    ? `/users/${encodeURIComponent(process.env.GITHUB_OWNER)}/repos?per_page=100&sort=updated`
    : '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'
  const { items: repos, pages, truncated } = await fetchAllPages((page) => githubFetch(page, { returnPageMetadata: true }), endpoint)
  const incoming = repos.map(normalizeRepo)
  const byFullName = new Map(state.projects.map((project) => [project.fullName, project]))
  for (const project of incoming) {
    const previous = byFullName.get(project.fullName)
    byFullName.set(project.fullName, { ...previous, ...project, workflows: previous?.workflows || [] })
  }
  state.projects = [...byFullName.values()].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
  state.activity.unshift({ id: id('activity'), type: 'repo_sync', message: `Synced ${incoming.length} repositories from GitHub across ${pages} page(s)${truncated ? ' (page limit reached)' : ''}`, at: now() })
  state.activity = state.activity.slice(0, 100)
  await saveState()
  return { imported: incoming.length, pages, truncated }
}

async function runTask(taskId, executor) {
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) return
  task.status = 'Running'
  task.startedAt = now()
  await saveState()
  try {
    const result = await executor(task)
    task.status = 'Success'
    task.result = result || null
    task.finishedAt = now()
    task.logs = [...(task.logs || []), 'Task completed successfully.']
  } catch (error) {
    task.status = error.code === 'GITHUB_NOT_CONFIGURED' ? 'Blocked' : 'Failed'
    task.error = error.message
    task.finishedAt = now()
    task.logs = [...(task.logs || []), error.message]
    if (task.metadata?.deliveryId) {
      const eventRecord = state.githubWebhookEvents.find((item) => item.deliveryId === task.metadata.deliveryId)
      if (eventRecord) { eventRecord.status = 'FAILED'; eventRecord.error = error.message; eventRecord.failedAt = now() }
    }
  }
  await saveState()
}

function createTask(type, label, metadata = {}) {
  const task = {
    id: id('task'), type, label, status: 'Pending', createdAt: now(), logs: [], metadata
  }
  state.tasks.unshift(task)
  state.tasks = state.tasks.slice(0, 100)
  return task
}

function safeError(error) {
  let message = redactSecrets(String(error?.message || 'Operation failed'))
  for (const secret of [process.env.GITHUB_TOKEN, process.env.AI_API_KEY, ...state.githubInstallations.map((item) => item.accessToken)]) {
    if (secret) message = message.split(secret).join('[redacted]')
  }
  return message.slice(0, 1000)
}

const LOCAL_AGENT_MAX_PROMPT_BYTES = 8 * 1024
const LOCAL_AGENT_MAX_QUEUED_TASKS = 8
const LOCAL_AGENT_CONTEXT_BYTES = 220 * 1024

function localAgentPublicTask(task) {
  if (!task) return null
  return {
    id: task.id,
    type: task.type,
    label: task.label,
    projectId: task.projectId,
    projectName: task.projectName,
    providerId: task.providerId || null,
    prompt: task.prompt,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt || null,
    finishedAt: task.finishedAt || null,
    error: task.error || null,
    events: (task.events || []).slice(-50),
    disclosedPaths: task.disclosedPaths || [],
    changedFiles: task.changedFiles || [],
    provider: task.provider || null,
    usage: task.usage || null,
    costUsd: task.costUsd ?? null,
    attempts: task.attempts ?? null,
    rationale: task.rationale || null,
    workspaceReady: Boolean(task.workspace?.id),
    workspaceStats: task.workspace?.stats || null,
    sourceDisclosureConfirmedAt: task.sourceDisclosureConfirmedAt || null
  }
}

function localAgentWorkspaceHandle(task) {
  if (!task?.workspace?.id || task.workspace.id !== task.id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(task.projectId || ''))) return null
  const workspaceRoot = path.join(dataDir, 'agent-workspaces', 'local')
  const root = path.join(workspaceRoot, task.projectId, task.workspace.id)
  return {
    id: task.workspace.id,
    projectId: task.projectId,
    projectName: task.projectName,
    workspaceRoot,
    root,
    source: path.join(root, 'source'),
    baselinePath: path.join(root, 'baseline.json'),
    baselineFiles: path.join(root, 'baseline-files'),
    limits: task.workspace.limits,
    stats: task.workspace.stats
  }
}

function localAgentCancellationError() {
  return Object.assign(new Error('Local Agent task was cancelled.'), { code: 'LOCAL_AGENT_CANCELLED' })
}

async function executeLocalAgentTask(taskId, providerId, controller) {
  let workspace = null
  try {
    let task = await getLocalAgentTask({ dataDir, taskId })
    if (!task || task.status !== 'Queued') return
    const startedAt = now()
    task = await updateLocalAgentTask({
      dataDir,
      taskId,
      patch: { status: 'Running', startedAt },
      event: { type: 'started', detail: 'Isolated local Agent work started.' }
    })
    const projects = await listLocalProjects({ dataDir })
    const project = projects.find((item) => item.id === task.projectId && item.available)
    if (!project) throw Object.assign(new Error('The selected local project is no longer registered or available.'), { code: 'LOCAL_PROJECT_NOT_AVAILABLE' })

    workspace = await createLocalAgentWorkspace({ dataDir, project, taskId: task.id })
    const contextFiles = await readLocalAgentFiles(workspace, undefined, { maxFiles: 20, maxBytes: LOCAL_AGENT_CONTEXT_BYTES })
    const workspaceRecord = { id: workspace.id, limits: workspace.limits, stats: workspace.stats, createdAt: workspace.createdAt }
    await updateLocalAgentTask({
      dataDir,
      taskId,
      patch: { workspace: workspaceRecord, disclosedPaths: contextFiles.map((file) => file.path) },
      event: { type: 'workspace_created', detail: 'Bounded isolated copy created; eligible source paths recorded before provider request.', metadata: { files: contextFiles.length, bytes: contextFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0), workspaceId: workspace.id } }
    })
    if (controller.signal.aborted) throw localAgentCancellationError()

    const generated = await generateLocalAgentOperations({
      prompt: task.prompt,
      project: { name: project.name },
      sourceFiles: contextFiles,
      signal: controller.signal,
      providerId
    })
    if (controller.signal.aborted) throw localAgentCancellationError()

    const applied = await applyLocalAgentOperations(workspace, generated.operations)
    if (controller.signal.aborted) throw localAgentCancellationError()
    const changes = await listLocalAgentChanges(workspace)
    const finishedAt = now()
    const result = await updateLocalAgentTask({
      dataDir,
      taskId,
      patch: {
        status: 'Succeeded',
        finishedAt,
        changedFiles: applied,
        rationale: redactSecrets(generated.rationale).slice(0, 8_000),
        provider: { id: generated.providerId, kind: generated.providerKind, host: generated.providerHost, model: generated.model },
        usage: generated.usage,
        costUsd: generated.costUsd,
        attempts: generated.attempts,
        changeCount: changes.length
      },
      event: { type: 'completed', detail: `Generated ${applied.length} isolated file operation(s). Original project remains unchanged.`, metadata: { providerId: generated.providerId, model: generated.model, usage: generated.usage, costUsd: generated.costUsd, changedFiles: applied } }
    })
    audit({ get: () => undefined }, 'local_agent_task_completed', `${project.name} (${project.id})`, 'success', 'medium', { taskId, changedFiles: applied.length, providerId: generated.providerId, model: generated.model, usage: generated.usage })
    await saveState()
    return result
  } catch (error) {
    const current = await getLocalAgentTask({ dataDir, taskId }).catch(() => null)
    if (!current || ['Succeeded', 'Cancelled', 'Interrupted'].includes(current.status)) return
    const code = error.code || ''
    const status = controller.signal.aborted || code === 'LOCAL_AGENT_CANCELLED'
      ? 'Cancelled'
      : code === 'AI_NOT_CONFIGURED' || code === 'LOCAL_PROJECT_NOT_AVAILABLE' || code.startsWith('LOCAL_AGENT_MAX_')
        ? 'Blocked'
        : code === 'AI_TIMEOUT'
          ? 'TimedOut'
          : 'Failed'
    const finishedAt = now()
    await updateLocalAgentTask({
      dataDir,
      taskId,
      patch: { status, finishedAt, error: safeError(error), ...(workspace ? { workspace: { id: workspace.id, limits: workspace.limits, stats: workspace.stats } } : {}) },
      event: { type: status.toLowerCase(), detail: safeError(error), metadata: { code: code || null } }
    }).catch(() => {})
    audit({ get: () => undefined }, 'local_agent_task_completed', taskId, status.toLowerCase(), 'medium', { taskId, code: code || null })
    await saveState().catch(() => {})
  }
}

async function pumpLocalAgentQueue() {
  if (localAgentWorkerRunning) return
  localAgentWorkerRunning = true
  try {
    while (localAgentQueue.length) {
      const queued = localAgentQueue.shift()
      const controller = new AbortController()
      localAgentControllers.set(queued.taskId, controller)
      try { await executeLocalAgentTask(queued.taskId, queued.providerId, controller) }
      finally { localAgentControllers.delete(queued.taskId) }
    }
  } finally {
    localAgentWorkerRunning = false
    if (localAgentQueue.length) queueMicrotask(() => void pumpLocalAgentQueue())
  }
}

function enqueueLocalAgentTask(taskId, providerId) {
  localAgentQueue.push({ taskId, providerId })
  queueMicrotask(() => void pumpLocalAgentQueue())
}

async function recoverLocalAgentTasks() {
  const tasks = await recoverLocalAgentTaskStore({ dataDir })
  for (const task of tasks) {
    if (task.status === 'Queued') {
      await updateLocalAgentTask({
        dataDir,
        taskId: task.id,
        patch: { status: 'Interrupted', finishedAt: now(), error: 'Queued work was not resumed after the local service restarted.' },
        event: { type: 'interrupted', detail: 'Queued task was not resumed after the local service restarted.' }
      })
    }
  }
}

async function createAndQueueLocalAgentTask({ projectId, prompt, providerId, req }) {
  const projects = await listLocalProjects({ dataDir })
  const project = projects.find((item) => item.id === projectId && item.available)
  if (!project) throw Object.assign(new Error('Choose a registered local project that is still available.'), { code: 'LOCAL_PROJECT_NOT_AVAILABLE' })

  const providers = listAIProviders()
  const defaultProvider = providers.find((item) => item.default) || providers.find((item) => item.configured)
  const selectedProvider = providerId ? providers.find((item) => item.id === providerId) : defaultProvider
  if (!selectedProvider) throw Object.assign(new Error('The selected AI provider is not configured.'), { code: 'AI_NOT_CONFIGURED' })
  if (!selectedProvider.configured) throw Object.assign(new Error('Configure this AI provider on the local service before starting an Agent task.'), { code: 'AI_NOT_CONFIGURED' })

  if (localAgentQueue.length + localAgentControllers.size >= LOCAL_AGENT_MAX_QUEUED_TASKS) {
    throw Object.assign(new Error(`The local Agent queue is limited to ${LOCAL_AGENT_MAX_QUEUED_TASKS} pending tasks.`), { code: 'LOCAL_AGENT_QUEUE_FULL' })
  }
  const safePrompt = redactSecrets(prompt.trim())
  const taskId = `nexus_agent_${crypto.randomUUID()}`
  const task = await persistLocalAgentTask({
    dataDir,
    task: {
      id: taskId,
      type: 'local-agent',
      label: safePrompt.split(/\r?\n/)[0].slice(0, 120) || 'Local Agent task',
      projectId: project.id,
      projectName: project.name,
      prompt: safePrompt,
      providerId: selectedProvider.id,
      status: 'Queued',
      sourceDisclosureConfirmedAt: now(),
      disclosedPaths: [],
      changedFiles: []
    }
  })
  audit(req, 'local_agent_task_created', `${project.name} (${project.id})`, 'queued', 'medium', { taskId, providerId: selectedProvider.id, sourceDisclosureConfirmed: true })
  await saveState()
  enqueueLocalAgentTask(taskId, selectedProvider.id)
  return { task, provider: selectedProvider }
}

function integrationLog(job, task, message) {
  const line = `${now()} ${String(message).slice(0, 500)}`
  job.logs = [...(job.logs || []), line].slice(-200)
  task.logs = [...(task.logs || []), line].slice(-200)
}

async function agentPhase(job, task, phase, detail, metadata = {}) {
  if (job.run) transitionAgentRun(job.run, phase, detail, metadata)
  integrationLog(job, task, detail)
  await saveState()
}

async function enqueueIntegrationScan(project, req) {
  const existing = state.integrationJobs.find((job) => job.type === 'scan' && job.projectId === project.id && ['Pending', 'Running'].includes(job.status))
  if (existing) return { job: existing, task: state.tasks.find((item) => item.id === existing.taskId), reused: true }
  const task = createTask('integration-scan', `Scan update capability for ${project.fullName}`, { projectId: project.id })
  const job = {
    id: id('integration'), type: 'scan', projectId: project.id, repository: project.fullName,
    taskId: task.id, status: 'Pending', currentStep: 'Queued', progress: 0,
    createdAt: now(), logs: [], requestedBy: currentRole(req)
  }
  task.metadata = { ...task.metadata, integrationJobId: job.id }
  state.integrationJobs.unshift(job)
  await saveState()
  return { job, task, reused: false }
}

async function executeIntegrationScan(jobId, req) {
  const job = state.integrationJobs.find((item) => item.id === jobId)
  const task = state.tasks.find((item) => item.id === job?.taskId)
  const project = state.projects.find((item) => item.id === job?.projectId)
  if (!job || !task || !project || job.cancelRequested) {
    if (job && task) { job.status = 'Cancelled'; job.finishedAt = now(); task.status = 'Cancelled'; task.finishedAt = now(); await saveState() }
    return
  }
  const controller = new AbortController()
  integrationControllers.set(job.id, controller)
  job.status = 'Running'; job.startedAt = now(); job.currentStep = 'Resolving repository'; job.progress = 5
  task.status = 'Running'; task.startedAt = job.startedAt
  integrationLog(job, task, 'Resolving the repository default branch.')
  await saveState()
  try {
    const report = await scanRepository(project, githubFetchForProject, {
      signal: controller.signal,
      onProgress: async ({ step, detail }) => {
        job.currentStep = detail; job.progress = step === 'reading-evidence' ? 25 : step === 'assessing' ? 80 : 10
        task.metadata = { ...task.metadata, currentStep: job.currentStep, progress: job.progress }
        integrationLog(job, task, detail)
        await saveState()
      }
    })
    const persistedReport = { ...report, id: id('report'), taskId: task.id, jobId: job.id }
    state.integrationReports.unshift(persistedReport)
    state.integrationReports = state.integrationReports.slice(0, 2000)
    project.integrationScan = { reportId: persistedReport.id, status: report.assessment.status, score: report.assessment.score, scannedAt: report.scannedAt, commitSha: report.commitSha }
    project.lastScannedAt = report.scannedAt
    if (report.components.length) project.stack = [...new Set([...(project.stack || []), ...report.components.map((component) => component.name)])]
    job.reportId = persistedReport.id; job.status = 'Succeeded'; job.progress = 100; job.currentStep = 'Report saved'; job.finishedAt = now()
    task.status = 'Success'; task.result = { reportId: persistedReport.id, status: report.assessment.status, score: report.assessment.score, commitSha: report.commitSha }; task.finishedAt = now()
    integrationLog(job, task, `Assessment saved at commit ${report.commitSha}; status ${report.assessment.status}.`)
    audit(req, 'integration_repository_scan', project.fullName, 'success', 'low', { reportId: persistedReport.id, commitSha: report.commitSha })
    state.activity.unshift({ id: id('activity'), type: 'integration-scan', message: `Scanned update capability for ${project.fullName}`, at: now() })
    state.activity = state.activity.slice(0, 100)
  } catch (error) {
    const cancelled = error.code === 'JOB_CANCELLED' || controller.signal.aborted
    job.status = cancelled ? 'Cancelled' : error.code?.includes('NOT_CONFIGURED') ? 'Blocked' : 'Failed'
    job.error = safeError(error); job.finishedAt = now(); job.currentStep = job.status
    task.status = job.status; task.error = job.error; task.finishedAt = job.finishedAt
    integrationLog(job, task, job.error)
    audit(req, 'integration_repository_scan', project.fullName, job.status.toLowerCase(), 'low', { code: error.code || null })
  } finally {
    integrationControllers.delete(job.id)
    await saveState()
  }
}

async function runScanQueue(jobIds, req) {
  let index = 0
  const setting = Number(state.settings.concurrency) || 3
  const workers = Array.from({ length: Math.min(Math.max(1, setting), 4, jobIds.length) }, async () => {
    while (index < jobIds.length) {
      const jobId = jobIds[index++]
      await executeIntegrationScan(jobId, req)
    }
  })
  await Promise.all(workers)
}

let scheduleTickRunning = false
async function runScheduledIntegrationScan() {
  if (scheduleTickRunning) return
  scheduleTickRunning = true
  try {
    const due = state.integrationSchedules.filter((item) => item.enabled && (!item.nextRunAt || new Date(item.nextRunAt) <= new Date()))
    if (!due.length) return
    const syntheticRequest = { get: () => undefined }
    const jobIds = []
    for (const schedule of due) {
      const projects = state.projects.filter((project) => githubConfigured() || project.installationId)
      for (const project of projects) {
        const queued = await enqueueIntegrationScan(project, syntheticRequest)
        if (!queued.reused) jobIds.push(queued.job.id)
      }
      schedule.lastRunAt = now()
      schedule.nextRunAt = new Date(Date.now() + Number(schedule.intervalHours || 24) * 60 * 60 * 1000).toISOString()
      schedule.lastQueued = jobIds.length
    }
    await saveState()
    if (jobIds.length) void runScanQueue(jobIds, syntheticRequest).catch((error) => console.error('Scheduled integration scan failed:', safeError(error)))
  } catch (error) {
    console.error('Integration schedule tick failed:', safeError(error))
  } finally { scheduleTickRunning = false }
}

async function enqueueAgentJob(project, report, req) {
  const existing = state.integrationJobs.find((job) => job.type === 'agent' && job.reportId === report.id && ['Pending', 'Running'].includes(job.status))
  if (existing) return { job: existing, task: state.tasks.find((item) => item.id === existing.taskId), reused: true }
  const task = createTask('integration-agent', `Prepare auto-update changes for ${project.fullName}`, { projectId: project.id, reportId: report.id })
  const job = {
    id: id('integration'), type: 'agent', projectId: project.id, repository: project.fullName,
    reportId: report.id, taskId: task.id, status: 'Pending', currentStep: 'Queued', progress: 0,
    createdAt: now(), logs: [], requestedBy: currentRole(req), sourceDisclosureConfirmedAt: now(),
    run: createAgentRun({ id: id('run'), taskId: task.id, projectId: project.id, repository: project.fullName, requestedBy: currentRole(req) })
  }
  task.metadata = { ...task.metadata, integrationJobId: job.id }
  state.integrationJobs.unshift(job)
  await saveState()
  return { job, task, reused: false }
}

async function executeAgentJob(jobId, req) {
  const job = state.integrationJobs.find((item) => item.id === jobId)
  const task = state.tasks.find((item) => item.id === job?.taskId)
  const project = state.projects.find((item) => item.id === job?.projectId)
  const report = state.integrationReports.find((item) => item.id === job?.reportId)
  if (!job || !task || !project || !report) return
  if (job.cancelRequested) { job.status = 'Cancelled'; job.finishedAt = now(); task.status = 'Cancelled'; task.finishedAt = job.finishedAt; await saveState(); return }
  const controller = new AbortController()
  integrationControllers.set(job.id, controller)
  job.status = 'Running'; job.currentStep = 'Checking provider and GitHub access'; job.progress = 5; job.startedAt = now()
  task.status = 'Running'; task.startedAt = job.startedAt
  await agentPhase(job, task, 'context', 'Preparing a repository-isolated workspace; no remote branch or PR will be created in this step.')
  if (!beginAgentAttempt(job.run)) {
    job.status = 'Blocked'; job.currentStep = 'Attempt limit reached'; job.finishedAt = now(); task.status = 'Blocked'; task.error = 'Agent attempt limit reached.'; task.finishedAt = job.finishedAt
    await saveState()
    return
  }
  await saveState()
  let workspace
  try {
    if (!aiProviderStatus().configured) throw Object.assign(new Error('AI provider requires AI_BASE_URL, AI_API_KEY, and AI_MODEL.'), { code: 'AI_NOT_CONFIGURED' })
    const token = await githubTokenForProject(project)
    if (!token) throw Object.assign(new Error('A GitHub token or installation token is required to clone this repository.'), { code: 'GITHUB_NOT_CONFIGURED' })
    job.currentStep = 'Cloning into isolated workspace'; job.progress = 15; integrationLog(job, task, job.currentStep); await saveState()
    workspace = await createAgentWorkspace({ jobId: job.id, project, token, signal: controller.signal })
    agentWorkspacePaths.set(job.id, workspace)
    if (controller.signal.aborted || job.cancelRequested) throw Object.assign(new Error('Integration job was cancelled.'), { code: 'JOB_CANCELLED' })
    job.workspace = { branch: workspace.branch, baseCommit: workspace.baseCommit, createdAt: workspace.createdAt }
    job.currentBranch = workspace.branch
    job.currentStep = 'Preparing selected source for model review'; job.progress = 30; await agentPhase(job, task, 'plan', job.currentStep)
    const sourceFiles = await readWorkspaceFiles(workspace, report.selectedPaths, { maxFiles: 20, maxFileBytes: 20_000 })
    if (!sourceFiles.length) throw new Error('No eligible source files were available for model analysis.')
    const plan = report.components.map((component) => ({
      adapter: component.adapter, framework: component.framework, appRoot: component.appRoot,
      recommendation: report.assessment.components.find((item) => item.component.adapter === component.adapter)?.assessment?.recommendation,
      evidence: component.evidence
    }))
    job.sentSourcePaths = sourceFiles.map((file) => file.path)
    job.provider = { host: aiProviderStatus().baseUrl ? new URL(aiProviderStatus().baseUrl).host : null, model: aiProviderStatus().model }
    job.currentStep = 'Generating a proposed change set'; job.progress = 45; await agentPhase(job, task, 'tool_execution', `Sending ${sourceFiles.length} selected file(s) after secret redaction to the configured AI provider.`, { tool: 'provider.generateIntegrationOperations' })
    const generated = await generateIntegrationOperations({ report, plan, sourceFiles, signal: controller.signal })
    job.rationale = String(generated.rationale || '').slice(0, 5000)
    job.requestedTests = Array.isArray(generated.tests) ? generated.tests.slice(0, 30).map((value) => String(value).slice(0, 300)) : []
    job.externalRequirements = Array.isArray(generated.externalRequirements) ? generated.externalRequirements.slice(0, 30).map((value) => String(value).slice(0, 300)) : []
    job.provider = { host: generated.providerHost, model: generated.model, usage: generated.usage }
    job.sentSourcePaths = generated.sentPaths
    job.currentStep = 'Applying proposed files in the isolated workspace'; job.progress = 60; await agentPhase(job, task, 'tool_execution', job.currentStep, { tool: 'workspace.applyFileOperations' })
    const applied = await applyFileOperations(workspace, generated.operations)
    job.modifiedFiles = applied
    job.currentStep = 'Running isolated checks'; job.progress = 75; await agentPhase(job, task, 'observe', `Applied ${applied.length} file operation(s) in the isolated clone.`, { tool: 'sandbox.run' })
    const primaryFramework = report.components.find((component) => component.supported)?.framework
    job.tests = await runSandboxed({ workspace: workspace.path, framework: primaryFramework, signal: controller.signal })
    if (controller.signal.aborted || job.cancelRequested) throw Object.assign(new Error('Integration job was cancelled.'), { code: 'JOB_CANCELLED' })
    await agentPhase(job, task, 'verify', `Isolated checks completed with status ${job.tests.status}.`, { testStatus: job.tests.status, exitCode: job.tests.exitCode ?? null })
    job.diff = await workspaceDiff(workspace)
    job.patch = await workspacePatch(workspace)
    job.workspaceStatus = await workspaceStatus(workspace)
    job.status = 'ReadyForReview'; job.progress = 100; job.currentStep = 'Local changes ready for review'; job.finishedAt = now()
    await agentPhase(job, task, 'review', job.currentStep, { modifiedFiles: applied.length, tests: job.tests.status })
    task.status = job.tests.status === 'PASS' ? 'Success' : 'Partial'
    task.result = { status: job.status, modifiedFiles: applied, tests: job.tests.status, branch: workspace.branch }
    task.finishedAt = job.finishedAt
    integrationLog(job, task, `Local change set is ready. Isolated checks: ${job.tests.status}. No remote write occurred.`)
    audit(req, 'integration_agent_changes_prepared', project.fullName, 'success', 'medium', { jobId: job.id, reportId: report.id, modifiedFiles: applied.length, tests: job.tests.status, runId: job.run?.id || null })
  } catch (error) {
    job.status = error.code === 'JOB_CANCELLED' || controller.signal.aborted ? 'Cancelled' : error.code?.includes('NOT_CONFIGURED') ? 'Blocked' : 'Failed'
    job.error = safeError(error); job.finishedAt = now(); job.currentStep = job.status
    if (job.run) {
      const phase = job.status === 'Blocked' ? 'blocked' : job.status === 'Cancelled' ? 'cancelled' : 'failed'
      transitionAgentRun(job.run, phase, job.error, { code: error.code || null })
    }
    task.status = job.status; task.error = job.error; task.finishedAt = job.finishedAt
    integrationLog(job, task, job.error)
    audit(req, 'integration_agent_changes_prepared', project.fullName, job.status.toLowerCase(), 'medium', { jobId: job.id, code: error.code || null })
  } finally {
    integrationControllers.delete(job.id)
    if (workspace) await releaseWorkspaceLock(project.githubId || project.id, job.id)
    await saveState()
  }
}

const app = express()
const localApiToken = String(process.env.NEXUS_LOCAL_API_TOKEN || '')
const desktopMode = process.env.NEXUS_DESKTOP_MODE === 'true'
let desktopOrigin = null
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && localApiToken) {
    const authorization = String(req.get('authorization') || '')
    const supplied = Buffer.from(authorization.startsWith('Bearer ') ? authorization.slice(7) : '')
    const expected = Buffer.from(localApiToken)
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ code: 'LOCAL_SESSION_REQUIRED', message: 'A valid local workstation session is required.' })
    }
  }
  const origin = req.get('origin')
  if (origin && !corsOrigins.has(origin) && !(desktopMode && origin === desktopOrigin)) return res.status(403).json({ code: 'CORS_ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed by NEXUS_CORS_ORIGINS.' })
  if (desktopMode && !req.path.startsWith('/api/')) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
  }
  return next()
})
app.use(cors({ origin: (origin, callback) => callback(null, origin ? corsOrigins.has(origin) || (desktopMode && origin === desktopOrigin) : false) }))
app.use('/api/github/webhook', express.raw({ type: '*/*', limit: '5mb' }))
app.use(express.json({ limit: '1mb' }))

function requireDesktopLocalAgent(res) {
  if (!desktopMode || !localApiToken) {
    res.status(404).json({ code: 'DESKTOP_AGENT_UNAVAILABLE', message: 'The local Agent is available only in the authenticated Windows workstation.' })
    return false
  }
  return true
}

function localAgentErrorStatus(error) {
  if (error.code === 'AI_NOT_CONFIGURED') return 424
  if (error.code === 'LOCAL_AGENT_QUEUE_FULL') return 429
  if (error.code === 'LOCAL_PROJECT_NOT_AVAILABLE') return 404
  return 400
}

app.get('/api/local-agent/config', (_req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  const providers = listAIProviders()
  res.json({
    configured: providers.some((provider) => provider.configured),
    defaultProviderId: providers.find((provider) => provider.default)?.id || null,
    providers,
    limits: { maxPromptBytes: LOCAL_AGENT_MAX_PROMPT_BYTES, maxContextFiles: 20, maxProviderSourceBytesAfterRedaction: 120 * 1024, maxOperationCount: 20, operations: ['create', 'replace'] },
    capabilities: { isolatedWorkspace: true, originalProjectWrites: false, commandExecution: false, buildAndTest: false, gitApply: false }
  })
})

app.get('/api/local-agent/tasks', async (_req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const tasks = await listLocalAgentTasks({ dataDir })
    res.json({ tasks: tasks.map(localAgentPublicTask) })
  } catch (error) { res.status(500).json({ code: error.code || 'LOCAL_AGENT_TASKS_FAILED', message: safeError(error) }) }
})

app.post('/api/local-agent/tasks', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  if (req.body?.confirmSourceDisclosure !== true) return res.status(400).json({ code: 'SOURCE_DISCLOSURE_CONFIRMATION_REQUIRED', message: 'Confirm that the task prompt and bounded, redacted project source may be sent to the selected AI provider.' })
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : ''
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : ''
  const providerId = req.body?.providerId === undefined || req.body.providerId === null || req.body.providerId === '' ? null : typeof req.body.providerId === 'string' ? req.body.providerId : ''
  if (!projectId || !/^[0-9a-f-]{36}$/i.test(projectId)) return res.status(400).json({ code: 'LOCAL_PROJECT_ID_INVALID', message: 'Choose a registered local project.' })
  if (!prompt.trim()) return res.status(400).json({ code: 'AI_PROMPT_REQUIRED', message: 'Enter a task request.' })
  if (Buffer.byteLength(prompt, 'utf8') > LOCAL_AGENT_MAX_PROMPT_BYTES) return res.status(413).json({ code: 'AI_PROMPT_TOO_LARGE', message: `Task prompts are limited to ${LOCAL_AGENT_MAX_PROMPT_BYTES} bytes.` })
  if (providerId === '') return res.status(400).json({ code: 'AI_PROVIDER_INVALID', message: 'Choose a configured provider.' })
  try {
    const { task, provider } = await createAndQueueLocalAgentTask({ projectId, prompt, providerId, req })
    res.status(202).json({ task: localAgentPublicTask(task), provider: { id: provider.id, kind: provider.kind, host: provider.host, model: provider.model } })
  } catch (error) { res.status(localAgentErrorStatus(error)).json({ code: error.code || 'LOCAL_AGENT_TASK_CREATE_FAILED', message: safeError(error) }) }
})

app.get('/api/local-agent/tasks/:taskId', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const task = await getLocalAgentTask({ dataDir, taskId: req.params.taskId })
    if (!task) return res.status(404).json({ code: 'LOCAL_AGENT_TASK_NOT_FOUND', message: 'Local Agent task was not found.' })
    let changes = []
    let changesError = null
    const workspace = localAgentWorkspaceHandle(task)
    if (workspace && !['Queued', 'Running'].includes(task.status)) {
      try { changes = await listLocalAgentChanges(workspace) }
      catch (error) { changesError = safeError(error) }
    }
    return res.json({ task: localAgentPublicTask(task), changes, changesError })
  } catch (error) { res.status(400).json({ code: error.code || 'LOCAL_AGENT_TASK_READ_FAILED', message: safeError(error) }) }
})

app.post('/api/local-agent/tasks/:taskId/cancel', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const task = await getLocalAgentTask({ dataDir, taskId: req.params.taskId })
    if (!task) return res.status(404).json({ code: 'LOCAL_AGENT_TASK_NOT_FOUND', message: 'Local Agent task was not found.' })
    if (!['Queued', 'Running'].includes(task.status)) return res.status(409).json({ code: 'LOCAL_AGENT_TASK_NOT_ACTIVE', message: `Task is already ${task.status}.` })
    const queueIndex = localAgentQueue.findIndex((item) => item.taskId === task.id)
    if (queueIndex >= 0) {
      localAgentQueue.splice(queueIndex, 1)
      const cancelled = await updateLocalAgentTask({ dataDir, taskId: task.id, patch: { status: 'Cancelled', finishedAt: now() }, event: { type: 'cancelled', detail: 'Queued task cancelled before execution.' } })
      return res.json({ task: localAgentPublicTask(cancelled) })
    }
    const controller = localAgentControllers.get(task.id)
    if (!controller) return res.status(409).json({ code: 'LOCAL_AGENT_TASK_NOT_ACTIVE', message: 'The task is no longer active.' })
    controller.abort()
    return res.status(202).json({ task: localAgentPublicTask(task), cancellationRequested: true })
  } catch (error) { res.status(400).json({ code: error.code || 'LOCAL_AGENT_CANCEL_FAILED', message: safeError(error) }) }
})

app.post('/api/local-agent/tasks/:taskId/retry', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  if (req.body?.confirmSourceDisclosure !== true) return res.status(400).json({ code: 'SOURCE_DISCLOSURE_CONFIRMATION_REQUIRED', message: 'Retry requires renewed confirmation that bounded, redacted project source may be sent to the selected AI provider.' })
  try {
    const previous = await getLocalAgentTask({ dataDir, taskId: req.params.taskId })
    if (!previous) return res.status(404).json({ code: 'LOCAL_AGENT_TASK_NOT_FOUND', message: 'Local Agent task was not found.' })
    if (['Queued', 'Running'].includes(previous.status)) return res.status(409).json({ code: 'LOCAL_AGENT_TASK_ACTIVE', message: 'An active task cannot be retried.' })
    const { task, provider } = await createAndQueueLocalAgentTask({ projectId: previous.projectId, prompt: previous.prompt, providerId: previous.providerId, req })
    return res.status(202).json({ task: localAgentPublicTask(task), provider: { id: provider.id, kind: provider.kind, host: provider.host, model: provider.model } })
  } catch (error) { return res.status(localAgentErrorStatus(error)).json({ code: error.code || 'LOCAL_AGENT_TASK_RETRY_FAILED', message: safeError(error) }) }
})

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'project-nexus', time: now() }))

app.get('/api/auth/context', (req, res) => res.json({ role: currentRole(req), mode: allowRoleHeader ? 'header-enabled' : 'single-user', supportedRoles: Object.keys(roleRank) }))

app.get('/api/github/app/config', (_req, res) => {
  res.json({
    configured: githubAppConfigured(), appId: appConfig.id || null, clientId: appConfig.clientId || null,
    privateKeyConfigured: Boolean(appConfig.privateKey), webhookSecretConfigured: Boolean(appConfig.webhookSecret),
    installations: state.githubInstallations.map(({ accessToken, ...installation }) => ({ ...installation, tokenConfigured: Boolean(accessToken) }))
  })
})

app.get('/api/github/app/install-url', (req, res) => {
  if (!githubAppConfigured() || !appConfig.clientId) return res.status(424).json({ code: 'GITHUB_APP_NOT_CONFIGURED', message: 'Configure GITHUB_APP_ID, GITHUB_APP_CLIENT_ID, and GITHUB_APP_PRIVATE_KEY first.' })
  const stateToken = issueGitHubAppInstallState()
  const callback = `${req.protocol}://${req.get('host')}/api/github/app/callback`
  const url = `https://github.com/apps/${encodeURIComponent(process.env.GITHUB_APP_SLUG || 'project-nexus')}/installations/new?state=${stateToken}&redirect_url=${encodeURIComponent(callback)}`
  res.json({ url, callback, state: stateToken })
})

app.get('/api/github/app/callback', async (req, res) => {
  if (!requireRole(req, res, 'Administrator')) return
  const installationId = req.query.installation_id
  if (!installationId) return res.status(400).send('Missing installation_id')
  if (!consumeGitHubAppInstallState(req.query.state)) {
    return res.status(400).json({ code: 'GITHUB_APP_STATE_INVALID', message: 'The GitHub App installation state is missing, expired, or has already been used.' })
  }
  try {
    const installation = await githubAppFetch(`/app/installations/${encodeURIComponent(installationId)}`)
    const record = { installationId: String(installation.id), accountLogin: installation.account?.login || null, accountType: installation.account?.type || null, repositorySelection: installation.repository_selection || null, permissions: installation.permissions || {}, accessToken: null, installedAt: now(), updatedAt: now() }
    const index = state.githubInstallations.findIndex((item) => String(item.installationId) === String(installation.id))
    if (index >= 0) state.githubInstallations[index] = { ...state.githubInstallations[index], ...record }
    else state.githubInstallations.push(record)
    audit(req, 'github_app_installation_verified', record.installationId, 'success', 'medium', { accountLogin: record.accountLogin })
    await saveState()
    res.type('html').send('<h1>PROJECT NEXUS</h1><p>GitHub App installation verified. You can close this window.</p>')
  } catch (error) { res.status(error.status || 500).send(error.message) }
})

app.post('/api/github/app/installations/:installationId/sync', async (req, res) => {
  if (!requireRole(req, res, 'Operator')) return
  try {
    const installationId = String(req.params.installationId)
    const { items: repositories, pages, truncated } = await fetchAllPages(
      (page) => installationFetch(installationId, page, { returnPageMetadata: true }),
      '/installation/repositories',
      { collection: 'repositories' }
    )
    const incoming = repositories.map((repo) => ({ ...normalizeRepo(repo), installationId }))
    const byFullName = new Map(state.projects.map((project) => [project.fullName, project]))
    for (const project of incoming) byFullName.set(project.fullName, { ...byFullName.get(project.fullName), ...project })
    state.projects = [...byFullName.values()].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    audit(req, 'github_app_repository_sync', installationId, 'success', 'low', { imported: incoming.length })
    await saveState()
    res.json({ imported: incoming.length, pages, truncated, projects: incoming })
  } catch (error) { res.status(error.status || 500).json({ code: error.code, message: error.message }) }
})

app.post('/api/github/webhook', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}))
  const signature = req.get('x-hub-signature-256')
  const deliveryId = req.get('x-github-delivery') || id('delivery')
  const event = req.get('x-github-event') || 'unknown'
  if (!verifyWebhookSignature(rawBody, signature)) return res.status(401).json({ code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Webhook signature could not be verified.' })
  if (state.githubWebhookEvents.some((item) => item.deliveryId === deliveryId)) return res.status(202).json({ duplicate: true, deliveryId })
  let payload
  try { payload = JSON.parse(rawBody.toString('utf8')) } catch { return res.status(400).json({ code: 'WEBHOOK_JSON_INVALID', message: 'Webhook body is not valid JSON.' }) }
  const record = { id: id('event'), deliveryId, event, action: payload.action || null, status: 'QUEUED', receivedAt: now(), payload }
  state.githubWebhookEvents.unshift(record)
  state.githubWebhookEvents = state.githubWebhookEvents.slice(0, 500)
  const task = createTask('webhook', `${event} webhook`, { deliveryId, event })
  await saveState()
  void runTask(task.id, async () => { record.status = 'PROCESSING'; await saveState(); await processWebhookEvent(record); return { deliveryId, event } })
  res.status(202).json({ accepted: true, deliveryId, status: 'QUEUED' })
})

app.get('/api/github/status', (_req, res) => {
  res.json({
    configured: githubConfigured(),
    tokenHint: redactToken(process.env.GITHUB_TOKEN),
    owner: process.env.GITHUB_OWNER || null,
    apiUrl: githubApiUrl,
    permissions: githubConfigured() ? ['repository metadata', 'actions read/dispatch', 'releases read'] : []
  })
})

app.get('/api/overview', (_req, res) => {
  const projects = state.projects
  const tasks = state.tasks
  const running = tasks.filter((task) => ['Pending', 'Running'].includes(task.status)).length
  const failed = tasks.filter((task) => task.status === 'Failed').length
  const blocked = tasks.filter((task) => task.status === 'Blocked').length
  res.json({
    metrics: {
      repositories: projects.length,
      managedProjects: projects.length,
      runningTasks: running,
      successfulBuilds: tasks.filter((task) => task.type === 'build' && task.status === 'Success').length,
      failedBuilds: tasks.filter((task) => task.type === 'build' && task.status === 'Failed').length,
      releases: projects.filter((project) => project.latestRelease).length,
      autoUpdateProjects: projects.filter((project) => project.updateSystem).length,
      alerts: failed + blocked
    },
    projects: projects.slice(0, 8),
    tasks: tasks.slice(0, 8),
    activity: state.activity.slice(0, 8),
    githubConfigured: githubConfigured()
  })
})

app.get('/api/projects', (req, res) => {
  const query = String(req.query.query || '').toLowerCase()
  const group = String(req.query.group || '')
  const projects = state.projects.filter((project) => {
    const matchesQuery = !query || [project.name, project.fullName, project.description, project.language].join(' ').toLowerCase().includes(query)
    const matchesGroup = !group || project.group === group
    return matchesQuery && matchesGroup
  })
  res.json({ projects, total: projects.length })
})

app.post('/api/tasks/sync-repositories', async (req, res) => {
  if (!requireRole(req, res, 'Operator')) return
  const task = createTask('repository-sync', 'Sync repositories from GitHub')
  await saveState()
  void runTask(task.id, async () => syncRepositories())
  res.status(202).json({ task })
})

app.get('/api/integrations/adapters', (_req, res) => {
  const ai = aiProviderStatus()
  res.json({
    adapters: adapters.map(({ id: adapterId, name, capabilities }) => ({ id: adapterId, name, capabilities })),
    ai: { configured: ai.configured, baseUrl: ai.baseUrl, model: ai.model },
    remoteWritesEnabled: process.env.NEXUS_ENABLE_REMOTE_WRITES === 'true',
    supportedWorkflows: { scan: true, localModification: true, isolatedBuild: true, push: process.env.NEXUS_ENABLE_REMOTE_WRITES === 'true', pullRequest: process.env.NEXUS_ENABLE_REMOTE_WRITES === 'true' }
  })
})

app.get('/api/ai/providers', (_req, res) => {
  const ai = aiProviderStatus()
  res.json({
    providers: listAIProviders(),
    configured: ai.configured,
    defaultProviderId: ai.providerId,
    defaultModel: ai.model
  })
})

app.get('/api/integrations/security', (_req, res) => {
  const reports = state.integrationReports
  const statuses = reports.map((report) => report.readiness || {})
  const lastScanAt = reports[0]?.scannedAt || null
  res.json({
    summary: {
      scannedRepositories: new Set(reports.map((report) => report.projectId)).size,
      reports: reports.length,
      codeSupport: statuses.filter((item) => item.codeSupportsUpdates).length,
      pipelineEvidence: statuses.filter((item) => item.ciBuildsUpdateArtifacts).length,
      manifestEvidence: statuses.filter((item) => item.updateManifestInRepository).length,
      signingConfigured: statuses.filter((item) => item.signingConfigured).length,
      signatureCryptographicallyVerified: 0,
      oldClientUpdateVerified: 0,
      lastScanAt
    },
    configuration: {
      githubConfigured: githubConfigured(), githubAppConfigured: githubAppConfigured(),
      aiConfigured: aiProviderStatus().configured,
      remoteWritesEnabled: process.env.NEXUS_ENABLE_REMOTE_WRITES === 'true',
      roleIdentityMode: allowRoleHeader ? 'request-header (remote writes disabled)' : 'single-server environment role'
    },
    findings: reports.slice(0, 100).flatMap((report) => (report.assessment?.components || []).flatMap(({ component, assessment }) => assessment.missing.map((check) => ({ projectId: report.projectId, repository: report.repository, framework: component.framework, check, status: assessment.status, reportId: report.id }))))
  })
})

app.get('/api/integrations/schedule', (_req, res) => res.json({ schedules: state.integrationSchedules }))

app.put('/api/integrations/schedule', async (req, res) => {
  if (!requireRole(req, res, 'Administrator')) return
  const enabled = req.body?.enabled === true
  const intervalHours = Number(req.body?.intervalHours || 24)
  if (!Number.isInteger(intervalHours) || intervalHours < 6 || intervalHours > 720) return res.status(400).json({ code: 'INVALID_SCHEDULE', message: 'intervalHours must be an integer from 6 to 720.' })
  let schedule = state.integrationSchedules.find((item) => item.id === 'repository-update-scan')
  if (!schedule) {
    schedule = { id: 'repository-update-scan', createdAt: now() }
    state.integrationSchedules.push(schedule)
  }
  schedule.enabled = enabled
  schedule.intervalHours = intervalHours
  schedule.updatedAt = now()
  schedule.nextRunAt = enabled ? new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString() : null
  audit(req, 'integration_schedule_update', schedule.id, 'success', 'low', { enabled, intervalHours })
  await saveState()
  res.json({ schedule })
})

app.get('/api/integrations/reports', (req, res) => {
  const projectId = String(req.query.projectId || '')
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
  const reports = state.integrationReports.filter((report) => !projectId || report.projectId === projectId).slice(0, limit)
  res.json({ reports, total: state.integrationReports.filter((report) => !projectId || report.projectId === projectId).length })
})

app.get('/api/integrations/reports/:reportId', (req, res) => {
  const report = state.integrationReports.find((item) => item.id === req.params.reportId)
  if (!report) return res.status(404).json({ code: 'REPORT_NOT_FOUND', message: 'Integration report not found.' })
  res.json({ report })
})

app.get('/api/integrations/jobs', (req, res) => {
  const projectId = String(req.query.projectId || '')
  const jobs = state.integrationJobs.filter((job) => !projectId || job.projectId === projectId).slice(0, 100)
  res.json({ jobs, total: state.integrationJobs.filter((job) => !projectId || job.projectId === projectId).length })
})

app.get('/api/integrations/jobs/:jobId', (req, res) => {
  const job = state.integrationJobs.find((item) => item.id === req.params.jobId)
  if (!job) return res.status(404).json({ code: 'JOB_NOT_FOUND', message: 'Integration job not found.' })
  const task = state.tasks.find((item) => item.id === job.taskId)
  const report = job.reportId ? state.integrationReports.find((item) => item.id === job.reportId) : null
  res.json({ job, task, report })
})

app.post('/api/integrations/jobs', async (req, res) => {
  if (!requireRole(req, res, 'Operator')) return
  if (req.body?.confirmSourceDisclosure !== true) return res.status(400).json({ code: 'SOURCE_DISCLOSURE_CONFIRMATION_REQUIRED', message: 'Confirm that selected repository files may be sent to the configured AI provider.' })
  const report = state.integrationReports.find((item) => item.id === req.body?.reportId)
  if (!report) return res.status(404).json({ code: 'REPORT_NOT_FOUND', message: 'Run a repository scan before creating an AI integration job.' })
  const project = state.projects.find((item) => item.id === report.projectId)
  if (!project) return res.status(404).json({ message: 'Repository is no longer managed.' })
  const queued = await enqueueAgentJob(project, report, req)
  if (!queued.reused) {
    if (!aiProviderStatus().configured) {
      queued.job.status = 'Blocked'; queued.job.currentStep = 'AI provider not configured'; queued.job.finishedAt = now()
      queued.job.error = 'Configure AI_BASE_URL, AI_API_KEY, and AI_MODEL to enable real code generation.'
      queued.task.status = 'Blocked'; queued.task.error = queued.job.error; queued.task.finishedAt = queued.job.finishedAt
      integrationLog(queued.job, queued.task, queued.job.error)
      audit(req, 'integration_agent_changes_prepared', project.fullName, 'blocked', 'medium', { code: 'AI_NOT_CONFIGURED' })
      await saveState()
      return res.status(202).json({ ...queued, blocked: true })
    }
    void executeAgentJob(queued.job.id, req).catch((error) => console.error('Integration agent job failed:', safeError(error)))
  }
  res.status(202).json(queued)
})

app.post('/api/integrations/jobs/:jobId/pull-request', async (req, res) => {
  if (process.env.NEXUS_ENABLE_REMOTE_WRITES !== 'true') return res.status(403).json({ code: 'REMOTE_WRITES_DISABLED', message: 'Enable NEXUS_ENABLE_REMOTE_WRITES explicitly before creating a remote branch or pull request.' })
  if (allowRoleHeader) return res.status(403).json({ code: 'UNTRUSTED_ROLE_MODE', message: 'Remote writes are disabled while role identity can be supplied by a request header.' })
  if (!requireRole(req, res, 'Administrator')) return
  const job = state.integrationJobs.find((item) => item.id === req.params.jobId)
  if (!job) return res.status(404).json({ message: 'Integration job not found.' })
  const project = state.projects.find((item) => item.id === job.projectId)
  const workspace = agentWorkspacePaths.get(job.id)
  if (!project || !workspace) return res.status(409).json({ code: 'WORKSPACE_UNAVAILABLE', message: 'The isolated workspace is unavailable; prepare a new integration job before creating a pull request.' })
  if (job.type !== 'agent' || job.status !== 'ReadyForReview' || job.tests?.status !== 'PASS' || !job.modifiedFiles?.length) {
    return res.status(409).json({ code: 'REVIEW_GATES_NOT_MET', message: 'Pull requests require a prepared change set, at least one file change, and passing isolated checks.' })
  }
  if (req.body?.confirm !== true || req.body?.confirmRepository !== project.fullName || req.body?.confirmBranch !== workspace.branch) {
    return res.status(400).json({ code: 'REMOTE_WRITE_CONFIRMATION_REQUIRED', message: 'Confirm the exact repository and generated branch before pushing and opening a pull request.' })
  }
  if (job.pullRequest) return res.status(409).json({ code: 'PULL_REQUEST_EXISTS', message: 'A pull request has already been recorded for this job.', pullRequest: job.pullRequest })
  try {
    const token = await githubTokenForProject(project)
    const head = await pushWorkspaceBranch(workspace, token, job.modifiedFiles)
    const endpoint = `${repositoryApiPath(project.fullName)}/pulls`
    const existing = await githubFetchForProject(project, `${endpoint}?state=open&head=${encodeURIComponent(`${project.owner}:${workspace.branch}`)}`)
    const pull = existing?.[0] || await githubFetchForProject(project, endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Add verified auto-update integration (${job.provider?.model || 'AI-assisted'})`,
        body: `## PROJECT NEXUS integration proposal\n\nRepository: ${project.fullName}\nBase commit: ${workspace.baseCommit}\nGenerated branch: ${workspace.branch}\nChanged files: ${job.modifiedFiles.join(', ')}\nLocal isolated tests: ${job.tests.status}\n\nThis pull request was prepared for human review. NEXUS did not merge or publish a release.`,
        head: workspace.branch, base: project.defaultBranch, draft: true
      })
    })
    job.pullRequest = { number: pull.number, url: pull.html_url, head: pull.head?.sha || head.stdout, createdAt: now(), draft: Boolean(pull.draft) }
    job.currentStep = 'Draft pull request opened'; job.status = 'PullRequestOpen'; job.finishedAt = now()
    audit(req, 'integration_pull_request_created', project.fullName, 'success', 'high', { jobId: job.id, number: pull.number, url: pull.html_url })
    integrationLog(job, state.tasks.find((item) => item.id === job.taskId), `Draft pull request #${pull.number} opened for human review.`)
    await saveState()
    res.status(201).json({ pullRequest: job.pullRequest, job })
  } catch (error) {
    const message = safeError(error)
    audit(req, 'integration_pull_request_created', project.fullName, 'failed', 'high', { jobId: job.id, code: error.code || null })
    await saveState()
    res.status(error.status || 502).json({ code: 'PULL_REQUEST_FAILED', message })
  }
})

app.post('/api/integrations/scans', async (req, res) => {
  if (!requireRole(req, res, 'Operator')) return
  const ids = req.body?.projectIds
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || ids.some((value) => typeof value !== 'string'))) {
    return res.status(400).json({ code: 'INVALID_PROJECT_IDS', message: 'projectIds must be an array of at most 100 project IDs.' })
  }
  const selected = state.projects.filter((project) => !ids?.length || ids.includes(project.id))
  if (!selected.length) return res.status(404).json({ code: 'NO_PROJECTS', message: 'No managed repositories matched this scan request.' })
  const blocked = selected.filter((project) => !githubConfigured() && !project.installationId)
  const runnable = selected.filter((project) => githubConfigured() || project.installationId)
  if (!runnable.length) return notConfigured(res)
  const queued = []
  for (const project of runnable) queued.push(await enqueueIntegrationScan(project, req))
  audit(req, 'integration_scan_batch_queued', 'workspace', 'success', 'low', { requested: selected.length, queued: queued.length, blocked: blocked.length })
  await saveState()
  void runScanQueue(queued.filter((entry) => !entry.reused).map((entry) => entry.job.id), req)
  res.status(202).json({ jobs: queued.map(({ job, task, reused }) => ({ job, task, reused })), blocked: blocked.map(({ id: projectId, fullName }) => ({ projectId, fullName, status: 'BLOCKED', reason: 'No GitHub token or installation is configured.' })) })
})

app.post('/api/projects/:projectId/integration-scan', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ message: 'Project not found' })
  if (!requireRole(req, res, 'Operator')) return
  if (!githubConfigured() && !project.installationId) return notConfigured(res)
  const queued = await enqueueIntegrationScan(project, req)
  if (!queued.reused) void runScanQueue([queued.job.id], req)
  res.status(202).json({ project, ...queued })
})

app.post('/api/integrations/jobs/:jobId/cancel', async (req, res) => {
  if (!requireRole(req, res, 'Operator')) return
  const job = state.integrationJobs.find((item) => item.id === req.params.jobId)
  if (!job) return res.status(404).json({ message: 'Integration job not found.' })
  if (!['Pending', 'Running'].includes(job.status)) return res.status(409).json({ code: 'JOB_NOT_ACTIVE', message: 'Only pending or running jobs can be cancelled.' })
  job.cancelRequested = true
  job.currentStep = 'Cancellation requested'
  integrationControllers.get(job.id)?.abort()
  audit(req, 'integration_job_cancel', job.repository, 'success', 'low', { jobId: job.id })
  await saveState()
  res.json({ job })
})

app.post('/api/integrations/jobs/:jobId/retry', async (req, res) => {
  if (!requireRole(req, res, 'Operator')) return
  const previous = state.integrationJobs.find((item) => item.id === req.params.jobId)
  if (!previous) return res.status(404).json({ message: 'Integration job not found.' })
  if (!['scan', 'agent'].includes(previous.type) || !['Failed', 'Blocked', 'Cancelled'].includes(previous.status)) return res.status(409).json({ code: 'JOB_NOT_RETRYABLE', message: 'Only failed, blocked, or cancelled integration jobs can be retried.' })
  const project = state.projects.find((item) => item.id === previous.projectId)
  if (!project) return res.status(404).json({ message: 'Repository is no longer managed.' })
  if (!githubConfigured() && !project.installationId) return notConfigured(res)
  if (previous.type === 'agent') {
    if (req.body?.confirmSourceDisclosure !== true) return res.status(400).json({ code: 'SOURCE_DISCLOSURE_CONFIRMATION_REQUIRED', message: 'Retry requires confirmation that selected repository files may be sent to the configured AI provider.' })
    const report = state.integrationReports.find((item) => item.id === previous.reportId)
    if (!report) return res.status(404).json({ code: 'REPORT_NOT_FOUND', message: 'The source report for this integration job no longer exists.' })
    const queued = await enqueueAgentJob(project, report, req)
    if (!queued.reused) void executeAgentJob(queued.job.id, req).catch((error) => console.error('Integration agent retry failed:', safeError(error)))
    audit(req, 'integration_job_retry', project.fullName, 'success', 'low', { previousJobId: previous.id, jobId: queued.job.id })
    return res.status(202).json(queued)
  }
  const queued = await enqueueIntegrationScan(project, req)
  if (!queued.reused) void runScanQueue([queued.job.id], req)
  audit(req, 'integration_job_retry', project.fullName, 'success', 'low', { previousJobId: previous.id, jobId: queued.job.id })
  res.status(202).json(queued)
})

app.post('/api/projects/:projectId/scan', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ message: 'Project not found' })
  if (!projectGithubConfigured(project)) return notConfigured(res)
  try {
    const contents = await githubFetchForProject(project, `/repos/${repoFromProject(project)}/contents`)
    const names = contents.map((item) => item.name.toLowerCase())
    const stack = []
    if (names.includes('package.json')) stack.push('Node.js')
    if (names.includes('pyproject.toml') || names.includes('requirements.txt')) stack.push('Python')
    if (names.includes('cargo.toml')) stack.push('Rust')
    if (names.includes('go.mod')) stack.push('Go')
    if (names.includes('dockerfile')) stack.push('Docker')
    if (names.some((name) => name.includes('electron'))) stack.push('Electron')
    project.stack = [...new Set(stack.length ? stack : project.stack)]
    project.lastScannedAt = now()
    await saveState()
    res.json({ project })
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message })
  }
})

app.get('/api/projects/:projectId/workflows', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ message: 'Project not found' })
  if (!projectGithubConfigured(project)) return notConfigured(res)
  try {
    const data = await githubFetchForProject(project, `/repos/${repoFromProject(project)}/actions/workflows?per_page=100`)
    res.json({ workflows: data.workflows || [] })
  } catch (error) { res.status(error.status || 500).json({ message: error.message }) }
})

app.get('/api/projects/:projectId/runs', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ message: 'Project not found' })
  if (!projectGithubConfigured(project)) return notConfigured(res)
  try {
    const data = await githubFetchForProject(project, `/repos/${repoFromProject(project)}/actions/runs?per_page=20`)
    res.json({ runs: data.workflow_runs || [] })
  } catch (error) { res.status(error.status || 500).json({ message: error.message }) }
})

app.post('/api/projects/:projectId/build', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ message: 'Project not found' })
  if (!projectGithubConfigured(project)) return notConfigured(res)
  const workflowId = req.body?.workflowId
  if (!workflowId) return res.status(400).json({ message: 'workflowId is required' })
  const task = createTask('build', `Dispatch workflow for ${project.fullName}`, { projectId: project.id, workflowId })
  await saveState()
  void runTask(task.id, async () => {
    const ref = req.body.ref || project.defaultBranch
    await githubFetchForProject(project, `/repos/${repoFromProject(project)}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref, inputs: req.body.inputs || {} }),
      headers: { 'Content-Type': 'application/json' }
    })
    state.activity.unshift({ id: id('activity'), type: 'build', message: `Triggered ${workflowId} on ${project.fullName}`, at: now() })
    return { ref, workflowId }
  })
  res.status(202).json({ task })
})

app.get('/api/auto-update', (_req, res) => {
  const projectId = String(_req.query.projectId || '')
  const configs = projectId ? state.updateConfigs.filter((item) => item.projectId === projectId) : state.updateConfigs
  res.json({ configs, total: configs.length })
})

app.post('/api/projects/:projectId/update-check', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ message: 'Project not found' })
  if (!requireRole(req, res, 'Operator')) return
  if (!githubConfigured() && !project.installationId) return notConfigured(res)
  const task = createTask('update-check', `Inspect update configuration for ${project.fullName}`, { projectId: project.id })
  await saveState()
  void runTask(task.id, async () => {
    const config = await inspectUpdateConfig(project)
    const index = state.updateConfigs.findIndex((item) => item.projectId === project.id)
    if (index >= 0) state.updateConfigs[index] = config
    else state.updateConfigs.push(config)
    project.updateSystem = config.framework
    project.updateConfigStatus = config.security.status
    audit(req, 'update_configuration_check', project.fullName, 'success', config.security.status === 'BLOCKED' ? 'high' : 'low', { framework: config.framework })
    await saveState()
    return config
  })
  res.status(202).json({ task })
})

app.post('/api/tasks/update-check-all', async (req, res) => {
  if (!requireRole(req, res, 'Operator')) return
  const selected = state.projects.filter((project) => !req.body?.projectIds?.length || req.body.projectIds.includes(project.id))
  const task = createTask('batch-update-check', `Inspect update configuration for ${selected.length} projects`, { projectIds: selected.map((project) => project.id) })
  await saveState()
  void runTask(task.id, async () => {
    const results = []
    for (const project of selected) {
      try {
        const config = await inspectUpdateConfig(project)
        const index = state.updateConfigs.findIndex((item) => item.projectId === project.id)
        if (index >= 0) state.updateConfigs[index] = config
        else state.updateConfigs.push(config)
        project.updateSystem = config.framework
        project.updateConfigStatus = config.security.status
        results.push({ projectId: project.id, status: config.security.status })
      } catch (error) { results.push({ projectId: project.id, status: 'FAILED', error: error.message }) }
    }
    audit(req, 'batch_update_configuration_check', 'workspace', 'success', 'low', { count: results.length })
    await saveState()
    return { results }
  })
  res.status(202).json({ task })
})

app.post('/api/projects/:projectId/releases', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ message: 'Project not found' })
  if (!requireRole(req, res, 'Operator')) return
  if (!githubConfigured() && !project.installationId) return notConfigured(res)
  const tagName = String(req.body?.tagName || '').trim()
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tagName)) return res.status(400).json({ code: 'INVALID_SEMVER', message: 'tagName must be a semantic version such as v1.2.3 or v1.2.3-beta.1.' })
  const task = createTask('release-create', `Create release draft for ${project.fullName}`, { projectId: project.id, tagName })
  await saveState()
  void runTask(task.id, async () => {
    const existing = await githubFetchForProject(project, `/repos/${repoFromProject(project)}/releases/tags/${encodeURIComponent(tagName)}`).catch((error) => error.status === 404 ? null : Promise.reject(error))
    if (existing) throw new Error(`Release ${tagName} already exists; existing releases cannot be overwritten.`)
    const release = await githubFetchForProject(project, `/repos/${repoFromProject(project)}/releases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag_name: tagName, name: req.body.name || tagName, body: req.body.body || '', target_commitish: req.body.targetCommitish || project.defaultBranch, draft: true, prerelease: Boolean(req.body.prerelease) }) })
    audit(req, 'release_draft_create', project.fullName, 'success', 'medium', { releaseId: release.id, tagName })
    state.activity.unshift({ id: id('activity'), type: 'release', message: `Created draft ${tagName} for ${project.fullName}`, at: now() })
    await saveState()
    return release
  })
  res.status(202).json({ task })
})

app.patch('/api/projects/:projectId/releases/:releaseId', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ message: 'Project not found' })
  if (!requireRole(req, res, 'Operator')) return
  if (!githubConfigured() && !project.installationId) return notConfigured(res)
  try {
    const release = await githubFetchForProject(project, `/repos/${repoFromProject(project)}/releases/${encodeURIComponent(req.params.releaseId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: req.body.name, body: req.body.body, draft: req.body.draft, prerelease: req.body.prerelease, target_commitish: req.body.targetCommitish }) })
    audit(req, 'release_edit', project.fullName, 'success', 'medium', { releaseId: release.id })
    await saveState()
    res.json({ release })
  } catch (error) { res.status(error.status || 500).json({ message: error.message }) }
})

app.post('/api/projects/:projectId/releases/:releaseId/publish', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ message: 'Project not found' })
  if (!requireRole(req, res, 'Administrator')) return
  if (req.body?.confirm !== true) return res.status(400).json({ code: 'CONFIRMATION_REQUIRED', message: 'Publishing requires confirm=true.' })
  if (!githubConfigured() && !project.installationId) return notConfigured(res)
  const task = createTask('release-publish', `Publish release ${req.params.releaseId} for ${project.fullName}`, { projectId: project.id, releaseId: req.params.releaseId })
  await saveState()
  void runTask(task.id, async () => {
    const release = await githubFetchForProject(project, `/repos/${repoFromProject(project)}/releases/${encodeURIComponent(req.params.releaseId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false }) })
    audit(req, 'release_publish', project.fullName, 'success', 'high', { releaseId: release.id, tagName: release.tag_name })
    await saveState()
    return release
  })
  res.status(202).json({ task })
})

app.post('/api/projects/:projectId/releases/:releaseId/assets', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ message: 'Project not found' })
  if (!requireRole(req, res, 'Operator')) return
  if (!req.body?.assetName || !req.body?.contentBase64) return res.status(400).json({ message: 'assetName and contentBase64 are required.' })
  if (!githubConfigured() && !project.installationId) return notConfigured(res)
  try {
    const release = await githubFetchForProject(project, `/repos/${repoFromProject(project)}/releases/${encodeURIComponent(req.params.releaseId)}`)
    const content = Buffer.from(req.body.contentBase64, 'base64')
    const uploadUrl = String(release.upload_url || '').replace(/\{.*$/, '')
    if (!uploadUrl) return res.status(502).json({ message: 'GitHub release did not return an upload URL.' })
    const token = await githubTokenForProject(project)
    const response = await fetch(`${uploadUrl}?name=${encodeURIComponent(req.body.assetName)}`, { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}`, 'Content-Type': req.body.contentType || 'application/octet-stream' }, body: content })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) return res.status(response.status).json({ message: body.message || 'Asset upload failed.' })
    audit(req, 'release_asset_upload', project.fullName, 'success', 'high', { releaseId: release.id, assetName: req.body.assetName, sha256: crypto.createHash('sha256').update(content).digest('hex') })
    res.status(201).json({ asset: body, sha256: crypto.createHash('sha256').update(content).digest('hex') })
  } catch (error) { res.status(error.status || 500).json({ message: error.message }) }
})

app.get('/api/releases', async (req, res) => {
  const projectId = String(req.query.projectId || '')
  const requestedProjects = projectId ? state.projects.filter((project) => project.id === projectId) : state.projects.slice(0, 25)
  const projects = requestedProjects.filter((project) => projectGithubConfigured(project))
  if (!projects.length) return res.json({ releases: [], blocked: true, message: 'Configure GITHUB_TOKEN or a GitHub App installation to read releases.' })
  try {
    const releases = []
    for (const project of projects) {
      const data = await githubFetchForProject(project, `/repos/${repoFromProject(project)}/releases?per_page=10`)
      releases.push(...(data || []).map((release) => ({ ...release, projectId: project.id, projectName: project.fullName })))
    }
    res.json({ releases })
  } catch (error) { res.status(error.status || 500).json({ message: error.message }) }
})

app.get('/api/tasks', (_req, res) => res.json({ tasks: state.tasks }))

app.get('/api/audit-logs', (req, res) => {
  if (!requireRole(req, res, 'Administrator')) return
  res.json({ logs: state.auditLogs })
})

app.post('/api/ai/diagnose', async (req, res) => {
  if (!requireRole(req, res, 'Operator')) return
  if (!aiProviderStatus().configured) return res.status(424).json({ code: 'AI_NOT_CONFIGURED', message: 'Configure an AI provider with a base URL, API key, and model to enable diagnosis.' })
  const prompt = String(req.body?.prompt || req.body?.message || '').trim()
  if (!prompt) return res.status(400).json({ code: 'AI_PROMPT_REQUIRED', message: 'A diagnosis prompt is required.' })
  if (prompt.length > 20_000) return res.status(413).json({ code: 'AI_PROMPT_TOO_LARGE', message: 'Diagnosis prompts are limited to 20,000 characters.' })
  try {
    const result = await diagnoseWithAI({ prompt, context: req.body?.context || null, providerId: req.body?.providerId || null })
    audit(req, 'ai_diagnose', 'ai-provider', 'success', 'low', { providerId: result.provider?.id || null, model: result.model, usage: result.usage, costUsd: result.costUsd })
    await saveState()
    res.json({ ok: true, ...result })
  } catch (error) {
    const code = error.code || 'AI_DIAGNOSE_FAILED'
    audit(req, 'ai_diagnose', 'ai-provider', code === 'AI_NOT_CONFIGURED' ? 'blocked' : 'failed', 'low', { code })
    await saveState()
    res.status(code === 'AI_NOT_CONFIGURED' ? 424 : code === 'AI_TIMEOUT' ? 504 : 502).json({ code, message: safeError(error) })
  }
})

app.get('/api/settings', (_req, res) => {
  const ai = aiProviderStatus()
  return res.json({
  github: { configured: githubConfigured(), owner: process.env.GITHUB_OWNER || null, apiUrl: githubApiUrl },
  ai: { configured: ai.configured, baseUrl: ai.baseUrl, model: ai.model, providerId: ai.providerId },
  tasks: state.settings
  })
})

app.use(express.static(path.join(root, 'dist')))
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  res.sendFile(path.join(root, 'dist', 'index.html'))
})

async function recoverIntegrationWork() {
  const pendingScans = []
  let changed = false
  for (const job of state.integrationJobs) {
    const task = state.tasks.find((item) => item.id === job.taskId)
    if (!['Pending', 'Running'].includes(job.status)) continue
    if (job.status === 'Running' || job.type === 'agent') {
      job.status = job.type === 'agent' ? 'Blocked' : 'Failed'
      job.error = job.type === 'agent'
        ? 'Server restarted before the local AI change job completed. Re-run after reviewing source disclosure and workspace state.'
        : 'Server restarted while this scan was running. Retry the scan to resume.'
      job.currentStep = job.status; job.finishedAt = now()
      if (task) { task.status = job.status; task.error = job.error; task.finishedAt = job.finishedAt }
      changed = true
    } else if (job.type === 'scan') pendingScans.push(job.id)
  }
  if (changed) await saveState()
  if (pendingScans.length) {
    const syntheticRequest = { get: () => undefined }
    setTimeout(() => void runScanQueue(pendingScans, syntheticRequest).catch((error) => console.error('Recovered integration scan failed:', safeError(error))), 0)
  }
}

await loadState()
await recoverIntegrationWork()
await recoverLocalAgentTasks()
const server = app.listen(port, host, () => {
  const address = server.address()
  if (desktopMode && address && typeof address === 'object') {
    desktopOrigin = `http://127.0.0.1:${address.port}`
    console.log(`NEXUS_DESKTOP_READY:${address.port}`)
  } else {
    console.log(`PROJECT NEXUS API listening on http://localhost:${address && typeof address === 'object' ? address.port : port}`)
  }
  const timer = setInterval(() => void runScheduledIntegrationScan(), 60_000)
  timer.unref?.()
  void runScheduledIntegrationScan()
})
