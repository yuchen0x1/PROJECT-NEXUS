import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// The Codex leg is mocked at the module boundary; everything else — project
// registry, git worktree isolation, diff capture, verification, persistence —
// runs for real against a temp repository.
const { codexInstances, detectMock, codexBehavior } = vi.hoisted(() => ({
  codexInstances: [],
  detectMock: vi.fn(),
  codexBehavior: {}
}))

vi.mock('../../server/services/agent/codex-app-server.mjs', async (importOriginal) => {
  const actual = await importOriginal()
  class FakeCodexAppServer {
    constructor(options = {}) {
      this.launcher = options.launcher
      this.handlers = new Map()
      this.serverRequestHandler = null
      this.disposed = false
      codexInstances.push(this)
    }
    async start() { this.started = true }
    onNotification(method, handler) {
      const list = this.handlers.get(method) || []
      list.push(handler)
      this.handlers.set(method, list)
      return () => {}
    }
    async accountRead() {
      if (codexBehavior.accountRead) return codexBehavior.accountRead(this)
      return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }
    }
    async threadStart(params) {
      this.threadParams = params
      return { id: 'thr_fake_1', modelProvider: 'openai' }
    }
    async turnStart(params) {
      this.turnParams = params
      if (codexBehavior.turnStart) await codexBehavior.turnStart(this, params)
      const turn = { id: 'turn_fake_1', status: 'completed', items: [], error: null }
      // The real app-server streams the completion asynchronously; deliver it
      // on a later tick so the executor is already listening for it.
      setTimeout(() => {
        for (const handler of this.handlers.get('turn/completed') || []) handler({ turn })
      }, 10)
      return { turn }
    }
    async turnInterrupt() { return true }
    async dispose() { this.disposed = true }
  }
  return { ...actual, detectCodexInstall: detectMock, CodexAppServer: FakeCodexAppServer }
})

import { executeAgentBridgeTask, buildAgentBridgeBrief } from '../../server/services/agent/bridge-executor.mjs'
import { registerLocalProject, listLocalProjects } from '../../server/services/local-projects.mjs'
import { createLocalAgentTask, getLocalAgentTask, listLocalAgentTasks, updateLocalAgentTask } from '../../server/services/local-agent-tasks.mjs'
import { runCommand } from '../../server/services/agent/executor.mjs'

let tempRoot
let projectPath
let dataDir

async function fresh() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-bridge-'))
  projectPath = path.join(tempRoot, 'project')
  dataDir = path.join(tempRoot, 'data')
  await fs.mkdir(projectPath, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
  codexInstances.length = 0
  for (const key of Object.keys(codexBehavior)) delete codexBehavior[key]
}

beforeEach(async () => { await fresh() })
afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  detectMock.mockReset()
})

async function setupGitProject() {
  await fs.writeFile(path.join(projectPath, 'README.md'), '# bridge demo\n', 'utf8')
  await runCommand({ cwd: projectPath, command: 'git init -b main', timeoutMs: 20_000 })
  await runCommand({ cwd: projectPath, command: 'git add -A', timeoutMs: 20_000 })
  await runCommand({ cwd: projectPath, command: 'git -c user.name=t -c user.email=t@t.local commit -m init', timeoutMs: 20_000 })
  await registerLocalProject({ dataDir, folderPath: projectPath })
}

const taskStore = {
  create: (args) => createLocalAgentTask({ dataDir, task: args.task }),
  get: ({ taskId }) => getLocalAgentTask({ dataDir, taskId }),
  update: ({ taskId, patch, event }) => updateLocalAgentTask({ dataDir, taskId, patch, event }),
  list: () => listLocalAgentTasks({ dataDir })
}

async function createBridgeTask() {
  const projects = await listLocalProjects({ dataDir })
  return createLocalAgentTask({
    dataDir,
    task: {
      id: `nexus_agent_${crypto.randomUUID().replaceAll('-', '')}`,
      type: 'agent-bridge',
      label: 'Bridge smoke',
      projectId: projects[0].id,
      projectName: projects[0].name,
      prompt: 'Add a file named bridge-result.txt containing BRIDGE_OK.',
      status: 'Queued',
      approvalPolicy: 'standard',
      workspaceMode: 'auto',
      sourceDisclosureConfirmedAt: new Date().toISOString(),
      disclosedPaths: [],
      changedFiles: []
    }
  })
}

describe('agent bridge executor', () => {
  it('blocks before creating any workspace when Codex is not installed', async () => {
    await setupGitProject()
    detectMock.mockResolvedValue({ installed: false, channel: 'codex-app-server' })
    const task = await createBridgeTask()
    await expect(executeAgentBridgeTask({ task, taskStore, dataDir, signal: null, options: {} }))
      .rejects.toMatchObject({ code: 'CODEX_NOT_DETECTED' })
    const workspaces = await fs.readdir(path.join(dataDir, 'agent-workspaces', 'agent')).catch(() => [])
    expect(workspaces).toEqual([])
  }, 90_000)

  it('blocks when the app server reports no usable account', async () => {
    await setupGitProject()
    detectMock.mockResolvedValue({ installed: true, version: '0.167.0-test', launcher: { command: 'codex', args: [] } })
    codexBehavior.accountRead = () => ({ account: null, requiresOpenaiAuth: true })
    const task = await createBridgeTask()
    await expect(executeAgentBridgeTask({ task, taskStore, dataDir, signal: null, options: {} }))
      .rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' })
    const fake = codexInstances[codexInstances.length - 1]
    expect(fake.disposed).toBe(true)
  }, 90_000)

  it('runs a full bridge task: isolated worktree, codex turn, diff and evidence', async () => {
    await setupGitProject()
    detectMock.mockResolvedValue({ installed: true, version: '0.167.0-test', launcher: { command: 'codex', args: [] } })
    codexBehavior.turnStart = async (instance, params) => {
      // The simulated Codex writes its change inside the workspace cwd only.
      await fs.writeFile(path.join(params.cwd, 'bridge-result.txt'), 'BRIDGE_OK\n', 'utf8')
      void instance
    }
    const task = await createBridgeTask()
    const outcome = await executeAgentBridgeTask({ task, taskStore, dataDir, signal: null, options: {}, audit: () => {} })

    expect(outcome.status).toBe('Succeeded')
    expect(outcome.changes.map((change) => change.path)).toContain('bridge-result.txt')
    expect(outcome.verification.attempted).toBe(false)

    const fake = codexInstances[codexInstances.length - 1]
    expect(fake.started).toBe(true)
    expect(fake.disposed).toBe(true)
    expect(fake.threadParams.cwd).toBe(outcome.adapter.source)
    expect(fake.turnParams.sandboxPolicy).toMatchObject({ type: 'workspace-write' })
    expect(fake.turnParams.sandboxPolicy.writableRoots).toEqual([outcome.adapter.source])
    expect(fake.turnParams.approvalPolicy).toBe('never')

    const stored = await getLocalAgentTask({ dataDir, taskId: task.id })
    expect(stored.status).toBe('Succeeded')
    expect(stored.workspace.mode).toBe('worktree')
    expect(stored.workspace.baseCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(stored.bridge.threadId).toBe('thr_fake_1')
    expect(stored.runtimeResult.bridge.channel).toBe('codex-app-server')
    expect(stored.artifactSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.changedFiles).toContain('bridge-result.txt')

    // The user's own project tree must remain untouched.
    expect(await fs.readFile(path.join(projectPath, 'bridge-result.txt'), 'utf8').catch(() => null)).toBeNull()
    const eventTypes = stored.events.map((event) => event.type)
    for (const expected of ['bridge_detected', 'bridge_account', 'bridge_thread', 'workspace_created', 'completed']) {
      expect(eventTypes).toContain(expected)
    }
  }, 120_000)

  it('builds a task brief with environment, rules and the user prompt', () => {
    const brief = buildAgentBridgeBrief({
      task: { prompt: 'Fix the login redirect loop.', approvalPolicy: 'never' },
      project: { name: 'Demo Project' },
      adapter: { source: 'E:/ws/source', branch: 'nexus-agent/task-1', baseCommit: 'a'.repeat(40) },
      contextBundle: { disclosedPaths: ['src/login.js'] }
    })
    expect(brief).toContain('Fix the login redirect loop.')
    expect(brief).toContain('E:/ws/source')
    expect(brief).toContain('nexus-agent/task-1')
    expect(brief).toContain('Do not commit, push')
    expect(brief).toContain('src/login.js')
  })
})
