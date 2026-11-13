import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const children = []
const directories = []
const httpServers = []

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

async function waitForHealth(base, child, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${stderr()}`)
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become healthy: ${stderr()}`)
}

async function startHttpServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  httpServers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      await exited
    }
  }
  await Promise.all(httpServers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('isolated Phase 3 API and schema migration', () => {
  it('preserves archive metadata on sync and rejects archived or newly archived hosting selections', async () => {
    let archiveFirst = true, archiveSecond = false
    const repositories = () => [1, 2].map((number) => ({ id: number, name: `repo-${number}`, full_name: `fixture/repo-${number}`, owner: { login: 'fixture' }, default_branch: 'main', archived: number === 1 ? archiveFirst : archiveSecond }))
    const githubApiUrl = await startHttpServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url.startsWith('/user/repos')) return res.end(JSON.stringify(repositories()))
      if (req.url.startsWith('/repos/fixture/repo-')) return res.end(JSON.stringify(repositories().find((repo) => req.url.endsWith(repo.name))))
      res.statusCode = 404; res.end('{}')
    })
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-archive-api-'))
    directories.push(directory)
    const stateFile = path.join(directory, 'state.json')
    await fs.writeFile(stateFile, JSON.stringify({ schemaVersion: 4, settings: { hostingPaused: true }, projects: [{ id: 'repo_1', name: 'repo-1', fullName: 'fixture/repo-1', repoMeta: { archived: true }, hosting: { enabled: false, strategy: 'observe' } }] }))
    const port = await freePort()
    let stderrText = ''
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PORT: String(port), NEXUS_STATE_FILE: stateFile, GITHUB_API_URL: githubApiUrl, GITHUB_TOKEN: 'archive-fixture-token', GITHUB_OWNER: '', NEXUS_ROLE: 'Administrator', NEXUS_ALLOW_ROLE_HEADER: 'false', NEXUS_ENABLE_REMOTE_WRITES: 'false', AI_API_KEY: '', AI_BASE_URL: '', AI_MODEL: '' }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderrText += chunk })
    children.push(child)
    const base = `http://127.0.0.1:${port}`
    await waitForHealth(base, child, () => stderrText)
    const post = (url, body = {}, method = 'POST') => fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const sync = async () => {
      const task = (await (await post('/api/tasks/sync-repositories')).json()).task
      await expect.poll(async () => (await (await fetch(base + '/api/tasks')).json()).tasks.find((item) => item.id === task.id).status).toBe('Success')
      return (await (await fetch(base + '/api/projects')).json()).projects
    }
    let projects = await sync()
    expect(projects).toHaveLength(2)
    expect(projects.find((project) => project.id === 'repo_1').archived).toBe(true)
    expect(projects.find((project) => project.id === 'repo_2').archived).toBe(false)
    for (const [endpoint, method, body] of [['readiness', 'POST', {}], ['enable', 'POST', {}], ['', 'PUT', { enabled: true }]]) {
      const response = await post(`/api/projects/repo_1/hosting${endpoint ? '/' + endpoint : ''}`, body, method)
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('REPOSITORY_ARCHIVED')
    }
    archiveSecond = true // The server's saved selection is still active.
    const newlyArchived = await post('/api/projects/repo_2/hosting/enable')
    expect(newlyArchived.status).toBe(409)
    expect((await newlyArchived.json()).code).toBe('REPOSITORY_ARCHIVED')
    const blockedReadiness = await post('/api/projects/repo_2/hosting/readiness')
    expect(blockedReadiness.status).toBe(409)
    archiveFirst = false
    projects = await sync()
    const restored = projects.find((project) => project.id === 'repo_1')
    expect(restored.archived).toBe(false)
    expect(restored.repoMeta.archived).toBe(false)
    const readiness = await post('/api/projects/repo_1/hosting/readiness')
    expect(readiness.status).toBe(200)
    const enabled = await post('/api/projects/repo_1/hosting/enable', { readinessId: (await readiness.json()).readinessId })
    expect(enabled.status).toBe(200)
    expect((await enabled.json()).project.archived).toBe(false)
    expect(JSON.parse(await fs.readFile(stateFile, 'utf8')).projects.find((project) => project.id === 'repo_2').hosting.enabled).toBe(false)
  })

  it('migrates a 24-repository v2 fixture additively and exposes real integration routes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-api-test-'))
    directories.push(directory)
    const stateFile = path.join(directory, 'state.json')
    const fixture = {
      schemaVersion: 2,
      projects: Array.from({ length: 24 }, (_, index) => ({ id: `repo_${index}`, name: `repo-${index}`, fullName: `fixture/repo-${index}`, owner: 'fixture', defaultBranch: 'main', stack: [] })),
      tasks: Array.from({ length: 3 }, (_, index) => ({ id: `task_${index}`, type: 'legacy', label: `kept-${index}`, status: 'Success', logs: ['preserved'] })),
      activity: [{ id: 'activity_1', message: 'preserved' }],
      settings: { concurrency: 3, notifications: true },
      githubInstallations: [{ installationId: '123', accessToken: 'fixture-token' }],
      githubWebhookEvents: [{ deliveryId: 'delivery_1', status: 'PROCESSED' }],
      updateConfigs: [{ id: 'update_1', projectId: 'repo_0' }],
      auditLogs: [{ id: 'audit_1', action: 'preserved' }]
    }
    await fs.writeFile(stateFile, JSON.stringify(fixture, null, 2), 'utf8')
    const port = await freePort()
    let stderrText = ''
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: root,
      env: { ...process.env, PORT: String(port), NEXUS_STATE_FILE: stateFile, NEXUS_ROLE: 'Administrator', NEXUS_ALLOW_ROLE_HEADER: 'false', NEXUS_ENABLE_REMOTE_WRITES: 'false', GITHUB_TOKEN: '', AI_API_KEY: '', AI_BASE_URL: '', AI_MODEL: '' },
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderrText += chunk })
    children.push(child)
    const base = `http://127.0.0.1:${port}`
    await waitForHealth(base, child, () => stderrText)

    const overview = await (await fetch(`${base}/api/overview`)).json()
    expect(overview.metrics.repositories).toBe(24)
    const allowedOrigin = await fetch(`${base}/api/health`, { headers: { Origin: 'http://127.0.0.1:5173' } })
    expect(allowedOrigin.status).toBe(200)
    expect(allowedOrigin.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173')
    const blockedOrigin = await fetch(`${base}/api/health`, { headers: { Origin: 'https://untrusted.example' } })
    expect(blockedOrigin.status).toBe(403)
    const adapterResult = await (await fetch(`${base}/api/integrations/adapters`)).json()
    expect(adapterResult.adapters.map((item) => item.id)).toEqual(['electron', 'tauri', 'python', 'dotnet', 'web-pwa'])
    const providerResult = await (await fetch(`${base}/api/ai/providers`)).json()
    expect(providerResult.providers).toEqual(expect.any(Array))
    expect(providerResult.configured).toBe(false)
    const blockedDiagnosis = await fetch(`${base}/api/ai/diagnose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'diagnose this fixture' }) })
    expect(blockedDiagnosis.status).toBe(424)
    const reportResult = await (await fetch(`${base}/api/integrations/reports`)).json()
    expect(reportResult).toEqual({ reports: [], total: 0 })
    const noCredentials = await fetch(`${base}/api/integrations/scans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(noCredentials.status).toBe(424)
    const remoteWrite = await fetch(`${base}/api/integrations/jobs/not-a-job/pull-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(remoteWrite.status).toBe(403)

    const migrated = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    expect(migrated.schemaVersion).toBe(4)
    expect(migrated.projects).toEqual(fixture.projects.map((project) => ({ ...project, hosting: null, repoMeta: null, localWorkspace: null })))
    expect(migrated.tasks).toEqual(fixture.tasks)
    expect(migrated.activity).toEqual(fixture.activity)
    expect(migrated.githubInstallations).toEqual(fixture.githubInstallations.map(({ accessToken, ...metadata }) => metadata))
    expect(JSON.stringify(migrated)).not.toContain('fixture-token')
    expect(migrated.githubWebhookEvents).toEqual(fixture.githubWebhookEvents)
    expect(migrated.updateConfigs).toEqual(fixture.updateConfigs)
    expect(migrated.auditLogs).toEqual(fixture.auditLogs)
    expect(migrated.integrationReports).toEqual([])
    expect(migrated.integrationJobs).toEqual([])
  })

  it('uses an installation token for project-scoped GitHub operations when no legacy token is configured', async () => {
    const githubApiUrl = await startHttpServer((req, res) => {
      const requestUrl = new URL(req.url, 'http://127.0.0.1')
      let body = {}
      let status = 200
      if (requestUrl.pathname === '/repos/fixture/repo-0/contents') body = [{ name: 'package.json' }]
      else if (requestUrl.pathname === '/repos/fixture/repo-0/actions/workflows') body = { workflows: [] }
      else if (requestUrl.pathname === '/repos/fixture/repo-0/actions/runs') body = { workflow_runs: [] }
      else if (requestUrl.pathname === '/repos/fixture/repo-0/releases') body = []
      else if (requestUrl.pathname.includes('/actions/workflows/') && req.method === 'POST') status = 204
      else status = 404
      res.statusCode = status
      if (status !== 204) res.setHeader('content-type', 'application/json')
      res.end(status === 204 ? '' : JSON.stringify(body))
    })
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-app-only-test-'))
    directories.push(directory)
    const stateFile = path.join(directory, 'state.json')
    const fixture = {
      schemaVersion: 3,
      projects: [{ id: 'repo_0', name: 'repo-0', fullName: 'fixture/repo-0', owner: 'fixture', defaultBranch: 'main', stack: [], installationId: '123' }],
      tasks: [], activity: [], settings: { concurrency: 3, notifications: false },
      githubInstallations: [{ installationId: '123', accessToken: 'fixture-token', expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }],
      githubWebhookEvents: [], updateConfigs: [], auditLogs: [], integrationReports: [], integrationJobs: [], integrationSchedules: []
    }
    await fs.writeFile(stateFile, JSON.stringify(fixture, null, 2), 'utf8')
    const port = await freePort()
    let stderrText = ''
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: root,
      env: { ...process.env, PORT: String(port), NEXUS_STATE_FILE: stateFile, GITHUB_API_URL: githubApiUrl, GITHUB_TOKEN: '', NEXUS_ROLE: 'Administrator', NEXUS_ALLOW_ROLE_HEADER: 'false', NEXUS_ENABLE_REMOTE_WRITES: 'false', AI_API_KEY: '', AI_BASE_URL: '', AI_MODEL: '' },
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderrText += chunk })
    children.push(child)
    const base = `http://127.0.0.1:${port}`
    await waitForHealth(base, child, () => stderrText)

    expect((await fetch(`${base}/api/projects/repo_0/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200)
    expect((await fetch(`${base}/api/projects/repo_0/workflows`)).status).toBe(200)
    expect((await fetch(`${base}/api/projects/repo_0/runs`)).status).toBe(200)
    expect((await fetch(`${base}/api/projects/repo_0/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: 123 }) })).status).toBe(202)
    const releases = await fetch(`${base}/api/releases?projectId=repo_0`)
    expect(releases.status).toBe(200)
    expect((await releases.json()).releases).toEqual([])
  })

  it('requires and consumes a one-time GitHub App installation state token', async () => {
    const githubApiUrl = await startHttpServer((req, res) => {
      if (req.url === '/app/installations/123') {
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ id: 123, account: { login: 'fixture', type: 'User' }, repository_selection: 'selected', permissions: { contents: 'read' } }))
      }
      res.statusCode = 404
      res.end('{}')
    })
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-app-state-test-'))
    directories.push(directory)
    const stateFile = path.join(directory, 'state.json')
    await fs.writeFile(stateFile, JSON.stringify({ schemaVersion: 3, projects: [], tasks: [], activity: [], settings: {}, githubInstallations: [], githubWebhookEvents: [], updateConfigs: [], auditLogs: [], integrationReports: [], integrationJobs: [], integrationSchedules: [] }, null, 2), 'utf8')
    const port = await freePort()
    let stderrText = ''
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: root,
      env: { ...process.env, PORT: String(port), NEXUS_STATE_FILE: stateFile, GITHUB_API_URL: githubApiUrl, GITHUB_TOKEN: '', GITHUB_APP_ID: '123', GITHUB_APP_CLIENT_ID: 'client-id', GITHUB_APP_PRIVATE_KEY: privateKeyPem, GITHUB_APP_SLUG: 'project-nexus', NEXUS_ROLE: 'Administrator', NEXUS_ALLOW_ROLE_HEADER: 'false', NEXUS_ENABLE_REMOTE_WRITES: 'false', AI_API_KEY: '', AI_BASE_URL: '', AI_MODEL: '' },
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderrText += chunk })
    children.push(child)
    const base = `http://127.0.0.1:${port}`
    await waitForHealth(base, child, () => stderrText)

    const installResponse = await fetch(`${base}/api/github/app/install-url`)
    expect(installResponse.status).toBe(200)
    const install = await installResponse.json()
    expect(typeof install.state).toBe('string')
    expect(install.url).toContain(`state=${install.state}`)

    const invalid = await fetch(`${base}/api/github/app/callback?installation_id=123&state=not-issued`)
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).code).toBe('GITHUB_APP_STATE_INVALID')

    const callback = await fetch(`${base}/api/github/app/callback?installation_id=123&state=${encodeURIComponent(install.state)}`)
    expect(callback.status).toBe(200)
    expect(await callback.text()).toContain('installation verified')

    const replay = await fetch(`${base}/api/github/app/callback?installation_id=123&state=${encodeURIComponent(install.state)}`)
    expect(replay.status).toBe(400)
    expect((await replay.json()).code).toBe('GITHUB_APP_STATE_INVALID')
    const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    expect(persisted.githubInstallations).toEqual(expect.arrayContaining([expect.objectContaining({ installationId: '123', accountLogin: 'fixture' })]))
  })
})
