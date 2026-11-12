import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const children = []
const servers = []
const directories = []

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

export async function startHttpServer(handler) {
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

export async function startNexusServer({ dataDir, stateFile, providerUrl, token, extraEnv = {} }) {
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
      GITHUB_TOKEN: '',
      ...extraEnv
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

export function trackChild(child) {
  children.push(child)
  return child
}

export async function cleanupTestEnvironment() {
  await Promise.all(children.splice(0).map((child) => stopChild(child)))
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
}

export async function tempDataDir(prefix = 'nexus-data-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  directories.push(dir)
  return dir
}

export async function getJson(base, token, endpoint) {
  const response = await fetch(`${base}${endpoint}`, { headers: { Authorization: `Bearer ${token}` } })
  return { response, body: await response.json().catch(() => ({})) }
}
