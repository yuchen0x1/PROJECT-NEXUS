import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { RuntimeCheckpoint } from '../../server/services/agent/runtime-checkpoint.mjs'
import { runAgentTask } from '../../server/services/agent/runtime.mjs'

const directories = [], servers = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  for (const directory of directories.splice(0)) { expect(directory.startsWith(os.tmpdir() + path.sep)).toBe(true); await fs.rm(directory, { recursive: true, force: true }) }
})
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-checkpoint-')); directories.push(directory)
  const original = 'export const answer = 41\n', file = path.join(directory, 'app.mjs')
  await fs.writeFile(file, original)
  let writes = 0, record = { id: 'checkpoint-fixture', prompt: 'Correct the answer.' }
  const adapter = { kind: 'copy', source: directory, root: directory, workspaceRoot: directory, diff: async () => ({ diff: 'fixture actual file diff', changes: (await fs.readFile(file, 'utf8')) === original ? [] : [{ path: 'app.mjs', action: 'modified' }] }), applyOperations: async (operations) => { for (const operation of operations) { expect(operation.path).toBe('app.mjs'); writes++; await fs.writeFile(file, operation.content) } return operations }, readFiles: async () => [{ path: 'app.mjs', content: await fs.readFile(file, 'utf8') }] }
  const store = { update: async ({ patch }) => { record = { ...record, ...structuredClone(patch) }; return record }, get: async () => structuredClone(record) }
  return { directory, file, adapter, store, get record() { return structuredClone(record) }, get writes() { return writes } }
}
it('recovers the conversation after an interrupted model call without replanning or repeating a completed write', async () => {
  const f = await fixture(), requests = []
  let interrupt = true
  const controller = new AbortController()
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const input = JSON.parse(text); requests.push(input)
    let content
    if (requests.length === 1) content = { plan: ['Correct the answer', 'Verify'], first_tool: { name: 'write_file', args: { path: 'app.mjs', content: 'export const answer = 42\n' } } }
    else if (interrupt) { interrupt = false; controller.abort(); res.end(); return }
    else if (input.messages[0].content.includes('independent code reviewer')) content = { findings: [], overall: 'Actual fixture diff checked.', verdict: 'approve' }
    else content = { final: 'Corrected the answer.' }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }))
  })
  servers.push(server); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const provider = { id: 'checkpoint-provider', kind: 'openai-compatible', model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture-key', configured: true }
  const common = { project: { path: f.directory }, provider, adapter: f.adapter, taskStore: f.store, index: null }
  await expect(runAgentTask({ ...common, task: f.record, signal: controller.signal, options: { approvalPolicy: 'workspace-auto' } })).rejects.toBeTruthy()
  expect(f.writes).toBe(1); expect(f.record.runtimeCheckpoint.status).toBe('model_pending')
  const result = await runAgentTask({ ...common, task: f.record, options: { resumeVerified: true, approvalPolicy: 'workspace-auto' } })
  expect(result.status).toBe('Succeeded'); expect(f.writes).toBe(1)
  expect(requests[2].messages.some((message) => message.content.includes('TOOL RESULT (write_file)'))).toBe(true)
  expect(result.usage.totalTokens).toBe(90); expect(result.usage.uncertainTokens).toBeGreaterThan(4096)
  expect(result.providerCalls).toBe(4)
})
it('rejects incomplete tool continuations, tampered snapshots and changed workspace bytes', async () => {
  const f = await fixture(), task = f.record, provider = { id: 'p', model: 'm', baseUrl: 'http://localhost' }
  const journal = new RuntimeCheckpoint({ task, provider, adapter: f.adapter, persist: (patch) => f.store.update({ patch }) })
  const state = { phase: 'executing', startedAt: Date.now(), totalUsage: { totalTokens: 4 }, providerCalls: 1 }
  await journal.beforeModel([{ role: 'user', content: 'continue' }], state, 100)
  const valid = f.record.runtimeCheckpoint
  await journal.intent('write_file', { path: 'app.mjs' })
  await expect(journal.restore(f.record.runtimeCheckpoint)).rejects.toMatchObject({ code: 'AGENT_CHECKPOINT_UNSAFE' })
  const tampered = structuredClone(valid); tampered.snapshot.state.totalUsage.totalTokens = 0
  await expect(journal.restore(tampered)).rejects.toMatchObject({ code: 'AGENT_CHECKPOINT_UNSAFE' })
  await fs.writeFile(f.file, 'export const answer = 999\n')
  await expect(journal.restore(valid)).rejects.toMatchObject({ code: 'AGENT_CHECKPOINT_ARTIFACT_CHANGED' })
})
