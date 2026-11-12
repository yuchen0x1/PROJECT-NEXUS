import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgentWorkspace, createWorktreeWorkspace } from '../../server/services/agent/workspace-worktree.mjs'
import { createLocalAgentWorkspace, applyLocalAgentOperations, deleteLocalAgentFile, restoreLocalAgentFile, restoreAllLocalAgentFiles } from '../../server/services/local-agent-workspace.mjs'

let tempRoot
let projectPath
let workspaceRoot
let dataDir

async function fresh() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-ws-'))
  projectPath = path.join(tempRoot, 'project')
  workspaceRoot = path.join(tempRoot, 'workspaces')
  dataDir = path.join(tempRoot, 'data')
  await fs.mkdir(projectPath, { recursive: true })
  await fs.mkdir(workspaceRoot, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
}

await fresh()

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  await fresh()
})

async function createGitProject() {
  await fs.mkdir(path.join(projectPath, 'lib'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'app.js'), 'export const version = "1.0.0"\n', 'utf8')
  await fs.writeFile(path.join(projectPath, 'lib', 'util.js'), 'export const add = (a, b) => a + b\n', 'utf8')
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\n', 'utf8')
  const { runCommand } = await import('../../server/services/agent/executor.mjs')
  await runCommand({ cwd: projectPath, command: 'git init -b main', timeoutMs: 20_000 })
  await runCommand({ cwd: projectPath, command: 'git add -A', timeoutMs: 20_000 })
  await runCommand({ cwd: projectPath, command: 'git -c user.name=nexus-test -c user.email=nexus@test.local commit -m "init"', timeoutMs: 20_000 })
}

describe('worktree workspace adapter', () => {
  it('creates an isolated worktree, tracks modifications, diffs, restores and disposes', async () => {
    await createGitProject()
    const { adapter, mode, fallbackReason } = await createAgentWorkspace({
      project: { id: 'p1', name: 'demo', path: projectPath },
      taskId: 'task-wt-1',
      mode: 'auto',
      workspaceRoot
    })
    expect(mode).toBe('worktree')
    expect(fallbackReason).toBeNull()
    expect(adapter.kind).toBe('worktree')
    expect(adapter.branch).toBe('nexus-agent/task-wt-1')
    expect(adapter.source.toLowerCase().includes(projectPath.toLowerCase())).toBe(false)

    // The user's original project stays untouched.
    const originalStatus = await fs.readFile(path.join(projectPath, 'app.js'), 'utf8')
    expect(originalStatus).toContain('1.0.0')

    await adapter.applyOperations([
      { action: 'replace', path: 'app.js', content: 'export const version = "1.1.0"\n' },
      { action: 'create', path: 'lib/extra.js', content: 'export const extra = true\n' }
    ])
    const { changes, diff } = await adapter.diff()
    expect(changes.map((change) => change.path).sort()).toEqual(['app.js', 'lib/extra.js'])
    expect(diff).toContain('b/app.js')
    expect(diff).toContain('+export const version = "1.1.0"')

    // Single-file restore: modified file returns to HEAD state, created file is removed.
    await adapter.restoreFile('app.js')
    expect(await fs.readFile(path.join(adapter.source, 'app.js'), 'utf8')).toContain('1.0.0')
    await adapter.restoreFile('lib/extra.js')
    expect(await fs.stat(path.join(adapter.source, 'lib', 'extra.js')).catch(() => null)).toBeNull()

    // Full reset then re-edit, then restoreAll.
    await adapter.applyOperations([
      { action: 'replace', path: 'lib/util.js', content: 'export const add = (a, b) => a + b + 1\n' },
      { action: 'create', path: 'scratch.txt', content: 'scratch\n' }
    ])
    await adapter.restoreAll()
    const { changes: afterReset } = await adapter.diff()
    expect(afterReset).toEqual([])
    expect(await fs.readFile(path.join(adapter.source, 'lib', 'util.js'), 'utf8')).toContain('(a, b) => a + b')

    const dispose = await adapter.dispose()
    expect(dispose.removedBranch).toBe(true)
    expect(await fs.stat(adapter.root).catch(() => null)).toBeNull()
  }, 60_000)

  it('reads files from the worktree with secret-like paths excluded', async () => {
    await createGitProject()
    const { adapter, mode } = await createAgentWorkspace({
      project: { id: 'p1', name: 'demo', path: projectPath },
      taskId: 'task-wt-2',
      mode: 'worktree',
      workspaceRoot
    })
    expect(mode).toBe('worktree')
    const files = await adapter.readFiles(['app.js', 'lib/util.js', '.env'], { maxBytes: 100_000 })
    expect(files.map((file) => file.path)).toEqual(['app.js', 'lib/util.js'])
    await adapter.dispose()
  }, 60_000)

  it('rejects a second worktree for the same task id and invalid task ids', async () => {
    await createGitProject()
    await createWorktreeWorkspace({ projectPath, taskId: 'task-dup', workspaceRoot })
    await expect(createWorktreeWorkspace({ projectPath, taskId: 'task-dup', workspaceRoot })).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_EXISTS' })
    await expect(createWorktreeWorkspace({ projectPath, taskId: '../escape', workspaceRoot })).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_INVALID_ID' })
    await expect(createWorktreeWorkspace({ projectPath: 'relative/path', taskId: 'task-x', workspaceRoot })).rejects.toMatchObject({ code: 'AGENT_WORKSPACE_INVALID_PATH' })
  }, 60_000)
})

describe('copy workspace adapter with delete and restore', () => {
  it('applies operations, deletes files, and restores from the baseline', async () => {
    await fresh()
    await fs.writeFile(path.join(projectPath, 'app.js'), 'const a = 1\n', 'utf8')
    await fs.writeFile(path.join(projectPath, 'keep.js'), 'const b = 2\n', 'utf8')
    const project = { id: '11111111-2222-4333-8444-555555555555', name: 'copy-demo', path: projectPath }
    const handle = await createLocalAgentWorkspace({ dataDir, project, taskId: 'task-copy-1' })
    const adapter = await import('../../server/services/agent/workspace-worktree.mjs').then((module) => {
      // Use the factory's copy branch through a non-git project.
      return module.createAgentWorkspace({ project, taskId: 'task-copy-2', mode: 'auto', workspaceRoot, dataDir })
    })
    expect(adapter.mode).toBe('copy')
    expect(adapter.adapter.kind).toBe('copy')
    // A non-git project legitimately falls back: the recorded reason must say so.
    expect(adapter.fallbackReason).toMatch(/git/i)

    await adapter.adapter.applyOperations([
      { action: 'replace', path: 'app.js', content: 'const a = 42\n' },
      { action: 'create', path: 'new-file.js', content: 'const c = 3\n' }
    ])
    let changes = await adapter.adapter.listChanges()
    expect(changes.map((change) => `${change.action}:${change.path}`).sort()).toEqual(['added:new-file.js', 'modified:app.js'])

    // delete_file tool surface: delete the newly created file.
    expect(await adapter.adapter.deleteFile('new-file.js')).toBe('new-file.js')
    changes = await adapter.adapter.listChanges()
    expect(changes.map((change) => `${change.action}:${change.path}`)).toEqual(['modified:app.js'])

    // restore single file to baseline.
    await adapter.adapter.restoreFile('app.js')
    expect(await fs.readFile(path.join(adapter.adapter.source, 'app.js'), 'utf8')).toBe('const a = 1\n')
    changes = await adapter.adapter.listChanges()
    expect(changes).toEqual([])

    // delete a baseline file then restore it.
    await deleteLocalAgentFile(handle, 'keep.js')
    expect(await fs.stat(path.join(handle.source, 'keep.js')).catch(() => null)).toBeNull()
    const restored = await restoreLocalAgentFile(handle, 'keep.js')
    expect(restored.restored).toBe(true)
    expect(await fs.readFile(path.join(handle.source, 'keep.js'), 'utf8')).toBe('const b = 2\n')

    // restoreAll rolls everything back.
    await applyLocalAgentOperations(handle, [{ action: 'replace', path: 'keep.js', content: 'changed\n' }, { action: 'create', path: 'x/y/deep.js', content: 'deep\n' }])
    await restoreAllLocalAgentFiles(handle)
    const finalChanges = await adapter.adapter.listChanges()
    expect(finalChanges).toEqual([])
    expect(await fs.stat(path.join(handle.source, 'x', 'y', 'deep.js')).catch(() => null)).toBeNull()
    await adapter.adapter.dispose()
  }, 60_000)

  it('refuses secret-like and traversal paths on delete', async () => {
    await fresh()
    await fs.writeFile(path.join(projectPath, 'app.js'), 'x\n', 'utf8')
    await fs.writeFile(path.join(projectPath, '.env.local'), 'SECRET=1\n', 'utf8')
    const project = { id: '11111111-2222-4333-8444-555555555556', name: 'sec-demo', path: projectPath }
    const handle = await createLocalAgentWorkspace({ dataDir, project, taskId: 'task-copy-3' })
    await expect(deleteLocalAgentFile(handle, '../outside.js')).rejects.toMatchObject({ code: 'LOCAL_AGENT_WORKSPACE_INVALID' })
    await expect(deleteLocalAgentFile(handle, '.env.local')).rejects.toMatchObject({ code: 'LOCAL_AGENT_WORKSPACE_INVALID' })
    await expect(restoreLocalAgentFile(handle, '../../system32')).rejects.toMatchObject({ code: 'LOCAL_AGENT_WORKSPACE_INVALID' })
    await handle.dispose?.().catch?.(() => {}) ?? await fs.rm(handle.root, { recursive: true, force: true })
  }, 60_000)

  it('falls back to copy mode with a recorded reason when the project has no git', async () => {
    await fresh()
    await fs.writeFile(path.join(projectPath, 'plain.txt'), 'no git here\n', 'utf8')
    const project = { id: '11111111-2222-4333-8444-555555555557', name: 'plain-project', path: projectPath }
    const result = await createAgentWorkspace({ project, taskId: 'task-fallback', mode: 'auto', workspaceRoot, dataDir })
    expect(result.mode).toBe('copy')
    expect(result.fallbackReason).toMatch(/git/i)
    expect(result.adapter.kind).toBe('copy')
    await result.adapter.dispose()
  }, 60_000)
})
