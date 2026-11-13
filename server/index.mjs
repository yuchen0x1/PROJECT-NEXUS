import { upsertIssueActivity } from './services/issue-activity.mjs'
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
import { executeAgentRuntimeTask, rollbackAgentTask, applyAgentTaskToProject, agentWorkspaceHandleFor } from './services/agent/task-executor.mjs'
import { listPublicProviders, createProviderRecord, updateProviderRecord, deleteProviderRecord, testProviderRecord, setRuntimeProviderKeys } from './services/provider-store.mjs'
import { resolveApprovalInTask, expireStaleApprovals, APPROVAL_POLICIES } from './services/agent/approval.mjs'
import { buildProjectIndex } from './services/agent/indexer.mjs'
import {
  getHostingPolicy, hostingStatus, normalizeHostingPolicy, applyStrategyPreset,
  recordHostingRun, summarizeFindings, HOSTING_STRATEGIES, HOSTING_INSPECTION_DEPTHS,
  HOSTING_MIN_INTERVAL_MINUTES, HOSTING_MAX_INTERVAL_MINUTES, defaultHostingPolicy
} from './services/hosting.mjs'
import { ensureRepoCache, removeRepoWorkspace, describeRepoCache, repoKeyFor, sweepStaleRepoWorkspaces } from './services/repo-workspace.mjs'
import { listRepositoryIssues, getIssue, listIssueComments, createIssueComment, updateIssueState, addIssueLabels, issuePublicSummary, isRealIssue } from './services/github-issues.mjs'
import { classifyIssue, ACTIONABLE_CATEGORIES, ISSUE_CATEGORIES } from './services/issue-classifier.mjs'
import { resolveProviderForInvocation } from './services/provider-store.mjs'
import { runIssueFixPipeline } from './services/issue-fix-pipeline.mjs'
import { runSecurityScan, summarizeFindingsByPriority } from './services/security-scan.mjs'
import { runCompetitorResearch, RESEARCH_MAX_CANDIDATES } from './services/competitor-research.mjs'
import { maybeMergePullRequest, maybePublishRelease, maybeCloseIssue } from './services/delivery-stage.mjs'
import fs from 'node:fs/promises'
import { buildUpgradeProposals, reviewUpgradeProposal } from './services/upgrade-proposals.mjs'
import { withExecutionPolicy, assertTrustedRepository } from './services/execution-policy.mjs'
import { durableEffect, reconcileEffect } from './services/durable-effects.mjs'
import { acquireFileLease } from './services/file-lease.mjs'
import { readinessFingerprint, validateReadiness } from './services/setup-readiness.mjs'
import { detectDevelopmentEnvironment } from './services/local-environment.mjs'
import { assertHostingWrite, hostingOperation, hostedResult, automaticFixDecision } from './services/hosting-gates.mjs'
import { queueHostedJob, nextHostedJobIndex, recoverHostedJobs } from './services/hosted-queue.mjs'
import { buildProjectOverview } from './services/project-overview.mjs'
import { registerEvolutionApi } from './services/evolution-api.mjs'
import { proposalLifecycle, startProposalImplementation } from './services/proposal-implementation.mjs'

const activeOverviewResearch = new Map()

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
const hostedControllers = new Map()
let shuttingDown = false
const localAgentQueue = []
const pendingGitHubAppInstallStates = new Map()
const installationTokens = new Map()
const readinessEpoch = crypto.randomUUID()
let githubAccount = null
let stateWriteQueue = Promise.resolve()

const GITHUB_APP_INSTALL_STATE_TTL_MS = 10 * 60 * 1000

async function loadState() {
  state = await loadStateFile(stateFile)
  // Migrate old plaintext installation-token records into process memory.
  for (const installation of state.githubInstallations) {
    if (installation.accessToken) installationTokens.set(String(installation.installationId), { accessToken: installation.accessToken, expiresAt: installation.expiresAt })
    delete installation.accessToken
  }
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

function remoteWritesEnabled() {
  return typeof state.settings.remoteWritesEnabled === 'boolean' ? state.settings.remoteWritesEnabled : process.env.NEXUS_ENABLE_REMOTE_WRITES === 'true'
}

function projectGithubConfigured(project) {
  return githubConfigured() || Boolean(project?.installationId)
}

function githubAppConfigured() {
  return Boolean(appConfig.id && appConfig.privateKey)
}

function currentRole(req) {
  if (allowRoleHeader && req?.get('x-nexus-role')) return req.get('x-nexus-role')
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
  try { body = text ? JSON.parse(text) : null } catch { body = response.ok ? text : { message: text } }
  if (!response.ok) throw Object.assign(new Error(body?.message || `GitHub App API returned ${response.status}`), { status: response.status, body })
  return body
}

async function installationFetch(installationId, endpoint, options = {}) {
  const { returnPageMetadata = false, ...fetchOptions } = options
  const installation = installationTokens.get(String(installationId))
  if (!installation?.accessToken || new Date(installation.expiresAt || 0) <= new Date(Date.now() + 60_000)) {
    if (!githubAppConfigured()) throw Object.assign(new Error('GitHub App credentials are not configured'), { code: 'GITHUB_APP_NOT_CONFIGURED' })
    const token = await githubAppFetch(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { method: 'POST' })
    const updated = { ...(installation || { installationId: String(installationId) }), accessToken: token.token, expiresAt: token.expires_at, updatedAt: now() }
    installationTokens.set(String(installationId), updated)
    const index = state.githubInstallations.findIndex((item) => String(item.installationId) === String(installationId))
    const { accessToken: _secret, ...metadata } = updated
    if (index >= 0) state.githubInstallations[index] = { ...state.githubInstallations[index], ...metadata }
    else state.githubInstallations.push(metadata)
    await saveState()
    return installationFetch(installationId, endpoint, options)
  }
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${installation.accessToken}`, ...(options.headers || {}) }
  const response = await fetch(githubRequestUrl(endpoint), { ...fetchOptions, headers })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = response.ok ? text : { message: text } }
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
  try { body = text ? JSON.parse(text) : null } catch { body = response.ok ? text : { message: text } }
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
  const installation = installationTokens.get(String(project.installationId))
  if (!installation?.accessToken || new Date(installation.expiresAt || 0) <= new Date(Date.now() + 60_000)) {
    await installationFetch(project.installationId, '/installation/repositories?per_page=1')
  }
  return installationTokens.get(String(project.installationId))?.accessToken || ''
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
  let handled = 'metadata'
  if (project) {
    project.lastWebhookAt = now()
    if (eventRecord.event === 'release' && payload.release) project.latestRelease = payload.release
    if (eventRecord.event === 'push' && payload.after) {
      project.latestCommit = payload.after
      if (project.repoMeta) project.repoMeta.pushedAt = now()
    }
    try {
      if (eventRecord.event === 'issues' && ['opened', 'edited', 'reopened', 'labeled'].includes(payload.action)) {
        const entry = await handleIssueEvent({ project, issue: payload.issue, source: 'webhook' })
        handled = 'issue-classified'
        if (entry?.triggerFix) {
          try {
            await enqueueIssueFixTask({ project, issueNumber: entry.number, source: 'webhook', classification: entry.classification })
            handled = 'issue-fix-queued'
          } catch (queueError) { handled = `fix-queue-rejected: ${queueError.code || 'unknown'}` }
        }
      } else if (eventRecord.event === 'issue_comment' && payload.action === 'created') {
        const entry = await handleIssueEvent({ project, issue: payload.issue, source: 'webhook', comment: payload.comment })
        handled = 'issue-comment-classified'
        if (entry?.triggerFix) {
          try {
            await enqueueIssueFixTask({ project, issueNumber: entry.number, source: 'webhook', classification: entry.classification })
            handled = 'issue-fix-queued'
          } catch (queueError) { handled = `fix-queue-rejected: ${queueError.code || 'unknown'}` }
        }
      } else if (eventRecord.event === 'issues' && payload.action === 'closed') {
        const store = normalizeIssueStore(project)
        if (payload.issue && store.known[String(payload.issue.number)]) store.known[String(payload.issue.number)].state = 'closed'
        handled = 'issue-closed'
      }
    } catch (error) {
      eventRecord.processingError = safeError(error)
      handled = `error: ${safeError(error).slice(0, 200)}`
    }
  }
  state.activity.unshift({ id: id('activity'), type: 'webhook', message: `${eventRecord.event} event received${repoName ? ` for ${repoName}` : ''} (${handled})`, at: now() })
  state.activity = state.activity.slice(0, 100)
  eventRecord.status = 'COMPLETED'
  eventRecord.handled = handled
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
    if (previous) {
      // Merge in place so concurrent per-project mutations (e.g. an in-flight
      // scan writing project.stack) are not clobbered by the sync.
      Object.assign(previous, project, { workflows: previous.workflows || [], hosting: previous.hosting || getHostingPolicy(null), repoMeta: previous.repoMeta || null, localWorkspace: previous.localWorkspace || null })
    } else {
      byFullName.set(project.fullName, { ...project, hosting: getHostingPolicy(null), repoMeta: null, localWorkspace: null })
    }
  }
  state.projects = [...byFullName.values()].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
  void sweepStaleRepoWorkspaces({ dataDir, keepKeys: state.projects.map((project) => repoKeyFor(project.fullName)).filter(Boolean) }).catch(() => {})
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
    phase: task.phase || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt || null,
    finishedAt: task.finishedAt || null,
    error: task.error || null,
    events: (task.events || []).slice(-50),
    plan: task.plan || null,
    approvals: task.approvals || [],
    pendingApprovalId: task.pendingApprovalId || null,
    disclosedPaths: task.disclosedPaths || [],
    changedFiles: task.changedFiles || [],
    changeCount: task.changeCount ?? (task.changedFiles ? task.changedFiles.length : 0),
    toolCallCount: task.toolCallCount ?? 0,
    iterations: task.runtimeResult?.iterations ?? task.iterations ?? null,
    provider: task.provider || null,
    usage: task.usage || null,
    costUsd: task.costUsd ?? null,
    attempts: task.attempts ?? null,
    rationale: task.rationale || null,
    runtimeResult: task.runtimeResult || null,
    verification: task.runtimeResult?.verification || task.verification || null,
    review: task.runtimeResult?.review || task.review || null,
    workspaceMode: task.workspaceMode || null,
    approvalPolicy: task.approvalPolicy || null,
    fallbackReason: task.fallbackReason || null,
    issue: task.issue || null,
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
    if (task.type === 'local-agent-runtime') {
      // PHASE 6 multi-turn runtime pipeline.
      task = await updateLocalAgentTask({ dataDir, taskId, patch: { startedAt: now() } })
      const outcome = await executeAgentRuntimeTask({
        task: { ...task, providerId },
        taskStore: {
          create: (args) => persistLocalAgentTask({ dataDir, task: args.task }),
          get: ({ taskId: id }) => getLocalAgentTask({ dataDir, taskId: id }),
          update: ({ taskId: id, patch, event }) => updateLocalAgentTask({ dataDir, taskId: id, patch, event }),
          list: () => listLocalAgentTasks({ dataDir })
        },
        dataDir,
        signal: controller.signal,
        options: {
          approvalPolicy: task.approvalPolicy || 'standard',
          workspaceMode: task.workspaceMode || 'auto',
          ...(task.maxIterations ? { maxIterations: task.maxIterations } : {}),
          ...(task.maxRepairAttempts ? { maxRepairAttempts: task.maxRepairAttempts } : {})
        },
        audit: (action, target, result, risk, detail) => audit({ get: () => undefined }, action, target, result, risk, detail)
      })
      if (outcome?.adapter && task.disposeWorkspaceAfterRun !== true) {
        // Keep the workspace for review, rollback and apply decisions.
      }
      return outcome
    }
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

// The local Agent queue runs different projects in parallel (bounded) while
// tasks for the SAME project stay strictly serial, so two agents never edit
// one project at once (PART 10.2/10.3) and a task paused on approval no
// longer blocks unrelated repositories (audit finding, fixed).
const LOCAL_AGENT_MAX_RUNNING = Math.min(Math.max(Number(process.env.NEXUS_LOCAL_AGENT_CONCURRENCY) || 2, 1), 4)
const localAgentActiveByProject = new Map()
let localAgentRunningCount = 0

async function pumpLocalAgentQueue() {
  if (shuttingDown) return
  while (localAgentQueue.length) {
    if (localAgentRunningCount >= LOCAL_AGENT_MAX_RUNNING) return
    const index = localAgentQueue.findIndex((item) => !localAgentActiveByProject.get(item.projectId))
    if (index === -1) return
    const [queued] = localAgentQueue.splice(index, 1)
    void runLocalAgentTask(queued).finally(() => queueMicrotask(() => void pumpLocalAgentQueue()))
  }
}

async function runLocalAgentTask(queued) {
  localAgentRunningCount += 1
  localAgentActiveByProject.set(queued.projectId, (localAgentActiveByProject.get(queued.projectId) || 0) + 1)
  const controller = new AbortController()
  localAgentControllers.set(queued.taskId, controller)
  try {
    await executeLocalAgentTask(queued.taskId, queued.providerId, controller)
  } finally {
    localAgentControllers.delete(queued.taskId)
    localAgentRunningCount -= 1
    const remaining = (localAgentActiveByProject.get(queued.projectId) || 1) - 1
    if (remaining <= 0) localAgentActiveByProject.delete(queued.projectId)
    else localAgentActiveByProject.set(queued.projectId, remaining)
  }
}

function enqueueLocalAgentTask(taskId, providerId, projectId) {
  localAgentQueue.push({ taskId, providerId, projectId })
  queueMicrotask(() => void pumpLocalAgentQueue())
}

// ---- PHASE 3: hosted-repository issue-fix queue ----
// Different repositories run in parallel (bounded); the same repository is
// strictly serial so two agents never touch one repo's code at once (PART 10).

const HOSTED_MAX_RUNNING = Math.min(Math.max(Number(process.env.NEXUS_HOSTED_TASK_CONCURRENCY) || 2, 1), 6)
const HOSTED_MAX_QUEUED = 16
const hostedPending = []
const hostedActive = new Map()
let hostedRunningCount = 0
let hostedPumpScheduled = false

function scheduleHostedPump() {
  if (hostedPumpScheduled) return
  hostedPumpScheduled = true
  queueMicrotask(() => {
    hostedPumpScheduled = false
    void pumpHostedTasks()
  })
}

async function pumpHostedTasks() {
  if (shuttingDown) return
  if (hostingPaused()) return
  while (hostedPending.length) {
    if (hostedRunningCount >= HOSTED_MAX_RUNNING) return
    const index = nextHostedJobIndex(hostedPending, hostedActive)
    if (index === -1) return
    const [item] = hostedPending.splice(index, 1)
    void runHostedIssueFix(item).finally(() => scheduleHostedPump())
  }
}

async function runHostedIssueFix(item) {
  return withExecutionPolicy({ assertAllowed: () => { assertTrustedRepository(item.project); if (!getHostingPolicy(item.project).enabled || hostingPaused()) throw Object.assign(new Error('Repository execution disabled or paused.'), { code: 'HOSTING_POLICY_FORBIDS_FIX' }) } }, () => runHostedIssueFixOwned(item))
}

async function runHostedIssueFixOwned(item) {
  const { project, issueNumber, repoKey } = item
  hostedRunningCount += 1
  hostedActive.set(repoKey, { project, issueNumber, taskId: null })
  const controller = new AbortController()
  hostedControllers.set(repoKey, controller)
  let repositoryLease = null
  const guardedRequest = (endpoint, options = {}) => {
    const operation = hostingOperation(endpoint, options)
    const guard = () => { if (shuttingDown) throw Object.assign(new Error('Host is stopping; no remote operation was started.'), { code: 'HOST_SHUTDOWN' }); return assertHostingWrite({ project, enabled: remoteWritesEnabled(), paused: hostingPaused(), operation }) }
    const perform = () => githubFetchForProject(project, endpoint, options)
    return operation && item.job ? durableEffect({ job: item.job, endpoint, options, save: saveState, guard, perform }) : perform()
  }
  const store = normalizeIssueStore(project)
  const entry = store.activity.find((candidate) => candidate.number === Number(issueNumber))
  if (entry) entry.fixState = 'running'
  project.hosting.currentTaskId = `pending:${repoKey}`
  try {
    repositoryLease = await acquireFileLease(path.join(dataDir, 'leases', `${repoKey}.lock`))
    if (item.job) { item.job.status = 'Running'; item.job.startedAt = now(); item.job.leaseToken = repositoryLease.token }
    await saveState()
    const token = await githubTokenForProject(project)
    if (!token) throw Object.assign(new Error('A GitHub token is required to run automated fixes.'), { code: 'GITHUB_NOT_CONFIGURED' })
    const policy = getHostingPolicy(project)
    assertTrustedRepository(project)
    const outcome = await runIssueFixPipeline({
      project,
      policy,
      issueNumber,
      classification: entry?.classification || null,
      comments: null,
      dataDir,
      request: guardedRequest,
      token,
      signal: controller.signal,
      helpers: {
        now,
        onCheckpoint: async (checkpoint) => { if (item.job) { item.job.checkpoint = structuredClone(checkpoint); item.job.executionStatus = checkpoint.status; item.job.outcome = structuredClone(checkpoint.delivery); await saveState() } },
        performPush: async (metadata, perform) => durableEffect({ job: item.job, endpoint: `git:${project.fullName}:${metadata.branch}:${metadata.commitSha}`, options: { body: JSON.stringify(metadata) }, save: saveState, guard: () => assertHostingWrite({ project, enabled: remoteWritesEnabled(), paused: hostingPaused(), operation: 'push' }), perform }),
        canWrite: (operation = 'push') => { assertHostingWrite({ project, enabled: remoteWritesEnabled(), paused: hostingPaused(), operation }); return true },
        audit: (action, target, result, risk, detail) => audit(item.req, action, target, result, risk, detail),
        onEvent: (event) => {
          if (item.job) { item.job.events.push({ ...event, at: now() }); item.job.events = item.job.events.slice(-500) }
          if (event.type === 'task_created' && event.metadata?.taskId) {
            hostedActive.get(repoKey).taskId = event.metadata.taskId
            project.hosting.currentTaskId = event.metadata.taskId
            if (entry) { entry.fixTaskId = event.metadata.taskId; entry.fixState = 'running' }
            void saveState().catch(() => {})
          }
        }
      }
    })
    // PHASE 6 delivery stage: merge → release → close, each gated by the
    // hosting policy and the genuine verification/review results (PART 8/9).
    if (outcome.status === 'Succeeded' && outcome.delivery?.pushed && remoteWritesEnabled() && getHostingPolicy(project).enabled) {
      const deliveryRequest = guardedRequest
      const deliveryPolicy = getHostingPolicy(project)
      outcome.delivery.merged = await maybeMergePullRequest({
        request: deliveryRequest, repository: project.fullName, pullRequest: outcome.delivery.pullRequest,
        policy: deliveryPolicy, verification: outcome.runtime.verification, review: outcome.runtime.review,
        signal: controller.signal
      }).catch((error) => ({ merged: false, reason: safeError(error) }))
      if (outcome.delivery.merged?.merged) {
        outcome.delivery.released = await maybePublishRelease({
          request: deliveryRequest, repository: project.fullName, token, policy: deliveryPolicy,
          issue: { number: outcome.issue.number, title: outcome.issue.title, url: outcome.issue.url, analysis: outcome.runtime.finalMessage },
          delivery: outcome.delivery, verification: outcome.runtime.verification, review: outcome.runtime.review,
          worktreePath: outcome.workspace.path, dataDir, signal: controller.signal,
          helpers: { onPlan: async (plan) => { if (item.job) { item.job.releasePlan = plan; await saveState() } }, beforeUpload: async (metadata, perform) => durableEffect({ job: item.job, endpoint: `upload:${metadata.releaseId}:${metadata.name}`, options: { body: JSON.stringify(metadata) }, save: saveState, guard: () => assertHostingWrite({ project, enabled: remoteWritesEnabled(), paused: hostingPaused(), operation: 'upload' }), perform }), onEvent: (event) => { void saveState().catch(() => {}) } }
        }).catch((error) => ({ published: false, reason: safeError(error) }))
        if (outcome.delivery.released?.published) {
          project.latestRelease = { tag_name: outcome.delivery.released.tag, html_url: outcome.delivery.released.releaseUrl, publishedAt: now() }
        }
      }
      // Post the actual final delivery outcome before considering closure.
      outcome.delivery.issueCommented = false
      const report = [
        `PROJECT NEXUS delivery report for issue #${issueNumber}.`,
        `PR: ${outcome.delivery.pullRequest?.url || 'not created'}`,
        `Commit: ${outcome.delivery.commitSha}`,
        `Tests: ${outcome.runtime.verification?.summary || 'not verified'}`,
        `Review: ${outcome.runtime.review?.verdict || 'not verified'}`,
        `Merge: ${outcome.delivery.merged?.merged ? 'confirmed' : outcome.delivery.merged?.reason || 'not merged'}`,
        `Release: ${outcome.delivery.released?.published ? outcome.delivery.released.releaseUrl : outcome.delivery.released?.reason || 'not published'}`
      ].join('\n\n')
      const reply = await createIssueComment(deliveryRequest, project.fullName, issueNumber, redactSecrets(report))
      outcome.delivery.issueCommented = true
      outcome.delivery.issueCommentUrl = reply.html_url || null
      outcome.delivery.closed = await maybeCloseIssue({
        request: deliveryRequest, repository: project.fullName, issueNumber, policy: deliveryPolicy,
        delivery: outcome.delivery, verification: outcome.runtime.verification, review: outcome.runtime.review,
        signal: controller.signal
      }).catch((error) => ({ closed: false, reason: safeError(error) }))
    }
    const resultState = hostedResult(outcome, policy)
    if (entry) {
      entry.fixState = resultState.status.toLowerCase()
      entry.executionStatus = resultState.executionStatus
      entry.deliveryStatus = resultState.deliveryStatus
      entry.fixTaskId = outcome.taskId
      entry.fixSummary = {
        changedPaths: outcome.changedPaths,
        branch: outcome.delivery?.branch || null,
        pullRequest: outcome.delivery?.pullRequest || null,
        issueCommented: Boolean(outcome.delivery?.issueCommented),
        verification: outcome.runtime?.verification?.summary || null,
        skippedReason: outcome.delivery?.skippedReason || null,
        merged: outcome.delivery?.merged ? { merged: Boolean(outcome.delivery.merged.merged), reason: outcome.delivery.merged.reason || null } : null,
        released: outcome.delivery?.released ? { published: Boolean(outcome.delivery.released.published), tag: outcome.delivery.released.tag || null, releaseUrl: outcome.delivery.released.releaseUrl || null, assets: outcome.delivery.released.assets?.length || 0, reason: outcome.delivery.released.reason || null } : null,
        issueClosed: outcome.delivery?.closed ? { closed: Boolean(outcome.delivery.closed.closed), reason: outcome.delivery.closed.reason || null } : null
      }
    }
    if (item.job) { Object.assign(item.job, resultState); item.job.outcome = outcome.delivery; item.job.taskId = outcome.taskId }
    outcome.status = resultState.status
    project.hosting.lastOutcome = { runId: outcome.taskId, status: outcome.status, issueNumber, at: now() }
    audit(item.req, 'issue_fix_pipeline_finished', `${project.fullName}#${issueNumber}`, outcome.status.toLowerCase(), 'high', {
      taskId: outcome.taskId,
      changedFiles: outcome.changedPaths?.length || 0,
      pullRequest: outcome.delivery?.pullRequest?.number || null,
      pushed: Boolean(outcome.delivery?.pushed),
      merged: Boolean(outcome.delivery?.merged?.merged),
      releasedTag: outcome.delivery?.released?.tag || null,
      issueClosed: Boolean(outcome.delivery?.closed?.closed)
    })
    state.activity.unshift({ id: id('activity'), type: 'issue-fix', message: `Issue fix for ${project.fullName}#${issueNumber}: ${outcome.status.toLowerCase()}${outcome.delivery?.pullRequest ? ` (PR #${outcome.delivery.pullRequest.number})` : ''}`, at: now() })
    state.activity = state.activity.slice(0, 100)
  } catch (error) {
    if (item.job) { item.job.status = 'Blocked'; item.job.executionStatus ||= 'Blocked'; item.job.deliveryStatus = item.job.operations?.length || item.job.executionStatus === 'Succeeded' ? 'Incomplete' : 'NotStarted'; item.job.error = safeError(error) }
    if (entry) {
      entry.fixState = error.code === 'GITHUB_NOT_CONFIGURED' || error.code === 'AI_NOT_CONFIGURED' || error.code === 'HOSTING_POLICY_FORBIDS_FIX' ? 'blocked' : 'failed'
      entry.fixSummary = { error: safeError(error) }
    }
    project.hosting.lastOutcome = { status: entry?.fixState || 'failed', issueNumber, error: safeError(error), at: now() }
    audit(item.req, 'issue_fix_pipeline_finished', `${project.fullName}#${issueNumber}`, 'failed', 'high', { code: error.code || null, error: safeError(error) })
    state.activity.unshift({ id: id('activity'), type: 'issue-fix', message: `Issue fix for ${project.fullName}#${issueNumber} failed: ${safeError(error).slice(0, 200)}`, at: now() })
    state.activity = state.activity.slice(0, 100)
  } finally {
    hostedControllers.delete(repoKey)
    await repositoryLease?.release().catch(() => {})
    hostedRunningCount -= 1
    hostedActive.delete(repoKey)
    project.hosting.currentTaskId = null
    if (item.job) item.job.finishedAt = now()
    await saveState().catch(() => {})
  }
}

async function enqueueIssueFixTask({ project, issueNumber, source = 'manual', req = null, classification = null, comments = null } = {}) {
  const repoKey = repoKeyFor(project.fullName)
  const policy = getHostingPolicy(project)
  if (!policy.enabled || policy.strategy === 'observe') {
    throw Object.assign(new Error('Enable repository hosting with a maintain or autonomous strategy before triggering automated fixes.'), { code: 'HOSTING_POLICY_FORBIDS_FIX' })
  }
  const queued = queueHostedJob(state, { projectId: project.id, repository: project.fullName, issueNumber: Number(issueNumber), source, priority: classification?.severity })
  if (queued.reused) return { queued: true, reused: true, jobId: queued.job.id, issueNumber: Number(issueNumber), repository: project.fullName }
  const store = normalizeIssueStore(project)
  const entry = store.activity.find((candidate) => candidate.number === Number(issueNumber))
  if (entry) entry.fixState = 'queued'
  const item = { repoKey, project, issueNumber: Number(issueNumber), classification, comments, source, job: queued.job, req: req || { get: () => undefined } }
  hostedPending.push(item)
  audit(req, 'issue_fix_queued', `${project.fullName}#${issueNumber}`, 'queued', 'high', { source, strategy: policy.strategy })
  await saveState()
  scheduleHostedPump()
  return { queued: true, jobId: queued.job.id, issueNumber: Number(issueNumber), repository: project.fullName }
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

// Resume durable queued work; interrupted side effects require reconciliation.
async function recoverHostedFixTasks() {
  for (const project of state.projects) if (project.hosting) project.hosting.currentTaskId = null
  const queued = recoverHostedJobs(state)
  for (const job of queued) {
    const project = state.projects.find((item) => item.id === job.projectId)
    if (!project || !getHostingPolicy(project).enabled) { job.status = 'Blocked'; continue }
    hostedPending.push({ repoKey: repoKeyFor(project.fullName), project, issueNumber: job.issueNumber, job, req: { get: () => undefined } })
  }
  await saveState()
  scheduleHostedPump()
}

// PART 18: workspace garbage collection. Finished task worktrees older than
// NEXUS_WORKSPACE_RETENTION_DAYS (default 14) are removed; task records,
// diffs and events are kept as evidence. Only NEXUS-managed paths are touched.
const WORKSPACE_RETENTION_MS = Math.max(Number(process.env.NEXUS_WORKSPACE_RETENTION_DAYS || 14), 1) * 24 * 60 * 60 * 1000

async function sweepExpiredWorkspaces() {
  const nowMs = Date.now()
  const tasks = await listLocalAgentTasks({ dataDir })
  const finalStatuses = ['Succeeded', 'Failed', 'Cancelled', 'Blocked', 'TimedOut']
  let swept = 0
  for (const task of tasks) {
    if (!finalStatuses.includes(task.status) || !task.workspace?.id || task.workspace.id !== task.id) continue
    // Age alone is not permission to discard a user's unapplied fix or failed
    // task evidence. Automatic cleanup requires an explicit cleanup receipt.
    if (!task.cleanupApprovedAt) continue
    const finishedAt = new Date(task.finishedAt || task.updatedAt || 0).getTime()
    if (!finishedAt || nowMs - finishedAt < WORKSPACE_RETENTION_MS) continue
    try {
      if (task.type === 'issue-fix-runtime' && task.issue?.repository) {
        const { disposeRepoWorktree } = await import('./services/repo-workspace.mjs')
        await disposeRepoWorktree({ dataDir, fullName: task.issue.repository, taskId: task.id, branch: task.workspace.branch || null })
      } else if (task.workspace.mode === 'worktree') {
        const handle = agentWorkspaceHandleFor(task, dataDir)
        if (!handle) continue
        await fs.rm(handle.root, { recursive: true, force: true })
        if (handle.branch) {
          const { runCommand } = await import('./services/agent/executor.mjs')
          const project = (await listLocalProjects({ dataDir })).find((item) => item.id === task.projectId)
          if (project?.available) {
            // The branch is one NEXUS created itself (nexus-agent/<taskId>); the
            // name is validated before use and the command is tokenized without
            // a shell by the executor.
            const safeBranch = String(handle.branch).replace(/[^A-Za-z0-9._\/-]/g, '')
            await runCommand({ cwd: project.path, command: `git branch -D ${safeBranch}`, timeoutMs: 20_000 }).catch(() => null)
          }
        }
      }
      swept += 1
      await updateLocalAgentTask({ dataDir, taskId: task.id, patch: {}, event: { type: 'workspace_swept', detail: `Expired workspace was garbage collected after retention (${Math.round(WORKSPACE_RETENTION_MS / 86400000)} days).` } })
    } catch { /* GC is best-effort; task records stay intact */ }
  }
  if (swept) {
    state.activity.unshift({ id: id('activity'), type: 'workspace-gc', message: `Garbage collected ${swept} expired task workspace(s).`, at: now() })
    state.activity = state.activity.slice(0, 100)
    await saveState().catch(() => {})
  }
  return swept
}

async function createAndQueueLocalAgentTask({ projectId, prompt, providerId, req, taskType = 'local-agent', approvalPolicy = 'standard', workspaceMode = 'auto' }) {
  const projects = await listLocalProjects({ dataDir })
  const project = projects.find((item) => item.id === projectId && item.available)
  if (!project) throw Object.assign(new Error('Choose a registered local project that is still available.'), { code: 'LOCAL_PROJECT_NOT_AVAILABLE' })

  // Provider resolution: the persistent provider registry (desktop) wins; the
  // legacy env-configured providers remain the fallback for server deployments.
  const runtimeProviders = await listPublicProviders({ dataDir })
  const runtimeConfigured = runtimeProviders.filter((item) => item.configured)
  const envProviders = listAIProviders()
  const envConfigured = envProviders.filter((item) => item.configured)
  const selected = providerId
    ? runtimeConfigured.find((item) => item.id === providerId) || envConfigured.find((item) => item.id === providerId)
    : runtimeConfigured[0] || envConfigured[0]
  if (!selected) throw Object.assign(new Error('Configure an AI provider with an API key and model before starting an Agent task.'), { code: 'AI_NOT_CONFIGURED' })

  if (localAgentQueue.length + localAgentControllers.size >= LOCAL_AGENT_MAX_QUEUED_TASKS) {
    throw Object.assign(new Error(`The local Agent queue is limited to ${LOCAL_AGENT_MAX_QUEUED_TASKS} pending tasks.`), { code: 'LOCAL_AGENT_QUEUE_FULL' })
  }
  const safePrompt = redactSecrets(prompt.trim())
  const taskId = `nexus_agent_${crypto.randomUUID()}`
  const policy = APPROVAL_POLICIES.includes(approvalPolicy) ? approvalPolicy : 'standard'
  const mode = ['auto', 'worktree', 'copy'].includes(workspaceMode) ? workspaceMode : 'auto'
  const task = await persistLocalAgentTask({
    dataDir,
    task: {
      id: taskId,
      type: taskType,
      label: safePrompt.split(/\r?\n/)[0].slice(0, 120) || 'Local Agent task',
      projectId: project.id,
      projectName: project.name,
      prompt: safePrompt,
      providerId: selected.id,
      status: 'Queued',
      approvalPolicy: policy,
      workspaceMode: mode,
      sourceDisclosureConfirmedAt: now(),
      disclosedPaths: [],
      changedFiles: []
    }
  })
  audit(req, 'local_agent_task_created', `${project.name} (${project.id})`, 'queued', 'medium', { taskId, providerId: selected.id, taskType, approvalPolicy: policy, workspaceMode: mode, sourceDisclosureConfirmed: true })
  await saveState()
  enqueueLocalAgentTask(taskId, selected.id, project.id)
  return { task, provider: selected }
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
  if (shuttingDown) return
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

// PHASE 2: autonomous hosting tick — light inspections + issue monitoring for
// every repository whose hosting policy is enabled and due. Repositories run
// in parallel up to NEXUS_HOSTING_CONCURRENCY (default 2); each repository is
// processed by exactly one worker at a time (PART 10).
let hostingTickRunning = false
async function runScheduledHostingTick() {
  if (shuttingDown) return
  if (hostingTickRunning) return
  hostingTickRunning = true
  try {
    const due = hostingDueProjects()
    if (!due.length) return
    const limit = Math.min(Math.max(Number(process.env.NEXUS_HOSTING_CONCURRENCY) || 2, 1), 6)
    let index = 0
    const researchCandidates = []
    const workers = Array.from({ length: Math.min(limit, due.length) }, async () => {
      while (index < due.length) {
        const { project } = due[index++]
        try {
          const run = await runHostingInspection(project, { depth: 'light' })
          if (run.status === 'Success' && true) {
            await syncProjectIssues(project, { request: (endpoint, options) => githubFetchForProject(project, endpoint, options) })
          }
          // PHASE 5: weekly competitor research for actively hosted repos.
          const policy = getHostingPolicy(project)
          const lastResearch = project.research?.lastRunAt ? new Date(project.research.lastRunAt).getTime() : 0
          if (policy.enabled && policy.strategy !== 'observe' && Date.now() - lastResearch > 7 * 24 * 60 * 60 * 1000) {
            researchCandidates.push(project)
          }
        } catch (error) {
          console.error(`Hosting tick failed for ${project.fullName}:`, safeError(error))
        }
      }
    })
    await Promise.all(workers)
    if (researchCandidates.length && process.env.GITHUB_TOKEN) {
      try {
        await runProjectResearch(researchCandidates[0], {})
        state.activity.unshift({ id: id('activity'), type: 'research', message: `Weekly competitor research completed for ${researchCandidates[0].fullName}`, at: now() })
        state.activity = state.activity.slice(0, 100)
      } catch (error) {
        console.error(`Scheduled research failed for ${researchCandidates[0].fullName}:`, safeError(error))
      }
    }
    await saveState()
  } catch (error) {
    console.error('Hosting schedule tick failed:', safeError(error))
  } finally { hostingTickRunning = false }
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

app.get('/api/local-agent/config', async (_req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  const providers = await listPublicProviders({ dataDir })
  const legacyProviders = listAIProviders()
  const configured = providers.some((provider) => provider.configured) || legacyProviders.some((provider) => provider.configured)
  res.json({
    configured,
    defaultProviderId: providers.find((provider) => provider.configured)?.id || legacyProviders.find((provider) => provider.configured)?.id || null,
    providers,
    legacyProviders,
    approvalPolicies: APPROVAL_POLICIES,
    taskTypes: ['local-agent-runtime', 'local-agent'],
    limits: { maxPromptBytes: LOCAL_AGENT_MAX_PROMPT_BYTES, maxContextFiles: 24, maxContextBytes: 120 * 1024, maxIterations: 40, maxRepairAttempts: 4 },
    capabilities: {
      isolatedWorkspace: true,
      workspaceModes: ['auto', 'worktree', 'copy'],
      originalProjectWrites: 'explicit-apply-only',
      commandExecution: true,
      commandAllowlist: true,
      buildAndTest: true,
      gitApply: true,
      gitPush: false,
      multiTurnRuntime: true,
      approvals: true,
      rollback: true,
      projectInsights: true,
      costTracking: true
    }
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
  const taskType = req.body?.taskType === 'local-agent-runtime' ? 'local-agent-runtime' : 'local-agent'
  const approvalPolicy = typeof req.body?.approvalPolicy === 'string' ? req.body.approvalPolicy : 'standard'
  const workspaceMode = typeof req.body?.workspaceMode === 'string' ? req.body.workspaceMode : 'auto'
  if (!projectId || !/^[0-9a-f-]{36}$/i.test(projectId)) return res.status(400).json({ code: 'LOCAL_PROJECT_ID_INVALID', message: 'Choose a registered local project.' })
  if (!prompt.trim()) return res.status(400).json({ code: 'AI_PROMPT_REQUIRED', message: 'Enter a task request.' })
  if (Buffer.byteLength(prompt, 'utf8') > LOCAL_AGENT_MAX_PROMPT_BYTES) return res.status(413).json({ code: 'AI_PROMPT_TOO_LARGE', message: `Task prompts are limited to ${LOCAL_AGENT_MAX_PROMPT_BYTES} bytes.` })
  if (providerId === '') return res.status(400).json({ code: 'AI_PROVIDER_INVALID', message: 'Choose a configured provider.' })
  try {
    const { task, provider } = await createAndQueueLocalAgentTask({ projectId, prompt, providerId, req, taskType, approvalPolicy, workspaceMode })
    res.status(202).json({ task: localAgentPublicTask(task), provider: { id: provider.id, kind: provider.kind, host: provider.host || null, model: provider.model } })
  } catch (error) { res.status(localAgentErrorStatus(error)).json({ code: error.code || 'LOCAL_AGENT_TASK_CREATE_FAILED', message: safeError(error) }) }
})

app.get('/api/local-agent/tasks/:taskId', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const task = await getLocalAgentTask({ dataDir, taskId: req.params.taskId })
    if (!task) return res.status(404).json({ code: 'LOCAL_AGENT_TASK_NOT_FOUND', message: 'Local Agent task was not found.' })
    let changes = []
    let changesError = null
    if (task.workspace?.id && !['Queued', 'Running'].includes(task.status)) {
      if (task.type === 'local-agent-runtime' && task.workspace.mode) {
        // Runtime workspaces live under agent-workspaces/agent (worktree or copy).
        try {
          const { listRuntimeTaskChanges } = await import('./services/agent/task-executor.mjs')
          const result = await listRuntimeTaskChanges({ task, dataDir })
          changes = result.changes
          changesError = result.error
        } catch (error) { changesError = safeError(error) }
      } else {
        const workspace = localAgentWorkspaceHandle(task)
        if (workspace) {
          try { changes = await listLocalAgentChanges(workspace) }
          catch (error) { changesError = safeError(error) }
        }
      }
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
    const { task, provider } = await createAndQueueLocalAgentTask({
      projectId: previous.projectId,
      prompt: previous.prompt,
      providerId: previous.providerId,
      req,
      taskType: previous.type === 'local-agent-runtime' ? 'local-agent-runtime' : 'local-agent',
      approvalPolicy: previous.approvalPolicy || 'standard',
      workspaceMode: previous.workspaceMode || 'auto'
    })
    return res.status(202).json({ task: localAgentPublicTask(task), provider: { id: provider.id, kind: provider.kind, host: provider.host || null, model: provider.model } })
  } catch (error) { return res.status(localAgentErrorStatus(error)).json({ code: error.code || 'LOCAL_AGENT_TASK_RETRY_FAILED', message: safeError(error) }) }
})

// ---- PHASE 6: provider registry, approvals, rollback, apply, insights ----

function providerErrorStatus(error) {
  if (['PROVIDER_NOT_CONFIGURED'].includes(error.code)) return 424
  if (['PROVIDER_STORE_LIMIT', 'PROVIDER_DUPLICATE_ID'].includes(error.code)) return 409
  if (['PROVIDER_ID_INVALID', 'PROVIDER_NAME_INVALID', 'PROVIDER_KIND_INVALID', 'PROVIDER_BASE_URL_INVALID', 'PROVIDER_MODEL_INVALID', 'PROVIDER_MODELS_INVALID', 'PROVIDER_INVALID', 'PROVIDER_KEYS_INVALID'].includes(error.code)) return 400
  return 500
}

app.get('/api/local-agent/providers', async (_req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const providers = await listPublicProviders({ dataDir })
    res.json({ providers, defaultProviderId: providers.find((provider) => provider.configured)?.id || null })
  } catch (error) { res.status(providerErrorStatus(error)).json({ code: error.code || 'PROVIDERS_FAILED', message: safeError(error) }) }
})

app.post('/api/local-agent/providers', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const provider = await createProviderRecord({ dataDir, provider: req.body })
    audit(req, 'provider_created', provider.id, 'success', 'medium', {})
    res.status(201).json({ provider })
  } catch (error) { res.status(providerErrorStatus(error)).json({ code: error.code || 'PROVIDER_CREATE_FAILED', message: safeError(error) }) }
})

app.patch('/api/local-agent/providers/:providerId', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const provider = await updateProviderRecord({ dataDir, providerId: req.params.providerId, patch: req.body })
    if (!provider) return res.status(404).json({ code: 'PROVIDER_NOT_FOUND', message: 'Provider was not found.' })
    res.json({ provider })
  } catch (error) { res.status(providerErrorStatus(error)).json({ code: error.code || 'PROVIDER_UPDATE_FAILED', message: safeError(error) }) }
})

app.delete('/api/local-agent/providers/:providerId', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const result = await deleteProviderRecord({ dataDir, providerId: req.params.providerId })
    if (!result.deleted) return res.status(404).json({ code: 'PROVIDER_NOT_FOUND', message: 'Provider was not found.' })
    audit(req, 'provider_deleted', req.params.providerId, 'success', 'medium', {})
    res.json(result)
  } catch (error) { res.status(providerErrorStatus(error)).json({ code: error.code || 'PROVIDER_DELETE_FAILED', message: safeError(error) }) }
})

app.post('/api/local-agent/providers/:providerId/test', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const result = await testProviderRecord({ dataDir, providerId: req.params.providerId, timeoutMs: Number(req.body?.timeoutMs) || undefined })
    audit(req, 'provider_tested', req.params.providerId, result.ok ? 'success' : 'failure', 'low', { latencyMs: result.latencyMs })
    res.json(result)
  } catch (error) { res.status(providerErrorStatus(error)).json({ code: error.code || 'PROVIDER_TEST_FAILED', message: safeError(error) }) }
})

// Provider API keys arrive only from the Electron main process (decrypted from
// Windows DPAPI via safeStorage) over the authenticated local loopback API.
app.post('/api/local-agent/provider-keys', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const result = setRuntimeProviderKeys(req.body?.keys)
    audit(req, 'provider_keys_synced', Object.keys(req.body?.keys || {}).join(','), 'success', 'high', { count: result.ids.length })
    res.json({ synced: result.ids })
  } catch (error) { res.status(400).json({ code: error.code || 'PROVIDER_KEYS_INVALID', message: safeError(error) }) }
})

app.post('/api/local-agent/tasks/:taskId/approvals/:approvalId/resolve', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  const decision = req.body?.decision === 'approved' ? 'approved' : req.body?.decision === 'denied' ? 'denied' : null
  if (!decision) return res.status(400).json({ code: 'APPROVAL_DECISION_INVALID', message: 'Decision must be approved or denied.' })
  try {
    const task = await getLocalAgentTask({ dataDir, taskId: req.params.taskId })
    if (!task) return res.status(404).json({ code: 'LOCAL_AGENT_TASK_NOT_FOUND', message: 'Local Agent task was not found.' })
    const resolved = resolveApprovalInTask(task, req.params.approvalId, decision, 'user')
    if (!resolved) return res.status(409).json({ code: 'APPROVAL_NOT_PENDING', message: 'This approval is not pending.' })
    const patch = { approvals: task.approvals }
    if (task.pendingApprovalId === resolved.id) patch.pendingApprovalId = null
    const updated = await updateLocalAgentTask({ dataDir, taskId: task.id, patch, event: { type: 'approval_resolved', detail: `${resolved.tool} ${decision} by the user.`, metadata: { approvalId: resolved.id, decision } } })
    audit(req, 'approval_resolved', `${task.id}/${resolved.id}`, decision === 'approved' ? 'success' : 'blocked', 'high', { tool: resolved.tool, decision })
    res.json({ task: localAgentPublicTask(updated) })
  } catch (error) { res.status(400).json({ code: error.code || 'APPROVAL_RESOLVE_FAILED', message: safeError(error) }) }
})

app.post('/api/local-agent/tasks/:taskId/rollback', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const task = await getLocalAgentTask({ dataDir, taskId: req.params.taskId })
    if (!task) return res.status(404).json({ code: 'LOCAL_AGENT_TASK_NOT_FOUND', message: 'Local Agent task was not found.' })
    if (['Queued', 'Running'].includes(task.status)) return res.status(409).json({ code: 'LOCAL_AGENT_TASK_ACTIVE', message: 'Wait for the task to finish before rolling it back.' })
    const result = await rollbackAgentTask({ task, dataDir })
    await updateLocalAgentTask({ dataDir, taskId: task.id, patch: {}, event: { type: 'rolled_back', detail: `Workspace rolled back (${result.mode}). No project files were touched.`, metadata: { workspace: result.workspace, mode: result.mode } } })
    audit(req, 'agent_task_rolled_back', task.id, 'success', 'medium', { mode: result.mode })
    res.json(result)
  } catch (error) {
    const status = error.code === 'AGENT_WORKSPACE_MISSING' || error.code === 'AGENT_WORKSPACE_GONE' ? 404 : 400
    res.status(status).json({ code: error.code || 'AGENT_ROLLBACK_FAILED', message: safeError(error) })
  }
})

app.post('/api/local-agent/tasks/:taskId/apply', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const task = await getLocalAgentTask({ dataDir, taskId: req.params.taskId })
    if (!task) return res.status(404).json({ code: 'LOCAL_AGENT_TASK_NOT_FOUND', message: 'Local Agent task was not found.' })
    if (['Queued', 'Running'].includes(task.status)) return res.status(409).json({ code: 'LOCAL_AGENT_TASK_ACTIVE', message: 'Wait for the task to finish before applying its changes.' })
    const result = await applyAgentTaskToProject({ task, dataDir, confirm: req.body?.confirm === true })
    if (result.applied) {
      await updateLocalAgentTask({ dataDir, taskId: task.id, patch: {}, event: { type: 'applied_to_project', detail: result.note, metadata: { appliedPaths: result.appliedPaths } } })
      audit(req, 'agent_task_applied', `${task.projectName} (${task.projectId})`, 'success', 'high', { appliedPaths: result.appliedPaths })
    }
    res.json(result)
  } catch (error) {
    const status = error.code === 'AGENT_APPLY_DIRTY_PROJECT' ? 409 : error.code === 'AGENT_APPLY_CONFIRMATION_REQUIRED' ? 400 : 400
    res.status(status).json({ code: error.code || 'AGENT_APPLY_FAILED', message: safeError(error) })
  }
})

app.post('/api/local-agent/projects/:projectId/insights', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  try {
    const projects = await listLocalProjects({ dataDir })
    const project = projects.find((item) => item.id === req.params.projectId && item.available)
    if (!project) return res.status(404).json({ code: 'LOCAL_PROJECT_NOT_AVAILABLE', message: 'The local project is not registered or available.' })
    const cacheFile = path.join(dataDir, 'agent-indexes', `${project.id}.json`)
    const built = await buildProjectIndex({ root: project.path, cacheFile })
    const { index } = built
    const insights = {
      projectId: project.id,
      projectName: project.name,
      cached: built.cached,
      reindexed: built.reindexed,
      changedFiles: built.changed.slice(0, 50),
      stats: index.stats,
      languages: index.files.reduce((counts, file) => {
        if (file.language) counts[file.language] = (counts[file.language] || 0) + 1
        return counts
      }, {}),
      manifests: (index.manifests || []).map((manifest) => ({ path: manifest.path, kind: manifest.kind, name: manifest.name || null, scripts: manifest.scripts || null, dependencies: manifest.dependencies || null })),
      entryPoints: index.entryPoints,
      testPaths: (index.testPaths || []).slice(0, 40),
      routeCandidates: (index.routeCandidates || []).slice(0, 20),
      apiCandidates: (index.apiCandidates || []).slice(0, 20),
      topSymbols: Object.entries(index.symbols || {}).slice(0, 40).map(([filePath, symbols]) => ({ path: filePath, symbols: symbols.slice(0, 8) }))
    }
    audit(req, 'project_insights_built', `${project.name} (${project.id})`, 'success', 'low', { files: index.stats.files, cached: built.cached })
    res.json(insights)
  } catch (error) { res.status(500).json({ code: error.code || 'PROJECT_INSIGHTS_FAILED', message: safeError(error) }) }
})

// ---- PHASE 1: repository hosting (policy, on-demand workspace, inspection) ----

function normalizeRepoMeta(meta, project) {
  return {
    defaultBranch: String(meta?.defaultBranch || project?.defaultBranch || 'main'),
    language: meta?.language || project?.language || null,
    pushedAt: meta?.pushedAt || null,
    openIssues: Number.isFinite(Number(meta?.openIssues)) ? Number(meta.openIssues) : null,
    topics: Array.isArray(meta?.topics) ? meta.topics.slice(0, 20) : [],
    visibility: meta?.visibility || null,
    archived: meta?.archived === true,
    headSha: meta?.headSha || null,
    lastSyncedAt: meta?.lastSyncedAt || null
  }
}

function hostingFinding(key, priority, summary, detail = null) {
  return { key, priority, summary: String(summary).slice(0, 400), detail: detail ? String(detail).slice(0, 1000) : null }
}

async function runHostingLightScan(project, { signal } = {}) {
  const repo = await githubFetchForProject(project, `/repos/${repoFromProject(project)}`, { signal })
  const defaultBranch = repo.default_branch || project.defaultBranch || 'main'
  const previousMeta = normalizeRepoMeta(project.repoMeta, project)
  const head = await githubFetchForProject(project, `/repos/${repoFromProject(project)}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, { signal }).catch(() => null)
  const meta = normalizeRepoMeta({
    defaultBranch,
    language: repo.language,
    pushedAt: repo.pushed_at,
    openIssues: repo.open_issues_count,
    topics: repo.topics,
    visibility: repo.visibility,
    archived: repo.archived,
    headSha: head?.object?.sha || null,
    lastSyncedAt: now()
  }, project)
  const findings = []
  if (meta.pushedAt && (!previousMeta.pushedAt || new Date(meta.pushedAt) > new Date(previousMeta.pushedAt))) {
    findings.push(hostingFinding('new_commits', 'P2', `Repository pushed updates at ${meta.pushedAt}`, `previous: ${previousMeta.pushedAt || 'never synced'}`))
  }
  if (previousMeta.openIssues !== null && meta.openIssues > previousMeta.openIssues) {
    findings.push(hostingFinding('open_issues_increased', 'P2', `Open issue count rose from ${previousMeta.openIssues} to ${meta.openIssues}`))
  }
  if (meta.headSha && previousMeta.headSha && meta.headSha !== previousMeta.headSha) {
    findings.push(hostingFinding('default_branch_moved', 'P3', `Default branch ${defaultBranch} moved to ${meta.headSha.slice(0, 12)}`))
  }
  if (meta.archived) {
    findings.push(hostingFinding('repo_archived', 'P1', 'The repository is archived on GitHub; autonomous maintenance should be paused.'))
  }
  project.repoMeta = meta
  return { meta, findings, repo }
}

async function runHostingInspection(project, { depth = 'light', req = null, signal } = {}) {
  const startedAt = now()
  const runId = id('hosting')
  const policy = getHostingPolicy(project)
  const run = { id: runId, projectId: project.id, repository: project.fullName, depth, status: 'Running', findings: [], startedAt, finishedAt: null, error: null, triggeredBy: req ? currentRole(req) : 'scheduler' }
  recordHostingRun(state, run)
  project.hosting = { ...(project.hosting || defaultHostingPolicy()), ...policy, currentTaskId: project.hosting?.currentTaskId || null }
  await saveState()
  try {
    if (!projectGithubConfigured(project)) throw Object.assign(new Error('Configure GITHUB_TOKEN or a GitHub App installation before inspecting this repository.'), { code: 'GITHUB_NOT_CONFIGURED' })
    const { findings, meta } = await runHostingLightScan(project, { signal })
    run.findings = findings
    if (depth === 'full') {
      const queued = await enqueueIntegrationScan(project, req || { get: () => undefined })
      run.integrationJobId = queued.job.id
      run.findings.push(hostingFinding('update_scan_queued', 'P4', `Update-capability scan queued (${queued.job.id})`))
      // PHASE 4: genuine security pass over the managed cache clone.
      try {
        const token = await githubTokenForProject(project)
        const cache = await ensureRepoCache({ dataDir, fullName: project.fullName, token, branch: meta.defaultBranch, signal })
        const scan = await runSecurityScan({ root: cache.path, signal })
        project.securitySummary = { lastScanAt: scan.scannedAt, status: scan.status, counts: scan.counts, dependencyAuditRan: scan.dependencyAuditRan, topFindings: scan.findings.slice(0, 10) }
        run.securityStatus = scan.status
        for (const finding of scan.findings.slice(0, 20)) {
          state.securityFindings.unshift({ id: id('sec'), projectId: project.id, repository: project.fullName, scanId: run.id, ...finding, recordedAt: now() })
        }
        state.securityFindings = state.securityFindings.slice(0, 1000)
        run.findings.push(hostingFinding('security_scan', scan.status === 'CLEAN' ? 'P4' : 'P2', `Security scan ${scan.status.toLowerCase()} (${scan.counts.P0} P0, ${scan.counts.P1} P1, ${scan.counts.P2} P2, ${scan.counts.P3} P3)`))
      } catch (scanError) {
        run.findings.push(hostingFinding('security_scan_failed', 'P3', `Security scan failed: ${safeError(scanError).slice(0, 200)}`))
      }
    }
    run.status = 'Success'
    project.hosting.lastInspectionAt = startedAt
    project.hosting.lastOutcome = { runId: run.id, status: run.status, findings: summarizeFindings(run.findings), at: now() }
    if (depth === 'light') project.hosting.lastLightScanAt = startedAt
    else project.hosting.lastFullScanAt = startedAt
  } catch (error) {
    run.status = error.code === 'GITHUB_NOT_CONFIGURED' ? 'Blocked' : error.code === 'JOB_CANCELLED' ? 'Cancelled' : 'Failed'
    run.error = safeError(error)
    project.hosting.lastOutcome = { runId: run.id, status: run.status, error: run.error, at: now() }
  } finally {
    run.finishedAt = now()
    state.activity.unshift({ id: id('activity'), type: 'hosting-inspection', message: `${depth} inspection ${run.status.toLowerCase()} for ${project.fullName} (${run.findings.length} finding(s))`, at: now() })
    state.activity = state.activity.slice(0, 100)
    await saveState()
  }
  return run
}

function hostingPaused() {
  return state.settings.hostingPaused === true
}

function hostingDueProjects() {
  if (hostingPaused()) return []
  const due = []
  for (const project of state.projects) {
    const policy = getHostingPolicy(project)
    if (!policy.enabled) continue
    if (project.hosting?.currentTaskId) continue // one active task per repository (PART 10.2)
    const last = project.hosting?.lastInspectionAt || null
    const dueAt = last ? new Date(last).getTime() + policy.intervalMinutes * 60 * 1000 : 0
    if (dueAt <= Date.now()) due.push({ project, policy })
  }
  return due
}

// ---- PHASE 2: issue monitoring, classification and event-driven triggers ----

const ISSUE_ACTIVITY_LIMIT = 200
const ISSUE_KNOWN_LIMIT = 500
const MAX_ISSUE_CLASSIFICATIONS_PER_SYNC = 5
const AUTO_LABEL_PREFIX = 'nexus'

function normalizeIssueStore(project) {
  if (!project.issues || typeof project.issues !== 'object') project.issues = { lastSyncedAt: null, activity: [], known: {} }
  if (!Array.isArray(project.issues.activity)) project.issues.activity = []
  if (!project.issues.known || typeof project.issues.known !== 'object') project.issues.known = {}
  return project.issues
}

function rememberIssueSeen(store, issue) {
  store.known[String(issue.number)] = { updatedAt: issue.updated_at || null, state: issue.state || 'open' }
  const keys = Object.keys(store.known)
  if (keys.length > ISSUE_KNOWN_LIMIT) {
    for (const key of keys.slice(0, keys.length - ISSUE_KNOWN_LIMIT)) delete store.known[key]
  }
}

function issueLabels(issue) {
  return (issue.labels || []).map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean).slice(0, 12)
}

function recordIssueActivity(project, { issue, classification, source, triggerFix }) {
  const store = normalizeIssueStore(project)
  const entry = {
    number: issue.number,
    title: String(issue.title || '').slice(0, 200),
    state: issue.state || 'open',
    htmlUrl: issue.html_url || null,
    labels: issueLabels(issue),
    updatedAt: issue.updated_at || null,
    seenAt: now(),
    source,
    classification: {
      category: classification.category,
      severity: classification.severity,
      confidence: classification.confidence,
      source: classification.source,
      suggestedAction: classification.suggestedAction || null,
      problemSummary: classification.problemSummary || null,
      reproductionSteps: classification.reproductionSteps || null,
      actualBehavior: classification.actualBehavior || null,
      expectedBehavior: classification.expectedBehavior || null,
      errorLogExcerpt: classification.errorLogExcerpt || null,
      affectedVersions: classification.affectedVersions || null,
      affectedModules: classification.affectedModules || null
    },
    triggerFix: triggerFix === true,
    fixTaskId: store.activity.find((item) => item.number === issue.number)?.fixTaskId || null
  }
  return upsertIssueActivity(store, entry, ISSUE_ACTIVITY_LIMIT)
}

async function resolveClassifierProvider() {
  try {
    return await resolveProviderForInvocation({ dataDir, providerId: null, taskType: 'issue-classification' }) || null
  } catch { return null }
}

async function classifyAndRecordIssue({ project, issue, comments = [], source, signal } = {}) {
  const provider = await resolveClassifierProvider()
  const classification = await classifyIssue({ issue, comments, provider, signal })
  const policy = getHostingPolicy(project)
  const blockedReason = automaticFixDecision(policy, classification, issue)
  const triggerFix = blockedReason === null
  const entry = recordIssueActivity(project, { issue, classification, source, triggerFix })
  entry.automationBlockedReason = blockedReason
  // Auto-labeling is a lightweight remote write; only non-observe strategies
  // label issues, and labeling failures never block monitoring.
  if (policy.enabled && policy.strategy !== 'observe' && remoteWritesEnabled() && !hostingPaused()) {
    const label = `${AUTO_LABEL_PREFIX}/${classification.category.toLowerCase()}`
    if (!issueLabels(issue).some((existing) => existing.startsWith(`${AUTO_LABEL_PREFIX}/`))) {
      try {
        await addIssueLabels((endpoint, options) => { assertHostingWrite({ project, enabled: remoteWritesEnabled(), paused: hostingPaused(), operation: 'label' }); return githubFetchForProject(project, endpoint, options) }, repoFromProject(project), issue.number, [label])
        entry.labels = [...new Set([...entry.labels, label])]
      } catch { /* labeling is best-effort */ }
    }
  }
  return { classification, entry, triggerFix }
}

async function syncProjectIssues(project, { request, signal, maxClassifications = MAX_ISSUE_CLASSIFICATIONS_PER_SYNC } = {}) {
  if (!projectGithubConfigured(project)) throw Object.assign(new Error('Configure GITHUB_TOKEN or a GitHub App installation before syncing issues.'), { code: 'GITHUB_NOT_CONFIGURED' })
  const store = normalizeIssueStore(project)
  const syncStartedAt = now()
  // GitHub's list index can lag issue creation. Overlap the cursor and use
  // per-issue timestamps for deduplication, so delayed records are not lost.
  const since = store.lastSyncedAt ? new Date(new Date(store.lastSyncedAt).getTime() - 5 * 60_000).toISOString() : null
  const { issues, truncated } = await listRepositoryIssues(request, repoFromProject(project), { state: 'all', since, signal })
  let classified = 0
  let newlyActionable = 0
  for (const issue of issues) {
    const key = String(issue.number)
    const previous = store.known[key]
    if (previous?.updatedAt === issue.updated_at && previous.state === issue.state) continue
    if (issue.state === 'closed') { recordIssueActivity(project, { issue, classification: { category: 'NEEDS_HUMAN_REVIEW', severity: 'P4', confidence: 0.2, source: 'heuristic', suggestedAction: 'none' }, source: 'poll', triggerFix: false }); continue }
    if (classified >= maxClassifications) continue
    const { entry, triggerFix } = await classifyAndRecordIssue({ project, issue, comments: [], source: 'poll', signal })
    rememberIssueSeen(store, issue)
    classified += 1
    if (triggerFix) {
      newlyActionable += 1
      try { await enqueueIssueFixTask({ project, issueNumber: entry.number, source: 'poll', classification: entry.classification }) }
      catch (queueError) { state.activity.unshift({ id: id('activity'), type: 'issue-fix', message: `Fix not queued for ${project.fullName}#${entry.number}: ${queueError.code || 'unknown'}`, at: now() }); state.activity = state.activity.slice(0, 100) }
    }
  }
  // Keep the cursor until all bounded classifications are processed.
  if (!truncated && classified < maxClassifications) store.lastSyncedAt = syncStartedAt
  return { scanned: issues.length, classified, newlyActionable }
}

async function handleIssueEvent({ project, issue, source, comment = null, comments: providedComments = null, signal } = {}) {
  if (!isRealIssue(issue)) return null
  const store = normalizeIssueStore(project)
  const key = String(issue.number)
  const previous = store.known[key]
  const changed = !previous || previous.updatedAt !== issue.updated_at
  rememberIssueSeen(store, issue)
  // Classify new issues immediately; re-classify known ones only when new
  // information arrives (a fresh comment may turn a question into a bug).
  const shouldClassify = !previous || changed || comment || providedComments
  if (!shouldClassify) return null
  let comments = providedComments
  if (!comments && comment) comments = [{ author: comment.user?.login || null, body: String(comment.body || '').slice(0, 4000), createdAt: comment.created_at || null }]
  if (!comments) {
    try {
      comments = await listIssueComments((endpoint, options) => githubFetchForProject(project, endpoint, options), repoFromProject(project), issue.number, { maxPages: 1, signal })
    } catch { comments = [] }
  }
  const { entry, triggerFix } = await classifyAndRecordIssue({ project, issue, comments: (comments || []).slice(0, 5), source, signal })
  if (triggerFix) entry.fixTaskId = entry.fixTaskId || null
  return entry
}

function hostingPublicProject(project) {
  return {
    id: project.id,
    fullName: project.fullName,
    name: project.name,
    owner: project.owner,
    defaultBranch: project.defaultBranch,
    installationId: project.installationId || null,
    hosting: hostingStatus(project),
    policy: getHostingPolicy(project),
    repoMeta: project.repoMeta ? normalizeRepoMeta(project.repoMeta, project) : null,
    githubConfigured: projectGithubConfigured(project)
  }
}

app.get('/api/hosting/overview', (_req, res) => {
  const hosted = state.projects.map(hostingPublicProject)
  const runs = state.hostingRuns.slice(0, 50)
  res.json({
    projects: hosted,
    enabledCount: hosted.filter((item) => item.policy.enabled).length,
    runs,
    scheduler: { dueNow: hostingDueProjects().length, strategies: HOSTING_STRATEGIES, paused: hostingPaused() }
  })
})

app.get('/api/project-overview', async (req, res) => {
  if (!requireDesktopLocalAgent(res)) return
  const results = await Promise.allSettled([listLocalAgentTasks({ dataDir }), listPublicProviders({ dataDir })])
  const localTasks = results[0].status === 'fulfilled' ? results[0].value : []
  const providers = results[1].status === 'fulfilled' ? results[1].value : []
  const secrets = [process.env.GITHUB_TOKEN, process.env.AI_API_KEY]
  for (const provider of providers.filter((item) => item.configured)) {
    try { secrets.push((await resolveProviderForInvocation({ dataDir, providerId: provider.id }))?.apiKey) } catch { /* public snapshot remains available */ }
  }
  const warnings = results.flatMap((result, index) => result.status === 'rejected' ? [index === 0 ? 'agent-store-unavailable' : 'provider-store-unavailable'] : [])
  res.json(buildProjectOverview({ state, localTasks, providers, github: { configured: githubConfigured(), owner: githubAccount?.login || process.env.GITHUB_OWNER }, paused: hostingPaused(), activeResearch: [...activeOverviewResearch.values()], projectId: String(req.query.projectId || '').slice(0, 128), secrets, warnings }))
})

const evolution = registerEvolutionApi({ app, dataDir, version: process.env.NEXUS_DESKTOP_VERSION || JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version, guard: (req, res) => requireDesktopLocalAgent(res) && requireRole(req, res, 'Operator'), getResearchEvidence: async (workflow) => workflow.metadata.evidence || [], isProposalLinked: async (workflow) => state.researchReports.find((report) => report.id === workflow.metadata.reportId)?.upgradeProposals?.find((proposal) => proposal.id === workflow.metadata.proposalId)?.implementation?.workflowId === workflow.id, request: async (endpoint) => {
  if (githubConfigured()) return githubFetch(endpoint)
  if (endpoint !== '/repos/yuchen0x1/PROJECT-NEXUS/releases/latest') throw Object.assign(new Error('This public request is outside the NEXUS release scope.'), { code: 'NEXUS_RELEASE_SCOPE_REQUIRED' })
  const response = await fetch(`https://api.github.com${endpoint}`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000), redirect: 'error' })
  if (!response.ok) throw Object.assign(new Error('NEXUS release metadata could not be read.'), { code: 'NEXUS_RELEASE_UNAVAILABLE' })
  return response.json()
} })

evolution.route('get', '/api/evolution/research', async (_req, res) => {
  const reports = []
  for (const report of state.researchReports.slice(0, 50)) {
    const proposals = []
    for (const proposal of (report.upgradeProposals || []).slice(0, 20)) {
      const workflow = proposal.implementation?.workflowId ? await evolution.engine.store.get(proposal.implementation.workflowId) : null
      proposals.push({ ...proposal, lifecycleStatus: proposalLifecycle(proposal, workflow), workflowStatus: workflow?.status || null, applied: proposal.applied === true })
    }
    reports.push({ id: report.id, projectId: report.projectId, repository: report.repository, createdAt: report.createdAt, proposals })
  }
  res.json({ reports })
})
evolution.route('post', '/api/evolution/research/:reportId/proposals/:proposalId/implement', async (req, res) => {
  const report = state.researchReports.find((item) => item.id === req.params.reportId)
  const proposal = report?.upgradeProposals?.find((item) => item.id === req.params.proposalId)
  if (!proposal) return res.status(404).json({ code: 'PROPOSAL_NOT_FOUND' })
  const project = await evolution.project(req.body?.projectId)
  const workflow = await startProposalImplementation({ report, proposal, project, body: req.body || {}, engine: evolution.engine, scheduler: evolution.scheduler, save: saveState })
  res.status(202).json({ workflow })
})

app.put('/api/settings/remote-writes', async (req, res) => {
  if (!requireDesktopLocalAgent(res) || !requireRole(req, res, 'Administrator')) return
  if (typeof req.body?.enabled !== 'boolean' || req.body?.confirm !== true) return res.status(400).json({ code: 'CONFIRMATION_REQUIRED', message: 'Confirm whether repository-policy remote writes should be enabled.' })
  state.settings.remoteWritesEnabled = req.body.enabled
  audit(req, 'remote_writes_updated', 'desktop', 'success', 'high', { enabled: req.body.enabled })
  await saveState()
  res.json({ enabled: remoteWritesEnabled() })
})

app.get('/api/hosting/runs', (req, res) => {
  const projectId = String(req.query.projectId || '')
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
  const runs = state.hostingRuns.filter((run) => !projectId || run.projectId === projectId).slice(0, limit)
  res.json({ runs, total: state.hostingRuns.filter((run) => !projectId || run.projectId === projectId).length })
})

app.get('/api/hosting/jobs', (req, res) => {
  const jobs = (state.hostedJobs || []).filter((job) => !req.query.projectId || job.projectId === req.query.projectId).slice(-100).reverse()
  res.json({ jobs, running: hostedRunningCount, queued: hostedPending.length, concurrency: HOSTED_MAX_RUNNING })
})

app.post('/api/hosting/jobs/:jobId/reconcile', async (req, res) => {
  if (!requireRole(req, res, 'Operator')) return
  const job = state.hostedJobs.find((candidate) => candidate.id === req.params.jobId)
  if (!job) return res.status(404).json({ code: 'JOB_NOT_FOUND' })
  if (!['Interrupted', 'Blocked'].includes(job.status)) return res.status(409).json({ code: 'JOB_NOT_RECONCILABLE' })
  const project = state.projects.find((candidate) => candidate.id === job.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND' })
  for (const entry of job.operations || []) {
    if (entry.status === 'Confirmed') continue
    try {
      if (entry.endpoint.startsWith('git:')) Object.assign(entry, JSON.parse(entry.body), { repository: project.fullName })
      if (entry.endpoint.startsWith('upload:')) Object.assign(entry, JSON.parse(entry.body), { repository: project.fullName })
      await reconcileEffect(entry, (endpoint) => githubFetchForProject(project, endpoint))
    } catch (error) { entry.reconcileError = safeError(error) }
  }
  job.reconciledAt = now()
  job.reconciliation = (job.operations || []).some((entry) => entry.status !== 'Confirmed') ? 'NeedsReview' : 'ReceiptsConfirmed'
  // Reconciliation does not execute code or silently replay delivery.
  await saveState()
  res.json({ job })
})

app.get('/api/projects/:projectId/hosting', (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  res.json({ project: hostingPublicProject(project), runs: state.hostingRuns.filter((run) => run.projectId === project.id).slice(0, 20) })
})

app.put('/api/projects/:projectId/hosting', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  if (!requireRole(req, res, 'Operator')) return
  const body = req.body || {}
  if (body.strategy !== undefined && !HOSTING_STRATEGIES.includes(body.strategy)) return res.status(400).json({ code: 'HOSTING_STRATEGY_INVALID', message: `strategy must be one of ${HOSTING_STRATEGIES.join(', ')}.` })
  if (body.intervalMinutes !== undefined) {
    const minutes = Math.round(Number(body.intervalMinutes))
    if (!Number.isFinite(minutes) || minutes < HOSTING_MIN_INTERVAL_MINUTES || minutes > HOSTING_MAX_INTERVAL_MINUTES) {
      return res.status(400).json({ code: 'HOSTING_INTERVAL_INVALID', message: `intervalMinutes must be between ${HOSTING_MIN_INTERVAL_MINUTES} and ${HOSTING_MAX_INTERVAL_MINUTES}.` })
    }
  }
  const previous = getHostingPolicy(project)
  const merged = normalizeHostingPolicy({ ...previous, ...body, enabled: body.enabled !== undefined ? body.enabled === true : previous.enabled })
  const withPreset = body.strategy && body.strategy !== previous.strategy && body.applyPreset !== false ? applyStrategyPreset(merged, body.strategy) : merged
  if (withPreset.enabled && withPreset.strategy !== 'observe' && (!previous.enabled || previous.strategy === 'observe')) return res.status(409).json({ code: 'SETUP_READINESS_REQUIRED', message: 'Save the policy disabled, then run readiness checks and enable hosting.' })
  project.hosting = { ...withPreset, updatedAt: now(), lastInspectionAt: project.hosting?.lastInspectionAt || null, lastLightScanAt: project.hosting?.lastLightScanAt || null, lastFullScanAt: project.hosting?.lastFullScanAt || null, lastOutcome: project.hosting?.lastOutcome || null, currentTaskId: project.hosting?.currentTaskId || null }
  audit(req, 'hosting_policy_updated', project.fullName, 'success', 'medium', { strategy: project.hosting.strategy, intervalMinutes: project.hosting.intervalMinutes, enabled: project.hosting.enabled })
  await saveState()
  res.json({ project: hostingPublicProject(project) })
})

async function setupContext(project) {
  const provider = await resolveProviderForInvocation({ dataDir, taskType: 'coding' })
  const credential = await githubTokenForProject(project)
  return { provider, credential, fingerprint: readinessFingerprint({ project, provider, credential, account: githubAccount?.login, epoch: readinessEpoch }) }
}

app.post('/api/projects/:projectId/hosting/readiness', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND' })
  if (!requireRole(req, res, 'Operator')) return
  try {
    const context = await setupContext(project)
    if (!context.credential) throw Object.assign(new Error('GitHub connection is required.'), { code: 'GITHUB_NOT_CONFIGURED' })
    await githubFetchForProject(project, `/repos/${project.fullName}`)
    if (getHostingPolicy(project).strategy !== 'observe') {
      assertTrustedRepository(project)
      if (!context.provider) throw Object.assign(new Error('A coding provider is required.'), { code: 'AI_NOT_CONFIGURED' })
      const test = await testProviderRecord({ dataDir, providerId: context.provider.id })
      if (!test.ok) throw Object.assign(new Error(test.error), { code: test.code || 'PROVIDER_TEST_FAILED' })
      const env = await detectDevelopmentEnvironment()
      if (!env.tools.some((tool) => tool.id === 'git' && tool.status === 'AVAILABLE')) throw Object.assign(new Error('A working Git installation is required.'), { code: 'GIT_NOT_AVAILABLE' })
    }
    const record = { id: crypto.randomUUID(), fingerprint: context.fingerprint, checkedAt: now(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }
    project.setupReadiness = record
    await saveState()
    res.json({ readinessId: record.id, checkedAt: record.checkedAt, expiresAt: record.expiresAt })
  } catch (error) { res.status(424).json({ code: error.code || 'SETUP_NOT_READY', message: safeError(error) }) }
})

app.post('/api/projects/:projectId/hosting/enable', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  if (!requireRole(req, res, 'Operator')) return
  if (!projectGithubConfigured(project)) return notConfigured(res)
  const policy = getHostingPolicy(project)
  if (policy.strategy !== 'observe' || req.body?.readinessId) {
    try { const context = await setupContext(project); validateReadiness(project.setupReadiness, { id: req.body?.readinessId, fingerprint: context.fingerprint }) }
    catch (error) { return res.status(409).json({ code: error.code, message: safeError(error) }) }
  }
  project.hosting = { ...policy, enabled: true, updatedAt: now(), lastInspectionAt: project.hosting?.lastInspectionAt || null, lastLightScanAt: project.hosting?.lastLightScanAt || null, lastFullScanAt: project.hosting?.lastFullScanAt || null, lastOutcome: project.hosting?.lastOutcome || null, currentTaskId: project.hosting?.currentTaskId || null }
  audit(req, 'hosting_enabled', project.fullName, 'success', 'high', { strategy: project.hosting.strategy, intervalMinutes: project.hosting.intervalMinutes })
  await saveState()
  res.json({ project: hostingPublicProject(project) })
})

app.post('/api/projects/:projectId/hosting/disable', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  if (!requireRole(req, res, 'Operator')) return
  project.hosting = { ...getHostingPolicy(project), enabled: false, updatedAt: now(), lastInspectionAt: project.hosting?.lastInspectionAt || null, lastLightScanAt: project.hosting?.lastLightScanAt || null, lastFullScanAt: project.hosting?.lastFullScanAt || null, lastOutcome: project.hosting?.lastOutcome || null, currentTaskId: project.hosting?.currentTaskId || null }
  audit(req, 'hosting_disabled', project.fullName, 'success', 'medium', {})
  await saveState()
  res.json({ project: hostingPublicProject(project) })
})

app.post('/api/projects/:projectId/hosting/inspect', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  if (!requireRole(req, res, 'Operator')) return
  if (!projectGithubConfigured(project)) return notConfigured(res)
  const depth = HOSTING_INSPECTION_DEPTHS.includes(req.body?.depth) ? req.body.depth : 'light'
  const run = await runHostingInspection(project, { depth, req })
  res.status(run.status === 'Success' ? 200 : 424).json({ run, project: hostingPublicProject(project) })
})

app.post('/api/projects/:projectId/hosting/workspace/prepare', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  if (!requireRole(req, res, 'Operator')) return
  if (!projectGithubConfigured(project)) return notConfigured(res)
  try {
    const token = await githubTokenForProject(project)
    const branch = String(req.body?.branch || project.defaultBranch || 'main')
    const startedAt = now()
    const cache = await ensureRepoCache({ dataDir, fullName: project.fullName, token, branch })
    project.localWorkspace = { status: 'ready', cachePath: cache.path, branch: cache.branch, headSha: cache.headSha, clonedNow: cache.cloned, preparedAt: now(), preparedInMs: Date.now() - new Date(startedAt).getTime(), lastError: null }
    audit(req, 'hosting_workspace_prepared', project.fullName, 'success', 'low', { branch, headSha: cache.headSha, cloned: cache.cloned })
    await saveState()
    res.json({ workspace: project.localWorkspace, cache: { path: cache.path, branch: cache.branch, headSha: cache.headSha } })
  } catch (error) {
    project.localWorkspace = { status: 'error', cachePath: null, branch: String(req.body?.branch || project.defaultBranch || 'main'), headSha: null, preparedAt: now(), lastError: safeError(error) }
    await saveState().catch(() => {})
    res.status(error.code === 'GITHUB_NOT_CONFIGURED' ? 424 : 502).json({ code: error.code || 'HOSTING_WORKSPACE_FAILED', message: safeError(error) })
  }
})

app.get('/api/projects/:projectId/hosting/workspace', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  const description = await describeRepoCache({ dataDir, fullName: project.fullName }).catch((error) => ({ exists: false, error: safeError(error) }))
  res.json({ workspace: project.localWorkspace || null, cache: description })
})

app.delete('/api/projects/:projectId/hosting/workspace', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  if (!requireRole(req, res, 'Operator')) return
  if ((req.body?.confirm || req.query.confirm) !== project.fullName) return res.status(400).json({ code: 'HOSTING_WORKSPACE_CONFIRM_REQUIRED', message: `Confirm by passing confirm: "${project.fullName}". Only the NEXUS-managed cache is removed; user folders are never touched.` })
  const result = await removeRepoWorkspace(dataDir, project.fullName).catch((error) => ({ removed: false, error: safeError(error) }))
  project.localWorkspace = { status: 'none', cachePath: null, branch: null, headSha: null, preparedAt: null, lastError: null }
  audit(req, 'hosting_workspace_removed', project.fullName, 'success', 'medium', { removed: result.removed })
  await saveState()
  res.json(result)
})

// ---- PHASE 2: issue monitoring routes ----

app.get('/api/projects/:projectId/issues', (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  const store = normalizeIssueStore(project)
  const actionableOnly = req.query.actionable === 'true'
  const category = String(req.query.category || '')
  const activity = store.activity.filter((entry) => (!actionableOnly || entry.triggerFix) && (!category || entry.classification?.category === category))
  res.json({
    issues: activity.slice(0, 100),
    total: activity.length,
    lastSyncedAt: store.lastSyncedAt,
    categories: ISSUE_CATEGORIES
  })
})

app.post('/api/projects/:projectId/issues/sync', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  if (!requireRole(req, res, 'Operator')) return
  if (!projectGithubConfigured(project)) return notConfigured(res)
  try {
    const result = await syncProjectIssues(project, { request: (endpoint, options) => githubFetchForProject(project, endpoint, options) })
    audit(req, 'project_issues_synced', project.fullName, 'success', 'low', { scanned: result.scanned, classified: result.classified })
    await saveState()
    res.json(result)
  } catch (error) {
    await saveState().catch(() => {})
    res.status(error.status || 500).json({ code: error.code || 'ISSUE_SYNC_FAILED', message: safeError(error) })
  }
})

app.post('/api/projects/:projectId/issues/:number/classify', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  if (!requireRole(req, res, 'Operator')) return
  if (!projectGithubConfigured(project)) return notConfigured(res)
  try {
    const request = (endpoint, options) => githubFetchForProject(project, endpoint, options)
    const issue = await getIssue(request, repoFromProject(project), req.params.number)
    const comments = await listIssueComments(request, repoFromProject(project), issue.number, { maxPages: 2 })
    const { classification, entry } = await classifyAndRecordIssue({ project, issue, comments, source: 'manual' })
    audit(req, 'issue_classified', `${project.fullName}#${issue.number}`, 'success', 'low', { category: classification.category, severity: classification.severity, source: classification.source })
    await saveState()
    res.json({ issue: issuePublicSummary(issue), classification, entry, commentsCount: comments.length })
  } catch (error) {
    await saveState().catch(() => {})
    res.status(error.status || 500).json({ code: error.code || 'ISSUE_CLASSIFY_FAILED', message: safeError(error) })
  }
})

app.get('/api/issues/activity', (req, res) => {
  const actionableOnly = req.query.actionable === 'true'
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300)
  const entries = []
  for (const project of state.projects) {
    const store = project.issues
    if (!store?.activity?.length) continue
    for (const entry of store.activity) {
      if (actionableOnly && !entry.triggerFix) continue
      entries.push({ projectId: project.id, repository: project.fullName, ...entry })
    }
  }
  entries.sort((a, b) => new Date(b.updatedAt || b.seenAt || 0) - new Date(a.updatedAt || a.seenAt || 0))
  res.json({ issues: entries.slice(0, limit), total: entries.length })
})

app.post('/api/projects/:projectId/issues/:number/fix', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  if (!requireRole(req, res, 'Operator')) return
  if (!projectGithubConfigured(project)) return notConfigured(res)
  try {
    const result = await enqueueIssueFixTask({ project, issueNumber: req.params.number, source: 'manual', req, classification: req.body?.classification || null })
    res.status(202).json(result)
  } catch (error) {
    const status = error.code === 'HOSTING_TASK_IN_PROGRESS' ? 409 : error.code === 'HOSTED_QUEUE_FULL' ? 429 : error.code === 'HOSTING_POLICY_FORBIDS_FIX' ? 424 : 400
    res.status(status).json({ code: error.code || 'ISSUE_FIX_QUEUE_FAILED', message: safeError(error) })
  }
})

// ---- PHASE 4/5/6 routes: security findings, research, delivery controls ----

app.post('/api/hosting/pause', async (req, res) => {
  if (!requireRole(req, res, 'Operator')) return
  const paused = req.body?.paused === true
  state.settings.hostingPaused = paused
  if (!paused) scheduleHostedPump()
  audit(req, 'hosting_pause_toggled', 'scheduler', 'success', 'medium', { paused })
  await saveState()
  res.json({ paused })
})

app.get('/api/security/findings', (req, res) => {
  const projectId = String(req.query.projectId || '')
  const priority = String(req.query.priority || '')
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
  const findings = state.securityFindings.filter((finding) => (!projectId || finding.projectId === projectId) && (!priority || finding.priority === priority))
  res.json({ findings: findings.slice(0, limit), total: findings.length })
})

app.post('/api/projects/:projectId/security-scan', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  if (!requireRole(req, res, 'Operator')) return
  if (!projectGithubConfigured(project)) return notConfigured(res)
  try {
    const token = await githubTokenForProject(project)
    const cache = await ensureRepoCache({ dataDir, fullName: project.fullName, token, branch: project.defaultBranch || 'main' })
    const scan = await runSecurityScan({ root: cache.path })
    project.securitySummary = { lastScanAt: scan.scannedAt, status: scan.status, counts: scan.counts, dependencyAuditRan: scan.dependencyAuditRan, topFindings: scan.findings.slice(0, 10) }
    for (const finding of scan.findings.slice(0, 20)) {
      state.securityFindings.unshift({ id: id('sec'), projectId: project.id, repository: project.fullName, scanId: 'manual', ...finding, recordedAt: now() })
    }
    state.securityFindings = state.securityFindings.slice(0, 1000)
    audit(req, 'security_scan_completed', project.fullName, 'success', 'medium', { status: scan.status, counts: scan.counts })
    await saveState()
    res.json({ scan, summary: project.securitySummary })
  } catch (error) {
    res.status(error.code === 'GITHUB_NOT_CONFIGURED' ? 424 : 502).json({ code: error.code || 'SECURITY_SCAN_FAILED', message: safeError(error) })
  }
})

async function runProjectResearch(project, { req = null, signal } = {}) {
  const overviewId = crypto.randomUUID()
  activeOverviewResearch.set(overviewId, { id: overviewId, projectId: project.id, repository: project.fullName, startedAt: now() })
  try { return await runProjectResearchBody(project, { req, signal }) }
  finally { activeOverviewResearch.delete(overviewId) }
}

async function runProjectResearchBody(project, { req = null, signal } = {}) {
  const token = process.env.GITHUB_TOKEN || ''
  if (!token) throw Object.assign(new Error('Competitor research requires a legacy GITHUB_TOKEN (the GitHub search API does not accept installation tokens).'), { code: 'GITHUB_NOT_CONFIGURED' })
  const provider = await resolveClassifierProvider()
  const request = (endpoint, options) => githubFetch(endpoint, options)
  const outcome = await runCompetitorResearch({ project, request, provider, signal, limit: RESEARCH_MAX_CANDIDATES })
  const report = {
    id: id('research'),
    projectId: project.id,
    repository: project.fullName,
    query: outcome.query,
    candidates: outcome.candidates,
    analysis: outcome.analysis,
    usage: outcome.usage || null,
    costUsd: outcome.costUsd ?? null,
    status: 'Success',
    createdAt: now()
  }
  report.upgradeProposals = buildUpgradeProposals(report)
  state.researchReports.unshift(report)
  state.researchReports = state.researchReports.slice(0, 200)
  project.research = { lastRunAt: report.createdAt, lastReportId: report.id, candidatesFound: outcome.candidates.length, source: outcome.analysis.source }
  return report
}

app.post('/api/projects/:projectId/research', async (req, res) => {
  const project = state.projects.find((item) => item.id === req.params.projectId)
  if (!project) return res.status(404).json({ code: 'PROJECT_NOT_FOUND', message: 'Project not found.' })
  if (!requireRole(req, res, 'Operator')) return
  if (!process.env.GITHUB_TOKEN) return notConfigured(res)
  try {
    const report = await runProjectResearch(project, { req })
    audit(req, 'competitor_research_completed', project.fullName, 'success', 'low', { reportId: report.id, candidates: report.candidates.length, source: report.analysis.source })
    await saveState()
    res.json({ report })
  } catch (error) {
    await saveState().catch(() => {})
    res.status(error.status || 502).json({ code: error.code || 'RESEARCH_FAILED', message: safeError(error) })
  }
})

app.get('/api/research/reports', (req, res) => {
  const projectId = String(req.query.projectId || '')
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100)
  const reports = state.researchReports.filter((report) => !projectId || report.projectId === projectId).slice(0, limit)
  res.json({ reports, total: state.researchReports.filter((report) => !projectId || report.projectId === projectId).length })
})

app.post('/api/research/reports/:reportId/proposals/:proposalId/review', async (req, res) => {
  if (!requireRole(req, res, 'Operator')) return
  const report = state.researchReports.find((item) => item.id === req.params.reportId)
  const proposal = report?.upgradeProposals?.find((item) => item.id === req.params.proposalId)
  if (!proposal) return res.status(404).json({ code: 'PROPOSAL_NOT_FOUND' })
  try {
    reviewUpgradeProposal(proposal, { ...req.body, actor: currentRole(req) })
    audit(req, 'upgrade_proposal_reviewed', proposal.id, proposal.status.toLowerCase(), 'high', { reportId: report.id })
    await saveState()
    res.json({ proposal })
  } catch (error) { res.status(409).json({ code: error.code, message: safeError(error) }) }
})

app.get('/api/research/reports/:reportId', (req, res) => {
  const report = state.researchReports.find((item) => item.id === req.params.reportId)
  if (!report) return res.status(404).json({ code: 'REPORT_NOT_FOUND', message: 'Research report not found.' })
  res.json({ report })
})

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'project-nexus', time: now(), uptimeSeconds: Math.floor(process.uptime()), memory: process.memoryUsage(), scheduler: { paused: hostingPaused(), running: hostedRunningCount, queued: hostedPending.length, concurrency: HOSTED_MAX_RUNNING } }))

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
    for (const project of incoming) byFullName.set(project.fullName, { ...byFullName.get(project.fullName), ...project, hosting: getHostingPolicy(byFullName.get(project.fullName)), repoMeta: byFullName.get(project.fullName)?.repoMeta || null, localWorkspace: byFullName.get(project.fullName)?.localWorkspace || null })
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

app.post('/api/github/credentials', async (req, res) => {
  if (!requireDesktopLocalAgent(res) || !requireRole(req, res, 'Administrator')) return
  const token = req.body?.token
  if (typeof token !== 'string' || !token.trim() || token.length > 4096) return res.status(400).json({ code: 'GITHUB_TOKEN_INVALID', message: 'Enter a GitHub access token.' })
  try {
    const response = await fetch(`${githubApiUrl}/user`, { headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000), redirect: 'error' })
    if (!response.ok) return res.status(424).json({ code: 'GITHUB_AUTH_FAILED', message: `GitHub rejected the connection (${response.status}).` })
    const user = await response.json()
    process.env.GITHUB_TOKEN = token.trim()
    githubAccount = { login: user.login, avatarUrl: user.avatar_url, connectedAt: now(), scopes: (response.headers.get('x-oauth-scopes') || '').split(',').map((scope) => scope.trim()).filter(Boolean) }
    res.json({ connected: true, account: githubAccount })
  } catch (error) { res.status(424).json({ code: 'GITHUB_CONNECTION_FAILED', message: safeError(error) }) }
})

app.get('/api/github/account', async (_req, res) => {
  if (!githubConfigured()) return res.status(424).json({ code: 'GITHUB_NOT_CONFIGURED', message: 'Connect GitHub first.' })
  try {
    const user = await githubFetch('/user', { signal: AbortSignal.timeout(15_000) })
    githubAccount = { ...githubAccount, login: user.login, avatarUrl: user.avatar_url }
    res.json({ account: githubAccount })
  } catch (error) { res.status(424).json({ code: 'GITHUB_CONNECTION_FAILED', message: safeError(error) }) }
})

app.get('/api/github/status', (_req, res) => {
  res.json({
    configured: githubConfigured(),
    owner: githubAccount?.login || process.env.GITHUB_OWNER || null,
    account: githubAccount,
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
    remoteWritesEnabled: remoteWritesEnabled(),
    supportedWorkflows: { scan: true, localModification: true, isolatedBuild: true, push: remoteWritesEnabled(), pullRequest: remoteWritesEnabled() }
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
      remoteWritesEnabled: remoteWritesEnabled(),
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
  if (!remoteWritesEnabled()) return res.status(403).json({ code: 'REMOTE_WRITES_DISABLED', message: 'Enable NEXUS_ENABLE_REMOTE_WRITES explicitly before creating a remote branch or pull request.' })
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

const hostLease = await acquireFileLease(`${stateFile}.host.lock`)
await loadState()
await recoverIntegrationWork()
await recoverLocalAgentTasks()
await recoverHostedFixTasks()
await evolution.recover()
setTimeout(() => void sweepExpiredWorkspaces().catch((error) => console.error('Workspace sweep failed:', safeError(error))), 30_000).unref?.()
setInterval(() => void sweepExpiredWorkspaces().catch((error) => console.error('Workspace sweep failed:', safeError(error))), 6 * 60 * 60_000).unref?.()
const server = app.listen(port, host, () => {
  const address = server.address()
  if (desktopMode && address && typeof address === 'object') {
    desktopOrigin = `http://127.0.0.1:${address.port}`
    console.log(`NEXUS_DESKTOP_READY:${address.port}`)
  } else {
    console.log(`PROJECT NEXUS API listening on http://localhost:${address && typeof address === 'object' ? address.port : port}`)
  }
  const timer = setInterval(() => { void runScheduledIntegrationScan(); void runScheduledHostingTick() }, 60_000)
  timer.unref?.()
  void runScheduledIntegrationScan()
  setTimeout(() => void runScheduledHostingTick(), 5_000).unref?.()
})

async function stopHost() {
  if (shuttingDown) return
  shuttingDown = true
  const forced = setTimeout(() => process.exit(1), 9000)
  forced.unref?.()
  server.close(); server.closeAllConnections?.()
  for (const collection of [localAgentControllers, integrationControllers, hostedControllers]) for (const controller of collection.values()) controller.abort(Object.assign(new Error('Host shutdown.'), { code: 'HOST_SHUTDOWN' }))
  try {
    await evolution.stop()
    const deadline = Date.now() + 6000
    while ((localAgentControllers.size || integrationControllers.size || hostedControllers.size) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    await saveState(); await stateWriteQueue
    await hostLease.release()
    process.exit(0)
  } catch { process.exit(1) }
}
process.on('message', (message) => { if (message?.type === 'nexus-shutdown' && process.send) void stopHost() })
if (process.send) process.on('disconnect', () => void stopHost())
// Owner liveness supplements IPC on desktop deployments. This monitors process
// lifecycle; it is not an OS security boundary.
const desktopOwnerPid = Number(process.env.NEXUS_DESKTOP_OWNER_PID)
if (desktopMode && Number.isInteger(desktopOwnerPid) && desktopOwnerPid > 0 && desktopOwnerPid !== process.pid) {
  const ownerTimer = setInterval(() => { try { process.kill(desktopOwnerPid, 0) } catch { void stopHost() } }, 1000)
  ownerTimer.unref?.()
}
process.on('SIGTERM', () => void stopHost())
process.on('SIGINT', () => void stopHost())
