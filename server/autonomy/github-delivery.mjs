import { execFile } from 'node:child_process'
import path from 'node:path'
import crypto from 'node:crypto'

function deliveryError(code, message) { return Object.assign(new Error(message), { code }) }

function repoPath(fullName) {
  const parts = String(fullName || '').split('/')
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part))) throw deliveryError('INVALID_REPOSITORY', 'Repository must be an owner/name pair.')
  return `/repos/${parts.map(encodeURIComponent).join('/')}`
}

function requireWrite({ remoteWritesEnabled, confirm, action }) {
  if (!remoteWritesEnabled) throw deliveryError('REMOTE_WRITES_DISABLED', `${action} is disabled until remote write permission is enabled.`)
  if (confirm !== true) throw deliveryError('CONFIRMATION_REQUIRED', `${action} requires an explicit confirm=true request.`)
}

function git(execImpl, args, cwd) {
  return new Promise((resolve, reject) => {
    execImpl('git', args, { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(deliveryError('GIT_DELIVERY_FAILED', String(stderr || error.message).slice(0, 500)))
      else resolve(String(stdout || '').trim())
    })
  })
}

export class GithubDelivery {
  constructor({ store, token = '', tokenResolver = null, apiBase = process.env.GITHUB_API_URL || 'https://api.github.com', fetchImpl = globalThis.fetch, clock = () => Date.now(), execImpl = execFile } = {}) {
    this.store = store
    this.token = token
    this.tokenResolver = tokenResolver
    this.apiBase = apiBase.replace(/\/$/, '')
    this.fetchImpl = fetchImpl
    this.clock = clock
    this.execImpl = execImpl
  }

  async resolveToken(repo) {
    if (this.tokenResolver && repo) {
      try { const token = await this.tokenResolver(repo); if (token) return token } catch {}
    }
    return this.token
  }

  async request(repo, endpoint, options = {}) {
    const token = await this.resolveToken(repo)
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {}) }
    if (token) headers.Authorization = `Bearer ${token}`
    const response = await this.fetchImpl(`${this.apiBase}${endpoint}`, { ...options, headers, signal: options.signal || AbortSignal.timeout(30_000) })
    const text = await response.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    if (!response.ok) throw Object.assign(new Error(String(body?.message || body || `GitHub returned ${response.status}`)), { code: 'GITHUB_REQUEST_FAILED', status: response.status, body })
    return body
  }

  record(repo, action, result) {
    const record = { id: `delivery_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`, repository: repo.fullName, action, result, at: new Date(this.clock()).toISOString() }
    this.store?.put('delivery_runs', record.id, record)
    return record
  }

  async inspect(repo, { branch = repo.defaultBranch || 'main', pullRequest = null } = {}) {
    const base = repoPath(repo.fullName)
    const [repository, ref, pulls, runs] = await Promise.all([
      this.request(repo, base),
      this.request(repo, `${base}/git/ref/heads/${encodeURIComponent(branch)}`),
      this.request(repo, `${base}/pulls?state=all&head=${encodeURIComponent(repo.fullName.split('/')[0])}:${encodeURIComponent(branch)}&per_page=20`),
      this.request(repo, `${base}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=20`)
    ])
    const selected = pullRequest ? pulls.find((item) => Number(item.number) === Number(pullRequest)) : pulls[0] || null
    let reviews = []
    let checks = []
    if (selected?.number) {
      reviews = await this.request(repo, `${base}/pulls/${selected.number}/reviews?per_page=100`)
      if (selected.head?.sha) checks = await this.request(repo, `${base}/commits/${selected.head.sha}/check-runs?per_page=100`, { headers: { Accept: 'application/vnd.github+json' } })
    }
    const result = {
      repository: { fullName: repository.full_name, defaultBranch: repository.default_branch, permissions: repository.permissions || null },
      branch: { name: branch, sha: ref?.object?.sha || null },
      pullRequest: selected ? { number: selected.number, state: selected.state, merged: selected.merged_at !== null, draft: selected.draft, headSha: selected.head?.sha || null, url: selected.html_url || null } : null,
      reviews: (Array.isArray(reviews) ? reviews : []).map((review) => ({ id: review.id, user: review.user?.login || null, state: review.state, submittedAt: review.submitted_at || null })),
      checks: (checks?.check_runs || []).map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion, url: check.html_url || null })),
      actions: (runs?.workflow_runs || []).slice(0, 20).map((run) => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, sha: run.head_sha, url: run.html_url || null }))
    }
    return this.record(repo, 'inspect', result).result
  }

  async commitWorkspace(repo, { workspacePath, branch, message, remoteWritesEnabled = false, confirm = false } = {}) {
    requireWrite({ remoteWritesEnabled, confirm, action: 'Commit and push' })
    const workspace = path.resolve(String(workspacePath || ''))
    if (!workspace || workspace === path.resolve(String(repo.localPath || ''))) throw deliveryError('ORIGINAL_WORKTREE_REFUSED', 'Delivery requires the isolated worktree, never the original repository path.')
    if (!/^nexus\/auto\/[A-Za-z0-9._-]+$/.test(String(branch || ''))) throw deliveryError('DELIVERY_BRANCH_INVALID', 'Only a NEXUS isolated branch can be pushed automatically.')
    const status = await git(this.execImpl, ['status', '--porcelain'], workspace)
    if (!status) throw deliveryError('NO_CHANGES', 'The isolated worktree has no changes to commit.')
    await git(this.execImpl, ['add', '--all'], workspace)
    await git(this.execImpl, ['commit', '-m', String(message || 'chore: apply verified PROJECT NEXUS task').slice(0, 160)], workspace)
    const sha = await git(this.execImpl, ['rev-parse', 'HEAD'], workspace)
    await git(this.execImpl, ['push', '--set-upstream', 'origin', branch], workspace)
    return this.record(repo, 'commit-push', { branch, sha, workspacePath: workspace }).result
  }

  async createPullRequest(repo, { branch, base = repo.defaultBranch || 'main', title, body, issueNumber = null, remoteWritesEnabled = false, confirm = false } = {}) {
    requireWrite({ remoteWritesEnabled, confirm, action: 'Create pull request' })
    if (!/^nexus\/auto\/[A-Za-z0-9._-]+$/.test(String(branch || ''))) throw deliveryError('DELIVERY_BRANCH_INVALID', 'Only a NEXUS isolated branch can create a pull request.')
    const endpoint = repoPath(repo.fullName)
    const existing = await this.request(repo, `${endpoint}/pulls?state=open&head=${encodeURIComponent(repo.fullName.split('/')[0])}:${encodeURIComponent(branch)}&per_page=10`)
    if (existing?.[0]) return this.record(repo, 'pull-request-reused', { number: existing[0].number, url: existing[0].html_url, reused: true }).result
    const text = `${String(body || '').slice(0, 18_000)}${issueNumber ? `\n\nResolves #${Number(issueNumber)}` : ''}`
    const created = await this.request(repo, `${endpoint}/pulls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: String(title || 'PROJECT NEXUS verified change').slice(0, 240), head: branch, base, body: text, draft: true }) })
    return this.record(repo, 'pull-request-created', { number: created.number, url: created.html_url || null, draft: created.draft === true, branch, base }).result
  }

  async mergePullRequest(repo, { pullRequest, sha = null, method = 'squash', remoteWritesEnabled = false, confirm = false, autoMerge = false } = {}) {
    requireWrite({ remoteWritesEnabled: remoteWritesEnabled && autoMerge, confirm, action: 'Merge pull request' })
    const endpoint = `${repoPath(repo.fullName)}/pulls/${Number(pullRequest)}/merge`
    const merged = await this.request(repo, endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ merge_method: method, ...(sha ? { sha } : {}) }) })
    const result = { merged: merged.merged === true, sha: merged.sha || null, message: merged.message || null, pullRequest: Number(pullRequest) }
    return this.record(repo, 'pull-request-merge', result).result
  }

  async createRelease(repo, { tag, name = tag, body = '', targetCommitish = null, prerelease = false, draft = true, remoteWritesEnabled = false, confirm = false, autoRelease = false } = {}) {
    requireWrite({ remoteWritesEnabled: remoteWritesEnabled && autoRelease, confirm, action: 'Create GitHub release' })
    if (!/^v\d+\.\d+\.\d+$/.test(String(tag || ''))) throw deliveryError('RELEASE_TAG_INVALID', 'Release tags must be stable vX.Y.Z tags.')
    const endpoint = repoPath(repo.fullName)
    const existing = await this.request(repo, `${endpoint}/releases/tags/${encodeURIComponent(tag)}`).then(() => true).catch((error) => error.status === 404 ? false : Promise.reject(error))
    if (existing) throw deliveryError('RELEASE_ALREADY_EXISTS', `Release ${tag} already exists.`)
    const created = await this.request(repo, `${endpoint}/releases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag_name: tag, name, body: String(body).slice(0, 50_000), target_commitish: targetCommitish || undefined, draft, prerelease }) })
    const result = { id: created.id, tag, draft: created.draft === true, published: created.draft === false && Boolean(created.published_at), url: created.html_url || null }
    return this.record(repo, 'release-created', result).result
  }

  async notify(repo, { channel = repo.notifyChannel, event = 'delivery', message, confirm = false } = {}) {
    if (!channel) return this.record(repo, 'notification-skipped', { sent: false, reason: 'no-channel' }).result
    if (confirm !== true) throw deliveryError('CONFIRMATION_REQUIRED', 'Notification delivery requires confirm=true.')
    let url
    try { url = new URL(channel) } catch { throw deliveryError('NOTIFICATION_URL_INVALID', 'Notification channel must be an absolute URL.') }
    if (!['https:', 'http:'].includes(url.protocol)) throw deliveryError('NOTIFICATION_URL_INVALID', 'Notification channel must use HTTP(S).')
    const response = await this.fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, repository: repo.fullName, message: String(message || '').slice(0, 10_000) }), signal: AbortSignal.timeout(20_000) })
    const result = { sent: response.ok, status: response.status, channel: `${url.protocol}//${url.host}` }
    return this.record(repo, 'notification', result).result
  }
}

\n