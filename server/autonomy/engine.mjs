// Autonomy Engine & durable scheduler (directives 10, 12, 14).
//
// Lives in the Node service process. It keeps running when the Electron window
// is hidden to the tray; a page is only a viewer, never the scheduler.
//
// Guarantees: P0-P4 priority, global concurrency cap, one writer per
// repository, one busy client per adapter, idempotent task creation, bounded
// retries with exponential backoff, timeouts, pause/cancel/takeover, and
// restart recovery that preserves the scene instead of replaying a send.

import os from 'node:os'
import path from 'node:path'
import {
  PRIORITIES, TERMINAL_TASK_STATUSES, TASK_STATUSES, assertTaskTransition,
  AGENT_TERMINAL_STATES, idempotencyKey, makeId, priorityFromFinding,
  MONITOR_RESOURCES, DEFAULT_POLL_INTERVALS_MS
} from './model.mjs'
import { backoffMs, RepositoryMonitor } from './monitor.mjs'
import { buildTaskPackage } from './task-package.mjs'
import { createAdapterRegistry } from './desktop/adapters.mjs'
import { createWorkspaceManager } from './workspace.mjs'
import { detectVerificationCommands, verifyTask, evaluateReleaseGate, computeNextVersion, classifyChange, buildReleaseNotes, createReleaseRecord } from './reviewer.mjs'
import { assessReadiness, discoverPeerProjects, savePeerProjects, trackPeerChanges, analyzePortingOpportunity, createPortingProposal } from './intelligence.mjs'

const RUNNING_TASK_STATES = ['DISPATCHED', 'IN_PROGRESS', 'VERIFYING']
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000

function nowIso(clock) { return new Date(clock()).toISOString() }

export class AutonomyEngine {
  constructor({
    store, dataDir = process.cwd(), token = process.env.GITHUB_TOKEN || '',
    tokenResolver = null,
    clock = () => Date.now(), fetchImpl = globalThis.fetch,
    monitor = null, adapters = null, workspaceManager = null,
    maxConcurrent = 2, execImpl = undefined, uiaDriverFactory = null
  } = {}) {
    this.store = store
    this.dataDir = dataDir
    this.clock = clock
    this.fetchImpl = fetchImpl
    this.monitor = monitor || new RepositoryMonitor({ store, token, tokenResolver, fetchImpl, clock })
    this.adapters = adapters || createAdapterRegistry({ store, dataDir, uia: uiaDriverFactory })
    this.workspace = workspaceManager || createWorkspaceManager({ dataDir, ...(execImpl ? { execImpl } : {}) })
    this.maxConcurrent = Math.max(1, Math.min(Math.max(1, os.cpus().length - 1), maxConcurrent))
    this.settings = this.loadSettings()
  }

  loadSettings() {
    const saved = this.store.getSetting('autonomySettings') || {}
    return {
      enabled: saved.enabled ?? true,
      paused: saved.paused ?? false,
      automationMode: saved.automationMode || 'observe',
      maxConcurrent: saved.maxConcurrent || this.maxConcurrent,
      aiApiConfigured: saved.aiApiConfigured ?? false,
      remoteWritesEnabled: saved.remoteWritesEnabled ?? false,
      researchEnabled: saved.researchEnabled ?? false,
      updatedAt: saved.updatedAt || nowIso(this.clock)
    }
  }

  saveSettings(patch = {}) {
    this.settings = { ...this.settings, ...patch, updatedAt: nowIso(this.clock) }
    this.store.setSetting('autonomySettings', this.settings)
    this.store.audit('control', 'settings-updated', 'global', { patch })
    return this.settings
  }

  // ---- Control plane -------------------------------------------------------

  start() { return this.saveSettings({ enabled: true, paused: false }) }
  pause() { return this.saveSettings({ paused: true }) }
  resume() { return this.saveSettings({ paused: false }) }
  stopCurrent() {
    const active = this.store.list('tasks', { filter: (task) => RUNNING_TASK_STATES.includes(task.status) })
    for (const task of active) {
      this.updateTask(task, 'CANCELLED', { detail: 'Operator stopped the current task.' })
      const sessions = this.store.list('agent_sessions', { filter: (session) => session.taskId === task.id && !AGENT_TERMINAL_STATES.includes(session.state) })
      for (const session of sessions) {
        this.store.put('agent_sessions', session.id, { ...session, state: 'NEEDS_HUMAN_HANDOFF', handoff: true, error: 'Stopped by operator.' })
      }
    }
    this.store.audit('control', 'stop-current', 'global', { tasks: active.length })
    return { stopped: active.length, taskIds: active.map((task) => task.id) }
  }

  status() {
    const tasks = this.store.list('tasks')
    const sessions = this.store.list('agent_sessions')
    return {
      ...this.settings,
      repositories: this.store.count('repositories'),
      tasks: { total: tasks.length, queued: tasks.filter((t) => t.status === 'QUEUED').length,
        running: tasks.filter((t) => RUNNING_TASK_STATES.includes(t.status)).length,
        awaitingHuman: tasks.filter((t) => t.status === 'AWAITING_HUMAN').length,
        accepted: tasks.filter((t) => t.status === 'ACCEPTED').length },
      sessions: { total: sessions.length, active: sessions.filter((s) => !AGENT_TERMINAL_STATES.includes(s.state)).length,
        handoff: sessions.filter((s) => s.handoff && !AGENT_TERMINAL_STATES.includes(s.state)).length },
      monitorConfigured: this.monitor.configured,
      lastTickAt: this.store.getSetting('lastTickAt') || null,
      storeBackend: this.store.backend
    }
  }

  // ---- Repositories --------------------------------------------------------

  addRepository(input = {}) {
    if (!input.fullName || !/^[^/\s]+\/[^/\s]+$/.test(String(input.fullName))) {
      throw Object.assign(new Error('fullName must be owner/repo.'), { code: 'AUTONOMY_INVALID_REPO' })
    }
    const id = makeId('repo')
    const record = this.store.put('repositories', id, {
      id, fullName: String(input.fullName), localPath: String(input.localPath || ''),
      defaultBranch: input.defaultBranch || 'main',
      pollIntervalMs: Number(input.pollIntervalMs) || DEFAULT_POLL_INTERVALS_MS['15m'],
      monitorItems: Array.isArray(input.monitorItems) ? input.monitorItems : MONITOR_RESOURCES.filter((r) => r.scope === 'core').map((r) => r.id),
      agentAdapterId: input.agentAdapterId || null,
      agentProjectRef: String(input.agentProjectRef || ''),
      autoFix: Boolean(input.autoFix), autoMerge: Boolean(input.autoMerge), autoRelease: Boolean(input.autoRelease),
      automationMode: input.automationMode || this.settings.automationMode,
      notifyChannel: input.notifyChannel || null,
      webhookEnabled: Boolean(input.webhookEnabled), lastWebhookAt: null,
      enabled: input.enabled !== false, stack: input.stack || null,
      createdAt: nowIso(this.clock), updatedAt: nowIso(this.clock)
    })
    this.store.audit('repository', 'added', record.fullName, { id, localPath: record.localPath })
    return record
  }

  updateRepository(id, patch = {}) {
    const current = this.store.get('repositories', id)
    if (!current) return null
    const forbidden = ['id', 'createdAt']
    const clean = Object.fromEntries(Object.entries(patch).filter(([key]) => !forbidden.includes(key)))
    const updated = this.store.put('repositories', id, { ...current, ...clean, updatedAt: nowIso(this.clock) })
    this.store.audit('repository', 'updated', updated.fullName, { fields: Object.keys(clean) })
    return updated
  }

  removeRepository(id) {
    const current = this.store.get('repositories', id)
    if (!current) return false
    this.store.delete('repositories', id)
    this.store.audit('repository', 'removed', current.fullName, { id })
    return true
  }

  // ---- Tasks ---------------------------------------------------------------

  createTask({ repoId, kind = 'fix', priority = 'P2', findings = [], references = [], source = 'monitor', writeTask = true, plan = {} } = {}) {
    const repo = this.store.get('repositories', repoId)
    if (!repo) throw Object.assign(new Error('Repository not found.'), { code: 'AUTONOMY_REPO_NOT_FOUND' })
    if (!PRIORITIES.includes(priority)) priority = 'P2'
    const findingIds = findings.map((finding) => String(finding.id)).sort()
    const key = idempotencyKey([repoId, kind, findingIds.join(','), source])
    const existing = this.store.list('tasks', { filter: (task) => task.idempotencyKey === key })
    if (existing.length) {
      const open = existing.find((task) => !TERMINAL_TASK_STATUSES.includes(task.status))
      return { task: open || existing[0], reused: true }
    }
    if (this.store.list('tasks', { filter: (task) => task.status === 'QUEUED' }).length >= 200) {
      throw Object.assign(new Error('Task queue is full (200).'), { code: 'AUTONOMY_QUEUE_FULL' })
    }
    const task = this.store.put('tasks', makeId('task'), {
      idempotencyKey: key, repoId, repository: repo.fullName, kind, priority,
      status: 'QUEUED', source, writeTask, findingIds,
      findings: findings.map((finding) => ({ id: finding.id, title: finding.title, kind: finding.kind, severity: finding.severity, priority: finding.priority, evidence: finding.evidence })),
      references, plan, attempts: 0, maxAttempts: DEFAULT_MAX_ATTEMPTS,
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS, nextAttemptAt: null,
      createdAt: nowIso(this.clock), updatedAt: nowIso(this.clock),
      events: [], workspace: null, verification: null, release: null, error: null,
      checkpoint: { version: 1, phase: 'QUEUED', status: 'QUEUED', attempts: 0, at: nowIso(this.clock) }
    })
    this.appendTaskEvent(task, 'QUEUED', `Task created from ${source} with ${findings.length} finding(s).`)
    this.store.audit('task', 'created', task.id, { repo: repo.fullName, priority, kind })
    return { task, reused: false }
  }

  updateTask(task, status, { detail = '', patch = {} } = {}) {
    assertTaskTransition(task.status, status)
    const updatedAt = nowIso(this.clock)
    const updated = this.store.put('tasks', task.id, { ...task, ...patch, status, updatedAt })
    const event = this.appendTaskEvent(updated, status, detail)
    // A checkpoint is the last safe durable boundary for scheduler recovery.
    // It records no secrets or model output; the task package and worktree
    // remain the source of truth for any later independent verification.
    return this.store.put('tasks', task.id, {
      ...updated,
      checkpoint: {
        version: 1, phase: status, status, at: updatedAt,
        eventId: event?.id || null, attempts: Number(updated.attempts || 0),
        nextAttemptAt: updated.nextAttemptAt || null,
        workspace: updated.workspace ? {
          path: updated.workspace.path || null, branch: updated.workspace.branch || null,
          baseSha: updated.workspace.baseSha || null, isolated: updated.workspace.isolated === true
        } : null
      }
    })
  }

  appendTaskEvent(task, phase, detail, level = 'info') {
    return this.store.append('task_events', {
      taskId: task.id, at: nowIso(this.clock), phase, detail: String(detail).slice(0, 1000), level
    })
  }

  taskEvents(taskId) {
    return this.store.list('task_events', { filter: (event) => event.taskId === taskId })
  }

  cancelTask(taskId, reason = 'Cancelled by operator') {
    const task = this.store.get('tasks', taskId)
    if (!task) return null
    if (TERMINAL_TASK_STATUSES.includes(task.status)) return task
    return this.updateTask(task, 'CANCELLED', { detail: reason })
  }

  pauseTask(taskId) {
    const task = this.store.get('tasks', taskId)
    if (!task || task.status !== 'QUEUED') return task || null
    return this.updateTask(task, 'PAUSED', { detail: 'Paused by operator.' })
  }

  resumeTask(taskId) {
    const task = this.store.get('tasks', taskId)
    if (!task || task.status !== 'PAUSED') return task || null
    return this.updateTask(task, 'QUEUED', { detail: 'Resumed by operator.' })
  }

  retryTask(taskId) {
    const task = this.store.get('tasks', taskId)
    if (!task || !['FAILED', 'REJECTED', 'EXPIRED', 'BLOCKED'].includes(task.status)) return task || null
    return this.updateTask(task, 'QUEUED', { detail: 'Manual retry.', patch: { attempts: 0, nextAttemptAt: null, error: null } })
  }

  takeover(taskId, note = 'Operator took over this task.') {
    const task = this.store.get('tasks', taskId)
    if (!task) return null
    const updated = TERMINAL_TASK_STATUSES.includes(task.status) ? task
      : this.updateTask(task, 'AWAITING_HUMAN', { detail: note })
    this.store.audit('control', 'takeover', task.id, { note })
    return updated
  }

  // ---- Scheduling ----------------------------------------------------------

  canAdmit(task, running) {
    if (task.writeTask && running.some((other) => other.repoId === task.repoId && other.writeTask)) {
      return { allowed: false, reason: 'REPO_WRITE_LOCK' }
    }
    const repo = this.store.get('repositories', task.repoId)
    const adapterId = repo?.agentAdapterId
    if (adapterId) {
      const busy = this.store.list('agent_sessions', {
        filter: (session) => session.adapterId === adapterId && !AGENT_TERMINAL_STATES.includes(session.state)
      })
      if (busy.length) return { allowed: false, reason: 'CLIENT_BUSY' }
    }
    return { allowed: true, reason: null }
  }

  async dispatch(task) {
    const repo = this.store.get('repositories', task.repoId)
    if (!repo) return this.updateTask(task, 'BLOCKED', { detail: 'Repository disappeared.' })
    const adapter = this.adapters.get(repo.agentAdapterId || 'chatgpt-desktop')
    if (!adapter) return this.updateTask(task, 'BLOCKED', { detail: 'No desktop adapter is configured.' })

    let workspace = null
    if (task.writeTask && repo.automationMode !== 'observe') {
      try {
        workspace = await this.workspace.prepare(repo, { taskId: task.id })
      } catch (error) {
        return this.updateTask(task, 'BLOCKED', { detail: `Workspace preparation failed: ${error.message}`, patch: { error: error.code || 'WORKSPACE_FAILED' } })
      }
    } else {
      workspace = { taskId: task.id, repoId: repo.id, path: repo.localPath, branch: repo.defaultBranch,
        baseSha: '', isolated: false, worktree: false }
    }

    const pkg = buildTaskPackage({
      repo, workspace, findings: task.findings, references: task.references, plan: task.plan, task
    })
    const session = adapter.createSession({ task, repo, pkg })
    task = this.updateTask(task, 'DISPATCHED', {
      detail: `Dispatched to ${adapter.name}`,
      patch: { workspace, packageHash: pkg.hash, sessionId: session.id, startedAt: nowIso(this.clock), timeoutAt: new Date(this.clock() + task.timeoutMs).toISOString() }
    })

    const detection = await adapter.detect().catch(() => null)
    this.appendTaskEvent(task, 'DISPATCHED', `Client detection: ${detection ? `${detection.name} installed=${detection.installed} running=${detection.running}` : 'unavailable'}`)
    const result = await adapter.sendTask(session, pkg, repo, {
      selection: { projectRef: repo.agentProjectRef, workspacePath: workspace.path }
    }).catch((error) => ({ error, session }))

    if (result.error) {
      task = this.updateTask(task, 'AWAITING_HUMAN', {
        detail: `Dispatch stopped: ${result.error.code || ''} ${result.error.message}`,
        patch: { error: result.error.code || 'DISPATCH_FAILED', packageFile: null }
      })
      this.store.audit('adapter', 'dispatch-stopped', task.id, { code: result.error.code, message: result.error.message })
      return task
    }
    if (result.humanHandoff) {
      return this.updateTask(task, 'AWAITING_HUMAN', {
        detail: `Human handoff required: ${result.reason}`,
        patch: { packageFile: result.packageFile, handoffReason: result.reason }
      })
    }
    return this.updateTask(task, 'IN_PROGRESS', { detail: `Executing on ${adapter.name}.` })
  }

  /** Mark a session terminal so it stops occupying its desktop client. */
  releaseSession(task, state, reason) {
    if (!task.sessionId) return null
    const session = this.store.get('agent_sessions', task.sessionId)
    if (!session || AGENT_TERMINAL_STATES.includes(session.state)) return session
    return this.store.put('agent_sessions', session.id, {
      ...session, state, handoff: state === 'NEEDS_HUMAN_HANDOFF', error: reason
    })
  }

  /** Independent verification + bounded repair loop (directive 8). */
  async finalize(task, { force = false } = {}) {
    const repo = this.store.get('repositories', task.repoId)
    if (!repo || !task.workspace) return this.updateTask(task, 'BLOCKED', { detail: 'Missing workspace for verification.' })
    const diff = await this.workspace.collectDiff(task.workspace).catch(() => null)
    if (!diff) return this.updateTask(task, 'FAILED', { detail: 'Could not collect the git diff.' })
    const scope = this.workspace.reviewScope(diff)
    const commands = await detectVerificationCommands(task.workspace.path)
    const report = await verifyTask({
      store: this.store, workspace: task.workspace, diff, commands,
      scopeReview: scope, clock: this.clock
    })
    task = this.updateTask(task, 'VERIFYING', { detail: `Independent verification: ${report.verdict}`, patch: { verification: { id: report.id, verdict: report.verdict } } })
    // Acceptance is independent of the AI client; close its session here so
    // the adapter is free for the next task (or for the bounded repair round).
    this.releaseSession(task, report.verdict === 'PASS' ? 'SUCCEEDED' : 'FAILED',
      `Independent verification ${report.verdict}`)

    if (report.verdict === 'PASS') {
      let release = null
      const gate = evaluateReleaseGate({
        repo, task, report, diff, automationMode: repo.automationMode,
        remoteWritesEnabled: this.settings.remoteWritesEnabled,
        explicitApproval: false, // never implied; a separate explicit switch
        existingRelease: this.store.list('releases', { filter: (item) => item.repoId === repo.id, limit: 1, order: 'desc' })[0]
      })
      if (gate.allowed) {
        const version = computeNextVersion(repo.currentVersion || '0.0.0', classifyChange(task.findings, diff))
        release = createReleaseRecord({
          store: this.store, repo, task, diff, report, findings: task.findings,
          version, notes: buildReleaseNotes({ version, repo, task, findings: task.findings, report, diff }), gate
        })
      }
      return this.updateTask(task, 'ACCEPTED', {
        detail: `Independent acceptance passed${release ? `; release v${release.version} prepared` : '; release gate not opened'}`,
        patch: { diff: { fileCount: diff.fileCount, changedFiles: diff.changedFiles }, release: release ? { id: release.id, version: release.version } : null, finishedAt: nowIso(this.clock) }
      })
    }

    const attempts = (task.attempts || 0) + 1
    if (attempts < (task.maxAttempts || DEFAULT_MAX_ATTEMPTS) && !force) {
      const delay = backoffMs(attempts, null, null, this.clock())
      return this.updateTask(task, 'QUEUED', {
        detail: `Verification failed (${report.failures.length} issue(s)); scheduling repair attempt ${attempts + 1}.`,
        patch: { attempts, nextAttemptAt: new Date(this.clock() + delay).toISOString(),
          verification: { id: report.id, verdict: 'FAIL', failures: report.failures } }
      })
    }
    return this.updateTask(task, 'AWAITING_HUMAN', {
      detail: `Verification failed after ${attempts} attempt(s); moved to the human queue.`,
      patch: { attempts, verification: { id: report.id, verdict: 'FAIL', failures: report.failures }, error: 'VERIFICATION_EXHAUSTED' }
    })
  }

  /** One scheduler turn. Called by the service timer, not by any UI page. */
  async tick({ doMonitor = true, doResearch = false, force = false } = {}) {
    if (!this.settings.enabled) return { skipped: true, reason: 'disabled' }
    const result = { at: nowIso(this.clock), monitor: [], dispatched: [], verified: [], expired: [], skipped: [], errors: [] }
    this.store.setSetting('lastTickAt', result.at)

    if (doMonitor) {
      try { result.monitor = await this.monitor.pollDue({ force }) } catch (error) { result.errors.push({ stage: 'monitor', message: error.message }) }
      for (const finding of this.store.list('findings', { filter: (item) => item.status === 'OPEN' && !item.taskId })) {
        const repo = this.store.get('repositories', finding.repoId)
        if (!repo || repo.automationMode === 'observe') continue
        const { task, reused } = this.createTask({
          repoId: finding.repoId, kind: 'fix', priority: finding.priority || priorityFromFinding(finding),
          findings: [finding], source: 'monitor'
        })
        this.store.put('findings', finding.id, { ...finding, taskId: task.id })
        if (!reused) result.dispatched.push({ taskId: task.id, source: 'finding' })
      }
    }

    if (doResearch && this.settings.researchEnabled) {
      try { result.research = await this.runResearch() } catch (error) { result.errors.push({ stage: 'research', message: error.message }) }
    }

    const all = this.store.list('tasks')
    const running = all.filter((task) => RUNNING_TASK_STATES.includes(task.status))

    // Timeout enforcement - no infinite loops.
    for (const task of running) {
      if (task.timeoutAt && this.clock() > Date.parse(task.timeoutAt)) {
        const updated = this.updateTask(task, 'EXPIRED', { detail: 'Task exceeded its deadline.' })
        // Release the client slot. A stale RUNNING session would otherwise
        // block every later task for that adapter forever.
        this.releaseSession(task, 'NEEDS_HUMAN_HANDOFF', 'Task expired; confirm the client state manually.')
        result.expired.push(updated.id)
      }
    }

    if (!this.settings.paused) {
      const pending = all
        .filter((task) => task.status === 'QUEUED')
        .filter((task) => !task.nextAttemptAt || this.clock() >= Date.parse(task.nextAttemptAt))
        .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || Date.parse(a.createdAt) - Date.parse(b.createdAt))
      let active = this.store.list('tasks', { filter: (task) => RUNNING_TASK_STATES.includes(task.status) })
      for (const task of pending) {
        if (active.length >= this.settings.maxConcurrent) { result.skipped.push({ taskId: task.id, reason: 'CONCURRENCY_LIMIT' }); continue }
        const admission = this.canAdmit(task, active)
        if (!admission.allowed) { result.skipped.push({ taskId: task.id, reason: admission.reason }); continue }
        try {
          const updated = await this.dispatch(task)
          // Only genuinely running tasks consume a concurrency slot. A task
          // that fell into human handoff / blocked must not hold the queue.
          if (RUNNING_TASK_STATES.includes(updated.status)) active.push(updated)
          result.dispatched.push({ taskId: task.id, status: updated.status })
        } catch (error) {
          result.errors.push({ stage: 'dispatch', taskId: task.id, message: String(error.message).slice(0, 300) })
        }
      }
    }

    // Advance live sessions with real state observation.
    for (const task of this.store.list('tasks', { filter: (item) => item.status === 'IN_PROGRESS' })) {
      const repo = this.store.get('repositories', task.repoId)
      const adapter = this.adapters.get(repo?.agentAdapterId || 'chatgpt-desktop')
      const session = task.sessionId ? this.store.get('agent_sessions', task.sessionId) : null
      if (!adapter || !session || AGENT_TERMINAL_STATES.includes(session.state)) continue
      try {
        const polled = await adapter.pollState(session, { deadlineMs: task.timeoutAt ? Date.parse(task.timeoutAt) : 0 })
        if (['SUCCEEDED', 'TIMEOUT', 'CLIENT_EXITED', 'FAILED'].includes(polled.signal)) {
          if (polled.signal === 'SUCCEEDED') {
            const verified = await this.finalize(task)
            result.verified.push({ taskId: task.id, verdict: verified.status })
          } else if (polled.signal === 'TIMEOUT') {
            result.expired.push(task.id)
            this.updateTask(task, 'EXPIRED', { detail: 'Desktop agent timed out.' })
          } else {
            this.updateTask(task, 'AWAITING_HUMAN', { detail: `Desktop agent state: ${polled.signal}` })
          }
        }
      } catch (error) {
        result.errors.push({ stage: 'poll', taskId: task.id, message: String(error.message).slice(0, 300) })
      }
    }
    this.store.setSetting('lastTickResult', { at: result.at, dispatched: result.dispatched.length, verified: result.verified.length, errors: result.errors.length })
    return result
  }

  /** Research loop: discover, persist, track real changes, propose ports. */
  async runResearch({ query = null, topics = [] } = {}) {
    const repos = this.store.list('repositories', { filter: (repo) => repo.enabled !== false })
    const results = []
    for (const repo of repos) {
      const terms = query || `${repo.fullName.split('/')[1]} AI agent automation desktop`
      const resolvedToken = await this.monitor.resolveToken(repo)
      const found = await discoverPeerProjects({ query: terms, topics, token: resolvedToken, fetchImpl: this.fetchImpl, limit: 8 })
      if (!found.ok) { results.push({ repo: repo.fullName, error: found.code }); continue }
      const saved = savePeerProjects(this.store, found.items.filter((item) => item.fullName !== repo.fullName), { repoId: repo.id })
      let proposals = 0
      for (const peer of saved.slice(0, 3)) {
        const changes = await trackPeerChanges({ peer, token: resolvedToken, fetchImpl: this.fetchImpl })
        const newest = [...changes.releases, ...changes.commits].filter((item) => item.title)[0]
        if (!newest) continue
        const analysis = analyzePortingOpportunity({
          peer, change: newest,
          currentProject: { existingCapabilities: ['monitoring', 'worktree', 'independent verification', 'desktop adapters'], candidateFiles: [] }
        })
        createPortingProposal({ store: this.store, repo, peer, change: newest, analysis })
        proposals++
      }
      results.push({ repo: repo.fullName, discovered: found.items.length, saved: saved.length, proposals })
    }
    this.store.audit('intelligence', 'research-run', 'global', { repositories: results.length })
    return results
  }

  /** Restart recovery: preserve the scene, never re-send automatically. */
  recover() {
    const recovered = { interrupted: [], requeued: [], preservedSessions: [] }
    for (const task of this.store.list('tasks')) {
      if (['DISPATCHED', 'IN_PROGRESS', 'VERIFYING'].includes(task.status)) {
        recovered.interrupted.push(task.id)
        this.store.put('tasks', task.id, {
          ...task, status: 'AWAITING_HUMAN', updatedAt: nowIso(this.clock),
          error: 'RESTARTED: verify the client and git workspace state before resuming.'
        })
        this.appendTaskEvent({ id: task.id }, 'AWAITING_HUMAN', 'Recovered after restart; no task was re-sent.')
      } else if (task.status === 'PAUSED') {
        recovered.requeued.push(task.id)
      }
    }
    for (const session of this.store.list('agent_sessions', { filter: (item) => !AGENT_TERMINAL_STATES.includes(item.state) })) {
      this.store.put('agent_sessions', session.id, {
        ...session, handoff: true, handoffReason: 'Application restarted; confirm client state before continuing.'
      })
      recovered.preservedSessions.push(session.id)
    }
    this.store.audit('control', 'recover', 'global', recovered)
    return recovered
  }

  /** Homepage metrics (directive 13): all values come from persisted records. */
  overview() {
    const repos = this.store.list('repositories')
    const tasks = this.store.list('tasks')
    const findings = this.store.list('findings')
    const sessions = this.store.list('agent_sessions')
    const peers = this.store.list('peer_projects')
    const releases = this.store.list('releases')
    const runs = this.store.list('monitor_runs', { order: 'desc', limit: 12 })
    const activeSessions = sessions.filter((session) => !AGENT_TERMINAL_STATES.includes(session.state) && !session.handoff)
    const lastRelease = releases.length ? releases[releases.length - 1] : null
    const healthy = repos.filter((repo) => {
      const failures = this.store.list('monitor_runs', { filter: (run) => run.repoId === repo.id, limit: 1, order: 'desc' })[0]
      return repo.enabled !== false && (!failures || failures.verdict === 'PASS')
    }).length
    return {
      repositoriesManaged: repos.length,
      repositoriesHealthy: healthy,
      newProblems: findings.filter((finding) => finding.status === 'OPEN').length,
      pendingFixes: tasks.filter((task) => task.status === 'QUEUED').length,
      aiTasksRunning: activeSessions.length,
      problemsFixed: tasks.filter((task) => task.status === 'ACCEPTED').length,
      awaitingVerification: tasks.filter((task) => task.status === 'VERIFYING' || task.status === 'AWAITING_HUMAN').length,
      securityRisks: findings.filter((finding) => /security|cve|secret/i.test(String(finding.kind)) && finding.status === 'OPEN').length,
      peerUpdates: peers.length,
      lastRelease: lastRelease ? { version: lastRelease.version, repository: lastRelease.repository, createdAt: lastRelease.createdAt } : null,
      recentActivity: runs.map((run) => ({ id: run.id, repository: run.repository, mode: run.mode, events: run.eventCount, verdict: run.verdict, at: run.finishedAt })),
      desktopClients: this.store.list('adapters').map((adapter) => ({ id: adapter.id, name: adapter.name, installed: adapter.installed, running: adapter.running, uia: adapter.uia?.available || false, checkedAt: adapter.checkedAt })),
      control: this.status(),
      generatedAt: nowIso(this.clock)
    }
  }
}

export { TASK_STATUSES, RUNNING_TASK_STATES }
