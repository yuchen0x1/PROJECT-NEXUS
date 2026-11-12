import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { registerLocalProject } from '../../server/services/local-projects.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const children = []
const directories = []
const servers = []

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

async function startHttpServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

async function stopChild(child) {
  const index = children.indexOf(child)
  if (index >= 0) children.splice(index, 1)
  if (child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await exited
}

async function startNexusServer({ dataDir, stateFile, providerUrl, token }) {
  const port = await freePort()
  let stderrText = ''
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NEXUS_HOST: '127.0.0.1',
      NEXUS_DESKTOP_MODE: 'true',
      NEXUS_LOCAL_API_TOKEN: token,
      NEXUS_DATA_DIR: dataDir,
      NEXUS_STATE_FILE: stateFile,
      NEXUS_AGENT_WORKSPACE_ROOT: path.join(dataDir, 'agent-workspaces'),
      NEXUS_CORS_ORIGINS: '',
      NEXUS_ROLE: 'Administrator',
      NEXUS_ALLOW_ROLE_HEADER: 'false',
      NEXUS_ENABLE_REMOTE_WRITES: 'false',
      AI_PROVIDER_KIND: 'openai-compatible',
      AI_BASE_URL: providerUrl,
      AI_API_KEY: 'fixture-provider-key',
      AI_MODEL: 'fixture-model',
      AI_REQUEST_TIMEOUT_MS: '5000',
      AI_MAX_RETRIES: '0',
      GITHUB_TOKEN: ''
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderrText += chunk })
  children.push(child)
  const base = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`NEXUS server exited early: ${stderrText}`)
    try {
      const response = await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${token}` } })
      if (response.ok) return { child, base }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`NEXUS server did not become healthy: ${stderrText}`)
}

async function getJson(base, token, endpoint) {
  const response = await fetch(`${base}${endpoint}`, { headers: { Authorization: `Bearer ${token}` } })
  return { response, body: await response.json() }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stopChild(child)))
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('authenticated local Agent API', () => {
  it('generates a multi-file proposal in a registered project copy, preserves the source, persists it, and recovers interrupted work', async () => {
    let providerRequest = null
    const providerUrl = await startHttpServer((req, res) => {
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        expect(req.url).toBe('/v1/chat/completions')
        expect(req.headers.authorization).toBe('Bearer fixture-provider-key')
        providerRequest = JSON.parse(raw)
        const result = {
          operations: [
            { action: 'replace', path: 'src/index.js', content: 'export const value = 2\n' },
            { action: 'create', path: 'src/added.js', content: 'export const added = true\n' }
          ],
          rationale: 'Update the exported value and add a small module.'
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(result) } }],
          usage: { prompt_tokens: 90, completion_tokens: 34, total_tokens: 124 }
        }))
      })
    })

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-agent-data-'))
    directories.push(dataDir)
    const projectPath = path.join(dataDir, '测试项目 工作区')
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
    await fs.writeFile(path.join(projectPath, 'README.md'), '# Fixture project\n', 'utf8')
    await fs.writeFile(path.join(projectPath, '.gitignore'), 'ignored.txt\n', 'utf8')
    await fs.writeFile(path.join(projectPath, 'ignored.txt'), 'ignored by project rules\n', 'utf8')
    await fs.writeFile(path.join(projectPath, '.env'), 'API_KEY=must-not-leave-the-workstation\n', 'utf8')
    const originalSource = 'export const value = 1\n'
    await fs.writeFile(path.join(projectPath, 'src/index.js'), originalSource, 'utf8')
    const { project } = await registerLocalProject({ dataDir, folderPath: projectPath })
    const stateFile = path.join(dataDir, 'state.json')
    const token = 'fixture-local-session-token'
    let service = await startNexusServer({ dataDir, stateFile, providerUrl, token })

    const unauthenticated = await fetch(`${service.base}/api/local-agent/config`)
    expect(unauthenticated.status).toBe(401)

    const config = await getJson(service.base, token, '/api/local-agent/config')
    expect(config.response.status).toBe(200)
    expect(config.body.configured).toBe(true)
    expect(config.body.capabilities).toMatchObject({ originalProjectWrites: false, commandExecution: false, buildAndTest: false, gitApply: false })

    const missingDisclosure = await fetch(`${service.base}/api/local-agent/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: 'Change the exported value.', confirmSourceDisclosure: false })
    })
    expect(missingDisclosure.status).toBe(400)

    const created = await fetch(`${service.base}/api/local-agent/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: 'Change the exported value and add one module.', providerId: 'default', confirmSourceDisclosure: true })
    })
    expect(created.status).toBe(202)
    const { task: queued } = await created.json()

    let result = null
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const polled = await getJson(service.base, token, `/api/local-agent/tasks/${encodeURIComponent(queued.id)}`)
      expect(polled.response.status).toBe(200)
      result = polled.body
      if (!['Queued', 'Running'].includes(result.task.status)) break
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    expect(result?.task.status).toBe('Succeeded')
    expect(result.task.changedFiles).toEqual(['src/index.js', 'src/added.js'])
    expect(result.task.disclosedPaths).not.toContain('.env')
    expect(result.task.disclosedPaths).not.toContain('ignored.txt')
    expect(result.task.provider).toMatchObject({ id: 'default', model: 'fixture-model' })
    expect(result.task.usage.totalTokens).toBe(124)
    expect(result.changes.map((change) => `${change.action}:${change.path}`)).toEqual(['added:src/added.js', 'modified:src/index.js'])
    expect(result.changes.find((change) => change.path === 'src/index.js').before).toBe(originalSource)
    expect(result.changes.find((change) => change.path === 'src/index.js').after).toBe('export const value = 2\n')
    expect(JSON.parse(providerRequest.messages[1].content).prompt).toContain('Change the exported value')
    expect(JSON.stringify(providerRequest.messages)).not.toContain('must-not-leave-the-workstation')
    expect(JSON.stringify(providerRequest.messages)).not.toContain('ignored by project rules')

    expect(await fs.readFile(path.join(projectPath, 'src/index.js'), 'utf8')).toBe(originalSource)
    await expect(fs.access(path.join(projectPath, 'src/added.js'))).rejects.toMatchObject({ code: 'ENOENT' })
    const registryTasks = JSON.parse(await fs.readFile(path.join(dataDir, 'local-agent-tasks.json'), 'utf8'))
    expect(registryTasks.tasks[0].status).toBe('Succeeded')
    expect(JSON.stringify(registryTasks.tasks[0])).not.toContain(originalSource)

    await stopChild(service.child)
    const taskStorePath = path.join(dataDir, 'local-agent-tasks.json')
    const taskStore = JSON.parse(await fs.readFile(taskStorePath, 'utf8'))
    taskStore.tasks[0].status = 'Running'
    await fs.writeFile(taskStorePath, JSON.stringify(taskStore, null, 2), 'utf8')
    service = await startNexusServer({ dataDir, stateFile, providerUrl, token })
    const recovered = await getJson(service.base, token, '/api/local-agent/tasks')
    expect(recovered.response.status).toBe(200)
    expect(recovered.body.tasks[0].status).toBe('Interrupted')
    expect(recovered.body.tasks[0].error).toContain('running when the application stopped')
    expect(await fs.readFile(path.join(projectPath, 'src/index.js'), 'utf8')).toBe(originalSource)
  })
})
