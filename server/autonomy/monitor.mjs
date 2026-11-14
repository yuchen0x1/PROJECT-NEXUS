// Repository Monitoring Engine (directive 3).
//
// Runs inside the Node service process, never inside a renderer page. Webhook
// deliveries are ingested when available; otherwise (or when they go stale)
// the engine falls back to incremental ETag-based polling automatically.
//
// Every request is a real GitHub REST call. No repository is ever re-cloned by
// a scan: only the changed resource pages are fetched, guarded by a stored
// ETag/last-seen cursor and a stable event fingerprint.

import { MONITOR_RESOURCES, eventFingerprint, evaluateIssueLifecycle, priorityFromFinding, makeId } from './model.mjs'

const DEFAULT_API = 'https://api.github.com'
const PER_PAGE = 100

export function escapeRepoPath(fullName = '') {
  const parts = String(fullName).split('/')
  // Exactly two segments, and neither may be a traversal token. Without this
  // a crafted full name could redirect a request to another API path.
  const [owner, repo] = parts
  const safe = (value) => Boolean(value) && /^[A-Za-z0-9._-]+$/.test(value) && !/^\.\.?$/.test(value) && !value.includes('..')
  if (parts.length !== 2 || !safe(owner) || !safe(repo)) {
    throw Object.assign(new Error(`Invalid repository full name: ${fullName}`), { code: 'AUTONOMY_INVALID_REPO' })
  }
  return `${owner}/${repo}`
}

export function parseNextLink(header = '') {
  const match = String(header).split(',').map((part) => part.trim())
    .find((part) => /rel="next"/.test(part))
  if (!match) return null
  const url = match.match(/<([^>]+)>/)
  return url ? url[1] : null
}

export function backoffMs(failures = 1, retryAfter = null, resetAt = null, now = Date.now()) {
  const exponential = Math.min(15 * 60_000, 30_000 * (2 ** Math.min(5, Math.max(0, failures - 1))))
  const retryDelay = Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 0
  const resetDelay = Number(resetAt) > 0 ? Number(resetAt) * 1000 - now : 0
  return Math.max(exponential, retryDelay, resetDelay, 0)
}

function responseError(response, body) {
  const error = new Error(`GitHub ${response.status}: ${body?.message || response.statusText || 'request failed'}`)
  error.status = response.status
  error.retryAfter = response.headers?.get?.('retry-after') || null
  error.rateReset = response.headers?.get?.('x-ratelimit-reset') || null
  error.rateRemaining = response.headers?.get?.('x-ratelimit-remaining') || null
  error.code = response.status === 429 || (response.status === 403 && error.rateRemaining === '0')
    ? 'GITHUB_RATE_LIMITED'
    : response.status === 403 ? 'GITHUB_FORBIDDEN' : 'GITHUB_REQUEST_FAILED'
  return error
}

export class RepositoryMonitor {
  constructor({
    store,
    token = process.env.GITHUB_TOKEN || '',
    tokenResolver = null,
    apiBase = process.env.GITHUB_API_URL || DEFAULT_API,
    fetchImpl = globalThis.fetch,
    clock = () => Date.now(),
    onFinding = null
  } = {}) {
    this.store = store
    this.token = token
    this.tokenResolver = tokenResolver
    this.apiBase = apiBase.replace(/\/$/, '')
    this.fetchImpl = fetchImpl
    this.clock = clock
    this.onFinding = onFinding
  }

  get configured() { return Boolean(this.token) || Boolean(this.tokenResolver) }

  /** Bind the repository to every request so credentials resolve correctly. */
  requestFor(repo, url, options = {}) {
    return this.request(url, { ...options, repo })
  }

  /** Resolve credentials per repository, including in-app GitHub App tokens. */
  async resolveToken(repo = null) {
    if (!this.tokenResolver || !repo) return this.token
    try {
      const resolved = await this.tokenResolver(repo)
      return typeof resolved === 'string' && resolved ? resolved : this.token
    } catch { return this.token }
  }

  async request(url, { etag = null, accept = 'application/vnd.github+json', repo = null } = {}) {
    const token = await this.resolveToken(repo)
    const headers = {
      Accept: accept,
      'User-Agent': 'PROJECT-NEXUS-Autonomy/2.0',
      'X-GitHub-Api-Version': '2022-11-28'
    }
    if (token) headers.Authorization = `Bearer ${token}`
    if (etag) headers['If-None-Match'] = etag
    const response = await this.fetchImpl(url, { headers })
    if (response.status === 304) {
      return { notModified: true, status: 304, headers: response.headers, items: null, body: null }
    }
    let body = null
    try { body = await response.json() } catch { body = null }
    if (!response.ok) throw responseError(response, body)
    return { notModified: false, status: response.status, headers: response.headers, body }
  }

  cursor(repoId, resource) {
    const id = `${repoId}:${resource}`
    return this.store.get('sync_cursors', id) || {
      id, repoId, resource, etag: null, lastSeenExternalId: null, lastSuccessAt: null,
      failures: 0, nextAttemptAt: null, lastError: null, available: true
    }
  }

  saveCursor(cursor) { return this.store.put('sync_cursors', cursor.id, cursor) }

  /**
   * Fetch one resource incrementally. Returns the normalized new events.
   * A 304 short-circuits without re-downloading anything.
   */
  async syncResource(repo, resource, { force = false } = {}) {
    const cursor = this.cursor(repo.id, resource.id)
    if (!force && cursor.nextAttemptAt && this.clock() < Date.parse(cursor.nextAttemptAt)) {
      return { skipped: true, reason: 'backoff', events: [], resource: resource.id }
    }
    if (!cursor.available && resource.scope === 'extended') {
      return { skipped: true, reason: 'unavailable-scope', events: [], resource: resource.id }
    }

    const repoPath = escapeRepoPath(repo.fullName)
    const base = `${this.apiBase}/repos/${repoPath}${resource.path}`
    const url = resource.path ? `${base}?state=all&per_page=${PER_PAGE}` : base
    const collected = []
    let nextUrl = url
    let pages = 0
    let firstEtag = null

    try {
      while (nextUrl && pages < 20) {
        pages++
        const response = await this.requestFor(repo,nextUrl, { etag: pages === 1 && !force ? cursor.etag : null })
        if (pages === 1) firstEtag = response.headers?.get?.('etag') || null
        if (response.notModified) {
          this.saveCursor({ ...cursor, lastSuccessAt: new Date(this.clock()).toISOString(), failures: 0, nextAttemptAt: null, lastError: null })
          return { skipped: false, notModified: true, events: [], resource: resource.id, pages }
        }
        const items = Array.isArray(response.body) ? response.body : (response.body ? [response.body] : [])
        collected.push(...items)
        const next = parseNextLink(response.headers?.get?.('link') || '')
        nextUrl = next && items.length === PER_PAGE ? next : null
        if (!resource.path) break // repository metadata is a single object
      }
    } catch (error) {
      const unavailable = error.status === 403 || error.status === 404
      const failures = (cursor.failures || 0) + 1
      const delay = backoffMs(failures, error.retryAfter, error.rateReset, this.clock())
      this.saveCursor({
        ...cursor, failures, lastError: String(error.message).slice(0, 300),
        nextAttemptAt: new Date(this.clock() + delay).toISOString(),
        // Extended scopes often need extra permissions; degrade, never block.
        available: unavailable && resource.scope === 'extended' ? false : cursor.available
      })
      return { skipped: false, error: error.code || 'GITHUB_REQUEST_FAILED', message: error.message, events: [], resource: resource.id, degraded: unavailable && resource.scope === 'extended' }
    }

    const ordered = collected
    // First contact establishes a cursor only. Replaying years of history as
    // "new" tasks would be wrong and dangerous for a 24/7 worker.
    const isBaseline = !cursor.lastSeenExternalId
    const fresh = []
    let seenLatest = cursor.lastSeenExternalId
    for (const item of ordered) {
      const externalId = String(item.id ?? item.sha ?? item.number ?? item.name ?? item.node_id ?? '')
      if (!externalId) continue
      if (!isBaseline && externalId === String(cursor.lastSeenExternalId)) break
      fresh.push({ item, externalId })
    }
    if (fresh.length && fresh[0].externalId) seenLatest = fresh[0].externalId
    if (isBaseline) fresh.length = 0

    const events = []
    for (const { item, externalId } of fresh) {
      const version = String(item.updated_at || item.created_at || item.pushed_at || item.sha || item.commit?.committer?.date || '')
      const fingerprint = eventFingerprint({ repoId: repo.id, kind: resource.id, externalId, version })
      if (this.store.get('events', fingerprint)) continue // durable de-duplication
      const event = {
        id: fingerprint, repoId: repo.id, repository: repo.fullName, kind: resource.id,
        externalId, version, occurredAt: version || null, receivedAt: new Date(this.clock()).toISOString(),
        source: 'poll', title: String(item.title || item.name || item.message || item.login || externalId).slice(0, 240),
        payload: summarizeItem(resource.id, item)
      }
      this.store.put('events', fingerprint, event)
      events.push(event)
    }

    this.saveCursor({
      ...cursor,
      etag: firstEtag || cursor.etag,
      lastSeenExternalId: seenLatest,
      lastSuccessAt: new Date(this.clock()).toISOString(),
      failures: 0, nextAttemptAt: null, lastError: null, available: true
    })
    return { skipped: false, notModified: false, events, resource: resource.id, pages, scanned: collected.length }
  }

  /** Persist findings for newly observed events (traceable problem records). */
  async recordFindings(repo, events) {
    const findings = []
    for (const event of events) {
      const finding = findingFromEvent(repo, event)
      if (!finding) continue
      const key = `finding:${event.id}`
      if (this.store.get('findings', key)) continue
      const saved = this.store.put('findings', key, finding)
      findings.push(saved)
      if (this.onFinding) await this.onFinding(saved)
    }
    return findings
  }

  /** Webhook-first: a fresh delivery suppresses the next redundant poll. */
  async ingestWebhook(repo, eventType, deliveryId, payload = {}) {
    const mapping = {
      issues: 'issues', issue_comment: 'issue_comments', pull_request: 'pull_requests',
      pull_request_review: 'pr_reviews', pull_request_review_comment: 'pr_reviews',
      push: 'commits', create: 'branches', delete: 'branches', release: 'releases',
      workflow_run: 'actions_runs', check_run: 'actions_runs',
      dependabot_alert: 'dependabot_alerts', code_scanning_alert: 'code_scanning_alerts',
      secret_scanning_alert: 'secret_scanning_alerts', repository: 'repository'
    }
    const kind = mapping[eventType] || `webhook:${eventType}`
    const externalId = String(deliveryId || payload?.id || payload?.after || payload?.repository?.id || makeId('wh'))
    const fingerprint = eventFingerprint({ repoId: repo.id, kind, externalId, version: String(payload?.updated_at || '') })
    if (this.store.get('events', fingerprint)) return { event: null, duplicate: true }
    const event = {
      id: fingerprint, repoId: repo.id, repository: repo.fullName, kind, externalId,
      version: String(payload?.updated_at || ''), occurredAt: new Date(this.clock()).toISOString(),
      receivedAt: new Date(this.clock()).toISOString(), source: 'webhook',
      title: String(payload?.action || eventType).slice(0, 240), payload: { eventType, action: payload?.action || null }
    }
    this.store.put('events', fingerprint, event)
    this.store.put('repositories', repo.id, { ...repo, lastWebhookAt: new Date(this.clock()).toISOString() })
    const findings = await this.recordFindings(repo, [event])
    this.store.audit('webhook', 'ingest', repo.fullName, { eventType, deliveryId: externalId, events: 1 })
    return { event, duplicate: false, findings }
  }

  /**
   * A webhook is only trusted while deliveries actually arrive. If the last
   * delivery is older than 2 intervals, polling resumes automatically.
   */
  webhookHealthy(repo) {
    if (!repo.webhookEnabled || !repo.lastWebhookAt) return false
    const interval = Number(repo.pollIntervalMs) || 900_000
    return this.clock() - Date.parse(repo.lastWebhookAt) < interval * 2
  }

  async syncRepository(repo, { force = false, resources = null } = {}) {
    if (!repo.enabled) return { repoId: repo.id, skipped: true, reason: 'disabled' }
    if (!this.configured) return { repoId: repo.id, skipped: true, reason: 'no-credentials' }
    const selected = (resources || repo.monitorItems || MONITOR_RESOURCES.filter((r) => r.scope === 'core').map((r) => r.id))
      .map((id) => MONITOR_RESOURCES.find((r) => r.id === id)).filter(Boolean)
    const run = {
      id: makeId('monitor'), repoId: repo.id, repository: repo.fullName,
      startedAt: new Date(this.clock()).toISOString(), mode: this.webhookHealthy(repo) && !force ? 'webhook-assisted' : 'poll',
      resources: [], errors: [], eventCount: 0
    }
    for (const resource of selected) {
      // With a healthy webhook, still poll at a reduced cadence as a safety net.
      if (run.mode === 'webhook-assisted' && !force && resource.scope === 'extended') {
        run.resources.push({ resource: resource.id, skipped: true, reason: 'webhook-active' })
        continue
      }
      const result = await this.syncResource(repo, resource, { force })
      run.resources.push({ resource: result.resource, events: result.events.length, skipped: result.skipped || false,
        notModified: Boolean(result.notModified), error: result.error || null, degraded: Boolean(result.degraded) })
      if (result.error && !result.degraded) run.errors.push({ resource: result.resource, message: result.message })
      const findings = await this.recordFindings(repo, result.events)
      run.eventCount += result.events.length
      run.resources[run.resources.length - 1].findings = findings.length
    }
    run.finishedAt = new Date(this.clock()).toISOString()
    run.verdict = run.errors.length ? 'PARTIAL' : 'PASS'
    this.store.append('monitor_runs', run)
    this.store.audit('monitor', 'sync', repo.fullName, { events: run.eventCount, mode: run.mode, errors: run.errors.length })
    return run
  }

  async pollDue({ force = false } = {}) {
    const repos = this.store.list('repositories', { filter: (repo) => repo.enabled !== false })
    const results = []
    for (const repo of repos) {
      const interval = Number(repo.pollIntervalMs) || 900_000
      const cursor = this.cursor(repo.id, 'issues')
      if (!force && cursor.lastSuccessAt && this.clock() - Date.parse(cursor.lastSuccessAt) < interval) {
        results.push({ repoId: repo.id, skipped: true, reason: 'not-due' })
        continue
      }
      results.push(await this.syncRepository(repo, { force }))
    }
    return results
  }

  // ---- Issue lifecycle: a closed issue is not a resolved issue -------------

  /**
   * Gather real evidence from GitHub before classifying an issue. Every check
   * is a separate API call; any failure lowers confidence instead of faking a
   * resolution.
   */
  async assessIssue(repo, issueNumber, { issue = null, regressionTestResult = null } = {}) {
    const repoPath = escapeRepoPath(repo.fullName)
    const evidence = { linkedPullRequest: null, pullRequestMerged: false, relatedCommits: [],
      fixPresentInTargetBranch: false, testsPassed: false, reproducible: null,
      newCommentsReportingProblem: 0, regressionDetected: false, reviewApproved: false, checks: [] }
    const issueData = issue || await this.requestFor(repo,`${this.apiBase}/repos/${repoPath}/issues/${issueNumber}`)
      .then((r) => r.body).catch(() => null)
    if (!issueData) return { lifecycle: 'UNCONFIRMABLE', evidence, error: 'ISSUE_NOT_READABLE' }

    // Timeline reveals cross-referenced/connected PRs and commits.
    const timeline = await this.requestFor(repo,`${this.apiBase}/repos/${repoPath}/issues/${issueNumber}/timeline?per_page=100`)
      .then((r) => (Array.isArray(r.body) ? r.body : [])).catch(() => [])
    const crossRefs = timeline.filter((entry) => entry.event === 'cross-referenced' && entry.source?.issue?.pull_request)
    const refs = timeline.filter((entry) => entry.event === 'referenced' || entry.event === 'closed')
    if (crossRefs.length) {
      const pr = crossRefs[0].source.issue
      evidence.linkedPullRequest = pr.number
      const prData = await this.requestFor(repo,`${this.apiBase}/repos/${repoPath}/pulls/${pr.number}`)
        .then((r) => r.body).catch(() => null)
      if (prData) {
        evidence.pullRequestMerged = Boolean(prData.merged)
        const reviews = await this.requestFor(repo,`${this.apiBase}/repos/${repoPath}/pulls/${pr.number}/reviews?per_page=100`)
          .then((r) => (Array.isArray(r.body) ? r.body : [])).catch(() => [])
        evidence.reviewApproved = reviews.some((review) => String(review.state).toUpperCase() === 'APPROVED')
        if (prData.merge_commit_sha) {
          // compare proves the fix is actually inside the target branch
          const compare = await this.requestFor(repo,`${this.apiBase}/repos/${repoPath}/compare/${encodeURIComponent(prData.base.sha)}...${encodeURIComponent(prData.merge_commit_sha)}`)
            .then((r) => r.body).catch(() => null)
          evidence.fixPresentInTargetBranch = Boolean(compare && (compare.status === 'ahead' || (compare.commits || []).length > 0))
        }
      }
    }
    evidence.relatedCommits = refs.map((entry) => String(entry.commit_id || '')).filter(Boolean)

    const comments = await this.requestFor(repo,`${this.apiBase}/repos/${repoPath}/issues/${issueNumber}/comments?per_page=100`)
      .then((r) => (Array.isArray(r.body) ? r.body : [])).catch(() => [])
    const problemWords = /still (?:happens|broken|fails)|regression|not fixed|reproduc|再次|仍然|复现/i
    evidence.newCommentsReportingProblem = comments.filter((comment) => problemWords.test(String(comment.body || ''))).length
    evidence.regressionDetected = comments.some((comment) => /regress/i.test(String(comment.body || '')))

    // CI evidence is used as the independent test signal, never the AI's claim.
    const runs = await this.requestFor(repo,`${this.apiBase}/repos/${repoPath}/actions/runs?per_page=10`)
      .then((r) => r.body?.workflow_runs || []).catch(() => [])
    evidence.testsPassed = Boolean(runs.length) && runs[0]?.conclusion === 'success'

    // "Not reproducible" may only be asserted when an independent regression
    // test reported that. It is never inferred from a closed issue.
    if (regressionTestResult === 'not-reproducible' && !evidence.regressionDetected && evidence.newCommentsReportingProblem === 0) {
      evidence.reproducible = false
    }

    const previous = this.store.get('issues', `${repo.id}:${issueNumber}`)
    const lifecycle = evaluateIssueLifecycle(issueData, {
      ...evidence, previouslyVerified: previous?.lifecycle === 'VERIFIED_RESOLVED',
      priorFixMerged: Boolean(previous?.evidence?.pullRequestMerged)
    })
    const record = this.store.put('issues', `${repo.id}:${issueNumber}`, {
      id: `${repo.id}:${issueNumber}`, repoId: repo.id, number: Number(issueNumber),
      githubState: issueData.state, lifecycle, title: String(issueData.title || '').slice(0, 300),
      evidence, updatedAt: new Date(this.clock()).toISOString(), confidence: confidenceOf(evidence)
    })
    this.store.audit('monitor', 'issue-lifecycle', `${repo.fullName}#${issueNumber}`, { lifecycle, confidence: record.confidence })
    return { lifecycle, confidence: record.confidence, evidence, issue: record }
  }
}

function confidenceOf(evidence) {
  const values = [Boolean(evidence.linkedPullRequest), evidence.pullRequestMerged,
    evidence.relatedCommits.length > 0, evidence.fixPresentInTargetBranch,
    evidence.testsPassed, evidence.reviewApproved]
  return Math.round((values.filter(Boolean).length / values.length) * 100) / 100
}

function summarizeItem(kind, item) {
  const base = { state: item.state || null, action: item.action || null, htmlUrl: item.html_url || item.url || null }
  if (kind === 'commits') return { ...base, sha: item.sha || null, message: String(item.commit?.message || '').slice(0, 300), author: item.commit?.author?.name || null }
  if (kind === 'issues' || kind === 'pull_requests') return { ...base, number: item.number || null, title: item.title || null, labels: (item.labels || []).map((l) => l.name), merged: item.merged ?? null, draft: item.draft ?? null }
  if (kind === 'releases') return { ...base, tag: item.tag_name || null, name: item.name || null, draft: item.draft ?? null, prerelease: item.prerelease ?? null }
  if (kind === 'actions_runs') return { ...base, conclusion: item.conclusion || null, status: item.status || null, name: item.name || null, headSha: item.head_sha || null }
  if (kind.endsWith('alerts') || kind === 'security_advisories') return { ...base, severity: item.security_advisory?.severity || item.severity || null, number: item.number || null, state: item.state || null }
  if (kind === 'repository') return { defaultBranch: item.default_branch, archived: item.archived, pushedAt: item.pushed_at, private: item.private, visibility: item.visibility }
  return { ...base, number: item.number || null, body: String(item.body || '').slice(0, 400) }
}

function findingFromEvent(repo, event) {
  const p = event.payload || {}
  let kind = event.kind
  let severity = 'low'
  let title = `${event.kind} ${event.title}`
  if (kind === 'secret_scanning_alerts' || kind === 'dependabot_alerts' || kind === 'code_scanning_alerts' || kind === 'security_advisories') {
    kind = `security:${kind}`
    severity = String(p.severity || 'high').toLowerCase().includes('critical') ? 'critical' : 'high'
    title = `Security alert: ${event.title}`
  } else if (kind === 'actions_runs' && (p.conclusion === 'failure' || p.conclusion === 'timed_out')) {
    kind = 'ci_failure'
    severity = 'high'
    title = `CI failure: ${p.name || event.title}`
  } else if (kind === 'issues' && p.state === 'open') {
    kind = 'bug'
    severity = 'medium'
    title = `Issue: ${p.title || event.title}`
  } else if (kind === 'pr_reviews') {
    kind = 'review_feedback'
    severity = 'medium'
  } else if (kind === 'releases') {
    kind = 'release_change'
    severity = 'info'
  } else if (kind === 'repository') {
    kind = 'config_change'
    severity = 'low'
  } else if (kind === 'commits' || kind === 'branches') {
    return null // ordinary activity, no problem record needed
  }
  return {
    id: `finding:${event.id}`, repoId: repo.id, repository: repo.fullName, eventId: event.id,
    kind, severity, title: String(title).slice(0, 300), evidence: p,
    priority: priorityFromFinding({ kind, severity }), status: 'OPEN',
    createdAt: event.receivedAt, source: event.source
  }
}

export { MONITOR_RESOURCES }
