import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { runAgentTask, parseModelResponse, normalizeToolCalls, compressHistory } from '../../server/services/agent/runtime.mjs'
import { createAgentWorkspace } from '../../server/services/agent/workspace-worktree.mjs'
import { scanProjectStructure } from '../../server/services/agent/indexer.mjs'
import { buildTaskContextBundle } from '../../server/services/agent/context.mjs'
import { createLocalAgentTask, getLocalAgentTask, updateLocalAgentTask } from '../../server/services/local-agent-tasks.mjs'

const servers = []
let tempRoot
let projectPath
let workspaceRoot
let dataDir

async function fresh() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-runtime-'))
  projectPath = path.join(tempRoot, 'project')
  workspaceRoot = path.join(tempRoot, 'workspaces')
  dataDir = path.join(tempRoot, 'data')
  await fs.mkdir(projectPath, { recursive: true })
  await fs.mkdir(workspaceRoot, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
}

await fresh()

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  await fresh()
})

async function setupProject({ withTestScript = true } = {}) {
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  if (withTestScript) {
    await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({
      name: 'runtime-demo', main: 'src/main.js', type: 'module', scripts: { test: 'node src/selfcheck.js' }
    }), 'utf8')
    await fs.writeFile(path.join(projectPath, 'src', 'selfcheck.js'), `
import fs from 'node:fs'
const main = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8')
if (main.includes('greeting = "hello there"')) { console.log('tests passed'); process.exit(0) }
console.error('tests failed: marker missing'); process.exit(1)
`, 'utf8')
  } else {
    await fs.writeFile(path.join(projectPath, 'README.md'), '# plain project\n', 'utf8')
  }
  await fs.writeFile(path.join(projectPath, 'src', 'main.js'), 'export const greeting = "hello"\n', 'utf8')
  const { runCommand } = await import('../../server/services/agent/executor.mjs')
  await runCommand({ cwd: projectPath, command: 'git init -b main', timeoutMs: 20_000 })
  await runCommand({ cwd: projectPath, command: 'git add -A', timeoutMs: 20_000 })
  await runCommand({ cwd: projectPath, command: 'git -c user.name=t -c user.email=t@t.local commit -m init', timeoutMs: 20_000 })
}

// Scripted model: pops the next response for every request.
function scriptedProvider(responses) {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      const next = responses.shift()
      if (next === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'script exhausted' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }], usage: { prompt_tokens: 40, completion_tokens: 20 } }))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests })))
}

function providerFromServer(server, model = 'scripted-model') {
  return {
    id: 'scripted', kind: 'openai-compatible', name: 'scripted', baseUrl: `http://127.0.0.1:${server.address().port}`,
    model, apiKey: 'scripted-key', configured: true, capabilities: ['chat', 'json'], priority: 1, pricing: { inputPer1M: 1, outputPerM: 2 }, temperature: 0.2, timeoutMs: 30_000, source: 'stored'
  }
}

function taskStoreFor(dataDirValue) {
  return {
    create: (args) => createLocalAgentTask({ dataDir: dataDirValue, task: args.task }),
    get: ({ taskId }) => getLocalAgentTask({ dataDir: dataDirValue, taskId }),
    update: ({ taskId, patch, event }) => updateLocalAgentTask({ dataDir: dataDirValue, taskId, patch, event })
  }
}

describe('agent runtime protocol helpers', () => {
  it('parses strict JSON, tolerates fences, and normalizes tool calls including native tool_calls', () => {
    expect(parseModelResponse('{"thought":"t","final":"done"}')).toEqual({ thought: 't', final: 'done' })
    expect(parseModelResponse('```json\n{"thought":"t","tool":{"name":"read_file","args":{"path":"a"}}}\n```')).toEqual({ thought: 't', tool: { name: 'read_file', args: { path: 'a' } } })
    expect(() => parseModelResponse('I will now edit the file.')).toThrow(/JSON/)
    expect(normalizeToolCalls({ tool: { name: 'a', args: { x: 1 } } })).toEqual([{ name: 'a', args: { x: 1 } }])
    expect(normalizeToolCalls({ tool_calls: [{ function: { name: 'b', arguments: '{"y":2}' } }] })).toEqual([{ name: 'b', args: { y: 2 } }])
    expect(normalizeToolCalls({ thought: 't', final: 'x' })).toEqual([])
  })

  it('compresses old tool observations when history exceeds the budget', () => {
    const observation = (marker, size) => ({ role: 'user', content: `TOOL RESULT (${marker}):\n${marker.repeat(size)}` })
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'plan' },
      { role: 'assistant', content: 'ok' },
      observation('x', 40_000),
      { role: 'assistant', content: 'mid1' },
      observation('y', 40_000),
      { role: 'assistant', content: 'mid2' },
      observation('w', 40_000),
      { role: 'assistant', content: 'mid3' },
      observation('v', 40_000),
      { role: 'assistant', content: 'recent' },
      { role: 'user', content: 'TOOL RESULT (z):\nz'.repeat(20) },
      { role: 'user', content: 'continue' }
    ]
    const compressed = compressHistory(messages, 100_000)
    const omitted = compressed.filter((message) => message.content.includes('omitted'))
    expect(omitted.length).toBeGreaterThanOrEqual(2)
    // recent messages survive
    expect(compressed.at(-1).content).toBe('continue')
    expect(compressed.some((message) => message.content.startsWith('TOOL RESULT (z)'))).toBeTruthy()
    // system prompt is never compressed
    expect(compressed[0].content).toBe('sys')
  })
})

describe('agent runtime end-to-end loop', () => {
  it('plans, edits files, fails verification, repairs itself, re-verifies, and reviews the diff', async () => {
    await setupProject()
    const { server, requests } = await scriptedProvider([
      { thought: 'plan and read', plan: ['read main.js', 'update greeting', 'run tests'], first_tool: { name: 'read_file', args: { path: 'src/main.js' } } },
      { thought: 'got content', tool: { name: 'edit_file', args: { path: 'src/main.js', oldText: 'greeting = "hello"', newText: 'greeting = "wrong marker"' } } },
      { thought: 'done too early', final: 'I updated the greeting.' },
      { thought: 'verification failed, fixing', tool: { name: 'edit_file', args: { path: 'src/main.js', oldText: 'greeting = "wrong marker"', newText: 'greeting = "hello there"' } } },
      { thought: 'fixed', final: 'Updated the greeting constant; the self-check passes after one repair.' }
    ])
    servers.push(server)
    const provider = providerFromServer(server)

    const task = await createLocalAgentTask({ dataDir, task: { id: 'nexus_agent_rt1', type: 'local-agent-runtime', label: 'runtime e2e', projectId: 'p', projectName: 'runtime-demo', prompt: 'Change the greeting constant to "hello there" and make sure the self-check passes.', status: 'Queued' } })
    const project = { id: 'p', name: 'runtime-demo', path: projectPath }
    const { adapter, mode } = await createAgentWorkspace({ project, taskId: task.id, mode: 'auto', workspaceRoot })
    expect(mode).toBe('worktree')
    const index = await scanProjectStructure(adapter.source)
    const contextBundle = await buildTaskContextBundle({ sourceRoot: adapter.source, index, prompt: task.prompt, budgetBytes: 60_000 })

    const events = []
    const result = await runAgentTask({
      task,
      project,
      provider,
      adapter,
      index,
      contextBundle,
      taskStore: taskStoreFor(dataDir),
      dataDir,
      signal: null,
      options: { approvalPolicy: 'standard', maxRepairAttempts: 2 },
      audit: (event) => events.push(event)
    })

    expect(result.status).toBe('Succeeded')
    expect(result.plan.map((step) => step.description)).toEqual(expect.arrayContaining(['read main.js']))
    expect(result.iterations).toBeGreaterThanOrEqual(2)
    expect(result.repairAttempts).toBe(1)
    expect(result.verification.passed).toBe(true)
    expect(result.verification.attempted).toBe(true)
    expect(result.finalMessage).toContain('greeting')
    expect(result.usage.totalTokens).toBeGreaterThan(0)
    expect(result.review.findings).toEqual([])
    expect(result.changes.map((change) => change.path)).toContain('src/main.js')

    // The original project was never modified; the worktree has the change.
    expect(await fs.readFile(path.join(projectPath, 'src', 'main.js'), 'utf8')).toContain('"hello"')
    expect(await fs.readFile(path.join(adapter.source, 'src', 'main.js'), 'utf8')).toContain('"hello there"')

    // Tool calls were really executed. run_tests in verification runs outside
    // the conversation loop (autoVerify), so it appears in verification.results.
    const toolNames = result.toolCalls.map((call) => call.tool)
    expect(toolNames).toContain('read_file')
    expect(toolNames.filter((name) => name === 'edit_file').length).toBe(2)
    expect(result.verification.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'test', attempted: true, ok: true })
    ]))

    // Every model request stayed in protocol shape.
    for (const request of requests) {
      expect(request.model).toBe('scripted-model')
      expect(request.messages[0].role).toBe('system')
    }
    // Task store captured the plan and events.
    const persisted = await getLocalAgentTask({ dataDir, taskId: task.id })
    expect(Array.isArray(persisted.plan)).toBe(true)
    expect(persisted.events.some((event) => event.type === 'plan')).toBe(true)
    expect(persisted.events.some((event) => event.type === 'repair_start')).toBe(true)
    await adapter.dispose()
  }, 120_000)

  it('stops after repeated unparseable model output with a clear error', async () => {
    await setupProject()
    const { server } = await scriptedProvider([
      'I am a helpful assistant and I will not emit JSON.',
      'Still no JSON here.',
      'Neither this.'
    ])
    servers.push(server)
    const task = await createLocalAgentTask({ dataDir, task: { id: 'nexus_agent_rt2', type: 'local-agent-runtime', label: 'unparseable', projectId: 'p', projectName: 'x', prompt: 'do nothing', status: 'Queued' } })
    const project = { id: 'p', name: 'x', path: projectPath }
    const { adapter } = await createAgentWorkspace({ project, taskId: task.id, mode: 'auto', workspaceRoot })
    const index = await scanProjectStructure(adapter.source)
    await expect(runAgentTask({
      task, project, provider: providerFromServer(server), adapter, index, contextBundle: null,
      taskStore: taskStoreFor(dataDir), dataDir, signal: null, options: { approvalPolicy: 'standard' }
    })).rejects.toMatchObject({ code: 'AGENT_MODEL_UNPARSEABLE' })
    await adapter.dispose()
  }, 60_000)

  it('honors cancellation immediately', async () => {
    await setupProject()
    const controller = new AbortController()
    const { server } = await scriptedProvider([
      { thought: 'plan', plan: ['never runs'], first_tool: { name: 'read_file', args: { path: 'src/main.js' } } }
    ])
    servers.push(server)
    const task = await createLocalAgentTask({ dataDir, task: { id: 'nexus_agent_rt3', type: 'local-agent-runtime', label: 'cancel', projectId: 'p', projectName: 'x', prompt: 'cancel me', status: 'Queued' } })
    const project = { id: 'p', name: 'x', path: projectPath }
    const { adapter } = await createAgentWorkspace({ project, taskId: task.id, mode: 'auto', workspaceRoot })
    const index = await scanProjectStructure(adapter.source)
    controller.abort()
    await expect(runAgentTask({
      task, project, provider: providerFromServer(server), adapter, index, contextBundle: null,
      taskStore: taskStoreFor(dataDir), dataDir, signal: controller.signal, options: { approvalPolicy: 'standard' }
    })).rejects.toMatchObject({ code: 'AGENT_CANCELLED' })
    await adapter.dispose()
  }, 60_000)

  it('records denials when the user rejects a high-risk approval', async () => {
    await setupProject({ withTestScript: false })
    const { server } = await scriptedProvider([
      { thought: 'plan', plan: ['delete something'], first_tool: { name: 'delete_file', args: { path: 'src/main.js' } } },
      { thought: 'denied, adapt', final: 'User denied deletion; stopping without changes.' }
    ])
    servers.push(server)
    const task = await createLocalAgentTask({ dataDir, task: { id: 'nexus_agent_rt4', type: 'local-agent-runtime', label: 'denial', projectId: 'p', projectName: 'x', prompt: 'delete main.js', status: 'Queued' } })
    const project = { id: 'p', name: 'x', path: projectPath }
    const { adapter } = await createAgentWorkspace({ project, taskId: task.id, mode: 'auto', workspaceRoot })
    const index = await scanProjectStructure(adapter.source)

    // Approvals resolve through the task store: auto-deny after a short window.
    const denyTimer = setInterval(async () => {
      const current = await getLocalAgentTask({ dataDir, taskId: task.id }).catch(() => null)
      const pending = current?.approvals?.find((approval) => approval.status === 'pending')
      if (pending) {
        const updated = await updateLocalAgentTask({ dataDir, taskId: task.id, patch: {} }).catch(() => null)
        if (updated) {
          resolveApproval(updated, pending.id)
        }
      }
    }, 300)
    function resolveApproval(taskRecord, approvalId) {
      const approval = taskRecord.approvals.find((item) => item.id === approvalId)
      if (approval) { approval.status = 'denied'; approval.resolvedAt = new Date().toISOString(); approval.resolvedBy = 'user' }
      return updateLocalAgentTask({ dataDir, taskId: taskRecord.id, patch: { approvals: taskRecord.approvals } })
    }

    const result = await runAgentTask({
      task, project, provider: providerFromServer(server), adapter, index, contextBundle: null,
      taskStore: taskStoreFor(dataDir), dataDir, signal: null, options: { approvalPolicy: 'standard', approvalTimeoutMs: 30_000 }
    })
    clearInterval(denyTimer)
    expect(result.status).toBe('Succeeded')
    const denial = result.toolCalls.find((call) => call.denied)
    expect(denial).toBeTruthy()
    expect(denial.tool).toBe('delete_file')
    expect(await fs.stat(path.join(adapter.source, 'src', 'main.js')).catch(() => null)).not.toBeNull()
    const persisted = await getLocalAgentTask({ dataDir, taskId: task.id })
    expect(persisted.approvals.find((approval) => approval.id === denial.approvalId || approval.status === 'denied')).toBeTruthy()
    await adapter.dispose()
  }, 60_000)
})
