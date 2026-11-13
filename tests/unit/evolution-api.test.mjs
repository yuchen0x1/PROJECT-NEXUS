import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { registerLocalProject } from '../../server/services/local-projects.mjs'
import { startHttpServer, startNexusServer, tempDataDir, cleanupTestEnvironment, getJson } from './helpers/server-harness.mjs'
afterEach(cleanupTestEnvironment)
it('stops the API host after its owning desktop IPC disconnects and releases the data-directory lease', async () => {
  const dataDir = await tempDataDir('nexus-owner-disconnect-'), token = 'fixture-owner-disconnect'
  const providerUrl = await startHttpServer((_req, res) => res.end('{}'))
  const settings = { dataDir, stateFile: path.join(dataDir, 'state.json'), providerUrl, token }
  const first = await startNexusServer({ ...settings, ipc: true })
  const exited = new Promise((resolve) => first.child.once('exit', resolve))
  first.child.disconnect()
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('API host survived its owner IPC disconnect.')), 12000))])
  expect(first.child.exitCode).toBe(0)
  expect(await fs.stat(`${settings.stateFile}.host.lock`).catch(() => null)).toBeNull()
  const second = await startNexusServer(settings)
  expect((await getJson(second.base, token, '/api/evolution/status')).response.ok).toBe(true)
}, 20000)
it('recovers after a real API process kill and reuses the child workspace without repeating planning or writing', async () => {
  const dataDir = await tempDataDir('nexus-evolution-crash-'), projectDir = await tempDataDir('nexus-evolution-crash-target-')
  await fs.writeFile(path.join(projectDir, 'app.mjs'), 'export const answer = 41\n')
  await fs.writeFile(path.join(projectDir, 'verify.mjs'), 'import { answer } from "./app.mjs"; if (answer !== 42) throw new Error("incorrect"); console.log("recovered answer 42")\n')
  await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture-crash-project', type: 'module', scripts: { test: 'node verify.mjs' } }))
  const { project } = await registerLocalProject({ dataDir, folderPath: projectDir })
  let planningCalls = 0, releaseRequest, heldResponse
  const blocked = new Promise((resolve) => { releaseRequest = resolve })
  const providerUrl = await startHttpServer((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk }); req.on('end', () => {
      const input = JSON.parse(body), system = input.messages[0].content
      const role = system.match(/^You are the (\w+) in a bounded/)?.[1]
      let answer
      if (role) answer = { summary: `Fixture ${role}`, safe: true, verdict: 'approve' }
      else if (system.includes('independent code reviewer')) answer = { findings: [], overall: 'Recovered diff reviewed.', verdict: 'approve' }
      else if (input.max_tokens === 2048) { planningCalls++; answer = { plan: ['Correct answer'], first_tool: { name: 'write_file', args: { path: 'app.mjs', content: 'export const answer = 42\n' } } } }
      else if (!heldResponse) { heldResponse = res; releaseRequest(); return }
      else { expect(input.messages.some((message) => message.content.includes('TOOL RESULT (write_file)'))).toBe(true); answer = { final: 'Resumed the existing candidate.' } }
      if (role === 'tester' && JSON.parse(input.messages[1].content).evidence?.task) answer.testFiles = [{ path: 'nexus-tests/answer.test.mjs', content: 'import {test} from "node:test"; import assert from "node:assert/strict"; import {answer} from "../app.mjs"; test("independent answer",()=>assert.equal(answer,42));\n' }]
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }))
    })
  })
  const token = 'fixture-real-process-crash', settings = { dataDir, stateFile: path.join(dataDir, 'state.json'), providerUrl, token }
  const first = await startNexusServer(settings)
  const created = await send(first.base, token, '/api/evolution/workflows', { projectId: project.id, prompt: 'Correct answer to 42.', sourceDisclosureConfirmed: true, executionConsent: true })
  const id = created.body.workflow.id
  await Promise.race([blocked, new Promise((_, reject) => setTimeout(() => reject(new Error('Execution boundary was never reached.')), 20000))])
  const before = (await getJson(first.base, token, `/api/evolution/workflows/${id}`)).body.workflow
  const taskId = before.nodes.find((node) => node.role === 'developer').taskId
  const exited = new Promise((resolve) => first.child.once('exit', resolve)); first.child.kill('SIGKILL'); await exited
  heldResponse.end()
  const restarted = await startNexusServer(settings)
  expect((await getJson(restarted.base, token, `/api/evolution/workflows/${id}`)).body.workflow.status).toBe('Interrupted')
  const resumed = await send(restarted.base, token, `/api/evolution/workflows/${id}/resume`, { confirm: true })
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(202)
  let completed
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    completed = (await getJson(restarted.base, token, `/api/evolution/workflows/${id}`)).body.workflow
    if (['Completed', 'Blocked'].includes(completed.status)) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  expect(completed.status, JSON.stringify(completed.nodes)).toBe('Completed')
  expect(planningCalls).toBe(1)
  expect(completed.nodes.find((node) => node.role === 'developer').result.taskId).toBe(taskId)
  expect(completed.usage.uncertainTokens).toBeGreaterThan(0)
  expect(await fs.readFile(path.join(projectDir, 'app.mjs'), 'utf8')).toContain('41')
}, 60000)
async function send(base, token, url, body, method = 'POST') {
  const response = await fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}
it('requires authenticated access and explicit consent, blocks unavailable strict mode, and manages project memory', async () => {
  const dataDir = await tempDataDir('nexus-evolution-api-'), projectDir = await tempDataDir('nexus-evolution-project-')
  await fs.writeFile(path.join(projectDir, 'app.mjs'), 'export const working = true\n')
  const { project } = await registerLocalProject({ dataDir, folderPath: projectDir })
  const providerUrl = await startHttpServer((_req, res) => res.end('{}')), token = 'evolution-test-session'
  const { base } = await startNexusServer({ dataDir, stateFile: path.join(dataDir, 'state.json'), providerUrl, token })
  expect((await fetch(base + '/api/evolution/status')).status).toBe(401)
  expect((await getJson(base, token, '/api/evolution/status')).body.execution.strictAvailable).toBe(false)
  expect((await send(base, token, '/api/evolution/workflows', { projectId: project.id, prompt: 'work' })).body.code).toBe('WORKFLOW_CONSENT_REQUIRED')
  expect((await send(base, token, '/api/evolution/workflows', { projectId: project.id, prompt: 'work', sourceDisclosureConfirmed: true, executionConsent: true, executionMode: 'strict-isolation' })).body.code).toBe('STRICT_ISOLATION_UNAVAILABLE')
  expect((await send(base, token, `/api/evolution/memory/${project.id}/refresh`, {})).body.memory.files[0].path).toBe('app.mjs')
  expect((await getJson(base, token, `/api/evolution/memory/${project.id}/export`)).body.memory.format).toBe('project-nexus-memory-v1')
  expect((await send(base, token, `/api/evolution/memory/${project.id}`, {}, 'DELETE')).status).toBe(400)
  expect((await send(base, token, `/api/evolution/memory/${project.id}`, { confirm: true }, 'DELETE')).body.cleared).toBe(true)
  expect((await getJson(base, token, '/api/evolution/workflows')).body.workflows).toEqual([])
})
it('runs the six real role adapters with a fixture model, real file edit/tests/review, and an idempotent request', async () => {
  const dataDir = await tempDataDir('nexus-evolution-run-'), projectDir = await tempDataDir('nexus-evolution-target-')
  await fs.writeFile(path.join(projectDir, 'app.mjs'), 'export const answer = 41\n')
  await fs.writeFile(path.join(projectDir, 'verify.mjs'), 'import { answer } from "./app.mjs"; if (answer !== 42) throw new Error("wrong answer"); console.log("verified 42")\n')
  await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture-project', type: 'module', scripts: { test: 'node verify.mjs' } }))
  const { project } = await registerLocalProject({ dataDir, folderPath: projectDir })
  const seen = []
  let developerCalls = 0
  const providerUrl = await startHttpServer((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk }); req.on('end', () => {
      const request = JSON.parse(body), system = request.messages[0].content
      let answer
      const role = system.match(/^You are the (\w+) in a bounded/)?.[1]
      if (role) { seen.push(role); answer = { summary: `Fixture ${role} assessment`, safe: true, verdict: 'approve', steps: ['Make answer correct'], risks: [], recommendations: [] } }
      else if (system.includes('independent code reviewer')) { seen.push('developer-review'); answer = { findings: [], overall: 'Fixture diff approved.', verdict: 'approve' } }
      else { seen.push('developer'); developerCalls++; answer = developerCalls === 1 ? { thought: 'Fix answer', plan: ['Update the existing source'], first_tool: { name: 'write_file', args: { path: 'app.mjs', content: 'export const answer = 42\n' } } } : { thought: 'Done', final: 'Updated the isolated answer and verified it.' } }
      if (role === 'tester' && JSON.parse(request.messages[1].content).evidence?.task) answer.testFiles = [{ path: 'nexus-tests/answer.test.mjs', content: 'import {test} from "node:test"; import assert from "node:assert/strict"; import {answer} from "../app.mjs"; test("independent answer",()=>assert.equal(answer,42));\n' }]
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 20, completion_tokens: 15 } }))
    })
  })
  const token = 'evolution-run-session', { base } = await startNexusServer({ dataDir, stateFile: path.join(dataDir, 'state.json'), providerUrl, token })
  const body = { requestId: crypto.randomUUID(), projectId: project.id, prompt: 'Correct the answer to 42.', sourceDisclosureConfirmed: true, executionConsent: true, executionMode: 'trusted-local' }
  const first = await send(base, token, '/api/evolution/workflows', body)
  expect(first.status).toBe(202)
  expect((await send(base, token, '/api/evolution/workflows', body)).body.workflow.id).toBe(first.body.workflow.id)
  let record
  const deadline = Date.now() + 75000
  while (Date.now() < deadline) {
    record = (await getJson(base, token, `/api/evolution/workflows/${first.body.workflow.id}`)).body.workflow
    if (['Completed', 'Blocked', 'Failed', 'TimedOut'].includes(record.status)) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  expect(record.status, JSON.stringify(record.nodes)).toBe('Completed')
  expect(record.nodes).toHaveLength(6)
  expect(record.nodes.find((node) => node.role === 'tester').result.checks[0].stdout).toContain('verified 42')
  expect(record.nodes.find((node) => node.role === 'tester').result.independentTestsAuthored).toBe(true)
  expect(record.nodes.find((node) => node.role === 'tester').result.checks.find((check) => check.name === 'independent-tests').exitCode).toBe(0)
  expect(new Set(seen)).toEqual(new Set(['planner', 'researcher', 'developer', 'developer-review', 'tester', 'security', 'reviewer']))
  expect(developerCalls).toBe(2)
  expect(await fs.readFile(path.join(projectDir, 'app.mjs'), 'utf8')).toContain('41')
  expect(record.nodes.find((node) => node.role === 'developer').result.artifactSha256).toMatch(/^[a-f0-9]{64}$/)
}, 90000)
