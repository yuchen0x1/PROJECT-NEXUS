// Manual live smoke test for the Local Agent Bridge (master directive PART 6,
// acceptance scenario D). Requires a real local Codex CLI signed in.
//
//   node tests/codex-bridge-live.mjs            # detection + probe only
//   node tests/codex-bridge-live.mjs --turn     # + one real Codex turn
//
// The turn runs inside a throwaway git repo/worktree and consumes a tiny
// amount of the signed-in account's quota. Nothing is pushed or committed.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { detectCodexInstall, probeCodexBridge } from '../server/services/agent/codex-app-server.mjs'
import { executeAgentBridgeTask } from '../server/services/agent/bridge-executor.mjs'
import { registerLocalProject, listLocalProjects } from '../server/services/local-projects.mjs'
import { createLocalAgentTask, getLocalAgentTask, updateLocalAgentTask, listLocalAgentTasks } from '../server/services/local-agent-tasks.mjs'
import { runCommand } from '../server/services/agent/executor.mjs'

const withTurn = process.argv.includes('--turn')

console.log('[1] detectCodexInstall()')
const detection = await detectCodexInstall()
console.log(JSON.stringify(detection, null, 2))
if (!detection.installed) {
  console.error('RESULT: BLOCKED — Codex is not installed on this machine.')
  process.exit(2)
}

console.log('[2] probeCodexBridge() — initialize + account/read + model/list')
const probe = await probeCodexBridge({ launcher: detection.launcher })
console.log(JSON.stringify({ ...probe, diagnostics: undefined }, null, 2))
if (!probe.ok) {
  console.error(`RESULT: FAIL — probe failed${probe.error ? `: ${probe.error}` : ''}`)
  process.exit(1)
}
if (!probe.signedIn) {
  console.error('RESULT: BLOCKED — Codex is installed but not signed in (open Codex once and sign in).')
  process.exit(2)
}

if (!withTurn) {
  console.log('RESULT: PASS (detection + live probe). Re-run with --turn for a real task.')
  process.exit(0)
}

console.log('[3] real turn — isolated workspace + real Codex modification')
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-bridge-live-'))
const projectPath = path.join(tempRoot, 'project')
const dataDir = path.join(tempRoot, 'data')
await fs.mkdir(projectPath, { recursive: true })
await fs.mkdir(dataDir, { recursive: true })
await fs.writeFile(path.join(projectPath, 'README.md'), '# bridge live smoke\n', 'utf8')
await runCommand({ cwd: projectPath, command: 'git init -b main', timeoutMs: 30_000 })
await runCommand({ cwd: projectPath, command: 'git add -A', timeoutMs: 30_000 })
await runCommand({ cwd: projectPath, command: 'git -c user.name=nexus-live -c user.email=live@nexus.local commit -m init', timeoutMs: 30_000 })
await registerLocalProject({ dataDir, folderPath: projectPath })

const projects = await listLocalProjects({ dataDir })
const task = await createLocalAgentTask({
  dataDir,
  task: {
    id: `nexus_agent_live_${Date.now()}`,
    type: 'agent-bridge',
    label: 'Bridge live smoke',
    projectId: projects[0].id,
    projectName: projects[0].name,
    prompt: 'Create a file named bridge-result.txt whose content is exactly the single line BRIDGE_OK. Then reply with a one-sentence summary.',
    status: 'Queued',
    approvalPolicy: 'standard',
    workspaceMode: 'auto',
    sourceDisclosureConfirmedAt: new Date().toISOString(),
    disclosedPaths: [],
    changedFiles: []
  }
})

const taskStore = {
  create: (args) => createLocalAgentTask({ dataDir, task: args.task }),
  get: ({ taskId }) => getLocalAgentTask({ dataDir, taskId }),
  update: ({ taskId, patch, event }) => updateLocalAgentTask({ dataDir, taskId, patch, event }),
  list: () => listLocalAgentTasks({ dataDir })
}

const startedAt = Date.now()
try {
  const outcome = await executeAgentBridgeTask({ task, taskStore, dataDir, signal: null, options: {}, audit: () => {} })
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  const stored = await getLocalAgentTask({ dataDir, taskId: task.id })
  console.log(JSON.stringify({
    status: outcome.status,
    seconds,
    changes: outcome.changes.map((change) => change.path),
    verification: outcome.verification,
    bridge: stored.runtimeResult?.bridge || null,
    events: (stored.events || []).map((event) => `${event.type}: ${String(event.detail).slice(0, 140)}`)
  }, null, 2))
  const workspaceResult = await fs.readFile(path.join(outcome.adapter.source, 'bridge-result.txt'), 'utf8').catch(() => null)
  const originalTouched = await fs.readFile(path.join(projectPath, 'bridge-result.txt'), 'utf8').catch(() => null)
  console.log(`workspace file content: ${JSON.stringify(workspaceResult)}`)
  console.log(`original project touched: ${Boolean(originalTouched)}`)
  const pass = outcome.status === 'Succeeded' && workspaceResult?.includes('BRIDGE_OK') && !originalTouched
  console.log(pass ? 'RESULT: PASS — real Codex modified the isolated workspace; original tree untouched.' : 'RESULT: FAIL')
  process.exit(pass ? 0 : 1)
} catch (error) {
  const stored = await getLocalAgentTask({ dataDir, taskId: task.id }).catch(() => null)
  console.error('RESULT: FAIL —', error.code || '', error.message)
  if (stored) console.error(JSON.stringify({ status: stored.status, error: stored.error, events: (stored.events || []).slice(-8).map((event) => `${event.type}: ${String(event.detail).slice(0, 160)}`) }, null, 2))
  process.exit(1)
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}
