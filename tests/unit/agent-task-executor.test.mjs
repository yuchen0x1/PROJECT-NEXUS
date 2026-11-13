import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { executeAgentRuntimeTask, rollbackAgentTask, applyAgentTaskToProject, agentWorkspaceHandleFor } from '../../server/services/agent/task-executor.mjs'
import { registerLocalProject } from '../../server/services/local-projects.mjs'
import { createLocalAgentTask, getLocalAgentTask, updateLocalAgentTask, listLocalAgentTasks } from '../../server/services/local-agent-tasks.mjs'

const servers = []
let tempRoot
let projectPath
let dataDir

async function fresh() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-texec-'))
  projectPath = path.join(tempRoot, 'project')
  dataDir = path.join(tempRoot, 'data')
  await fs.mkdir(projectPath, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
}

await fresh()

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  await fresh()
})

async function setupGitProject() {
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'texec-demo', type: 'module', scripts: { test: 'node src/selfcheck.js' } }), 'utf8')
  await fs.writeFile(path.join(projectPath, 'src', 'main.js'), 'export const answer = 41\n', 'utf8')
  await fs.writeFile(path.join(projectPath, 'src', 'selfcheck.js'), `
import fs from 'node:fs'
const main = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8')
process.exit(main.includes('answer = 42') ? 0 : 1)
`, 'utf8')
  const { runCommand } = await import('../../server/services/agent/executor.mjs')
  await runCommand({ cwd: projectPath, command: 'git init -b main', timeoutMs: 20_000 })
  await runCommand({ cwd: projectPath, command: 'git add -A', timeoutMs: 20_000 })
  await runCommand({ cwd: projectPath, command: 'git -c user.name=t -c user.email=t@t.local commit -m init', timeoutMs: 20_000 })
  await registerLocalProject({ dataDir, folderPath: projectPath })
}

function scriptedProvider(responses) {
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const next = responses.shift()
      if (next === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'script exhausted' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }], usage: { prompt_tokens: 50, completion_tokens: 25 } }))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function providerRecord(server) {
  const { setRuntimeProviderKeys, createProviderRecord } = await import('../../server/services/provider-store.mjs')
  await createProviderRecord({ dataDir, provider: { id: 'scripted', name: 'Scripted', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'scripted-model' } })
  setRuntimeProviderKeys({ scripted: 'scripted-key' })
}

const taskStore = {
  create: (args) => createLocalAgentTask({ dataDir, task: args.task }),
  get: ({ taskId }) => getLocalAgentTask({ dataDir, taskId }),
  update: ({ taskId, patch, event }) => updateLocalAgentTask({ dataDir, taskId, patch, event }),
  list: () => listLocalAgentTasks({ dataDir })
}

describe('agent task executor pipeline', () => {
  it('runs the full pipeline and persists a complete, verifiable task record', async () => {
    await setupGitProject()
    const server = await scriptedProvider([
      { thought: 'plan', plan: ['read main.js', 'set answer to 42', 'verify'], first_tool: { name: 'read_file', args: { path: 'src/main.js' } } },
      { thought: 'editing', tool: { name: 'edit_file', args: { path: 'src/main.js', oldText: 'answer = 41', newText: 'answer = 42' } } },
      { thought: 'finished', final: 'Set answer to 42. Verification runs automatically.' },
      { findings: [], verdict: 'approve', overall: 'The focused change passes its self-check.' }
    ])
    servers.push(server)
    await providerRecord(server)
    const { listLocalProjects } = await import('../../server/services/local-projects.mjs')
    const project = (await listLocalProjects({ dataDir }))[0]
    const task = await createLocalAgentTask({ dataDir, task: { id: 'nexus_agent_tex1', type: 'local-agent-runtime', label: 'pipeline', projectId: project.id, projectName: project.name, prompt: 'Set answer to 42 in src/main.js and make the self-check pass.', status: 'Queued', approvalPolicy: 'standard' } })

    const { result } = await executeAgentRuntimeTask({ task, taskStore, dataDir, signal: null, options: { approvalPolicy: 'standard' } })

    expect(result.status).toBe('Succeeded')
    expect(result.verification.passed).toBe(true)
    expect(result.review.verdict).toBe('approve')

    const persisted = await getLocalAgentTask({ dataDir, taskId: task.id })
    expect(persisted.status).toBe('Succeeded')
    expect(persisted.workspace.mode).toBe('worktree')
    expect(persisted.workspace.id).toBe(task.id)
    expect(persisted.provider).toMatchObject({ id: 'scripted', model: 'scripted-model' })
    expect(persisted.plan.length).toBe(3)
    expect(persisted.toolCallCount).toBeGreaterThanOrEqual(2)
    expect(persisted.changedFiles).toContain('src/main.js')
    expect(persisted.usage.totalTokens).toBeGreaterThan(0)
    expect(persisted.disclosedPaths.length).toBeGreaterThan(0)
    expect(persisted.events.some((event) => event.type === 'verification')).toBe(true)

    // Original project untouched by the run itself.
    expect(await fs.readFile(path.join(projectPath, 'src', 'main.js'), 'utf8')).toContain('answer = 41')
    expect(await fs.stat(path.join(dataDir, 'agent-indexes', `${project.id}.json`)).catch(() => null)).not.toBeNull()
  }, 120_000)

  it('rolls a completed task back to a clean workspace state', async () => {
    await setupGitProject()
    const server = await scriptedProvider([
      { thought: 'plan', plan: ['edit'], first_tool: { name: 'read_file', args: { path: 'src/main.js' } } },
      { thought: 'editing', tool: { name: 'edit_file', args: { path: 'src/main.js', oldText: 'answer = 41', newText: 'answer = 42' } } },
      { thought: 'finished', final: 'Edited.' }
    ])
    servers.push(server)
    await providerRecord(server)
    const { listLocalProjects } = await import('../../server/services/local-projects.mjs')
    const project = (await listLocalProjects({ dataDir }))[0]
    const task = await createLocalAgentTask({ dataDir, task: { id: 'nexus_agent_tex2', type: 'local-agent-runtime', label: 'rollback', projectId: project.id, projectName: project.name, prompt: 'edit main', status: 'Queued', approvalPolicy: 'standard' } })
    await executeAgentRuntimeTask({ task, taskStore, dataDir, signal: null, options: { approvalPolicy: 'standard' } })

    const finished = await getLocalAgentTask({ dataDir, taskId: task.id })
    const rollback = await rollbackAgentTask({ task: finished, dataDir })
    expect(rollback.rolledBack).toBe(true)
    expect(rollback.mode).toBe('worktree')

    // After rollback the worktree is clean again.
    const handle = agentWorkspaceHandleFor(finished, dataDir)
    const { runCommand } = await import('../../server/services/agent/executor.mjs')
    const status = await runCommand({ cwd: handle.root, command: 'git status --porcelain', timeoutMs: 20_000 })
    expect(status.stdout.trim()).toBe('')
  }, 120_000)

  it('applies finished task changes to the original project only with confirmation and a clean tree', async () => {
    await setupGitProject()
    const server = await scriptedProvider([
      { thought: 'plan', plan: ['edit'], first_tool: { name: 'read_file', args: { path: 'src/main.js' } } },
      { thought: 'editing', tool: { name: 'edit_file', args: { path: 'src/main.js', oldText: 'answer = 41', newText: 'answer = 42' } } },
      { thought: 'finished', final: 'Edited.' }
    ])
    servers.push(server)
    await providerRecord(server)
    const { listLocalProjects } = await import('../../server/services/local-projects.mjs')
    const project = (await listLocalProjects({ dataDir }))[0]
    const task = await createLocalAgentTask({ dataDir, task: { id: 'nexus_agent_tex3', type: 'local-agent-runtime', label: 'apply', projectId: project.id, projectName: project.name, prompt: 'edit main', status: 'Queued', approvalPolicy: 'standard' } })
    await executeAgentRuntimeTask({ task, taskStore, dataDir, signal: null, options: { approvalPolicy: 'standard' } })
    const finished = await getLocalAgentTask({ dataDir, taskId: task.id })

    await expect(applyAgentTaskToProject({ task: finished, dataDir, confirm: false })).rejects.toMatchObject({ code: 'AGENT_APPLY_CONFIRMATION_REQUIRED' })

    // Dirty tree refuses to apply.
    await fs.appendFile(path.join(projectPath, 'src', 'main.js'), '\n// user edit\n', 'utf8')
    await expect(applyAgentTaskToProject({ task: finished, dataDir, confirm: true })).rejects.toMatchObject({ code: 'AGENT_APPLY_DIRTY_PROJECT' })

    // Restore a clean tree, then apply.
    const { runCommand } = await import('../../server/services/agent/executor.mjs')
    await runCommand({ cwd: projectPath, command: 'git checkout -- src/main.js', timeoutMs: 20_000 })
    const applied = await applyAgentTaskToProject({ task: finished, dataDir, confirm: true })
    expect(applied.applied).toBe(true)
    expect(applied.appliedPaths).toContain('src/main.js')
    expect(await fs.readFile(path.join(projectPath, 'src', 'main.js'), 'utf8')).toContain('answer = 42')
    // Backup of the original content exists under the workspace root.
    const backup = await fs.readFile(path.join(applied.backupRoot, 'src', 'main.js'), 'utf8')
    expect(backup).toContain('answer = 41')
  }, 120_000)

  it('reconstructs hosted worktree handles for repository project ids', async () => {
    const repository = 'fixture/hosted-repo'
    const task = {
      id: 'nexus_issue_17_ab12cd34',
      type: 'issue-fix-runtime',
      projectId: 'repo_123',
      projectName: repository,
      issue: { repository },
      status: 'Succeeded',
      workspace: { id: 'nexus_issue_17_ab12cd34', mode: 'worktree', branch: 'nexus-agent/nexus_issue_17_ab12cd34' }
    }
    const handle = agentWorkspaceHandleFor(task, dataDir)
    expect(handle).toMatchObject({ repository, mode: 'worktree' })
    expect(handle.root).toContain(path.join('repositories', 'fixture__hosted-repo', 'worktrees', task.id))
    expect(agentWorkspaceHandleFor({ ...task, workspace: { ...task.workspace, mode: 'copy' } }, dataDir)).toBeNull()
    expect(agentWorkspaceHandleFor({ ...task, issue: { repository: '../escape' } }, dataDir)).toBeNull()
  })

  it('reports provider-not-configured as a blocked task', async () => {
    await setupGitProject()
    // No provider registered with a key.
    const { listLocalProjects } = await import('../../server/services/local-projects.mjs')
    const project = (await listLocalProjects({ dataDir }))[0]
    const task = await createLocalAgentTask({ dataDir, task: { id: 'nexus_agent_tex4', type: 'local-agent-runtime', label: 'no provider', projectId: project.id, projectName: project.name, prompt: 'x', status: 'Queued', approvalPolicy: 'standard' } })
    await expect(executeAgentRuntimeTask({ task, taskStore, dataDir, signal: null, options: {} })).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' })
  }, 60_000)
})
