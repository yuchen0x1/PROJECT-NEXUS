import crypto from 'node:crypto'
import path from 'node:path'
import { createAgentWorkspace } from './agent/workspace-worktree.mjs'
import { scanProjectStructure } from './agent/indexer.mjs'
import { createToolContext, executeTool } from './agent/tools.mjs'
import { createLocalAgentTask, updateLocalAgentTask } from './local-agent-tasks.mjs'
import { captureWorkspaceEvidence } from './workspace-evidence.mjs'
import { redactSecrets } from './ai-provider.mjs'

const fail = (code, message) => Object.assign(new Error(message), { code })
export async function runIndependentTests({ input, artifact, project, dataDir, draft, onTask, trusted }) {
  const authored = draft.testFiles || []
  if (!Array.isArray(authored) || authored.length > 8 || authored.some((file) => !file || typeof file.path !== 'string' || !/^nexus-tests\/[A-Za-z0-9_/-]+\.test\.mjs$/.test(file.path) || file.path.split('/').some((part) => !part || part === '..') || typeof file.content !== 'string' || !file.content.trim() || Buffer.byteLength(file.content) > 64000) || new Set(authored.map((file) => file.path)).size !== authored.length) throw fail('WORKFLOW_TEST_PLAN_INVALID', 'Independent tests must be bounded new Node test files under nexus-tests/.')
  const taskId = `evolution_test_${crypto.randomUUID()}`
  await createLocalAgentTask({ dataDir, task: { id: taskId, workflowId: input.workflow.id, roleId: input.node.id, role: 'tester', type: 'collaboration-tests', projectId: project.id, projectName: project.name, label: 'Independent candidate tests', prompt: input.workflow.prompt, status: 'Queued' } })
  await onTask(input.workflow.id, input.node.id, taskId)
  await updateLocalAgentTask({ dataDir, taskId, patch: { status: 'Running', phase: 'testing', startedAt: new Date().toISOString() } })
  try {
    // A separate bounded snapshot includes the developer's actual uncommitted
    // bytes. A new Git worktree from HEAD would silently lose those changes.
    const { adapter } = await createAgentWorkspace({ project: { ...project, path: artifact.adapter.source }, taskId, mode: 'copy', workspaceRoot: path.join(dataDir, 'agent-workspaces', 'tests'), dataDir, signal: input.signal })
    await updateLocalAgentTask({ dataDir, taskId, patch: { workspaceMode: 'copy', workspace: { id: taskId, mode: 'copy', createdAt: new Date().toISOString() } } })
    if (authored.length) await adapter.applyOperations(authored.map((file) => ({ action: 'create', ...file })))
    const index = await scanProjectStructure(adapter.source), ctx = createToolContext({ adapter, index, manifests: index.manifests, signal: input.signal })
    const checks = await trusted(input.workflow, input.signal, async () => {
      const commands = [{ name: 'test', ...await executeTool('run_tests', {}, ctx) }]
      if (index.manifests.some((item) => item.scripts?.build)) commands.push({ name: 'build', ...await executeTool('build_project', {}, ctx) })
      if (authored.length) commands.push({ name: 'independent-tests', ...await executeTool('run_command', { command: `node --test ${authored.map((file) => file.path).join(' ')}`, timeoutMs: 120000 }, ctx) })
      return commands.map(({ name, ok, exitCode, stdout, stderr }) => ({ name, ok, exitCode, stdout: redactSecrets(stdout || '').slice(-3000), stderr: redactSecrets(stderr || '').slice(-2000) }))
    })
    const evidence = await captureWorkspaceEvidence(adapter, { signal: input.signal })
    const verified = checks.length > 0 && checks.every((check) => check.ok === true && check.exitCode === 0)
    await updateLocalAgentTask({ dataDir, taskId, patch: { status: verified ? 'Succeeded' : 'Failed', finishedAt: new Date().toISOString(), phase: 'delivered', testResults: checks, changedFiles: authored.map((file) => file.path), artifactSha256: evidence.artifactSha256 }, event: { type: 'independent_tests', detail: `${authored.length} independent test file(s); ${verified ? 'PASS' : 'FAIL'}.` } })
    return { checks, verified, testTaskId: taskId, testFiles: authored.map(({ path: file, content }) => ({ path: file, sha256: crypto.createHash('sha256').update(content).digest('hex') })), testArtifactSha256: evidence.artifactSha256, independentTestsAuthored: authored.length > 0 }
  } catch (cause) {
    await updateLocalAgentTask({ dataDir, taskId, patch: { status: input.signal.aborted ? 'Interrupted' : 'Failed', finishedAt: new Date().toISOString(), error: cause.code || cause.name } })
    throw cause
  }
}
