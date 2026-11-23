import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { defaultAutonomyDbFile, openAutonomyStore } from '../../server/autonomy/db.mjs'
import { cleanupTestEnvironment, startHttpServer, startNexusServer, tempDataDir } from './helpers/server-harness.mjs'

const token = 'autonomy-routing-local-session'
const webhookSecret = 'autonomy-routing-synthetic-hmac'

afterEach(cleanupTestEnvironment)

async function setup(role = 'Viewer', allowRoleHeader = false, extraEnv = {}) {
  const dataDir = await tempDataDir('nexus-autonomy-routing-')
  const externalRequests = []
  const fixtureUrl = await startHttpServer((req, res) => {
    externalRequests.push(`${req.method} ${req.url}`)
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end('{"message":"No external action is approved by this fixture"}')
  })
  const stateFile = path.join(dataDir, 'state.json')
  await fs.writeFile(stateFile, JSON.stringify({ schemaVersion: 4, projects: [], settings: { hostingPaused: true, remoteWritesEnabled: false } }))
  const store = openAutonomyStore({ file: defaultAutonomyDbFile(dataDir) })
  try {
    // Seed locally, never via a mutating API. Even a persisted remote-write flag
    // and confirmations must not reopen the production read-only surface.
    store.setSetting('autonomySettings', { enabled: false, paused: true, remoteWritesEnabled: true, researchEnabled: false, automationMode: 'observe' })
    store.put('repositories', 'repo_fixture', { id: 'repo_fixture', fullName: 'fixture/local-only', enabled: false, automationMode: 'observe', stack: 'generic' })
    store.put('tasks', 'task_fixture', { id: 'task_fixture', repoId: 'repo_fixture', repository: 'fixture/local-only', status: 'ACCEPTED', verification: { verdict: 'PASS' } })
    store.put('findings', 'finding_fixture', { id: 'finding_fixture', kind: 'security:fixture', status: 'OPEN' })
    store.put('peer_projects', 'peer_fixture', { id: 'peer_fixture', fullName: 'fixture/peer' })
    store.put('porting_proposals', 'proposal_fixture', { id: 'proposal_fixture', featureName: 'Local fixture' })
    store.audit('fixture', 'seed', 'local-only', {})
  } finally { store.close() }
  const server = await startNexusServer({
    dataDir, stateFile, token, providerUrl: fixtureUrl, ipc: true,
    extraEnv: {
      NEXUS_ROLE: role, NEXUS_ALLOW_ROLE_HEADER: String(allowRoleHeader),
      GITHUB_API_URL: fixtureUrl, GITHUB_UPLOADS_URL: fixtureUrl,
      GITHUB_TOKEN: '', GITHUB_OWNER: '', GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '',
      GITHUB_APP_CLIENT_ID: '', GITHUB_APP_CLIENT_SECRET: '', GITHUB_WEBHOOK_SECRET: webhookSecret,
      AI_API_KEY: '', AI_BASE_URL: fixtureUrl, AI_MODEL: '',
      NEXUS_AI_PROVIDERS_JSON: '', NEXUS_AI_ROUTING_JSON: '', ...extraEnv
    }
  })
  const request = async (endpoint, { headers = {}, ...init } = {}) => {
    const response = await fetch(`${server.base}${endpoint}`, {
      ...init, headers: { Authorization: `Bearer ${token}`, ...headers }
    })
    return { response, body: await response.json() }
  }
  return { ...server, request, externalRequests }
}

async function snapshot(request) {
  const endpoints = ['/control/status', '/repositories', '/tasks', '/findings', '/sessions', '/audit']
  return Promise.all(endpoints.map(async (endpoint) => (await request(`/api/autonomy${endpoint}`)).body))
}

describe('production autonomy routing (real server/index.mjs, local fixtures only)', () => {
  it('serves the entire frontend initial/refresh batch before the terminal API fallback', async () => {
    const { request, externalRequests, base } = await setup()
    // Follow AutonomyCenter.load rather than a toy Express app or a hand-picked
    // overview request: any one failure rejects the real frontend Promise.all.
    const frontend = await fs.readFile(new URL('../../src/desktop/AutonomyCenter.tsx', import.meta.url), 'utf8')
    const load = frontend.slice(frontend.indexOf('const load ='), frontend.indexOf('setOverview(ov)'))
    const endpoints = [...load.matchAll(/'(\/api\/autonomy\/[^']+)'/g)].map((match) => match[1])
    expect(endpoints).toHaveLength(12)
    for (let refresh = 0; refresh < 2; refresh++) {
      const results = await Promise.all(endpoints.map((endpoint) => request(endpoint, { headers: { Origin: base } })))
      for (const { response, body } of results) {
        expect(response.status, response.url).toBe(200)
        expect(response.headers.get('content-type')).toContain('application/json')
        expect(response.headers.get('x-request-id')).toBeTruthy()
        expect(body.code).toBeUndefined()
      }
      const [overview, repos, adapters, tasks, findings, sessions, peers, proposals, audit, readiness, intents, backups] = results.map((result) => result.body)
      expect(overview).toMatchObject({ apiAccess: 'read-only', repositoriesManaged: 1, problemsFixed: 1, securityRisks: 1, peerUpdates: 1, control: { enabled: false, paused: true } })
      expect(repos.repositories[0].id).toBe('repo_fixture')
      expect(Array.isArray(adapters.adapters)).toBe(true)
      expect(tasks.items[0].id).toBe('task_fixture')
      expect(findings.items[0].id).toBe('finding_fixture')
      expect(sessions.items).toEqual([])
      expect(peers.peers[0].id).toBe('peer_fixture')
      expect(proposals.items[0].id).toBe('proposal_fixture')
      expect(audit.items.some((item) => item.action === 'seed')).toBe(true)
      expect(readiness).toMatchObject({ mode: 'desktop', checks: expect.any(Array), blockingCodes: expect.any(Array) })
      // The Safety & recovery tab renders these two responses directly, so the
      // initial batch must include them and they must be safely empty.
      expect(intents.grants).toEqual([])
      expect(intents.uses).toEqual([])
      expect(backups.backups).toEqual([])
    }
    for (const endpoint of ['/api/autonomy/health', '/api/autonomy/control/status', '/api/health']) {
      expect((await request(endpoint)).response.status).toBe(200)
    }
    const head = await fetch(`${base}/api/autonomy/overview`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    for (const endpoint of ['/api/autonomy/not-a-route', '/api/not-a-route', '/api/autonomy/delivery/repo_fixture/status', '/api/autonomy/security/tools']) {
      const result = await request(endpoint)
      expect(result.response.status).toBe(404)
      expect(result.body.code).toBe('API_NOT_FOUND')
    }
    expect(externalRequests).toEqual([])
  })

  it('retains local-session, origin and configured-role gates on overview', async () => {
    const { request, base } = await setup('Unknown', true)
    for (const endpoint of ['/api/autonomy/overview', '/API/Autonomy/overview']) {
      const unauthenticated = await fetch(`${base}${endpoint}`)
      expect(unauthenticated.status).toBe(401)
      expect((await unauthenticated.json()).code).toBe('LOCAL_SESSION_REQUIRED')
    }
    const denied = await request('/api/autonomy/overview')
    expect(denied.response.status).toBe(403)
    expect(denied.body).toMatchObject({ code: 'INSUFFICIENT_ROLE', required: 'Viewer', role: 'Unknown' })
    const invalidHeaderRole = await request('/api/autonomy/overview', { headers: { 'x-nexus-role': 'constructor' } })
    expect(invalidHeaderRole.response.status).toBe(403)
    const viewer = await request('/api/autonomy/overview', { headers: { 'x-nexus-role': 'Viewer' } })
    expect(viewer.response.status).toBe(200)
    const badOrigin = await request('/api/autonomy/overview', { headers: { Origin: 'https://untrusted.invalid', 'x-nexus-role': 'Viewer' } })
    expect(badOrigin.response.status).toBe(403)
    expect(badOrigin.body.code).toBe('CORS_ORIGIN_NOT_ALLOWED')
  })

  it('allows token-free standalone loopback reads but fails closed without a desktop session', async () => {
    const desktop = await setup('Viewer', false, { NEXUS_LOCAL_API_TOKEN: '' })
    expect((await desktop.request('/api/autonomy/overview')).response.status).toBe(401)
    const standalone = await setup('Viewer', false, { NEXUS_LOCAL_API_TOKEN: '', NEXUS_DESKTOP_MODE: 'false' })
    const result = await fetch(`${standalone.base}/api/autonomy/overview`)
    expect(result.status).toBe(200)
    expect((await result.json()).apiAccess).toBe('read-only')
    expect(standalone.externalRequests).toEqual([])
  })

  it.each(['Viewer', 'Operator', 'Administrator'])('blocks all autonomy mutations for configured %s without side effects or webhook bypass', async (role) => {
    const { request, externalRequests } = await setup(role)
    const before = await snapshot(request)
    const blocked = [
      ['POST', '/control/start'], ['POST', '/control/pause'], ['POST', '/control/resume'], ['POST', '/control/stop'],
      ['POST', '/control/scan-now'], ['POST', '/control/research-now'], ['POST', '/control/run-now'], ['POST', '/control/settings'],
      ['POST', '/repositories'], ['PATCH', '/repositories/repo_fixture'], ['DELETE', '/repositories/repo_fixture'],
      ['POST', '/repositories/repo_fixture/sync'], ['POST', '/repositories/repo_fixture/issues/1/assess'],
      ['POST', '/security/scan'], ['POST', '/security/scans/scan_fixture/tasks'],
      ['POST', '/delivery/repo_fixture/commit-push'], ['POST', '/delivery/repo_fixture/pull-request'],
      ['POST', '/delivery/repo_fixture/tasks/task_fixture/pull-request'], ['POST', '/delivery/repo_fixture/merge'],
      ['POST', '/delivery/repo_fixture/release'], ['POST', '/delivery/repo_fixture/notify'],
      ['POST', '/webhook'], ['POST', '/tasks'], ['POST', '/tasks/task_fixture/finalize'],
      ['POST', '/tasks/task_fixture/cancel'], ['POST', '/tasks/task_fixture/pause'], ['POST', '/tasks/task_fixture/resume'],
      ['POST', '/tasks/task_fixture/retry'], ['POST', '/tasks/task_fixture/takeover'],
      ['POST', '/adapters/probe'], ['POST', '/adapters/windows'], ['POST', '/adapters/chatgpt-desktop/launch'],
      ['POST', '/sessions/session_fixture/resolve'], ['POST', '/research'], ['PUT', '/control/settings'], ['POST', '/overview']
    ]
    for (const [method, endpoint] of blocked) {
      const result = await request(`/api/autonomy${endpoint}`, {
        method, headers: { 'content-type': 'application/json', 'x-nexus-role': 'Administrator' },
        body: JSON.stringify({ confirm: true, confirmSourceDisclosure: true, remoteWritesEnabled: true, enabled: true, paused: false,
          fullName: 'fixture/local-only', repoId: 'repo_fixture', repository: { full_name: 'fixture/local-only' } })
      })
      expect(result.response.status, `${role}: ${method} ${endpoint}`).toBe(403)
      expect(result.body.code).toBe('AUTONOMY_READ_ONLY')
    }
    expect(await snapshot(request)).toEqual(before)
    expect(externalRequests).toEqual([])

    // Only the existing raw-body HMAC path remains usable. A valid local
    // session is NOT a substitute for a GitHub webhook signature.
    const raw = '{ "repository": { "full_name": "fixture/unmanaged" }, "zen": "synthetic ping" }'
    const postWebhook = (signature, body = raw) => request('/api/github/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-github-delivery': 'routing-fixture-ping',
        ...(signature ? { 'x-hub-signature-256': signature } : {}) }, body
    })
    for (const signature of [undefined, 'sha256=invalid']) {
      const rejected = await postWebhook(signature)
      expect(rejected.response.status).toBe(401)
      expect(rejected.body.code).toBe('WEBHOOK_SIGNATURE_INVALID')
    }
    const signature = `sha256=${crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex')}`
    expect((await postWebhook(signature, `${raw} `)).response.status).toBe(401)
    const accepted = await postWebhook(signature)
    expect(accepted.response.status).toBe(202)
    expect(accepted.body.accepted).toBe(true)
    const duplicate = await postWebhook(signature)
    expect(duplicate.body.duplicate).toBe(true)
    expect(await snapshot(request)).toEqual(before)
    expect(externalRequests).toEqual([])
  })

  it('requires and records an explicit scoped intent before a local autonomy action', async () => {
    const { request, externalRequests } = await setup('Administrator')
    const denied = await request('/api/autonomy/control/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) })
    expect(denied.response.status).toBe(403)
    expect(denied.body).toMatchObject({ code: 'AUTONOMY_READ_ONLY', intentCode: 'INTENT_NOT_GRANTED' })

    const granted = await request('/api/autonomy/intents/grant', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'local_file_write', scope: { repository: '__global__' }, reason: 'Enable the local scheduler for this session', duration: 'once', confirm: true })
    })
    expect(granted.response.status).toBe(201)
    expect(granted.body.grant).toMatchObject({ action: 'local_file_write', status: 'ACTIVE', scope: { repository: '__global__' } })

    const started = await request('/api/autonomy/control/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) })
    expect(started.response.status).toBe(200)
    expect(started.body.settings.enabled).toBe(true)
    const intents = await request('/api/autonomy/intents')
    expect(intents.response.status).toBe(200)
    expect(intents.body.uses.some((use) => use.action === 'local_file_write' && use.status === 'SUCCEEDED')).toBe(true)
    expect(externalRequests).toEqual([])
  })

  it('resolves repository scope from a mounted route before authorizing the handler', async () => {
    const { request, externalRequests } = await setup('Administrator')
    const granted = await request('/api/autonomy/intents/grant', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'local_file_write', scope: { repository: 'fixture/local-only' }, reason: 'Update local repository metadata', duration: 'once', confirm: true })
    })
    expect(granted.response.status).toBe(201)
    const mismatched = await request('/api/autonomy/repositories/repo_fixture', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fullName: 'other/repo', confirm: true })
    })
    expect(mismatched.response.status).toBe(403)
    expect(mismatched.body).toMatchObject({ code: 'AUTONOMY_READ_ONLY', intentCode: 'INTENT_SCOPE_MISMATCH' })
    const updated = await request('/api/autonomy/repositories/repo_fixture', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, confirm: true })
    })
    expect(updated.response.status).toBe(200)
    expect(updated.body.fullName).toBe('fixture/local-only')
    expect(externalRequests).toEqual([])
  })

  it('drives the Safety & recovery tab end to end: revoke a grant, then back up and restore state', async () => {
    const { request, externalRequests } = await setup('Administrator')

    // 1. A grant is visible to the tab and can be revoked through the UI route.
    const granted = await request('/api/autonomy/intents/grant', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'local_file_write', scope: { repository: '__global__' }, reason: 'Safety tab fixture', duration: 'session', confirm: true })
    })
    expect(granted.response.status).toBe(201)
    const grantId = granted.body.grant.id
    expect((await request('/api/autonomy/intents')).body.grants.map((grant) => grant.id)).toContain(grantId)

    const revoked = await request(`/api/autonomy/intents/${grantId}/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Revoked from the workstation UI' })
    })
    expect(revoked.response.status).toBe(200)
    expect(revoked.body.grant).toMatchObject({ id: grantId, status: 'REVOKED' })
    expect((await request('/api/autonomy/intents')).body.grants.map((grant) => grant.id)).not.toContain(grantId)
    // The revoked grant cannot be replayed for a write.
    const blockedAfterRevoke = await request('/api/autonomy/backups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'manual', confirm: true }) })
    expect(blockedAfterRevoke.response.status).toBe(403)
    expect(blockedAfterRevoke.body.intentCode).toBe('INTENT_NOT_GRANTED')

    // 2. Backup creation itself is a local write and needs its own grant.
    const writeGrant = await request('/api/autonomy/intents/grant', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'local_file_write', scope: { repository: '__global__' }, reason: 'Safety tab backup fixture', duration: 'session', confirm: true })
    })
    expect(writeGrant.response.status).toBe(201)
    const created = await request('/api/autonomy/backups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'manual', confirm: true }) })
    expect(created.response.status).toBe(201)
    expect(created.body.manifest.files.map((file) => file.path)).toContain('state.json')
    const backupId = created.body.id
    expect((await request('/api/autonomy/backups')).body.backups.map((entry) => entry.id)).toContain(backupId)

    // 3. Verification is read-only and must report the real asset digests.
    const verified = await request('/api/autonomy/backups/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backupId }) })
    expect(verified.response.status).toBe(200)
    expect(verified.body.valid).toBe(true)
    expect(verified.body.manifest.files[0].sha256).toMatch(/^[a-f0-9]{64}$/)

    // 4. State restore is a write, succeeds through the granted intent, and
    //    never claims to restore the live SQLite file from this route.
    const restored = await request('/api/autonomy/backups/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backupId, confirm: true }) })
    expect(restored.response.status).toBe(200)
    expect(restored.body).toMatchObject({ restored: true, backupId })
    const restartGated = await request('/api/autonomy/backups/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backupId, restoreAutonomyDb: true, confirm: true }) })
    expect(restartGated.response.status).toBe(409)
    expect(restartGated.body.code).toBe('RESTORE_REQUIRES_RESTART')

    // 5. Every step is auditable and nothing left the machine.
    const audit = (await request('/api/autonomy/audit?limit=200')).body.items
    for (const action of ['intent-granted', 'intent-revoked', 'intent-use:local_file_write']) {
      expect(audit.map((entry) => entry.action)).toContain(action)
    }
    expect(audit.some((entry) => entry.actor === 'backup' && entry.action === 'created')).toBe(true)
    expect(audit.some((entry) => entry.actor === 'backup' && entry.action === 'state-restored')).toBe(true)
    expect(externalRequests).toEqual([])
  })
})
