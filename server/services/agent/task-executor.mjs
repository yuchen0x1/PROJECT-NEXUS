import fs from 'node:fs/promises'
import path from 'node:path'
import { runAgentTask } from './runtime.mjs'
import { createAgentWorkspace } from './workspace-worktree.mjs'
import { buildProjectIndex } from './indexer.mjs'
import { buildTaskContextBundle } from './context.mjs'
import { resolveProviderForInvocation } from '../provider-store.mjs'
import { repoWorktreePath, repoWorkspaceRootFor, validateRepoFullName } from '../repo-workspace.mjs'

// Full agent task pipeline: resolve provider → create isolated workspace
// (worktree preferred) → index the workspace → select task context → run the
// agent loop → persist results. Exposes rollback and apply-to-project helpers
// used by the API endpoints.

export function agentWorkspaceHandleFor(task, dataDir) {
  if (!task?.workspace?.id || task.workspace.id !== task.id) return null
  const hostedRepository = task.type === 'issue-fix-runtime' && typeof task.issue?.repository === 'string'
    ? task.issue.repository
    : null
  const localProjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(task.projectId || ''))
  if (!hostedRepository && !localProjectId) return null
  if (hostedRepository) {
    try { validateRepoFullName(hostedRepository) } catch { return null }
  }
  if (hostedRepository && task.workspace.mode !== 'worktree') return null
  const rootBase = hostedRepository ? repoWorkspaceRootFor(dataDir) : path.join(dataDir, 'agent-workspaces', 'agent')
  const root = hostedRepository
    ? repoWorktreePath(dataDir, hostedRepository, task.id)
    : task.workspace.mode === 'worktree'
      ? path.join(rootBase, 'worktree', `nexus-agent__${task.workspace.id.replace(/[._]/g, '-')}`)
      : path.join(rootBase, task.projectId, task.workspace.id)
  return {
    id: task.workspace.id,
    mode: task.workspace.mode,
    projectId: task.projectId,
    projectName: task.projectName,
    repository: hostedRepository,
    workspaceRoot: rootBase,
    root,
    source: root,
    branch: task.workspace.branch || null
  }
}

export async function executeAgentRuntimeTask({ task, taskStore, dataDir, signal, options = {}, audit = () => {} }) {
  const tasks = await taskStore.list({ dataDir })
  const current = tasks.find((item) => item.id === task.id) || task
  // Hosted-repository pipelines (issue fixes) resolve the project themselves:
  // the "project path" is the NEXUS-managed cache clone instead of a locally
  // registered folder.
  const project = options.projectOverride || await resolveProject({ dataDir, projectId: current.projectId })
  if (!project) throw Object.assign(new Error('The selected local project is no longer registered or available.'), { code: 'LOCAL_PROJECT_NOT_AVAILABLE' })

  await taskStore.update({ taskId: task.id, patch: { status: 'Running', startedAt: new Date().toISOString(), phase: 'preparing' }, event: { type: 'started', detail: 'Agent runtime starting: provider, workspace, index, context.' } })

  const provider = await resolveProviderForInvocation({ dataDir, providerId: current.providerId, taskType: 'coding' })
  if (!provider) throw Object.assign(new Error('No configured AI provider with a valid API key was found for this task.'), { code: 'AI_NOT_CONFIGURED' })
  await taskStore.update({ taskId: task.id, patch: { provider: { id: provider.id, kind: provider.kind, host: safeHost(provider.baseUrl), model: provider.model } } })

  const hostedRepository = current.type === 'issue-fix-runtime' && typeof current.issue?.repository === 'string'
    ? current.issue.repository
    : null
  const agentWorkspaceRoot = hostedRepository ? repoWorkspaceRootFor(dataDir) : path.join(dataDir, 'agent-workspaces', 'agent')
  const agentWorkspacePath = hostedRepository ? repoWorktreePath(dataDir, hostedRepository, current.id) : null

  const { adapter, mode, fallbackReason } = await createAgentWorkspace({
    project,
    taskId: task.id,
    mode: options.workspaceMode || current.workspaceMode || 'auto',
    workspaceRoot: agentWorkspaceRoot,
    workspacePath: agentWorkspacePath,
    dataDir,
    signal
  })
  await taskStore.update({
    taskId: task.id,
      patch: {
        workspace: {
          id: task.id,
          mode,
          branch: adapter.branch || null,
          source: hostedRepository ? 'repositories/<owner>__<repo>/worktrees/<taskId>' : 'agent-workspaces/agent',
          createdAt: adapter.createdAt
        },
        workspaceMode: mode,
        fallbackReason
      },
    event: { type: 'workspace_created', detail: `Isolated ${mode} workspace created${fallbackReason ? ` (fallback: ${fallbackReason})` : ''}.`, metadata: { mode, branch: adapter.branch || null } }
  })

  const cacheFile = path.join(dataDir, 'agent-indexes', `${project.id}.json`)
  let index
  try {
    const built = await buildProjectIndex({ root: adapter.source, cacheFile })
    index = built.index
    await taskStore.update({ taskId: task.id, patch: { indexStats: { files: index.stats.files, entries: index.stats.entries, reindexed: built.reindexed } }, event: { type: 'index', detail: `Project index ready: ${index.stats.files} files (${built.reindexed} re-indexed).` } })
  } catch (error) {
    await taskStore.update({ taskId: task.id, patch: {}, event: { type: 'index_failed', detail: `Project indexing failed: ${String(error.message).slice(0, 300)}; continuing without index.` } })
    index = null
  }

  let contextBundle = null
  if (index) {
    try {
      contextBundle = await buildTaskContextBundle({ sourceRoot: adapter.source, index, prompt: current.prompt, budgetBytes: options.contextBudgetBytes || 120 * 1024 })
      await taskStore.update({ taskId: task.id, patch: { disclosedPaths: contextBundle.disclosedPaths }, event: { type: 'context', detail: `Task context: ${contextBundle.disclosedPaths.length} file(s) selected (${Math.round(contextBundle.usedBytes / 1024)} KB).`, metadata: { paths: contextBundle.disclosedPaths.slice(0, 40) } } })
    } catch (error) {
      await taskStore.update({ taskId: task.id, patch: {}, event: { type: 'context_failed', detail: `Context selection failed: ${String(error.message).slice(0, 300)}; the agent will read files itself.` } })
    }
  }

  const result = await runAgentTask({
    task: current,
    project,
    provider,
    adapter,
    index,
    contextBundle,
    taskStore,
    dataDir,
    signal,
    options: { approvalPolicy: current.approvalPolicy || options.approvalPolicy || 'standard', ...options },
    audit
  })

  const changesSummary = Array.isArray(result.changes) ? result.changes : null
  await taskStore.update({
    taskId: task.id,
    patch: {
      status: result.status === 'Succeeded' ? 'Succeeded' : 'Failed',
      finishedAt: new Date().toISOString(),
      phase: 'delivered',
      plan: result.plan,
      runtimeResult: {
        status: result.status,
        iterations: result.iterations,
        repairAttempts: result.repairAttempts,
        providerCalls: result.providerCalls,
        usage: result.usage,
        costUsd: result.costUsd,
        verification: result.verification,
        review: result.review,
        finalMessage: result.finalMessage,
        runtimeVersion: result.runtimeVersion,
        timedOut: result.timedOut,
        tokenExhausted: result.tokenExhausted
      },
      toolCallCount: result.toolCalls.length,
      changedFiles: changesSummary ? changesSummary.map((change) => change.path) : [],
      changeCount: changesSummary ? changesSummary.length : 0,
      usage: result.usage,
      costUsd: result.costUsd
    },
    event: {
      type: result.status === 'Succeeded' ? 'completed' : 'failed',
      detail: `${result.status}: ${result.iterations} iteration(s), ${result.toolCalls.length} tool call(s), ${result.repairAttempts} repair attempt(s). ${result.verification?.summary || ''}`.trim().slice(0, 900),
      metadata: { verification: result.verification?.summary || null, reviewFindings: result.review?.findings?.length ?? 0, changedFiles: changesSummary?.map((change) => change.path) || [] }
    }
  })
  audit('agent_runtime_task_completed', `${project.name} (${project.id})`, result.status.toLowerCase(), 'medium', { taskId: task.id, providerId: provider.id, model: provider.model, iterations: result.iterations, usage: result.usage })
  return { result, adapter, provider, project }
}

async function resolveProject({ dataDir, projectId }) {
  const { listLocalProjects } = await import('../local-projects.mjs')
  const projects = await listLocalProjects({ dataDir })
  return projects.find((item) => item.id === projectId && item.available) || null
}

function safeHost(value) {
  try { return new URL(value).host } catch { return null }
}

// ---- Change listing for finished tasks (task detail endpoint) ----

export async function listRuntimeTaskChanges({ task, dataDir, maxChanges = 40, maxFileBytes = 200 * 1024 }) {
  const handle = agentWorkspaceHandleFor(task, dataDir)
  if (!handle) return { changes: [], error: 'This task has no workspace handle.' }
  const info = await fs.lstat(handle.root).catch(() => null)
  if (!info) return { changes: [], error: 'The workspace for this task no longer exists.' }
  const { reconstructAdapter, parsePorcelain } = await import('./workspace-worktree.mjs')
  const { runCommand } = await import('./executor.mjs')
  const adapter = await reconstructAdapter({
    taskId: task.workspace.id,
    projectId: task.projectId,
    repository: handle.repository,
    mode: handle.mode,
    dataDir,
    workspaceRoot: handle.workspaceRoot
  })
  if (adapter.kind === 'copy') {
    const changes = await adapter.listChanges()
    return { changes: changes.slice(0, maxChanges), error: null }
  }
  // Worktree: derive before/after per file from HEAD and the working tree.
  const status = await runCommand({ cwd: adapter.source, command: 'git status --porcelain', timeoutMs: 20_000 })
  const raw = parsePorcelain(status.stdout || '')
  const changes = []
  for (const change of raw.slice(0, maxChanges)) {
    let before = null
    let after = null
    let contentStatus = 'available'
    try {
      if (change.action !== 'added') {
        const show = await runCommand({ cwd: adapter.source, command: `git show "HEAD:${change.path}"`, timeoutMs: 15_000, outputLimitBytes: maxFileBytes })
        if (show.ok) before = show.stdout
        else contentStatus = 'preview-unavailable'
      }
      if (change.action !== 'deleted') {
        const files = await adapter.readFiles([change.path], { maxFiles: 1, maxBytes: maxFileBytes })
        const file = files.find((item) => item.path === change.path)
        if (file) after = file.content
        else contentStatus = 'preview-unavailable'
      }
    } catch { contentStatus = 'preview-unavailable' }
    changes.push({ action: change.action, path: change.path, before, after, contentStatus })
  }
  return { changes, error: null }
}

// ---- Rollback ----

export async function rollbackAgentTask({ task, dataDir }) {
  const handle = agentWorkspaceHandleFor(task, dataDir)
  if (!handle) throw Object.assign(new Error('This task has no recoverable workspace.'), { code: 'AGENT_WORKSPACE_MISSING' })
  const info = await fs.lstat(handle.root).catch(() => null)
  if (!info) throw Object.assign(new Error('The workspace for this task no longer exists.'), { code: 'AGENT_WORKSPACE_GONE' })
  const { reconstructAdapter } = await import('./workspace-worktree.mjs')
  const adapter = await reconstructAdapter({
    taskId: task.workspace.id,
    projectId: task.projectId,
    repository: handle.repository,
    mode: handle.mode,
    dataDir,
    workspaceRoot: handle.workspaceRoot
  })
  const result = await adapter.restoreAll()
  return { rolledBack: true, workspace: handle.id, mode: handle.mode, ...result }
}

// ---- Apply workspace changes to the original project (explicit user action) ----

export async function applyAgentTaskToProject({ task, dataDir, confirm = false }) {
  if (confirm !== true) throw Object.assign(new Error('Applying changes to the original project requires explicit confirmation.'), { code: 'AGENT_APPLY_CONFIRMATION_REQUIRED' })
  // Paused tasks may still be awaiting an approval decision; applying their
  // workspace would deliver an unreviewed change set (audit finding, fixed).
  if (!['Succeeded', 'Failed'].includes(task.status)) {
    throw Object.assign(new Error('Only finished tasks can be applied to the project.'), { code: 'AGENT_APPLY_NOT_FINISHED' })
  }
  const handle = agentWorkspaceHandleFor(task, dataDir)
  if (!handle) throw Object.assign(new Error('This task has no workspace to apply.'), { code: 'AGENT_WORKSPACE_MISSING' })
  const project = await resolveProject({ dataDir, projectId: task.projectId })
  if (!project) throw Object.assign(new Error('The original project is no longer available.'), { code: 'LOCAL_PROJECT_NOT_AVAILABLE' })
  const { reconstructAdapter } = await import('./workspace-worktree.mjs')
  const adapter = await reconstructAdapter({
    taskId: task.workspace.id,
    projectId: task.projectId,
    repository: handle.repository,
    mode: handle.mode,
    dataDir,
    workspaceRoot: handle.workspaceRoot
  })

  const { changes, diff } = await adapter.diff()
  if (!changes.length) return { applied: false, note: 'The workspace has no changes to apply.', appliedPaths: [] }

  // Protect the user's own uncommitted work: refuse when the original tree is dirty.
  const statusResult = await import('./executor.mjs').then((module) => module.runCommand({
    cwd: project.path,
    command: 'git status --porcelain',
    timeoutMs: 20_000
  })).catch(() => null)
  const isGit = statusResult && statusResult.ok
  if (isGit && statusResult.stdout.trim()) {
    throw Object.assign(new Error('The original project has uncommitted changes. Commit or stash them before applying agent changes.'), { code: 'AGENT_APPLY_DIRTY_PROJECT' })
  }

  // Backup affected original files inside the workspace root before overwriting.
  const backupRoot = path.join(handle.workspaceRoot, 'apply-backup', task.id)
  const appliedPaths = []
  for (const change of changes) {
    const cleanSegments = change.path.replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.' && segment !== '..')
    if (!cleanSegments.length) continue
    const originalTarget = path.join(project.path, ...cleanSegments)
    const backupPath = path.join(backupRoot, ...cleanSegments)
    const originalInfo = await fs.lstat(originalTarget).catch(() => null)
    if (originalInfo?.isFile() && !originalInfo.isSymbolicLink()) {
      await fs.mkdir(path.dirname(backupPath), { recursive: true })
      await fs.copyFile(originalTarget, backupPath, fs.constants.COPYFILE_EXCL).catch(() => {})
    }
    if (change.action === 'deleted') {
      await fs.rm(originalTarget, { force: true })
    } else {
      const files = await adapter.readFiles([change.path], { maxFiles: 1, maxBytes: 4 * 1024 * 1024 })
      const file = files.find((item) => item.path === change.path)
      if (!file) throw Object.assign(new Error(`Workspace file could not be read for apply: ${change.path}`), { code: 'AGENT_APPLY_READ_FAILED' })
      await fs.mkdir(path.dirname(originalTarget), { recursive: true })
      await fs.writeFile(originalTarget, Buffer.from(file.content, 'utf8'))
    }
    appliedPaths.push(change.path)
  }
  return {
    applied: true,
    mode: handle.mode,
    appliedPaths,
    backupRoot,
    diffBytes: Buffer.byteLength(diff || '', 'utf8'),
    note: `Applied ${appliedPaths.length} file change(s) to the original project. Original versions backed up under the task workspace.`
  }
}
