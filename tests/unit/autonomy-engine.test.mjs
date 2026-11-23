import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openAutonomyStore } from '../../server/autonomy/db.mjs'
import { AutonomyEngine } from '../../server/autonomy/engine.mjs'

const dirs = []
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-autonomy-engine-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 })))
})

async function setup({ clock = () => Date.parse('2026-01-01T00:00:00Z'), maxConcurrent = 1, sendResult = null } = {}) {
  const store = openAutonomyStore({ file: ':memory:' })
  const dataDir = await tempDir()
  const monitor = {
    configured: false, token: '', pollDue: async () => [], resolveToken: async () => '',
    syncRepository: async () => ({}), assessIssue: async () => ({})
  }
  const adapter = {
    id: 'chatgpt-desktop', name: 'ChatGPT Desktop',
    detect: async () => ({ installed: true, running: true, name: 'ChatGPT Desktop' }),
    createSession: ({ task, repo, pkg }) => store.put('agent_sessions', `session_${task.id}`, {
      id: `session_${task.id}`, taskId: task.id, repoId: repo.id, adapterId: 'chatgpt-desktop',
      state: 'NOT_STARTED', packageHash: pkg.hash, sentPackageHash: null, handoff: false, pollCount: 0
    }),
    sendTask: async (session, pkg) => {
      if (sendResult) return sendResult(session, pkg)
      const updated = store.put('agent_sessions', session.id, { ...session, state: 'RUNNING', sentPackageHash: pkg.hash })
      return { automated: true, session: updated }
    },
    pollState: async (session) => ({ session, signal: 'INCONCLUSIVE' })
  }
  const adapters = { get: () => adapter, list: () => [adapter], probeAll: async () => [] }
  const workspaceManager = {
    prepare: async (repo, { taskId }) => ({ id: `ws_${taskId}`, taskId, repoId: repo.id, path: dataDir, branch: `nexus/auto/${taskId}`, baseSha: 'abc123', isolated: true, worktree: true, originalPath: dataDir }),
    collectDiff: async () => ({ fileCount: 1, changedFiles: [{ path: 'src/a.ts', status: 'M' }], deletedFiles: [], sensitiveFiles: [], untrackedFiles: [], patch: '+ fixed', stat: '1 file', baseSha: 'abc123' }),
    reviewScope: () => ({ pass: true, violations: [] }),
    cleanup: async () => ({ removed: true })
  }
  const engine = new AutonomyEngine({ store, dataDir, token: '', clock, monitor, adapters, workspaceManager, maxConcurrent })
  const repo = engine.addRepository({ fullName: 'acme/widget', localPath: dataDir, automationMode: 'repair', agentAdapterId: 'chatgpt-desktop', agentProjectRef: 'Widget' })
  engine.saveSettings({ automationMode: 'repair', maxConcurrent })
  return { store, engine, repo, dataDir, adapter, clock }
}

const finding = (id, priority = 'P2') => ({ id, title: `Problem ${id}`, kind: 'bug', severity: 'medium', priority, evidence: {} })

describe('durable autonomy scheduler', () => {
  it('creates idempotent tasks and never duplicates the same finding set', async () => {
    const { engine, repo, store } = await setup()
    const first = engine.createTask({ repoId: repo.id, findings: [finding('f1')] })
    const second = engine.createTask({ repoId: repo.id, findings: [finding('f1')] })
    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(second.task.id).toBe(first.task.id)
    expect(store.count('tasks')).toBe(1)
    expect(first.task.priority).toBe('P2')
  })

  it('dispatches by P0-P4 priority under a concurrency cap', async () => {
    const { engine, repo, store } = await setup({ maxConcurrent: 1 })
    const other = engine.addRepository({ fullName: 'acme/other', localPath: (await tempDir()), automationMode: 'repair' })
    const low = engine.createTask({ repoId: repo.id, priority: 'P3', findings: [finding('low', 'P3')] }).task
    const critical = engine.createTask({ repoId: other.id, priority: 'P0', findings: [finding('high', 'P0')] }).task
    const tick = await engine.tick({ doMonitor: false })
    expect(tick.dispatched).toHaveLength(1)
    expect(tick.dispatched[0].taskId).toBe(critical.id)
    expect(store.get('tasks', critical.id).status).toBe('IN_PROGRESS')
    expect(store.get('tasks', low.id).status).toBe('QUEUED')
    expect(tick.skipped.some((item) => item.reason === 'CONCURRENCY_LIMIT')).toBe(true)
  })

  it('enforces one writer per repository and one busy client per adapter', async () => {
    const { engine, repo } = await setup({ maxConcurrent: 4 })
    engine.createTask({ repoId: repo.id, findings: [finding('f1')] })
    engine.createTask({ repoId: repo.id, findings: [finding('f2')] })
    const tick = await engine.tick({ doMonitor: false })
    expect(tick.dispatched).toHaveLength(1)
    expect(tick.skipped.some((item) => item.reason === 'REPO_WRITE_LOCK' || item.reason === 'CLIENT_BUSY')).toBe(true)
  })

  it('supports pause, resume, cancel, takeover and manual retry', async () => {
    const { engine, repo } = await setup()
    const task = engine.createTask({ repoId: repo.id, findings: [finding('f1')] }).task
    expect(engine.pauseTask(task.id).status).toBe('PAUSED')
    expect((await engine.tick({ doMonitor: false })).dispatched).toHaveLength(0)
    expect(engine.resumeTask(task.id).status).toBe('QUEUED')
    expect(engine.pause().paused).toBe(true)
    expect((await engine.tick({ doMonitor: false })).dispatched).toHaveLength(0)
    expect(engine.resume().paused).toBe(false)
    expect(engine.cancelTask(task.id).status).toBe('CANCELLED')

    const second = engine.createTask({ repoId: repo.id, findings: [finding('f2')] }).task
    expect(engine.takeover(second.id).status).toBe('AWAITING_HUMAN')
    expect(engine.retryTask(second.id)).toBeTruthy()
  })

  it('recovers after restart by preserving the scene, never replaying a send', async () => {
    const { engine, repo, store } = await setup()
    const task = engine.createTask({ repoId: repo.id, findings: [finding('f1')] }).task
    await engine.tick({ doMonitor: false })
    expect(store.get('tasks', task.id).status).toBe('IN_PROGRESS')

    const recovered = engine.recover()
    expect(recovered.interrupted).toContain(task.id)
    expect(store.get('tasks', task.id).status).toBe('AWAITING_HUMAN')
    expect(store.get('tasks', task.id).error).toMatch(/RESTARTED/)
    expect(store.list('agent_sessions')[0].handoff).toBe(true)
    expect(store.list('audit_log').some((entry) => entry.action === 'recover')).toBe(true)
  })

  it('expires tasks past their deadline and stops the current task on demand', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const { engine, repo, store } = await setup({ clock: () => now })
    const task = engine.createTask({ repoId: repo.id, findings: [finding('f1')] }).task
    await engine.tick({ doMonitor: false })
    now += 40 * 60_000
    const tick = await engine.tick({ doMonitor: false })
    expect(store.get('tasks', task.id).status).toBe('EXPIRED')
    expect(tick.expired).toContain(task.id)

    const second = engine.createTask({ repoId: repo.id, findings: [finding('f2')] }).task
    await engine.tick({ doMonitor: false })
    const stopped = engine.stopCurrent()
    expect(stopped.stopped).toBe(1)
    expect(store.get('tasks', second.id).status).toBe('CANCELLED')
  })

  it('falls back to human handoff when the adapter cannot automate, without losing the package', async () => {
    const { engine, repo, store } = await setup({
      sendResult: (session) => ({ automated: false, humanHandoff: true, reason: 'UIA_UNAVAILABLE', packageFile: '/tmp/task.md', session })
    })
    const task = engine.createTask({ repoId: repo.id, findings: [finding('f1')] }).task
    await engine.tick({ doMonitor: false })
    expect(store.get('tasks', task.id).status).toBe('AWAITING_HUMAN')
    expect(store.get('tasks', task.id).packageFile).toBe('/tmp/task.md')
  })

  it('returns a failed verification to the durable queue for a bounded repair attempt', async () => {
    const { engine, repo, store } = await setup()
    const task = engine.createTask({ repoId: repo.id, findings: [finding('f1')] }).task
    await engine.tick({ doMonitor: false })
    const result = await engine.finalize(store.get('tasks', task.id))
    expect(result.status).toBe('QUEUED')
    expect(result.attempts).toBe(1)
    expect(result.nextAttemptAt).toBeTruthy()
    expect(result.checkpoint).toMatchObject({ version: 1, phase: 'QUEUED', status: 'QUEUED' })
    expect(result.checkpoint.eventId).toBeTruthy()
    expect(store.list('task_events').some((event) => /scheduling repair attempt/.test(event.detail))).toBe(true)
  })

  it('builds homepage metrics from persisted records only', async () => {
    const { engine, repo } = await setup()
    const task = engine.createTask({ repoId: repo.id, findings: [finding('f1')] }).task
    engine.updateTask(task, 'DISPATCHED', { detail: 'test' })
    const overview = engine.overview()
    expect(overview.repositoriesManaged).toBe(1)
    expect(overview.pendingFixes).toBe(0)
    expect(overview.control.tasks.running).toBe(1)
    expect(overview.desktopClients).toEqual([])
    expect(overview.generatedAt).toBeTruthy()
  })
})
