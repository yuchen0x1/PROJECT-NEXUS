// REST surface for the Autonomy Runtime. Registered onto the EXISTING Express
// app with a dedicated /api/autonomy prefix - no existing route is modified.

import fs from 'node:fs/promises'
import path from 'node:path'
import { AutonomyEngine } from './engine.mjs'
import { openAutonomyStore, defaultAutonomyDbFile, SQLITE_AVAILABLE, AUTONOMY_MIGRATIONS } from './db.mjs'
import { MONITOR_RESOURCES, DEFAULT_POLL_INTERVALS_MS } from './model.mjs'
import { assessReadiness } from './intelligence.mjs'
import { TASK_STATUSES, AGENT_STATES, ISSUE_LIFECYCLES, PRIORITIES, AUTOMATION_MODES } from './model.mjs'
import { detectSecurityTools, runSecurityScan } from '../services/security-scan.mjs'
import { GithubDelivery } from './github-delivery.mjs'

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch((error) => {
    const status = /NOT_FOUND|UNKNOWN/.test(String(error.code)) ? 404 : /INVALID|ILLEGAL|REFUS/.test(String(error.code)) ? 400 : 500
    res.status(status).json({ error: String(error.message || error).slice(0, 500), code: error.code || 'AUTONOMY_ERROR' })
  })
}

function page(items, req, fallback = 100) {
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || fallback))
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit }
}

export function createAutonomyRuntime({ dataDir, token = process.env.GITHUB_TOKEN || '', tokenResolver = null, clock = () => Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const dbFile = defaultAutonomyDbFile(dataDir)
  const store = openAutonomyStore({ file: dbFile })
  try {
    const engine = new AutonomyEngine({ store, dataDir, token, tokenResolver, clock, fetchImpl })
    const delivery = new GithubDelivery({ store, token, tokenResolver, fetchImpl, clock })
    engine.recover()
    return { store, engine, delivery, dbFile }
  } catch (error) {
    try { store.close() } catch { /* preserve the initialization error */ }
    throw error
  }
}

export function registerAutonomyApi(app, { engine, store, delivery, dataDir }) {
  const routes = []

  const add = (method, route, handler) => {
    app[method](`/api/autonomy${route}`, asyncHandler(handler))
    routes.push(`${method.toUpperCase()} /api/autonomy${route}`)
  }

  add('get', '/health', (_req, res) => res.json({
    ok: true, service: 'project-nexus-autonomy', storeBackend: store.backend,
    schemaVersion: store.schemaVersion, sqliteAvailable: SQLITE_AVAILABLE,
    migrations: AUTONOMY_MIGRATIONS, status: engine.status(), time: new Date().toISOString()
  }))

  add('get', '/overview', (_req, res) => res.json(engine.overview()))

  add('get', '/control/status', (_req, res) => res.json(engine.status()))

  const controlActions = {
    start: () => ({ settings: engine.start(), message: 'Autonomous operations started.' }),
    pause: () => ({ settings: engine.pause(), message: 'Autonomous operations paused.' }),
    resume: () => ({ settings: engine.resume(), message: 'Autonomous operations resumed.' }),
    stop: () => ({ ...engine.stopCurrent(), message: 'Current tasks stopped and handed to a human.' }),
    'scan-now': async () => ({ ...await engine.tick({ doMonitor: true, force: true }), message: 'Immediate repository scan completed.' }),
    'research-now': async () => ({ research: await engine.runResearch(), message: 'Peer-project research completed.' }),
    'run-now': async () => ({ ...await engine.tick({ doMonitor: false, force: true }), message: 'Pending tasks dispatched.' })
  }
  add('post', '/control/:action', async (req, res) => {
    const action = req.params.action
    if (Object.hasOwn(controlActions, action)) return res.json(await controlActions[action]())
    if (action === 'settings') {
      const allowed = ['automationMode', 'maxConcurrent', 'aiApiConfigured', 'remoteWritesEnabled', 'researchEnabled']
      const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.includes(key)))
      if (patch.automationMode && !AUTOMATION_MODES.includes(patch.automationMode)) {
        return res.status(400).json({ error: 'Invalid automation mode.', code: 'INVALID_MODE' })
      }
      if (patch.maxConcurrent) patch.maxConcurrent = Math.max(1, Math.min(8, Number(patch.maxConcurrent) || 1))
      return res.json({ settings: engine.saveSettings(patch) })
    }
    return res.status(404).json({ error: `Unknown control action: ${action}`, code: 'UNKNOWN_ACTION' })
  })

  // ---- Repositories --------------------------------------------------------

  add('get', '/repositories', (_req, res) => res.json({ repositories: store.list('repositories'), resources: MONITOR_RESOURCES, intervals: DEFAULT_POLL_INTERVALS_MS }))

  add('post', '/repositories', (req, res) => res.status(201).json(engine.addRepository(req.body || {})))

  add('patch', '/repositories/:id', (req, res) => {
    const updated = engine.updateRepository(req.params.id, req.body || {})
    if (!updated) return res.status(404).json({ error: 'Repository not found.', code: 'NOT_FOUND' })
    return res.json(updated)
  })

  add('delete', '/repositories/:id', (req, res) => res.json({ removed: engine.removeRepository(req.params.id) }))

  add('post', '/repositories/:id/sync', async (req, res) => {
    const repo = store.get('repositories', req.params.id)
    if (!repo) return res.status(404).json({ error: 'Repository not found.', code: 'NOT_FOUND' })
    return res.json(await engine.monitor.syncRepository(repo, { force: req.body?.force === true, resources: req.body?.resources || null }))
  })

  add('post', '/repositories/:id/issues/:number/assess', async (req, res) => {
    const repo = store.get('repositories', req.params.id)
    if (!repo) return res.status(404).json({ error: 'Repository not found.', code: 'NOT_FOUND' })
    return res.json(await engine.monitor.assessIssue(repo, Number(req.params.number)))
  })

  // ---- Monitoring ----------------------------------------------------------

  add('get', '/events', (req, res) => res.json(page(
    store.list('events', { order: 'desc', filter: req.query.repoId ? (event) => event.repoId === req.query.repoId : null }), req)))

  add('get', '/findings', (req, res) => res.json(page(
    store.list('findings', { order: 'desc', filter: req.query.status ? (finding) => finding.status === req.query.status : null }), req)))

  add('get', '/issues', (req, res) => res.json({ issues: store.list('issues', { order: 'desc' }), lifecycles: ISSUE_LIFECYCLES }))

  add('get', '/monitor/runs', (req, res) => res.json(page(store.list('monitor_runs', { order: 'desc' }), req, 30)))

  add('get', '/monitor/cursors', (req, res) => res.json({ cursors: store.list('sync_cursors') }))

  // ---- Security toolchain --------------------------------------------------

  add('get', '/security/tools', async (_req, res) => res.json(await detectSecurityTools()))

  add('get', '/security/scans', (req, res) => res.json(page(store.list('security_scans', { order: 'desc' }), req, 30)))

  add('post', '/security/scan', async (req, res) => {
    const repo = req.body?.repoId ? store.get('repositories', req.body.repoId) : null
    if (req.body?.repoId && !repo) return res.status(404).json({ error: 'Repository not found.', code: 'NOT_FOUND' })
    const rawRoot = String(req.body?.root || repo?.localPath || '').trim()
    if (!rawRoot) return res.status(400).json({ error: 'A repository scan root is required.', code: 'SECURITY_ROOT_REQUIRED' })
    const root = path.resolve(rawRoot)
    if (root === path.parse(root).root) return res.status(400).json({ error: 'Scanning a filesystem root is not allowed.', code: 'SECURITY_ROOT_INVALID' })
    const reportDir = path.join(dataDir, 'security-reports', repo?.id || 'standalone')
    const scan = await runSecurityScan({ root, reportDir, includeExternal: req.body?.includeExternal !== false })
    const saved = store.put('security_scans', scan.id, { ...scan, repoId: repo?.id || null, repository: repo?.fullName || null })
    for (const item of scan.findings.slice(0, 500)) {
      const findingId = `${scan.id}:${item.id || item.key || item.path || 'finding'}`
      store.put('findings', findingId, {
        id: findingId, repoId: repo?.id || null, repository: repo?.fullName || null,
        kind: `security:${item.tool || 'local'}`, severity: item.priority === 'P0' ? 'critical' : item.priority === 'P1' ? 'high' : 'medium',
        priority: item.priority || 'P2', title: item.summary || item.key || 'Security finding', evidence: item,
        status: 'OPEN', source: 'security-scan', scanId: scan.id, createdAt: scan.scannedAt
      })
    }
    store.audit('security', 'scan', repo?.fullName || root, { scanId: scan.id, status: scan.status, findings: scan.findings.length, external: Boolean(scan.external) })
    return res.status(201).json({ scan: saved, reportPath: scan.reportPath })
  })

  add('post', '/security/scans/:id/tasks', (req, res) => {
    const scan = store.get('security_scans', req.params.id)
    if (!scan) return res.status(404).json({ error: 'Security scan not found.', code: 'NOT_FOUND' })
    if (!scan.repoId) return res.status(400).json({ error: 'A repository-bound scan is required to create a task.', code: 'SECURITY_REPO_REQUIRED' })
    const selected = Array.isArray(req.body?.findingIds) && req.body.findingIds.length
      ? scan.findings.filter((item) => req.body.findingIds.includes(item.id)) : scan.findings
    const findings = selected.map((item, index) => ({
      id: `${scan.id}:${item.id || index}`, title: item.summary || item.key || 'Security finding',
      kind: `security:${item.tool || 'local'}`, severity: item.priority === 'P0' ? 'critical' : item.priority === 'P1' ? 'high' : 'medium',
      priority: item.priority || 'P2', evidence: item
    }))
    const priority = findings.some((item) => item.priority === 'P0') ? 'P0' : findings.some((item) => item.priority === 'P1') ? 'P1' : 'P2'
    return res.status(201).json(engine.createTask({ repoId: scan.repoId, kind: 'security-fix', priority, findings, source: `security-scan:${scan.id}`, writeTask: true, plan: { scanId: scan.id } }))
  })

  // ---- GitHub delivery -----------------------------------------------------

  add('get', '/delivery/:repoId/status', async (req, res) => {
    const repo = store.get('repositories', req.params.repoId)
    if (!repo) return res.status(404).json({ error: 'Repository not found.', code: 'NOT_FOUND' })
    return res.json(await delivery.inspect(repo, { branch: req.query.branch || repo.defaultBranch || 'main', pullRequest: req.query.pullRequest || null }))
  })

  add('post', '/delivery/:repoId/commit-push', async (req, res) => {
    const repo = store.get('repositories', req.params.repoId)
    if (!repo) return res.status(404).json({ error: 'Repository not found.', code: 'NOT_FOUND' })
    return res.json(await delivery.commitWorkspace(repo, { ...req.body, remoteWritesEnabled: engine.settings.remoteWritesEnabled, confirm: req.body?.confirm === true }))
  })

  add('post', '/delivery/:repoId/pull-request', async (req, res) => {
    const repo = store.get('repositories', req.params.repoId)
    if (!repo) return res.status(404).json({ error: 'Repository not found.', code: 'NOT_FOUND' })
    return res.status(201).json(await delivery.createPullRequest(repo, { ...req.body, remoteWritesEnabled: engine.settings.remoteWritesEnabled, confirm: req.body?.confirm === true }))
  })

  // One guarded path for the autonomy task UI: only an independently accepted,
  // isolated worktree may be committed and opened as a draft PR. The original
  // checkout is never used, and the two remote writes remain explicit.
  add('post', '/delivery/:repoId/tasks/:taskId/pull-request', async (req, res) => {
    const repo = store.get('repositories', req.params.repoId)
    if (!repo) return res.status(404).json({ error: 'Repository not found.', code: 'NOT_FOUND' })
    const task = store.get('tasks', req.params.taskId)
    if (!task || task.repoId !== repo.id) return res.status(404).json({ error: 'Autonomy task not found for this repository.', code: 'TASK_NOT_FOUND' })
    if (task.delivery?.pullRequest) return res.status(200).json({ task, commit: task.delivery.commit, pullRequest: task.delivery.pullRequest, reused: true })
    if (task.status !== 'ACCEPTED') return res.status(409).json({ error: 'The task must pass independent acceptance before a PR can be opened.', code: 'TASK_NOT_ACCEPTED' })
    if (task.verification?.verdict !== 'PASS') return res.status(409).json({ error: 'Independent verification did not pass.', code: 'VERIFICATION_NOT_PASSED' })
    if (!task.workspace?.isolated || !task.workspace?.worktree || !task.workspace?.path) {
      return res.status(409).json({ error: 'The task does not have an isolated NEXUS worktree.', code: 'ISOLATED_WORKTREE_REQUIRED' })
    }
    if (req.body?.confirm !== true || req.body?.confirmRepository !== repo.fullName || req.body?.confirmBranch !== task.workspace.branch) {
      return res.status(400).json({ error: 'Confirm the exact repository and generated branch before opening a pull request.', code: 'CONFIRMATION_REQUIRED' })
    }
    const report = task.verification?.id ? store.get('verification_reports', task.verification.id) : null
    const diff = await engine.workspace.collectDiff(task.workspace).catch((error) => ({ error }))
    if (diff?.error) return res.status(409).json({ error: `Could not collect the isolated worktree diff: ${diff.error.message}`, code: 'DIFF_UNAVAILABLE' })
    const changedPaths = (diff.changedFiles || []).map((item) => item.path).filter(Boolean)
    if (!changedPaths.length) return res.status(409).json({ error: 'The accepted task has no file changes to publish.', code: 'NO_CHANGES' })
    try {
      const commit = task.delivery?.commit || await delivery.commitWorkspace(repo, {
        workspacePath: task.workspace.path,
        branch: task.workspace.branch,
        message: `fix: publish verified autonomy task ${task.id}`,
        remoteWritesEnabled: engine.settings.remoteWritesEnabled,
        confirm: true
      })
      if (!task.delivery?.commit) {
        // Persist the push checkpoint before attempting the second remote write.
        // A PR request can fail or time out after a successful push; retrying
        // must reuse the commit instead of trying to commit an empty worktree.
        store.put('tasks', task.id, {
          ...task,
          delivery: { status: 'PUSHED', commit, changedPaths, pushedAt: new Date().toISOString() },
          updatedAt: new Date().toISOString()
        })
      }
      const pullRequest = await delivery.createPullRequest(repo, {
        branch: task.workspace.branch,
        base: repo.defaultBranch || 'main',
        title: String(req.body?.title || `fix: verified autonomy task ${task.id}`).slice(0, 240),
        body: String(req.body?.body || [
          '## PROJECT NEXUS verified autonomy task',
          '',
          `Repository: ${repo.fullName}`,
          `Task: ${task.id}`,
          `Base commit: ${task.workspace.baseSha}`,
          `Worktree: ${task.workspace.path}`,
          `Changed files: ${changedPaths.join(', ')}`,
          `Independent verification: ${report?.verdict || task.verification.verdict}`,
          '',
          'This is a draft pull request. Merge and release remain separate human-gated actions.'
        ].join('\n')).slice(0, 18_000),
        issueNumber: Number.isFinite(Number(req.body?.issueNumber)) ? Number(req.body.issueNumber) : null,
        remoteWritesEnabled: engine.settings.remoteWritesEnabled,
        confirm: true
      })
      const updated = store.put('tasks', task.id, {
        ...store.get('tasks', task.id),
        delivery: { status: 'PULL_REQUEST_OPEN', commit, pullRequest, changedPaths, openedAt: new Date().toISOString() },
        updatedAt: new Date().toISOString()
      })
      engine.appendTaskEvent(updated, 'DELIVERY', `Draft pull request #${pullRequest.number} opened for human review.`)
      store.audit('delivery', 'autonomy-task-pull-request-created', repo.fullName, { taskId: task.id, number: pullRequest.number, branch: task.workspace.branch })
      return res.status(201).json({ task: updated, commit, pullRequest, changedPaths })
    } catch (error) {
      return res.status(error.status || 502).json({ error: error.message, code: error.code || 'PULL_REQUEST_FAILED' })
    }
  })

  add('post', '/delivery/:repoId/merge', async (req, res) => {
    const repo = store.get('repositories', req.params.repoId)
    if (!repo) return res.status(404).json({ error: 'Repository not found.', code: 'NOT_FOUND' })
    return res.json(await delivery.mergePullRequest(repo, { ...req.body, remoteWritesEnabled: engine.settings.remoteWritesEnabled, confirm: req.body?.confirm === true, autoMerge: repo.autoMerge === true }))
  })

  add('post', '/delivery/:repoId/release', async (req, res) => {
    const repo = store.get('repositories', req.params.repoId)
    if (!repo) return res.status(404).json({ error: 'Repository not found.', code: 'NOT_FOUND' })
    return res.status(201).json(await delivery.createRelease(repo, { ...req.body, remoteWritesEnabled: engine.settings.remoteWritesEnabled, confirm: req.body?.confirm === true, autoRelease: repo.autoRelease === true }))
  })

  add('post', '/delivery/:repoId/notify', async (req, res) => {
    const repo = store.get('repositories', req.params.repoId)
    if (!repo) return res.status(404).json({ error: 'Repository not found.', code: 'NOT_FOUND' })
    return res.json(await delivery.notify(repo, { ...req.body, confirm: req.body?.confirm === true }))
  })

  add('post', '/webhook', async (req, res) => {
    const eventType = req.get('x-github-event') || 'unknown'
    const deliveryId = req.get('x-github-delivery') || ''
    const fullName = req.body?.repository?.full_name
    const repo = store.list('repositories', { filter: (item) => item.fullName === fullName })[0]
    if (!repo) return res.status(202).json({ accepted: false, reason: 'UNMANAGED_REPOSITORY' })
    return res.json({ accepted: true, ...await engine.monitor.ingestWebhook(repo, eventType, deliveryId, req.body || {}) })
  })

  // ---- Tasks ---------------------------------------------------------------

  add('get', '/tasks', (req, res) => res.json({
    ...page(store.list('tasks', { order: 'desc', filter: req.query.status ? (task) => task.status === req.query.status : null }), req),
    statuses: TASK_STATUSES, priorities: PRIORITIES
  }))

  add('post', '/tasks', (req, res) => {
    const body = req.body || {}
    const findings = Array.isArray(body.findingIds)
      ? body.findingIds.map((id) => store.get('findings', id)).filter(Boolean) : []
    return res.status(201).json(engine.createTask({
      repoId: body.repoId, kind: body.kind || 'fix', priority: body.priority || 'P2',
      findings, references: body.references || [], source: body.source || 'manual',
      writeTask: body.writeTask !== false, plan: body.plan || {}
    }))
  })

  add('get', '/tasks/:id', (req, res) => {
    const task = store.get('tasks', req.params.id)
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 'NOT_FOUND' })
    return res.json({ task, events: engine.taskEvents(task.id), session: task.sessionId ? store.get('agent_sessions', task.sessionId) : null,
      verification: task.verification?.id ? store.get('verification_reports', task.verification.id) : null })
  })

  add('get', '/tasks/:id/events', (req, res) => res.json({ events: engine.taskEvents(req.params.id) }))

  const taskActions = {
    cancel: (id) => engine.cancelTask(id), pause: (id) => engine.pauseTask(id),
    resume: (id) => engine.resumeTask(id), retry: (id) => engine.retryTask(id)
  }
  add('post', '/tasks/:id/:action', async (req, res) => {
    const { id, action } = req.params
    if (action === 'finalize') {
      const task = store.get('tasks', id)
      if (!task) return res.status(404).json({ error: 'Task not found.', code: 'NOT_FOUND' })
      return res.json(await engine.finalize(task, { force: req.body?.force === true }))
    }
    if (!Object.hasOwn(taskActions, action)) return res.status(404).json({ error: 'Unknown task action.', code: 'UNKNOWN_ACTION' })
    const result = action === 'takeover' ? engine.takeover(id, req.body?.note || 'Operator took over this task.') : taskActions[action](id)
    if (!result) return res.status(404).json({ error: 'Task not found.', code: 'NOT_FOUND' })
    return res.json(result)
  })

  add('get', '/packages/:taskId', async (req, res) => {
    const task = store.get('tasks', req.params.taskId)
    if (!task?.packageFile) return res.status(404).json({ error: 'No task package for this task.', code: 'NOT_FOUND' })
    const safeRoot = path.resolve(path.join(dataDir, 'autonomy-packages'))
    const target = path.resolve(task.packageFile)
    if (!target.startsWith(safeRoot + path.sep)) return res.status(400).json({ error: 'Unsafe package path.', code: 'INVALID_PATH' })
    const text = await fs.readFile(target, 'utf8').catch(() => null)
    if (text === null) return res.status(404).json({ error: 'Package file is missing.', code: 'NOT_FOUND' })
    return res.type('text/markdown').send(text)
  })

  // ---- Desktop clients -----------------------------------------------------

  add('get', '/adapters', (_req, res) => res.json({
    adapters: store.list('adapters'),
    registry: engine.adapters.list().map((adapter) => ({ id: adapter.id, name: adapter.name, kind: adapter.kind })),
    agentStates: AGENT_STATES
  }))

  add('post', '/adapters/probe', async (_req, res) => res.json({ adapters: await engine.adapters.probeAll(), probedAt: new Date().toISOString() }))

  // Real UI Automation window discovery (read-only): identifies windows by
  // title + owning process, never by screen coordinates.
  add('post', '/adapters/windows', async (req, res) => {
    const adapter = engine.adapters.get(req.body?.adapterId || 'chatgpt-desktop')
    if (!adapter) return res.status(404).json({ error: 'Adapter not found.', code: 'NOT_FOUND' })
    const capability = await adapter.uia.probe()
    if (!capability.available) return res.json({ ok: false, adapterId: adapter.id, code: 'UIA_UNAVAILABLE', capability, count: 0, windows: [] })
    const result = await adapter.uia.windows(adapter.window)
    return res.json({ ok: result.ok !== false, adapterId: adapter.id, ...result, count: Number(result.count) || 0, windows: Array.isArray(result.windows) ? result.windows : [] })
  })

  add('post', '/adapters/:id/launch', async (req, res) => {
    const adapter = engine.adapters.get(req.params.id)
    if (!adapter) return res.status(404).json({ error: 'Adapter not found.', code: 'NOT_FOUND' })
    return res.json(await adapter.launch())
  })

  add('get', '/sessions', (req, res) => res.json(page(
    store.list('agent_sessions', { order: 'desc', filter: req.query.taskId ? (session) => session.taskId === req.query.taskId : null }), req)))

  add('post', '/sessions/:id/resolve', async (req, res) => {
    const session = store.get('agent_sessions', req.params.id)
    if (!session) return res.status(404).json({ error: 'Session not found.', code: 'NOT_FOUND' })
    const adapter = engine.adapters.get(session.adapterId)
    if (!adapter) return res.status(404).json({ error: 'Adapter not found.', code: 'NOT_FOUND' })
    const result = adapter.resolveHandoff(session, { outcome: req.body?.outcome || 'completed', note: req.body?.note || '' })
    const task = store.get('tasks', session.taskId)
    if (task && result.outcome === 'completed' && task.status === 'AWAITING_HUMAN') {
      await engine.finalize(task).catch((error) => store.audit('reviewer', 'handoff-verify-failed', task.id, { message: error.message }))
    }
    return res.json(result)
  })

  // ---- Intelligence / verification / release -------------------------------

  add('get', '/readiness', async (req, res) => {
    const repoId = req.query.repoId
    const repo = repoId ? store.get('repositories', repoId) : store.list('repositories')[0] || {}
    const hasScanned = store.count('monitor_runs') > 0
    return res.json(await assessReadiness({
      store, repo, mode: req.query.mode || 'desktop',
      aiApiConfigured: engine.settings.aiApiConfigured,
      adapters: store.list('adapters'), selectedAdapterId: repo.agentAdapterId,
      hasScanned, taskCount: store.count('tasks'),
      remoteWritesEnabled: engine.settings.remoteWritesEnabled
    }))
  })

  add('get', '/peers', (req, res) => res.json({ peers: store.list('peer_projects', { order: 'desc' }) }))

  add('get', '/proposals', (req, res) => res.json(page(store.list('porting_proposals', { order: 'desc' }), req)))

  add('post', '/research', async (req, res) => res.json({ results: await engine.runResearch({ query: req.body?.query, topics: req.body?.topics || [] }) }))

  add('get', '/verification', (req, res) => res.json(page(store.list('verification_reports', { order: 'desc' }), req)))

  add('get', '/releases', (req, res) => res.json(page(store.list('releases', { order: 'desc' }), req)))

  add('get', '/audit', (req, res) => res.json(page(store.list('audit_log', { order: 'desc' }), req, 200)))

  add('get', '/db', (_req, res) => res.json({ stats: store.stats(), dbFile: path.basename(defaultAutonomyDbFile(dataDir)), migrations: AUTONOMY_MIGRATIONS }))

  return routes
}

/** Background ticker owned by the Node service, independent of any renderer. */
export function startAutonomyTicker(engine, { intervalMs = 60_000, immediate = true, logger = console } = {}) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try { await engine.tick({ doMonitor: true, doResearch: engine.settings.researchEnabled }) } catch (error) {
      logger.error?.('[autonomy] tick failed:', error?.message || error)
    } finally { running = false }
  }
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  if (immediate) setTimeout(() => void tick(), 3_000).unref?.()
  return {
    stop: () => clearInterval(timer),
    tickNow: tick,
    intervalMs
  }
}
