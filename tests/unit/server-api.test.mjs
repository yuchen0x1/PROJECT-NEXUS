import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../src/api.ts'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildProjectOverview } from '../../server/services/project-overview.mjs'

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

async function waitForHealth(base, child, stderr, headers = {}) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${stderr()}`)
    try {
      const response = await fetch(`${base}/api/health`, { headers })
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

const fixtureTokenPath = '/app/installations/123/access_tokens'
const fixtureAssetPath = '/repos/fixture/repo-0/releases/7/assets'

async function startGithubWriteFixture({ credential = 'pat', role = 'Administrator', enabled, envEnabled = false, roleHeader = false } = {}) {
  const calls = []
  const control = { draft: true, onRead: null, heldCredential: null, uploadUrl: undefined, uploadRedirect: null }
  const token = 'write-guard-fixture-token'
  const installation = credential !== 'pat'
  const refresh = credential === 'refreshing-installation'
  const privateKey = refresh ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) : ''
  const githubApiUrl = await startHttpServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const url = new URL(req.url, 'http://127.0.0.1')
    const call = { method: req.method, path: url.pathname, body: text ? JSON.parse(text) : null, authorization: req.headers.authorization }
    calls.push(call)
    if (req.method === 'GET' && control.onRead) await control.onRead(call)
    const release = { id: 7, tag_name: 'v1.2.3', draft: control.draft, upload_url: control.uploadUrl ?? `${githubApiUrl}${fixtureAssetPath}{?name,label}` }
    let body = release
    if (req.method === 'POST' && url.pathname === fixtureTokenPath) {
      await control.heldCredential
      body = { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }
    } else if (url.pathname.includes('/releases/tags/')) { res.statusCode = 404; body = { message: 'Not found' } }
    else if (url.pathname.endsWith('/actions/workflows')) body = { workflows: [] }
    else if (url.pathname.endsWith('/actions/runs')) body = { workflow_runs: [] }
    else if (req.method === 'GET' && url.pathname.endsWith('/releases')) body = [release]
    else if (req.method === 'POST' && url.pathname.endsWith('/dispatches')) { res.statusCode = 204; return res.end() }
    else if (req.method === 'POST' && url.pathname === fixtureAssetPath) {
      if (control.uploadRedirect) { res.writeHead(307, { location: control.uploadRedirect }); return res.end() }
      res.statusCode = 201; body = { id: 8, name: url.searchParams.get('name') }
    } else if (req.method !== 'GET') body = { ...release, ...call.body }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  })
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-write-guard-'))
  directories.push(directory)
  const stateFile = path.join(directory, 'state.json')
  await fs.writeFile(stateFile, JSON.stringify({
    schemaVersion: 4,
    projects: [{ id: 'repo_0', name: 'repo-0', fullName: 'fixture/repo-0', owner: 'fixture', defaultBranch: 'main', ...(installation ? { installationId: '123' } : {}) }],
    settings: { hostingPaused: true, ...(enabled === undefined ? {} : { remoteWritesEnabled: enabled }) },
    githubInstallations: installation ? [{ installationId: '123', ...(!refresh ? { accessToken: token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } : {}) }] : []
  }))
  const port = await freePort()
  let stderrText = ''
  const headers = { authorization: 'Bearer write-guard-local-session' }
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PORT: String(port), NEXUS_HOST: '127.0.0.1', NEXUS_DATA_DIR: directory, NEXUS_STATE_FILE: stateFile, GITHUB_API_URL: githubApiUrl, GITHUB_UPLOADS_URL: githubApiUrl, GITHUB_TOKEN: installation ? '' : token, GITHUB_OWNER: '', GITHUB_APP_ID: refresh ? '123' : '', GITHUB_APP_PRIVATE_KEY: privateKey, NEXUS_ROLE: role, NEXUS_ALLOW_ROLE_HEADER: String(roleHeader), NEXUS_ENABLE_REMOTE_WRITES: String(envEnabled), NEXUS_DESKTOP_MODE: 'true', NEXUS_LOCAL_API_TOKEN: 'write-guard-local-session', NEXUS_DESKTOP_OWNER_PID: '', AI_API_KEY: '', AI_BASE_URL: '', AI_MODEL: '' }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderrText += chunk })
  children.push(child)
  const base = `http://127.0.0.1:${port}`
  await waitForHealth(base, child, () => stderrText, headers)
  const send = (endpoint, body, method = 'POST', extraHeaders = {}) => fetch(base + endpoint, { method, headers: { ...headers, 'content-type': 'application/json', ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const tasks = async () => (await (await send('/api/tasks', undefined, 'GET')).json()).tasks
  const finish = async (task, status = 'Success') => {
    await expect.poll(async () => (await tasks()).find((item) => item.id === task.id)?.status).toBe(status)
    return (await tasks()).find((item) => item.id === task.id)
  }
  return { calls, control, send, tasks, finish, token, githubApiUrl }
}

const githubWriteRoutes = [
  ['POST', '/build', { workflowId: 123, ref: 'main' }],
  ['POST', '/releases', { tagName: 'v1.2.3' }],
  ['PATCH', '/releases/7', { name: 'Release notes' }],
  ['POST', '/releases/7/publish', { confirm: true }],
  ['POST', '/releases/7/assets', { assetName: 'fixture.txt', contentBase64: 'e30=' }]
]
const projectRoute = (suffix) => `/api/projects/repo_0${suffix}`
const outboundWrites = (calls) => calls.filter((call) => !['GET', 'HEAD'].includes(call.method))

afterEach(async () => {
  vi.unstubAllGlobals()
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

describe.each(['pat', 'installation'])('legacy GitHub write authorization (%s)', (credential) => {
  it.each([
    ['default-disabled', { role: 'Administrator' }, 'REMOTE_WRITES_DISABLED'],
    ['persisted-off overrides environment', { enabled: false, envEnabled: true }, 'REMOTE_WRITES_DISABLED'],
    ['header identity cannot authorize writes', { enabled: true, roleHeader: true }, 'UNTRUSTED_ROLE_MODE'],
    ['Viewer cannot write or spoof Administrator', { role: 'Viewer', enabled: true }, 'INSUFFICIENT_ROLE'],
    ['unknown role fails closed', { role: 'Unknown', enabled: true }, 'INSUFFICIENT_ROLE'],
    ['inherited role name fails closed', { role: 'constructor', enabled: true }, 'INSUFFICIENT_ROLE'],
    ['empty configured role fails closed', { role: '', enabled: true }, 'INSUFFICIENT_ROLE']
  ])('rejects all write routes with no GitHub calls or queued tasks: %s', async (_label, config, code) => {
    const { calls, send, tasks } = await startGithubWriteFixture({ credential, ...config })
    for (const [method, suffix, body] of githubWriteRoutes) {
      const response = await send(projectRoute(suffix), body, method, { 'x-nexus-role': 'Administrator' })
      expect(response.status).toBe(403)
      expect((await response.json()).code).toBe(code)
    }
    expect(await tasks()).toEqual([])
    expect(calls).toEqual([])
    // The allow switch must not turn read-only GitHub APIs off.
    for (const route of [projectRoute('/workflows'), projectRoute('/runs'), '/api/releases?projectId=repo_0']) {
      expect((await send(route, undefined, 'GET')).status).toBe(200)
    }
    expect(calls).toHaveLength(3)
    expect(outboundWrites(calls)).toEqual([])
  })

  it('allows Operator dispatch and draft preparation but never publication', async () => {
    const { calls, send, tasks, finish, token } = await startGithubWriteFixture({ credential, role: 'Operator', envEnabled: true })
    for (const [method, suffix, body] of githubWriteRoutes) {
      const response = await send(projectRoute(suffix), { ...body, ...(suffix === '/releases' ? { draft: false } : {}) }, method)
      if (suffix.endsWith('/publish')) {
        expect(response.status).toBe(403)
        expect((await response.json()).code).toBe('INSUFFICIENT_ROLE')
      } else {
        expect(response.status).toBe(suffix === '/build' || suffix === '/releases' ? 202 : suffix.endsWith('/assets') ? 201 : 200)
        const result = await response.json()
        if (result.task) await finish(result.task)
        if (suffix.endsWith('/assets')) expect(result.asset.name).toBe(body.assetName)
      }
    }
    expect(await tasks()).toHaveLength(2)
    expect(outboundWrites(calls)).toMatchObject([
      { method: 'POST', path: '/repos/fixture/repo-0/actions/workflows/123/dispatches', body: { ref: 'main', inputs: {} } },
      { method: 'POST', path: '/repos/fixture/repo-0/releases', body: { tag_name: 'v1.2.3', draft: true } },
      { method: 'PATCH', path: '/repos/fixture/repo-0/releases/7', body: { name: 'Release notes' } },
      { method: 'POST', path: fixtureAssetPath }
    ])
    expect(calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(true)
    expect(outboundWrites(calls).some((call) => call.body?.draft === false)).toBe(false)
  })

  it.each(['Operator', 'Administrator'])('does not allow %s to publish through generic PATCH, even with confirm', async (role) => {
    const { calls, send, tasks } = await startGithubWriteFixture({ credential, role, enabled: true })
    for (const draft of [false, null, 0, '', 'false', 'true', {}, []]) {
      const response = await send(projectRoute('/releases/7'), { draft, confirm: true, name: 'Not published' }, 'PATCH')
      expect(response.status).toBe(400)
      expect((await response.json()).code).toBe('RELEASE_PUBLISH_REQUIRED')
    }
    expect(calls).toEqual([])
    expect(await tasks()).toEqual([])
    const response = await send(projectRoute('/releases/7'), { name: 'Draft edit', draft: true }, 'PATCH')
    expect(response.status).toBe(200)
    expect(outboundWrites(calls)).toHaveLength(1)
    expect(outboundWrites(calls)[0].body).toEqual({ name: 'Draft edit' })
  })

  it('requires a literal confirmation on the dedicated Administrator publish path', async () => {
    // Persisted opt-in is the same supported switch used by the desktop settings.
    const { calls, send, tasks, finish } = await startGithubWriteFixture({ credential, enabled: true, envEnabled: false })
    for (const confirm of [undefined, false, 'true', 1, {}, []]) {
      const response = await send(projectRoute('/releases/7/publish'), { confirm })
      expect(response.status).toBe(400)
      expect((await response.json()).code).toBe('CONFIRMATION_REQUIRED')
    }
    expect(calls).toEqual([])
    expect(await tasks()).toEqual([])
    const response = await send(projectRoute('/releases/7/publish'), { confirm: true })
    expect(response.status).toBe(202)
    await finish((await response.json()).task)
    expect(outboundWrites(calls)).toEqual([expect.objectContaining({ method: 'PATCH', path: '/repos/fixture/repo-0/releases/7', body: { draft: false } })])
  })

  it('does not edit or upload assets to an already published release', async () => {
    const { calls, control, send, tasks } = await startGithubWriteFixture({ credential, enabled: true })
    control.draft = false
    for (const [method, suffix, body] of githubWriteRoutes.filter(([, suffix]) => ['/releases/7', '/releases/7/assets'].includes(suffix))) {
      const response = await send(projectRoute(suffix), body, method)
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('RELEASE_NOT_DRAFT')
    }
    expect(calls).toHaveLength(2)
    expect(outboundWrites(calls)).toEqual([])
    expect(await tasks()).toEqual([])
  })

  it('rechecks the live allow switch after release preflight reads', async () => {
    const { calls, control, send, finish } = await startGithubWriteFixture({ credential, enabled: true })
    control.onRead = async () => {
      const disabled = await send('/api/settings/remote-writes', { enabled: false, confirm: true }, 'PUT')
      expect(disabled.status).toBe(200)
    }
    const response = await send(projectRoute('/releases'), { tagName: 'v1.2.3' })
    expect(response.status).toBe(202)
    expect((await finish((await response.json()).task, 'Failed')).errorCode).toBe('REMOTE_WRITES_DISABLED')
    for (const [method, suffix, body] of githubWriteRoutes.filter(([, suffix]) => ['/releases/7', '/releases/7/assets'].includes(suffix))) {
      expect((await send('/api/settings/remote-writes', { enabled: true, confirm: true }, 'PUT')).status).toBe(200)
      const denied = await send(projectRoute(suffix), body, method)
      expect(denied.status).toBe(403)
      expect((await denied.json()).code).toBe('REMOTE_WRITES_DISABLED')
    }
    expect(calls).toHaveLength(3)
    expect(outboundWrites(calls)).toEqual([])
  })
})

describe('legacy GitHub write send boundary', () => {
  it.each(githubWriteRoutes.filter(([, suffix]) => ['/build', '/releases/7/publish'].includes(suffix)))('blocks %s %s when disabled during installation credential refresh', async (method, suffix, body) => {
    const { calls, control, send, finish } = await startGithubWriteFixture({ credential: 'refreshing-installation', enabled: true, envEnabled: true })
    const credential = Promise.withResolvers()
    control.heldCredential = credential.promise
    let task
    try {
      const queued = await send(projectRoute(suffix), body, method)
      expect(queued.status).toBe(202)
      task = (await queued.json()).task
      await expect.poll(() => calls.map((call) => call.path)).toEqual([fixtureTokenPath])
      const disabled = await send('/api/settings/remote-writes', { enabled: false, confirm: true }, 'PUT')
      expect(disabled.status).toBe(200)
      expect(await disabled.json()).toEqual({ enabled: false })
    } finally {
      credential.resolve()
    }
    expect((await finish(task, 'Failed')).errorCode).toBe('REMOTE_WRITES_DISABLED')
    expect(calls.map(({ method, path }) => [method, path])).toEqual([['POST', fixtureTokenPath]])
  })

  it('rejects asset destinations outside the configured upload origin or release path', async () => {
    const { calls, control, send, githubApiUrl } = await startGithubWriteFixture({ enabled: true })
    const otherOrigin = await startHttpServer((_req, res) => { calls.push({ method: _req.method }); res.end() })
    for (const uploadUrl of ['', `${otherOrigin}${fixtureAssetPath}{?name,label}`, `${githubApiUrl}/repos/fixture/repo-0/releases/8/assets{?name,label}`]) {
      control.uploadUrl = uploadUrl
      const response = await send(projectRoute('/releases/7/assets'), { assetName: 'fixture.txt', contentBase64: 'e30=' })
      expect(response.status).toBe(502)
      expect((await response.json()).code).toBe('INVALID_RELEASE_UPLOAD_URL')
    }
    expect(calls).toHaveLength(3)
    expect(outboundWrites(calls)).toEqual([])
  })

  it('does not follow redirects from the validated upload URL', async () => {
    const { calls, control, send } = await startGithubWriteFixture({ enabled: true })
    control.uploadRedirect = '/repos/fixture/repo-0/releases/8/assets'
    const response = await send(projectRoute('/releases/7/assets'), { assetName: 'fixture.txt', contentBase64: 'e30=' })
    expect(response.ok).toBe(false)
    expect(outboundWrites(calls).map((call) => call.path)).toEqual([fixtureAssetPath])
  })

  it('rejects unknown header roles on role-checked routes without falling back to the process role', async () => {
    const { calls, send } = await startGithubWriteFixture({ enabled: true, roleHeader: true })
    for (const role of ['Unknown', 'constructor', 'toString', '__proto__', '']) {
      const response = await send('/api/audit-logs', undefined, 'GET', { 'x-nexus-role': role })
      expect(response.status).toBe(403)
      expect((await response.json()).code).toBe('INSUFFICIENT_ROLE')
    }
    expect((await send('/api/audit-logs', undefined, 'GET', { 'x-nexus-role': 'Administrator' })).status).toBe(200)
    expect(calls).toEqual([])
  })
})

describe('release client confirmation', () => {
  it('does not manufacture confirmation in the API wrapper', async () => {
    const fetchStub = vi.fn(async () => ({ status: 202, json: async () => ({ task: {} }) }))
    vi.stubGlobal('fetch', fetchStub)
    for (const confirm of [undefined, false, true]) {
      await api.publishRelease('repo_0', 7, confirm)
      const [url, options] = fetchStub.mock.calls.at(-1)
      expect(url).toBe('/api/projects/repo_0/releases/7/publish')
      expect(JSON.parse(options.body)).toEqual(confirm === undefined ? {} : { confirm })
    }
  })

  it('places the renderer publication request after repository/tag confirmation', async () => {
    const source = await fs.readFile(path.join(root, 'src/App.tsx'), 'utf8')
    const handler = source.slice(source.indexOf('  const publish = async (release:'), source.indexOf("  return <><PageIntro eyebrow={t('release:center.eyebrow')}"))
    expect(handler).toContain("if (!project || !window.confirm(t('release:center.confirmPublish', { repository: project.fullName, tag: release.tag_name }))) return")
    expect(handler.indexOf('window.confirm(')).toBeLessThan(handler.indexOf('await api.publishRelease('))
    expect(source).toContain('onClick={() => void publish(release)}')
    expect(source.match(/api\.publishRelease\(/g)).toHaveLength(1)
  })
})

describe('isolated Phase 3 API and schema migration', () => {
  it('updates current counts after deletion, reuses concurrent syncs, validates ETags and backs off on rate limits', async () => {
    let count = 26, requests = 0, limited = false, notModified = 0
    const githubApiUrl = await startHttpServer((req, res) => {
      requests++
      if (limited) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' }); return res.end('{"message":"API rate limit"}') }
      const etag = `"repos-${count}"`
      if (req.headers['if-none-match'] === etag) { notModified++; res.writeHead(304); return res.end() }
      const items = Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `repo-${index + 1}`, full_name: `fixture/repo-${index + 1}`, owner: { login: 'fixture' }, archived: false }))
      setTimeout(() => { res.setHeader('content-type', 'application/json'); res.setHeader('etag', etag); res.end(JSON.stringify(items)) }, 80)
    })
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-sync-api-')); directories.push(directory)
    const stateFile = path.join(directory, 'state.json')
    const records = Array.from({ length: 26 }, (_, index) => ({ id: `repo_${index + 1}`, githubId: index + 1, name: `repo-${index + 1}`, fullName: `fixture/repo-${index + 1}`, owner: 'fixture', hosting: { enabled: false } }))
    await fs.writeFile(stateFile, JSON.stringify({ schemaVersion: 4, projects: records, settings: { hostingPaused: true }, tasks: [{ id: 'history', projectId: 'repo_26', status: 'Success', logs: ['retained'] }] }))
    const port = await freePort(); let errors = ''
    const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PORT: String(port), NEXUS_DATA_DIR: directory, NEXUS_STATE_FILE: stateFile, GITHUB_API_URL: githubApiUrl, GITHUB_TOKEN: 'sync-fixture', GITHUB_OWNER: '', NEXUS_ROLE: 'Administrator', NEXUS_ALLOW_ROLE_HEADER: 'false', NEXUS_ENABLE_REMOTE_WRITES: 'false', AI_API_KEY: '', AI_BASE_URL: '', AI_MODEL: '' } })
    children.push(child); child.stderr.on('data', (chunk) => { errors += chunk })
    const base = `http://127.0.0.1:${port}`; await waitForHealth(base, child, () => errors)
    const post = (automatic = false) => fetch(base + '/api/tasks/sync-repositories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ automatic }) })
    const finish = async (task, expected = 'Success') => expect.poll(async () => (await (await fetch(base + '/api/tasks')).json()).tasks.find((item) => item.id === task.id).status).toBe(expected)
    const first = await Promise.all([post(), post()]); const bodies = await Promise.all(first.map((response) => response.json()))
    expect(bodies[0].task.id).toBe(bodies[1].task.id); await finish(bodies[0].task)
    expect(requests).toBe(1)
    count = 25
    const second = await (await post()).json(); await finish(second.task)
    expect((await (await fetch(base + '/api/projects')).json()).total).toBe(25)
    expect((await (await fetch(base + '/api/overview')).json()).metrics.repositories).toBe(25)
    const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    expect(buildProjectOverview({ state: persisted }).repositories).toHaveLength(25)
    expect(persisted.projects).toHaveLength(26)
    expect(persisted.projects.find((project) => project.id === 'repo_26').repositoryAvailable).toBe(false)
    expect(persisted.tasks.find((task) => task.id === 'history').logs).toEqual(['retained'])
    await finish((await (await post()).json()).task)
    expect(notModified).toBe(1)
    const before = requests
    expect((await (await post(true)).json()).skipped).toBe(true); expect(requests).toBe(before)
    limited = true
    await finish((await (await post()).json()).task, 'Failed')
    const status = await (await fetch(base + '/api/repository-sync')).json()
    expect(status.lastErrorCode).toBe('GITHUB_RATE_LIMITED')
    expect(Date.parse(status.nextSyncAt) - Date.now()).toBeGreaterThan(115_000)
    expect((await post()).status).toBe(429)
    expect((await (await fetch(base + '/api/projects')).json()).total).toBe(25)
  })

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
      env: { ...process.env, PORT: String(port), NEXUS_DATA_DIR: directory, NEXUS_STATE_FILE: stateFile, GITHUB_API_URL: githubApiUrl, GITHUB_TOKEN: 'archive-fixture-token', GITHUB_OWNER: '', NEXUS_ROLE: 'Administrator', NEXUS_ALLOW_ROLE_HEADER: 'false', NEXUS_ENABLE_REMOTE_WRITES: 'false', AI_API_KEY: '', AI_BASE_URL: '', AI_MODEL: '' }
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
      env: { ...process.env, PORT: String(port), NEXUS_DATA_DIR: directory, NEXUS_STATE_FILE: stateFile, NEXUS_ROLE: 'Administrator', NEXUS_ALLOW_ROLE_HEADER: 'false', NEXUS_ENABLE_REMOTE_WRITES: 'false', GITHUB_TOKEN: '', AI_API_KEY: '', AI_BASE_URL: '', AI_MODEL: '' },
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
    const sameOrigin = await fetch(`${base}/api/health`, { headers: { Origin: base } })
    expect(sameOrigin.status).toBe(200)
    expect(sameOrigin.headers.get('access-control-allow-origin')).toBe(base)
    const otherLoopbackPort = await fetch(`${base}/api/health`, { headers: { Origin: 'http://127.0.0.1:1' } })
    expect(otherLoopbackPort.status).toBe(403)
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
    const installationToken = `ghs_${'k9.m-R_s'.repeat(65)}`
    const githubApiUrl = await startHttpServer((req, res) => {
      const requestUrl = new URL(req.url, 'http://127.0.0.1')
      const authorization = req.headers.authorization || ''
      expect(authorization === `Bearer ${installationToken}`).toBe(true)
      expect(req.headers['x-github-stateless-s2s-token']).toBeUndefined()
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
      githubInstallations: [{ installationId: '123', accessToken: installationToken, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }],
      githubWebhookEvents: [], updateConfigs: [], auditLogs: [], integrationReports: [], integrationJobs: [], integrationSchedules: []
    }
    await fs.writeFile(stateFile, JSON.stringify(fixture, null, 2), 'utf8')
    const port = await freePort()
    let stderrText = ''
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: root,
      env: { ...process.env, PORT: String(port), NEXUS_DATA_DIR: directory, NEXUS_STATE_FILE: stateFile, GITHUB_API_URL: githubApiUrl, GITHUB_TOKEN: '', NEXUS_ROLE: 'Administrator', NEXUS_ALLOW_ROLE_HEADER: 'false', NEXUS_ENABLE_REMOTE_WRITES: 'true', AI_API_KEY: '', AI_BASE_URL: '', AI_MODEL: '' },
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

  it.each(['stateless-shaped', 'opaque'])('mints, caches and redacts a %s installation token without persisting it', async (shape) => {
    const token = shape === 'stateless-shaped' ? `ghs_123_${'aB9_-'.repeat(110)}.payload.signature` : `opaque.${'bC8_+-'.repeat(100)}.end`
    let mints = 0
    let rejectRequests = false
    const githubApiUrl = await startHttpServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/app/installations/123/access_tokens') {
        mints++
        return res.end(JSON.stringify({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }))
      }
      expect(req.headers.authorization === `Bearer ${token}`).toBe(true)
      expect(req.headers['x-github-stateless-s2s-token']).toBeUndefined()
      if (rejectRequests) {
        res.statusCode = 502
        return res.end(JSON.stringify({ message: `Upstream rejected ${token}; Authorization: Bearer ${token}`, detail: { accessToken: token } }))
      }
      if (req.url?.includes('/actions/workflows')) return res.end('{"workflows":[]}')
      res.statusCode = 404
      res.end('{}')
    })
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-token-format-'))
    directories.push(directory)
    const stateFile = path.join(directory, 'state.json')
    await fs.writeFile(stateFile, JSON.stringify({ schemaVersion: 4, projects: [{ id: 'repo_0', name: 'repo-0', fullName: 'fixture/repo-0', owner: 'fixture', defaultBranch: 'main', stack: [], installationId: '123' }], githubInstallations: [{ installationId: '123' }], settings: { hostingPaused: true } }))
    const port = await freePort()
    let stderrText = ''
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: root,
      env: { ...process.env, PORT: String(port), NEXUS_DATA_DIR: directory, NEXUS_STATE_FILE: stateFile, GITHUB_API_URL: githubApiUrl, GITHUB_TOKEN: '', GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), NEXUS_ROLE: 'Administrator', NEXUS_ALLOW_ROLE_HEADER: 'false', NEXUS_ENABLE_REMOTE_WRITES: 'true', AI_API_KEY: '', AI_BASE_URL: '', AI_MODEL: '' },
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderrText += chunk })
    children.push(child)
    const base = `http://127.0.0.1:${port}`
    await waitForHealth(base, child, () => stderrText)
    expect((await fetch(`${base}/api/projects/repo_0/workflows`)).status).toBe(200)
    expect((await fetch(`${base}/api/projects/repo_0/workflows`)).status).toBe(200)
    expect(mints).toBe(1)
    rejectRequests = true
    for (const [endpoint, method] of [['workflows', 'GET'], ['issues/sync', 'POST']]) {
      const response = await fetch(`${base}/api/projects/repo_0/${endpoint}`, { method })
      const body = await response.text()
      expect(response.status).toBe(502)
      expect(body.includes(token)).toBe(false)
      expect(body.includes(token.slice(-60))).toBe(false)
      expect(body).toContain('[REDACTED]')
    }
    expect((await fetch(`${base}/api/projects/repo_0/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowId: 123 }) })).status).toBe(202)
    let failedTask
    for (let attempt = 0; attempt < 100; attempt++) {
      const { tasks } = await (await fetch(`${base}/api/tasks`)).json()
      failedTask = tasks.find((task) => task.type === 'build' && task.status === 'Failed')
      if (failedTask) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(Boolean(failedTask)).toBe(true)
    expect(JSON.stringify(failedTask).includes(token)).toBe(false)
    for (const name of ['state.json', 'state.json.bak']) {
      const persisted = await fs.readFile(path.join(directory, name), 'utf8')
      expect(persisted.includes(token)).toBe(false)
      expect(persisted.includes('accessToken')).toBe(false)
    }
    expect(stderrText.includes(token)).toBe(false)
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
      env: { ...process.env, PORT: String(port), NEXUS_DATA_DIR: directory, NEXUS_STATE_FILE: stateFile, GITHUB_API_URL: githubApiUrl, GITHUB_TOKEN: '', GITHUB_APP_ID: '123', GITHUB_APP_CLIENT_ID: 'client-id', GITHUB_APP_PRIVATE_KEY: privateKeyPem, GITHUB_APP_SLUG: 'project-nexus', NEXUS_ROLE: 'Administrator', NEXUS_ALLOW_ROLE_HEADER: 'false', NEXUS_ENABLE_REMOTE_WRITES: 'false', AI_API_KEY: '', AI_BASE_URL: '', AI_MODEL: '' },
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
