import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AGENT_ROLES, CollaborationEngine, validateAgentGraph } from '../../server/services/collaboration-engine.mjs'
import { EvolutionStore } from '../../server/services/evolution-store.mjs'

const directories = []
async function environment(handlers = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-collaboration-')); directories.push(dataDir)
  const calls = []
  const defaults = Object.fromEntries(AGENT_ROLES.map((role) => [role, async ({ context, send }) => {
    calls.push({ role, context })
    if (role === 'planner') await send('developer', 'Check actual project files before editing.')
    return { totalTokens: 10, verified: role === 'tester', safe: role === 'security', verdict: role === 'reviewer' ? 'approve' : null }
  }]))
  return { dataDir, calls, engine: new CollaborationEngine({ dataDir, handlers: { ...defaults, ...handlers } }) }
}
afterEach(async () => {
  for (const dir of directories.splice(0)) {
    expect(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  }
})
it('reconciles a verified completed child after loss of the parent receipt without rerunning the developer', async () => {
  const { engine, calls } = await environment()
  const job = await engine.create({ projectId: 'p', prompt: 'Recover a receipted child.' })
  await engine.store.update(job.id, (record) => {
    record.status = 'Interrupted'
    const node = record.nodes.find((item) => item.role === 'developer')
    node.status = 'Interrupted'; node.attempts = 1; node.failedReservation = 100; node.taskId = 'durable-child'
    record.usage.uncertainTokens = 100
    return record
  })
  const resumed = await engine.resume(job.id, { confirm: true, recoverWritingCheckpoint: async () => ({ result: { totalTokens: 7, summary: 'Recovered known child receipt.', taskId: 'durable-child' } }) })
  expect(resumed.nodes.find((node) => node.role === 'developer').status).toBe('Completed')
  expect(resumed.usage).toEqual({ totalTokens: 7, uncertainTokens: 0 })
  expect((await engine.run(job.id)).status).toBe('Completed')
  expect(calls.some((call) => call.role === 'developer')).toBe(false)
})
it('rejects cycles, unknown dependencies, repeated nodes and unbounded limits', async () => {
  expect(() => validateAgentGraph([{ id: 'a', role: 'planner', dependencies: ['b'] }, { id: 'b', role: 'developer', dependencies: ['a'] }])).toThrow(/cycle/)
  expect(() => validateAgentGraph([{ id: 'a', role: 'planner', dependencies: ['missing'] }])).toThrow(/unknown/)
  expect(() => validateAgentGraph([{ id: 'a', role: 'planner', dependencies: [] }, { id: 'a', role: 'reviewer', dependencies: [] }])).toThrow(/duplicate/)
  const { engine } = await environment()
  await expect(engine.create({ projectId: 'p', prompt: 'work', limits: { concurrency: 0 } })).rejects.toMatchObject({ code: 'WORKFLOW_INVALID_LIMIT' })
})
it('executes independent role contexts, messages, durable receipts and final arbitration', async () => {
  const { engine, calls } = await environment()
  const job = await engine.create({ projectId: 'project-a', prompt: 'Fix a real issue.' })
  expect((await engine.run(job.id)).status).toBe('Completed')
  expect(calls.map((item) => item.role)).toEqual(AGENT_ROLES)
  expect(calls.find((item) => item.role === 'reviewer').context.map((item) => item.role)).toEqual(['tester', 'security'])
  const saved = await engine.store.get(job.id)
  expect(saved.nodes.every((node) => node.checkpoint.resultSha256.length === 64)).toBe(true)
  expect(saved.messages).toHaveLength(1)
  expect(saved.usage).toEqual({ totalTokens: 60, uncertainTokens: 0 })
  const other = new CollaborationEngine({ dataDir: engine.dataDir, handlers: {} })
  expect((await other.store.get(job.id)).status).toBe('Completed')
  await expect(other.run(job.id)).rejects.toMatchObject({ code: 'WORKFLOW_NOT_QUEUED' })
  expect((await other.store.get(job.id)).status).toBe('Completed')
})
it('never declares completion from a missing test or declined independent review', async () => {
  const { engine } = await environment({ tester: async () => ({ totalTokens: 1, verified: false }), reviewer: async () => ({ totalTokens: 1, verdict: 'approve' }) })
  const job = await engine.create({ projectId: 'p', prompt: 'work' })
  expect((await engine.run(job.id)).status).toBe('Blocked')
})
it('actually runs eligible read roles concurrently while respecting the configured cap', async () => {
  let active = 0, maximum = 0
  const read = async () => { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 30)); active--; return { totalTokens: 1 } }
  const { engine } = await environment({ planner: read, researcher: read })
  const job = await engine.create({ projectId: 'p', prompt: 'work', nodes: [{ id: 'a', role: 'planner', dependencies: [] }, { id: 'b', role: 'researcher', dependencies: [] }] })
  await engine.run(job.id)
  expect(maximum).toBe(2)
})
it('recovers completed receipts without replay and refuses an uncertain writing step', async () => {
  const { engine } = await environment()
  const job = await engine.create({ projectId: 'p', prompt: 'work' })
  await engine.store.update(job.id, (record) => { record.status = 'Running'; record.nodes.find((node) => node.role === 'developer').status = 'Running'; record.nodes.find((node) => node.role === 'developer').attempts = 1; return record })
  await engine.recover()
  expect((await engine.store.get(job.id)).status).toBe('Interrupted')
  await expect(engine.resume(job.id, { confirm: true, validateCheckpoint: async () => true })).rejects.toMatchObject({ code: 'WORKFLOW_WRITE_UNCERTAIN' })
})
it('retains a role budget reservation across a hard crash before any response receipt exists', async () => {
  const { engine } = await environment()
  const job = await engine.create({ projectId: 'p', prompt: 'Retain unknown request usage after a crash.' })
  await engine.store.update(job.id, (record) => { record.status = 'Running'; Object.assign(record.nodes[0], { status: 'Running', attempts: 1, reservedTokens: 25000 }); return record })
  await engine.recover()
  const recovered = await engine.store.get(job.id)
  expect(recovered.usage.uncertainTokens).toBe(25000)
  expect(recovered.nodes[0].failedReservation).toBe(25000)
  expect(recovered.nodes[0].reservedTokens).toBe(0)
  await engine.resume(job.id, { confirm: true, validateCheckpoint: async () => true })
  expect((await engine.run(job.id)).usage.uncertainTokens).toBe(25000)
})
it('times out cooperative operations, records uncertainty and blocks downstream work', async () => {
  const { engine, calls } = await environment({ planner: async ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) })
  const job = await engine.create({ projectId: 'p', prompt: 'work', limits: { stepTimeoutMs: 50 } })
  expect((await engine.run(job.id)).status).toBe('Blocked')
  const record = await engine.store.get(job.id)
  expect(record.nodes[0].status).toBe('Interrupted')
  expect(record.usage.uncertainTokens).toBe(record.nodes[0].failedReservation)
  expect(record.usage.uncertainTokens).toBeGreaterThan(0)
  expect(record.usage.uncertainTokens).toBeLessThan(record.limits.tokenBudget)
  expect(calls).toHaveLength(0)
})
it('pauses cooperatively and resumes remaining roles without silently resetting the uncertain budget', async () => {
  let entered, count = 0
  const started = new Promise((resolve) => { entered = resolve })
  const { engine } = await environment({ planner: async ({ signal }) => {
    count++
    if (count > 1) return { totalTokens: 10 }
    entered()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const job = await engine.create({ projectId: 'p', prompt: 'Pause and continue safely.' })
  const running = engine.run(job.id)
  await started; await engine.pause(job.id); await running
  const paused = await engine.store.get(job.id)
  expect(paused.status).toBe('Interrupted')
  expect(paused.usage.uncertainTokens).toBeGreaterThan(0)
  await engine.resume(job.id, { confirm: true, validateCheckpoint: async () => true })
  const completed = await engine.run(job.id)
  expect(completed.status).toBe('Completed')
  expect(completed.usage.uncertainTokens).toBe(paused.usage.uncertainTokens)
  expect(count).toBe(2)
})
it('does not overwrite damaged JSON or accept a stale revision', async () => {
  const { dataDir } = await environment()
  const store = new EvolutionStore(dataDir, 'memory')
  await store.update('p', () => ({ id: 'p', value: 'initial' }), 0)
  await expect(store.update('p', () => ({ id: 'p', value: 'new' }), 0)).rejects.toMatchObject({ code: 'EVOLUTION_REVISION_CONFLICT' })
  await fs.writeFile(store.file('p'), '{broken')
  await expect(store.update('p', () => ({ id: 'p' }))).rejects.toThrow()
  expect(await fs.readFile(store.file('p'), 'utf8')).toBe('{broken')
})
