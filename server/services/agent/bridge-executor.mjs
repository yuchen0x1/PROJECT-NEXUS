import path from 'node:path'
import { createAgentWorkspace } from './workspace-worktree.mjs'
import { buildProjectIndex } from './indexer.mjs'
import { buildTaskContextBundle } from './context.mjs'
import { autoVerify } from './runtime.mjs'
import { captureWorkspaceEvidence } from '../workspace-evidence.mjs'
import { redactSecrets } from '../ai-provider.mjs'
import { detectCodexInstall, CodexAppServer, CODEX_SANDBOX_PRESETS } from './codex-app-server.mjs'

// Local Agent Bridge executor (PART 6/7 of the master directive): runs a task
// in an isolated NEXUS workspace and delegates the actual code understanding
// and modification to the user's local Codex via the official App Server
// protocol. PROJECT NEXUS stays responsible for discovery, isolation, event
// capture, verification and delivery; Codex does the coding.

const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000
const BRIEF_CONTEXT_BUDGET_BYTES = 60 * 1024

export function bridgeTurnTimeoutMs() {
  const value = Number(process.env.NEXUS_AGENT_BRIDGE_TURN_TIMEOUT_MS)
  return Number.isFinite(value) && value >= 30_000 ? value : DEFAULT_TURN_TIMEOUT_MS
}

export function buildAgentBridgeBrief({ task, project, adapter, contextBundle }) {
  const lines = []
  lines.push('You are executing a development task dispatched by PROJECT NEXUS, a local maintenance workstation the user runs on this machine.')
  lines.push('')
  lines.push('## Environment')
  lines.push(`- Project: ${project.name}`)
  lines.push(`- Your working directory (cwd): ${adapter.source}`)
  lines.push('- This directory is an ISOLATED workspace (a dedicated git worktree or bounded copy). The user\'s original project tree is elsewhere and MUST stay untouched; you cannot reach it.')
  if (adapter.branch) lines.push(`- Workspace branch: ${adapter.branch}`)
  if (adapter.baseCommit) lines.push(`- Base commit: ${adapter.baseCommit}`)
  if (contextBundle?.disclosedPaths?.length) {
    lines.push(`- Context files pre-selected for you: ${contextBundle.disclosedPaths.slice(0, 24).join(', ')}${contextBundle.disclosedPaths.length > 24 ? ' (and more)' : ''}`)
  }
  lines.push('')
  lines.push('## Task')
  lines.push(task.prompt)
  lines.push('')
  lines.push('## Rules')
  lines.push('1. Read and understand the relevant code first, locate the real root cause or implementation point, then implement the change directly. Do not stop at suggestions, plans or sample snippets.')
  lines.push('2. Only modify what the task requires. No unrelated refactoring, no reformatting, no drive-by fixes.')
  lines.push('3. Never weaken, delete or skip existing tests or checks to make them pass. Add or adjust tests when the task requires them.')
  lines.push('4. Do not commit, push, or touch git remotes/branches. Leave all changes in the working tree; PROJECT NEXUS captures and delivers the diff after independent verification.')
  lines.push('5. Do not read, create or modify secret-like files (.env, *.pem, *.key, credentials). Never print tokens or credentials.')
  lines.push('6. Do not modify anything outside your working directory, and do not attempt to elevate permissions.')
  lines.push('7. If the project defines build/test scripts, run the relevant ones before finishing and fix real failures you caused.')
  lines.push('8. When done, summarize what you changed and why, and mention any follow-up risk you noticed.')
  if (task.approvalPolicy) lines.push(`Approval policy for this session: ${task.approvalPolicy}; commands run under the app-server sandbox with writes confined to the working directory.`)
  return lines.join('\n')
}

function redactDetail(value, limit = 400) {
  return redactSecrets(String(value ?? '')).replace(/\s+/g, ' ').trim().slice(0, limit)
}

function sanitizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const pick = (value) => Number.isFinite(value) ? value : undefined
  const usage = {
    inputTokens: pick(raw.inputTokens ?? raw.input_tokens),
    cachedInputTokens: pick(raw.cachedInputTokens ?? raw.cached_input_tokens),
    outputTokens: pick(raw.outputTokens ?? raw.output_tokens),
    totalTokens: pick(raw.totalTokens ?? raw.total_tokens)
  }
  const hasKnown = Object.values(usage).some((value) => value !== undefined)
  return hasKnown ? usage : null
}

export async function executeAgentBridgeTask({ task, taskStore, dataDir, signal, options = {}, audit = () => {} }) {
  const tasks = await taskStore.list({ dataDir })
  const current = tasks.find((item) => item.id === task.id) || task
  const { listLocalProjects } = await import('../local-projects.mjs')
  const projects = await listLocalProjects({ dataDir })
  const project = projects.find((item) => item.id === current.projectId && item.available)
  if (!project) throw Object.assign(new Error('The selected local project is no longer registered or available.'), { code: 'LOCAL_PROJECT_NOT_AVAILABLE' })

  const addEvent = (patch, event) => taskStore.update({ taskId: current.id, patch: patch || {}, event })

  await taskStore.update({ taskId: current.id, patch: { status: 'Running', startedAt: new Date().toISOString(), phase: 'preparing' }, event: { type: 'started', detail: 'Agent Bridge starting: Codex detection, isolated workspace, task brief.' } })

  // 1. Codex must be present and launchable before any workspace is created.
  const detection = await detectCodexInstall({ signal })
  if (!detection?.installed) {
    throw Object.assign(new Error('Codex was not detected on this machine. Install the Codex CLI (winget install OpenAI.Codex) or set NEXUS_CODEX_PATH.'), { code: 'CODEX_NOT_DETECTED', detection })
  }
  await addEvent({ bridge: { channel: 'codex-app-server', version: detection.version || null, launcherCommand: path.basename(detection.launcher?.command || 'codex') } }, { type: 'bridge_detected', detail: `Codex detected: ${detection.version || 'version unknown'} (${path.basename(detection.launcher?.command || 'codex')}).` })
  if (signal?.aborted) throw cancellationError()

  // 2. Isolated workspace, exactly like the internal runtime pipeline.
  const agentWorkspaceRoot = path.join(dataDir, 'agent-workspaces', 'agent')
  const { adapter, mode, fallbackReason } = await createAgentWorkspace({
    project,
    taskId: current.id,
    mode: options.workspaceMode || current.workspaceMode || 'auto',
    workspaceRoot: agentWorkspaceRoot,
    dataDir,
    signal
  })
  await taskStore.update({
    taskId: current.id,
    patch: {
      workspace: {
        id: current.id,
        mode,
        branch: adapter.branch || null,
        baseCommit: adapter.baseCommit || null,
        source: 'agent-workspaces/agent',
        createdAt: adapter.createdAt
      },
      workspaceMode: mode,
      fallbackReason
    },
    event: { type: 'workspace_created', detail: `Isolated ${mode} workspace created${fallbackReason ? ` (fallback: ${fallbackReason})` : ''}; Codex writes are confined to it.`, metadata: { mode, branch: adapter.branch || null, source: adapter.source } }
  })

  // 3. Optional project index: powers context hints and post-run verification.
  const cacheFile = path.join(dataDir, 'agent-indexes', `${project.id}.json`)
  let index = null
  try {
    const built = await buildProjectIndex({ root: adapter.source, cacheFile })
    index = built.index
    await addEvent({ indexStats: { files: index.stats.files, entries: index.stats.entries, reindexed: built.reindexed } }, { type: 'index', detail: `Project index ready: ${index.stats.files} files (${built.reindexed} re-indexed).` })
  } catch (error) {
    await addEvent({}, { type: 'index_failed', detail: `Project indexing failed: ${redactDetail(error.message, 300)}; continuing without index.` })
  }

  let contextBundle = null
  if (index) {
    try {
      contextBundle = await buildTaskContextBundle({ sourceRoot: adapter.source, index, prompt: current.prompt, budgetBytes: BRIEF_CONTEXT_BUDGET_BYTES })
      await addEvent({ disclosedPaths: contextBundle.disclosedPaths }, { type: 'context', detail: `Task context: ${contextBundle.disclosedPaths.length} file(s) selected (${Math.round(contextBundle.usedBytes / 1024)} KB).`, metadata: { paths: contextBundle.disclosedPaths.slice(0, 40) } })
    } catch (error) {
      await addEvent({}, { type: 'context_failed', detail: `Context selection failed: ${redactDetail(error.message, 300)}; Codex will explore the workspace itself.` })
    }
  }

  // 4. Launch the official app server and verify the account state.
  const client = new CodexAppServer({ launcher: detection.launcher })
  let thread = null
  let turn = null
  const changedPaths = new Set()
  let toolCalls = 0
  let finalMessage = ''
  let usage = null
  let authMode = null
  const state = { timedOut: false }

  const recordItem = async (item, lifecycle) => {
    if (!item || typeof item !== 'object') return
    const type = String(item.type || 'item')
    if (type === 'agentMessage') {
      if (lifecycle === 'completed' && typeof item.text === 'string' && item.text.trim()) {
        finalMessage = item.text
        await addEvent({}, { type: 'agent_message', detail: redactDetail(item.text, 800) })
      }
      return
    }
    if (type === 'commandExecution') {
      toolCalls += 1
      if (lifecycle === 'completed') {
        const exit = item.exitCode
        await addEvent({}, { type: 'command', detail: `${redactDetail(item.command, 240)} → ${exit === undefined || exit === null ? 'no exit' : `exit ${exit}`}` })
      } else {
        await addEvent({}, { type: 'command_started', detail: redactDetail(item.command, 240) })
      }
      return
    }
    if (type === 'fileChange') {
      toolCalls += 1
      const paths = Array.isArray(item.changes) ? item.changes.map((change) => String(change?.path || '')).filter(Boolean) : []
      paths.forEach((itemPath) => changedPaths.add(itemPath))
      await addEvent({}, { type: 'file_change', detail: paths.length ? `Codex proposes changes to: ${paths.slice(0, 10).join(', ')}${paths.length > 10 ? ` (+${paths.length - 10} more)` : ''}` : 'Codex proposed a file change.' })
      return
    }
    if (type === 'reasoning' || type === 'plan' || type === 'userMessage') return
    if (lifecycle === 'completed') {
      await addEvent({}, { type: 'bridge_item', detail: `${type}: ${redactDetail(item.text || item.command || item.review || '', 200)}` })
    }
  }

  const timeoutGuard = setTimeout(() => { state.timedOut = true }, bridgeTurnTimeoutMs())
  try {
    await client.start()
    client.serverRequestHandler = (message) => {
      // NEXUS runs Codex with approvalPolicy "never"; any approval request is
      // declined and recorded. Non-approval server requests are unsupported.
      if (typeof message?.method === 'string' && message.method.includes('requestApproval')) {
        void addEvent({}, { type: 'approval_declined', detail: `Declined an app-server approval request (${redactDetail(message.method, 120)}): the task runs with approvalPolicy "never".` })
        return { decision: 'decline' }
      }
      throw Object.assign(new Error('Unsupported server request'), { code: 'CODEX_SERVER_REQUEST_UNSUPPORTED' })
    }
    const offTokenUsage = client.onNotification('thread/tokenUsage/updated', (params) => {
      const sanitized = sanitizeUsage(params?.tokenUsage ?? params)
      if (sanitized) usage = sanitized
    })
    const offPlan = client.onNotification('turn/plan/updated', (params) => {
      const steps = Array.isArray(params?.plan) ? params.plan.map((entry) => ({ step: String(entry?.step ?? '').slice(0, 300), status: entry?.status || 'pending' })) : null
      if (steps) void taskStore.update({ taskId: current.id, patch: { plan: steps }, event: { type: 'plan', detail: `Codex plan updated: ${steps.length} step(s).` } })
    })
    const offItemStarted = client.onNotification('item/started', (params) => { void recordItem(params?.item, 'started').catch(() => {}) })
    const offItemCompleted = client.onNotification('item/completed', (params) => { void recordItem(params?.item, 'completed').catch(() => {}) })
    const offTurnCompleted = client.onNotification('turn/completed', (params) => { turn = params?.turn || turn })
    const offError = client.onNotification('error', (params) => {
      void addEvent({}, { type: 'bridge_error', detail: redactDetail(params?.error?.message || 'App server error.', 500) })
    })

    const account = await client.accountRead()
    if (!account.account && account.requiresOpenaiAuth) {
      throw Object.assign(new Error('Codex is installed but not signed in. Open Codex once and sign in, then retry the task.'), { code: 'CODEX_AUTH_REQUIRED' })
    }
    authMode = account.account?.type || null
    await addEvent({ bridge: { ...(current.bridge || {}), authMode } }, { type: 'bridge_account', detail: `Codex auth mode: ${authMode || 'none (no OpenAI credentials required)'}.` })

    thread = await client.threadStart({ cwd: adapter.source, approvalPolicy: 'never', sandbox: 'workspaceWrite' })
    if (!thread?.id) throw Object.assign(new Error('The app server did not return a thread id.'), { code: 'CODEX_THREAD_START_FAILED' })
    await addEvent({ bridge: { ...(current.bridge || {}), threadId: thread.id, modelProvider: thread.modelProvider || null } }, { type: 'bridge_thread', detail: `Codex session ${thread.id} started in the isolated workspace.` })

    const brief = buildAgentBridgeBrief({ task: current, project, adapter, contextBundle })
    await addEvent({ phase: 'agent_working' }, { type: 'turn_started', detail: 'Task brief sent to Codex; waiting for the agent to work.' })
    if (signal?.aborted) throw cancellationError()
    await client.turnStart({
      threadId: thread.id,
      input: [{ type: 'text', text: brief }],
      cwd: adapter.source,
      approvalPolicy: 'never',
      sandboxPolicy: CODEX_SANDBOX_PRESETS.workspaceWrite([adapter.source], { networkAccess: options.networkAccess !== false })
    })

    const finished = await waitForTurnCompletion({ client, threadId: thread.id, signal, state, getTurn: () => turn })
    turn = finished.turn
    if (signal?.aborted) {
      throw cancellationError()
    }
    if (state.timedOut) {
      throw Object.assign(new Error(`The Codex turn exceeded ${Math.round(bridgeTurnTimeoutMs() / 60_000)} minutes and was interrupted.`), { code: 'AI_TIMEOUT' })
    }
    if (finished.status !== 'completed') {
      const detail = finished.error?.message ? redactDetail(finished.error.message, 600) : `turn ${finished.status}`
      throw Object.assign(new Error(`The Codex turn ended with status "${finished.status}": ${detail}`), { code: finished.status === 'failed' ? 'CODEX_TURN_FAILED' : 'CODEX_TURN_INTERRUPTED' })
    }

    offTokenUsage(); offPlan(); offItemStarted(); offItemCompleted(); offTurnCompleted(); offError()
  } finally {
    clearTimeout(timeoutGuard)
    await client.dispose().catch(() => {})
  }

  // 5. Independent verification on the resulting workspace.
  await addEvent({ phase: 'verifying' }, { type: 'phase', detail: 'Verification started.' })
  const verification = await autoVerify({ adapter, index, signal })
  await addEvent({ verification }, { type: 'verification', detail: `Verification: ${verification.summary}` })

  // 6. Capture the diff, evidence and persist the outcome.
  const { changes, diff } = await adapter.diff()
  const evidence = changes.length ? await captureWorkspaceEvidence(adapter, { signal }) : null
  const verificationPassed = !verification.attempted || verification.passed
  const status = verificationPassed ? 'Succeeded' : 'Failed'
  const finishedAt = new Date().toISOString()
  const result = await taskStore.update({
    taskId: current.id,
    patch: {
      status,
      finishedAt,
      phase: 'delivered',
      changedFiles: changes.map((change) => change.path),
      changeCount: changes.length,
      toolCallCount: toolCalls,
      usage,
      artifactSha256: evidence?.artifactSha256 || null,
      runtimeResult: {
        status,
        channel: 'codex-app-server',
        bridge: {
          channel: 'codex-app-server',
          threadId: thread?.id || current.bridge?.threadId || null,
          modelProvider: thread?.modelProvider || null,
          authMode,
          version: detection.version || null,
          turnStatus: turn?.status || null,
          timedOut: state.timedOut
        },
        iterations: 1,
        repairAttempts: 0,
        providerCalls: 0,
        usage,
        costUsd: null,
        costKnown: false,
        verification,
        review: null,
        finalMessage: finalMessage.slice(0, 8_000),
        runtimeVersion: 'agent-bridge-1'
      }
    },
    event: {
      type: status === 'Succeeded' ? 'completed' : 'failed',
      detail: `${status}: ${changes.length} file change(s) in the isolated workspace. ${verification.summary}`.trim().slice(0, 900),
      metadata: { verification: verification.summary || null, changedFiles: changes.map((change) => change.path), diffBytes: Buffer.byteLength(diff || '', 'utf8') }
    }
  })
  audit('agent_bridge_task_completed', `${project.name} (${project.id})`, status.toLowerCase(), 'medium', { taskId: current.id, threadId: thread?.id || null, changedFiles: changes.length, verification: verification.summary })
  return { result, adapter, project, changes, verification, status }
}

async function waitForTurnCompletion({ client, threadId, signal, state, getTurn }) {
  return await new Promise((resolve, reject) => {
    let settled = false
    let offCompleted = null
    let poll = null
    let abortListener = null
    let overduePolls = 0
    const cleanup = () => {
      offCompleted?.()
      if (poll) clearInterval(poll)
      if (abortListener && signal) signal.removeEventListener('abort', abortListener)
    }
    const finish = (value) => { if (settled) return; settled = true; cleanup(); resolve(value) }
    const fail = (error) => { if (settled) return; settled = true; cleanup(); reject(error) }
    if (signal?.aborted) return fail(cancellationError())
    if (signal) {
      abortListener = () => fail(cancellationError())
      signal.addEventListener('abort', abortListener)
    }
    offCompleted = client.onNotification('turn/completed', (params) => {
      const turn = params?.turn || null
      finish({ turn, status: turn?.status || 'failed', error: turn?.error || params?.error || null })
    })
    // The soft timeout flags state.timedOut and requests interruption every
    // poll. If the app server never confirms the interruption, force-fail
    // after ~60s so the task cannot hang forever.
    poll = setInterval(() => {
      if (!state.timedOut) return
      overduePolls += 1
      void client.turnInterrupt(threadId, getTurn()?.id ?? '').catch(() => {})
      if (overduePolls >= 30) fail(Object.assign(new Error('The Codex turn timed out and did not acknowledge the interruption.'), { code: 'AI_TIMEOUT' }))
    }, 2_000)
  })
}

function cancellationError() {
  return Object.assign(new Error('Local Agent task was cancelled.'), { code: 'LOCAL_AGENT_CANCELLED' })
}
