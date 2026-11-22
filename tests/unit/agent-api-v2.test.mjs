import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { startNexusServer, startHttpServer, tempDataDir, cleanupTestEnvironment } from './helpers/server-harness.mjs'

afterEach(async () => {
  await cleanupTestEnvironment()
})

async function getJson(base, token, url) {
  const response = await fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${token}` } })
  return { response, body: await response.json().catch(() => ({})) }
}

async function sendJson(base, token, url, method, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { response, body: await response.json().catch(() => ({})) }
}

describe('PHASE 6 agent API surface', () => {
  it('manages providers over the API without ever exposing keys, and syncs keys from the host process', async () => {
    const dataDir = await tempDataDir('nexus-agent-api-')
    const stateFile = path.join(dataDir, 'state.json')
    const token = 'fixture-local-session-token'

    // Model server for connectivity tests.
    let providerHits = 0
    const providerUrl = await startHttpServer((_request, response) => {
      providerHits += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }))
    })

    const service = await startNexusServer({ dataDir, stateFile, providerUrl, token })

    const unauth = await getJson(service.base, 'wrong-token', '/api/local-agent/providers')
    expect(unauth.response.status).toBe(401)

    const created = await sendJson(service.base, token, '/api/local-agent/providers', 'POST', {
      id: 'gateway-1', name: 'Gateway', kind: 'openai-compatible', baseUrl: providerUrl, model: 'test-model', capabilities: ['chat', 'json']
    })
    expect(created.response.status).toBe(201)
    expect(created.body.provider).toMatchObject({ id: 'gateway-1', configured: false, hasApiKey: false })

    const invalid = await sendJson(service.base, token, '/api/local-agent/providers', 'POST', { id: 'bad kind!', name: 'X', kind: 'openai-compatible', baseUrl: 'https://a.com', model: 'm' })
    expect(invalid.response.status).toBe(400)

    const listed = await getJson(service.base, token, '/api/local-agent/providers')
    const gateway = listed.body.providers.find((provider) => provider.id === 'gateway-1')
    expect(gateway).toMatchObject({ configured: false, hasApiKey: false })
    expect(JSON.stringify(listed.body)).not.toMatch(/sk-/)

    const testBeforeKey = await sendJson(service.base, token, '/api/local-agent/providers/gateway-1/test', 'POST', {})
    expect(testBeforeKey.response.status).toBe(200)
    expect(testBeforeKey.body.ok).toBe(false)

    // Host-process key injection (this is what the Electron main process calls).
    const keySync = await sendJson(service.base, token, '/api/local-agent/provider-keys', 'POST', { keys: { 'gateway-1': 'sk-host-injected-key-0000000001' } })
    expect(keySync.response.status).toBe(200)
    expect(keySync.body.synced).toEqual(['gateway-1'])

    const testAfterKey = await sendJson(service.base, token, '/api/local-agent/providers/gateway-1/test', 'POST', {})
    expect(testAfterKey.body.ok).toBe(true)
    expect(testAfterKey.body.replyPreview).toBe('pong')
    expect(providerHits).toBe(1)

    const updated = await sendJson(service.base, token, '/api/local-agent/providers/gateway-1', 'PATCH', { name: 'Renamed Gateway', model: 'model-b' })
    expect(updated.body.provider).toMatchObject({ name: 'Renamed Gateway', model: 'model-b' })

    const deleted = await sendJson(service.base, token, '/api/local-agent/providers/gateway-1', 'DELETE')
    expect(deleted.response.status).toBe(200)
    const afterDelete = await getJson(service.base, token, '/api/local-agent/providers')
    expect(afterDelete.body.providers.find((provider) => provider.id === 'gateway-1')).toBeUndefined()
  })

  it('resolves agent approvals through the API and exposes them on the task detail', async () => {
    const dataDir = await tempDataDir('nexus-agent-api-')
    const stateFile = path.join(dataDir, 'state.json')
    const token = 'fixture-local-session-token'

    const providerUrl = await startHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ thought: 'ack', final: 'ok' }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    })

    const service = await startNexusServer({ dataDir, stateFile, providerUrl, token })

    // Seed a task with a pending approval directly through the task store by
    // creating it via the API and then patching the store file is not possible;
    // instead use the approval resolution contract against a hand-written store.
    const { createLocalAgentTask, updateLocalAgentTask } = await import('../../server/services/local-agent-tasks.mjs')
    const { registerLocalProject } = await import('../../server/services/local-projects.mjs')
    const projectPath = path.join(dataDir, 'approval-project')
    await fs.mkdir(projectPath, { recursive: true })
    await fs.writeFile(path.join(projectPath, 'README.md'), '# approval fixture\n', 'utf8')
    const { project } = await registerLocalProject({ dataDir, folderPath: projectPath })
    const task = await createLocalAgentTask({ dataDir, task: { id: 'nexus_agent_appr1', type: 'local-agent-runtime', label: 'approval', projectId: project.id, projectName: 'approval-project', prompt: 'x', status: 'Queued' } })
    await updateLocalAgentTask({ dataDir, taskId: task.id, patch: { status: 'Running' } })
    await updateLocalAgentTask({ dataDir, taskId: task.id, patch: { status: 'Paused', pendingApprovalId: 'appr_test1', approvals: [{ id: 'appr_test1', tool: 'run_command', risk: 'high', reason: 'needs approval', action: 'npm test', argsSummary: '{}', status: 'pending', createdAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null }] } })

    const missingDecision = await sendJson(service.base, token, `/api/local-agent/tasks/${task.id}/approvals/appr_test1/resolve`, 'POST', {})
    expect(missingDecision.response.status).toBe(400)

    const denied = await sendJson(service.base, token, `/api/local-agent/tasks/${task.id}/approvals/appr_test1/resolve`, 'POST', { decision: 'denied' })
    expect(denied.response.status).toBe(200)
    expect(denied.body.task.approvals[0]).toMatchObject({ id: 'appr_test1', status: 'denied', resolvedBy: 'user' })
    expect(denied.body.task.pendingApprovalId).toBeNull()

    const double = await sendJson(service.base, token, `/api/local-agent/tasks/${task.id}/approvals/appr_test1/resolve`, 'POST', { decision: 'approved' })
    expect(double.response.status).toBe(409)
  })
})
