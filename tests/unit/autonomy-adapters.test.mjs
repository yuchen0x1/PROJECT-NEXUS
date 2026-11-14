import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openAutonomyStore } from '../../server/autonomy/db.mjs'
import { buildTaskPackage } from '../../server/autonomy/task-package.mjs'
import {
  ChatGptDesktopAdapter, WorkBuddyAdapter, CodexCliDesktopAdapter, createAdapterRegistry
} from '../../server/autonomy/desktop/adapters.mjs'
import { classifyUiText } from '../../server/autonomy/desktop/uia.mjs'

const dirs = []
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-autonomy-adapter-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 })))
})

// Mirrors the actual Windows inventory captured on the audited host.
const realInventory = {
  processes: [
    { ProcessName: 'ChatGPT', Id: 45856, MainWindowTitle: 'ChatGPT', Path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe' },
    { ProcessName: 'WorkBuddy', Id: 7316, MainWindowTitle: 'WorkBuddy', Path: 'E:\\AppStoreSoftstore\\Install\\WorkBuddy\\WorkBuddy.exe' },
    { ProcessName: 'codex', Id: 49932, Path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe' }
  ],
  appx: [{ Name: 'OpenAI.Codex', Version: '26.1112.611.0', InstallLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0', PackageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0' }],
  uninstall: [{ DisplayName: 'WorkBuddy 5.11.3', DisplayVersion: '5.11.3', InstallLocation: '' }]
}

function uiaStub({ available = true, findName = 'Repo A', findOk = true, setValueOk = true, invokeOk = true, readLines = ['Working'] } = {}) {
  return {
    probe: async () => ({ available, reason: available ? 'UIA_LOADED' : 'UIA_UNAVAILABLE' }),
    windows: async () => available ? { ok: true, count: 1, windows: [{ name: 'ChatGPT', processId: 45856 }] } : { ok: false, code: 'UIA_UNAVAILABLE' },
    find: async () => findOk ? { ok: true, control: { name: findName, automationId: 'input' } } : { ok: false, code: 'CONTROL_NOT_FOUND' },
    setValue: async () => setValueOk ? { ok: true } : { ok: false, code: 'CONTROL_NOT_WRITABLE' },
    invoke: async () => invokeOk ? { ok: true } : { ok: false, code: 'CONTROL_NOT_INVOKABLE' },
    readText: async () => ({ ok: true, count: readLines.length, lines: readLines }),
    screenshot: async () => ({ ok: false, code: 'SCREENSHOT_SKIPPED' })
  }
}

async function setup(AdapterClass = ChatGptDesktopAdapter, { uia = uiaStub(), inventory = realInventory, clock = () => Date.parse('2026-01-01T00:00:00Z') } = {}) {
  const store = openAutonomyStore({ file: ':memory:' })
  const dataDir = await tempDir()
  const adapter = new AdapterClass({ store, uia, dataDir, clock, probeImpl: async () => inventory })
  const repo = store.put('repositories', 'r1', {
    id: 'r1', fullName: 'acme/widget', localPath: dataDir, defaultBranch: 'main',
    agentProjectRef: 'Repo A', agentAdapterId: adapter.id, automationMode: 'repair'
  })
  const task = { id: 'task_1' }
  const pkg = buildTaskPackage({
    repo, task,
    workspace: { path: dataDir, branch: 'nexus/auto/task_1', baseSha: 'abc123', isolated: true, worktree: true },
    findings: [{ id: 'f1', kind: 'bug', severity: 'high', priority: 'P1', title: 'Crash on startup', evidence: { number: 7 } }]
  })
  return { store, adapter, repo, task, pkg, dataDir }
}

describe('desktop agent adapters', () => {
  it('detects ChatGPT Desktop, WorkBuddy and the distinct Codex CLI entry point from real inventory', async () => {
    const { adapter, store } = await setup(ChatGptDesktopAdapter)
    const chat = await adapter.detect()
    expect(chat.installed).toBe(true)
    expect(chat.running).toBe(true)
    expect(chat.launcher).toContain('ChatGPT.exe')
    expect(chat.capabilities.detect.level).toBe('verified')
    expect(chat.capabilities.loginState.level).toBe('unsupported')

    const workbuddy = await setup(WorkBuddyAdapter)
    const wb = await workbuddy.adapter.detect()
    expect(wb.launcher).toContain('WorkBuddy.exe')
    expect(wb.version).toBe('5.11.3')

    const cli = await setup(CodexCliDesktopAdapter)
    const cliDetection = await cli.adapter.detect()
    expect(cliDetection.windowless).toBe(true)
    expect(cliDetection.capabilities.selectProject.level).toBe('unsupported')
    expect(cliDetection.id).not.toBe(chat.id)

    const registry = createAdapterRegistry({ store })
    expect(registry.list().map((item) => item.id)).toContain('codex-cli')
    expect(registry.get('workbuddy-desktop')).toBeTruthy()
    expect(registry.get('chatgpt-desktop')).toBeTruthy()
  })

  it('keeps separate capability tables and refuses to guess login state', async () => {
    const chat = await setup(ChatGptDesktopAdapter)
    const workbuddy = await setup(WorkBuddyAdapter, { uia: uiaStub({ available: false }) })
    const a = await chat.adapter.detect()
    const b = await workbuddy.adapter.detect()
    expect(a.capabilities.sendTask.level).toBe('partial')
    expect(b.capabilities.sendTask.level).toBe('unsupported')
    expect(a.loginState).toBe('UNKNOWN')
  })

  it('stops when the client project binding is uncertain', async () => {
    const { adapter, repo, pkg } = await setup()
    expect(() => adapter.assertProjectBinding({ ...repo, agentProjectRef: '' }, { projectRef: '' }))
      .toThrowError(/PROJECT_SELECTION_UNCERTAIN/)
    expect(() => adapter.assertProjectBinding(repo, { projectRef: 'Repo B' }))
      .toThrowError(/PROJECT_SELECTION_UNCERTAIN/)
    expect(() => adapter.assertProjectBinding(repo, { projectRef: 'Repo A', workspacePath: path.join(repo.localPath, '..', 'other') }))
      .toThrowError(/PROJECT_SELECTION_UNCERTAIN/)
    expect(() => adapter.assertProjectBinding(repo, { projectRef: 'Repo A' })).not.toThrow()
    expect(pkg.hash).toBeTruthy()
  })

  it('sends a task through verified UIA and never sends the same package twice', async () => {
    const { adapter, repo, pkg, store } = await setup()
    const session = adapter.createSession({ task: { id: 'task_1' }, repo, pkg })
    expect(session.state).toBe('NOT_STARTED')
    const result = await adapter.sendTask(session, pkg, repo, { selection: { projectRef: 'Repo A', workspacePath: repo.localPath } })
    expect(result.automated).toBe(true)
    expect(result.session.state).toBe('RUNNING')
    expect(result.session.sentPackageHash).toBe(pkg.hash)
    expect(store.list('task_events').length).toBeGreaterThan(3)

    await expect(adapter.sendTask(result.session, pkg, repo, { selection: { projectRef: 'Repo A' } }))
      .rejects.toThrowError(/already executing|DUPLICATE_TASK_SEND/)
  })

  it('enters a reliable human handoff when UI Automation is unavailable', async () => {
    const { adapter, repo, pkg } = await setup(ChatGptDesktopAdapter, { uia: uiaStub({ available: false }) })
    const session = adapter.createSession({ task: { id: 'task_1' }, repo, pkg })
    const result = await adapter.sendTask(session, pkg, repo)
    expect(result.humanHandoff).toBe(true)
    expect(result.session.state).toBe('NEEDS_HUMAN_HANDOFF')
    expect(result.packageText).toContain('PROJECT NEXUS autonomous task')
    const saved = await fs.readFile(result.packageFile, 'utf8')
    expect(saved).toContain('abc123') // base SHA is in the handoff package
    expect(saved).not.toContain('ghp_')

    const resolved = adapter.resolveHandoff(result.session, { outcome: 'sent' })
    expect(resolved.session.state).toBe('RUNNING')
    expect(resolved.session.handoff).toBe(false)
  })

  it('stops instead of clicking when the project control cannot be identified', async () => {
    const { adapter, repo, pkg } = await setup(ChatGptDesktopAdapter, { uia: uiaStub({ findOk: false }) })
    const session = adapter.createSession({ task: { id: 'task_1' }, repo, pkg })
    const result = await adapter.sendTask(session, pkg, repo)
    expect(result.humanHandoff).toBe(true)
    expect(result.reason).toContain('CONTROL_NOT_FOUND')
  })

  it('refuses to send a package containing a credential', async () => {
    const { adapter, repo, pkg } = await setup()
    pkg.objective = `use ghp_${'d'.repeat(30)}`
    const session = adapter.createSession({ task: { id: 'task_1' }, repo, pkg })
    await expect(adapter.sendTask(session, pkg, repo)).rejects.toThrowError(/TASK_PACKAGE_UNSAFE/)
  })

  it('classifies real UI text into execution states without fixed sleeps', () => {
    expect(classifyUiText(['Approve command execution?'])).toBe('AWAITING_AUTHORIZATION')
    expect(classifyUiText(['Running tests: npm test'])).toBe('RUNNING_TESTS')
    expect(classifyUiText(['Error: build failed'])).toBe('FAILED')
    expect(classifyUiText(['Nothing special'])).toBeNull()
  })

  it('detects timeout, client exit and normal state transitions', async () => {
    const { adapter, repo, pkg, store } = await setup(ChatGptDesktopAdapter, { uia: uiaStub({ readLines: ['Running tests: npm test'] }) })
    const sent = await adapter.sendTask(adapter.createSession({ task: { id: 'task_1' }, repo, pkg }), pkg, repo,
      { selection: { projectRef: 'Repo A', workspacePath: repo.localPath } })
    const running = sent.session
    expect(running.state).toBe('RUNNING')

    const polled = await adapter.pollState(running, { deadlineMs: 0 })
    expect(polled.signal).toBe('RUNNING_TESTS')
    expect(polled.session.state).toBe('RUNNING_TESTS')

    const timed = await adapter.pollState(running, { deadlineMs: 1 })
    expect(timed.signal).toBe('TIMEOUT')
    expect(timed.session.state).toBe('TIMEOUT')

    const offline = await setup(ChatGptDesktopAdapter, { inventory: { ...realInventory, processes: [] } })
    const offlineSession = { ...offline.adapter.createSession({ task: { id: 't2' }, repo: offline.repo, pkg }), state: 'RUNNING' }
    const exited = await offline.adapter.pollState(offlineSession, { deadlineMs: 0 })
    expect(exited.signal).toBe('CLIENT_EXITED')
    expect(store.count('audit_log')).toBeGreaterThan(0)
  })
})
