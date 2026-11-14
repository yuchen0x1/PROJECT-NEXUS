import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import os from 'node:os'

// Local Agent Bridge: official Codex App Server channel (PART 6.1/6.2).
//
// `codex app-server` is OpenAI's supported JSON-RPC-over-stdio interface that
// powers rich Codex clients (VS Code extension, desktop). PROJECT NEXUS uses it
// to run INDEPENDENT agent sessions inside its own isolated workspaces:
//  - the user's existing Codex login is reused (we never read, copy or decrypt
//    ~/.codex/auth.json — auth state comes from the `account/read` method),
//  - each task gets its own thread/turn, so existing Codex Desktop windows and
//    sessions are never taken over,
//  - file writes are sandboxed to the task workspace via `workspaceWrite`
//    writableRoots, and command/file-change approval requests are declined by
//    default (NEXUS runs with approvalPolicy "never").

const PROTOCOL_TIMEOUT_MS = 30_000
const MAX_LINE_BYTES = 8 * 1024 * 1024
const DISPOSE_GRACE_MS = 3_000

const DEFAULT_PATH_EXT = ['.COM', '.EXE', '.BAT', '.CMD']

function bridgeError(code, message) {
  return Object.assign(new Error(message), { code })
}

function envPathDirectories(env = process.env) {
  const raw = env.PATH || env.Path || ''
  return raw.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)
}

async function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    const info = await fsp.stat(candidate).catch(() => null)
    if (info?.isFile()) return candidate
  }
  return null
}

// Resolve the actual codex launcher binary. Windows npm shims are .cmd files
// that cannot be spawned without a shell, so prefer the real platform exe
// shipped inside the @openai/codex package, then a PATH codex.exe, and only
// fall back to the shim with an explicit shell wrapper.
export async function resolveCodexCommand({ env = process.env } = {}) {
  const override = String(env.NEXUS_CODEX_PATH || '').trim()
  if (override) {
    const info = await fsp.stat(override).catch(() => null)
    if (!info?.isFile()) throw bridgeError('CODEX_NOT_DETECTED', `NEXUS_CODEX_PATH does not point to a file: ${override}`)
    if (/\.cmd$/i.test(override)) return shellWrappedCommand(override)
    return { command: override, args: [] }
  }

  const directories = envPathDirectories(env)
  const exeCandidates = []
  const cmdCandidates = []
  for (const directory of directories) {
    // On Windows the extensionless npm `codex` file is a sh shim that cannot
    // be spawned; only the .exe (or the shim-derived platform binary) works.
    if (process.platform === 'win32') {
      exeCandidates.push(path.join(directory, 'codex.exe'))
      cmdCandidates.push(path.join(directory, 'codex.cmd'))
    } else {
      exeCandidates.push(path.join(directory, 'codex'))
    }
  }
  const exe = await firstExistingFile(exeCandidates)
  if (exe) return { command: exe, args: [] }

  // npm global install: codex.cmd sits next to node_modules/@openai/codex and
  // the platform package ships the real binary under vendor/<target>/bin.
  const shim = await firstExistingFile(cmdCandidates)
  if (shim) {
    const packageRoot = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex')
    const platformExe = await findPlatformBinary(packageRoot)
    if (platformExe) return { command: platformExe, args: [] }
    const jsEntry = await firstExistingFile([path.join(packageRoot, 'bin', 'codex.js')])
    if (jsEntry) return { command: process.execPath, args: [jsEntry], env: { ELECTRON_RUN_AS_NODE: '1' } }
    return shellWrappedCommand(shim)
  }

  // Winget/other installs commonly expose codex.exe through PATH which the
  // checks above already cover; ~/.codex/bin is a last-resort convention.
  const localBin = await firstExistingFile([path.join(os.homedir(), '.codex', 'bin', `codex${process.platform === 'win32' ? '.exe' : ''}`)])
  if (localBin) return { command: localBin, args: [] }
  return null
}

async function findPlatformBinary(packageRoot) {
  const vendorRoot = path.join(packageRoot, 'node_modules', '@openai')
  let platformDirs = []
  try { platformDirs = await fsp.readdir(vendorRoot) } catch { return null }
  for (const platformPackage of platformDirs) {
    if (!platformPackage.startsWith('codex-')) continue
    const vendorBin = path.join(vendorRoot, platformPackage, 'vendor')
    let targets = []
    try { targets = await fsp.readdir(vendorBin) } catch { continue }
    for (const target of targets) {
      const binary = path.join(vendorBin, target, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
      const info = await fsp.stat(binary).catch(() => null)
      if (info?.isFile()) return binary
    }
  }
  return null
}

function shellWrappedCommand(cmdPath) {
  if (process.platform !== 'win32') return { command: cmdPath, args: [] }
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${cmdPath}"`],
    shellQuoted: true,
    windowsVerbatimArguments: true
  }
}

// Detection only reports what is on disk plus the launcher version. It never
// inspects authentication material: account state is queried from the running
// app server itself (see CodexAppServer.accountRead).
export async function detectCodexInstall({ env = process.env, timeoutMs = 12_000 } = {}) {
  let command
  try {
    command = await resolveCodexCommand({ env })
  } catch (error) {
    return { installed: false, channel: 'codex-app-server', error: String(error.message || error).slice(0, 300) }
  }
  if (!command) return { installed: false, channel: 'codex-app-server' }
  const version = await runVersionProbe(command, timeoutMs).catch(() => null)
  return {
    installed: true,
    channel: 'codex-app-server',
    version,
    launcher: { command: command.command, args: command.args || [] },
    configDir: path.join(os.homedir(), '.codex')
  }
}

async function runVersionProbe(command, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const child = nodeSpawn(command.command, [...(command.args || []), '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
    })
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(bridgeError('CODEX_PROBE_TIMEOUT', 'codex --version did not answer in time.'))
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.on('error', (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) reject(bridgeError('CODEX_PROBE_FAILED', `codex --version exited with ${code}.`))
      else resolve(String(stdout).trim().split(/\r?\n/)[0]?.trim() || null)
    })
  })
}

// JSON-RPC-over-stdio client for `codex app-server`. One instance per task.
export class CodexAppServer {
  constructor({ launcher, env = process.env, spawnImpl = nodeSpawn, protocolTimeoutMs = PROTOCOL_TIMEOUT_MS, stderrLimit = 20_000 } = {}) {
    if (!launcher?.command) throw bridgeError('CODEX_NOT_DETECTED', 'A codex launcher is required to start the app server.')
    this.launcher = launcher
    this.env = env
    this.spawnImpl = spawnImpl
    this.protocolTimeoutMs = protocolTimeoutMs
    this.stderrLimit = stderrLimit
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.notificationHandlers = new Map()
    this.serverRequestHandler = null
    this.closed = false
    this.stderrTail = ''
    this.exitPromise = null
    this.lineCount = 0
    this.parseErrorCount = 0
  }

  async start({ timeoutMs = this.protocolTimeoutMs } = {}) {
    const extraEnv = this.launcher.env ? { ...this.launcher.env } : null
    const child = this.spawnImpl(this.launcher.command, [...(this.launcher.args || []), 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: extraEnv ? { ...this.env, ...extraEnv } : this.env,
      ...(this.launcher.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      ...(this.launcher.shellQuoted && process.platform !== 'win32' ? { shell: true } : {})
    })
    this.child = child
    this.exitPromise = new Promise((resolve) => { child.once('close', (code, signalArg) => resolve({ code, signal: signalArg })) })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-this.stderrLimit)
    })
    const stdout = child.stdout
    if (!stdout) throw bridgeError('CODEX_APP_SERVER_NO_STDOUT', 'The app server did not expose stdout.')
    this.attachStdout(stdout)

    const exitHandler = this.exitPromise.then(({ code }) => {
      this.closed = true
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(bridgeError('CODEX_APP_SERVER_CLOSED', `The app server exited (code ${code ?? 'null'}) while handling request ${id}.`))
      }
      this.pending.clear()
    })
    this.exitHandler = exitHandler
    // A spawn failure (bad launcher, missing binary) emits 'error' without a
    // 'close' in some cases; it must never crash the process unhandled.
    child.on('error', (error) => {
      this.closed = true
      const wrapped = bridgeError('CODEX_APP_SERVER_SPAWN_FAILED', `Failed to start the Codex app server: ${error.message}`)
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(wrapped)
      }
      this.pending.clear()
    })

    await this.request('initialize', {
      clientInfo: { name: 'project-nexus', title: 'PROJECT NEXUS', version: '0.8.7' }
    }, { timeoutMs })
    this.notify('initialized', {})
    return this
  }

  attachStdout(stdout) {
    stdout.setEncoding('utf8')
    const lines = readline.createInterface({ input: stdout, terminal: false })
    lines.on('line', (line) => this.handleLine(line))
  }

  handleLine(line) {
    if (this.closed) return
    if (!line || !line.trim()) return
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      this.parseErrorCount += 1
      return
    }
    let message
    try { message = JSON.parse(line) } catch {
      this.parseErrorCount += 1
      return
    }
    this.lineCount += 1
    if (typeof message?.id === 'number' && (message.result !== undefined || message.error !== undefined) && message.method === undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(bridgeError(`CODEX_RPC_${message.error.code ?? 'ERROR'}`, String(message.error.message || 'App server request failed.')))
      else entry.resolve(message.result)
      return
    }
    if (typeof message?.method !== 'string') return
    // Server-initiated requests (approvals, token refresh) carry an id and
    // expect a response; notifications do not.
    if (typeof message.id === 'number' && typeof this.serverRequestHandler === 'function') {
      void Promise.resolve(this.serverRequestHandler(message))
        .then((result) => this.respond(message.id, result ?? { decision: 'decline' }))
        .catch(() => this.respondError(message.id, -32603, 'PROJECT NEXUS could not handle the request.'))
      return
    }
    const handlers = this.notificationHandlers.get(message.method)
    if (handlers) for (const handler of handlers) {
      try { handler(message.params ?? {}) } catch { /* a bad handler must not break the stream */ }
    }
  }

  respond(id, result) {
    this.send({ id, result })
  }

  respondError(id, code, message) {
    this.send({ id, error: { code, message } })
  }

  send(payload) {
    if (!this.child?.stdin?.writable || this.closed) return false
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`)
      return true
    } catch { return false }
  }

  request(method, params = {}, { timeoutMs = this.protocolTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(bridgeError('CODEX_APP_SERVER_CLOSED', 'The app server connection is closed.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(bridgeError('CODEX_RPC_TIMEOUT', `The app server did not answer ${method} within ${timeoutMs} ms.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      if (!this.send({ method, params, id })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(bridgeError('CODEX_APP_SERVER_CLOSED', 'The app server stdin is no longer writable.'))
      }
    })
  }

  notify(method, params = {}) {
    this.send({ method, params })
  }

  onNotification(method, handler) {
    const list = this.notificationHandlers.get(method) || []
    list.push(handler)
    this.notificationHandlers.set(method, list)
    return () => {
      const current = this.notificationHandlers.get(method) || []
      this.notificationHandlers.set(method, current.filter((entry) => entry !== handler))
    }
  }

  // Auth/account surface: reads the live account state from the running app
  // server. The result never contains tokens; we additionally drop the email
  // before the value can reach logs or task records.
  async accountRead({ refreshToken = false } = {}) {
    const result = await this.request('account/read', { refreshToken })
    const account = result?.account || null
    if (account && typeof account === 'object') {
      const { email, ...rest } = account
      return { account: Object.keys(rest).length ? rest : { type: account.type }, requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth) }
    }
    return { account: null, requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth) }
  }

  async modelList({ limit = 20 } = {}) {
    const result = await this.request('model/list', { limit })
    return Array.isArray(result?.data) ? result.data : []
  }

  async threadStart({ cwd, approvalPolicy = 'never', sandbox = 'workspace-write', model = undefined } = {}) {
    const attempt = async (sandboxValue) => {
      const params = { cwd, approvalPolicy, sandbox: sandboxValue }
      if (model) params.model = model
      return await this.request('thread/start', params)
    }
    let result
    try {
      result = await attempt(sandbox)
    } catch (error) {
      // Codex builds renamed the sandbox variants (camelCase vs kebab-case);
      // retry once with the alternate spelling before giving up.
      const alternate = alternateSandboxType(String(sandbox))
      if (!alternate || !/unknown variant|Invalid request/i.test(String(error.message))) throw error
      result = await attempt(alternate)
    }
    return result?.thread || null
  }

  async turnStart({ threadId, input, sandboxPolicy = undefined, approvalPolicy = undefined, cwd = undefined, effort = undefined }) {
    const attempt = async (policy) => {
      const params = { threadId, input }
      if (policy) params.sandboxPolicy = policy
      if (approvalPolicy) params.approvalPolicy = approvalPolicy
      if (cwd) params.cwd = cwd
      if (effort) params.effort = effort
      return await this.request('turn/start', params, { timeoutMs: this.protocolTimeoutMs })
    }
    try {
      return await attempt(sandboxPolicy)
    } catch (error) {
      if (!sandboxPolicy?.type || !/unknown variant|Invalid request/i.test(String(error.message))) throw error
      const alternate = alternateSandboxType(String(sandboxPolicy.type))
      if (!alternate) throw error
      return await attempt({ ...sandboxPolicy, type: alternate })
    }
  }

  async turnInterrupt(threadId, turnId) {
    try {
      await this.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 10_000 })
      return true
    } catch { return false }
  }

  async waitExit() {
    return this.exitPromise || Promise.resolve({ code: null, signal: null })
  }

  async dispose({ graceMs = DISPOSE_GRACE_MS } = {}) {
    this.closed = true
    const child = this.child
    if (!child) return
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(bridgeError('CODEX_APP_SERVER_CLOSED', 'The app server connection was closed by PROJECT NEXUS.'))
    }
    this.pending.clear()
    try { child.stdin?.end() } catch { /* already gone */ }
    if (!child.killed) child.kill()
    const exited = await Promise.race([
      this.exitPromise?.catch(() => ({})) || Promise.resolve({}),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), graceMs))
    ])
    if (exited?.timedOut && !child.killed) child.kill('SIGKILL')
  }

  diagnostics() {
    return {
      lineCount: this.lineCount,
      parseErrorCount: this.parseErrorCount,
      stderrTail: this.stderrTail.slice(-2_000)
    }
  }
}

// Convenience: capability probe used by the status endpoint and the first-run
// test in the UI. Starts the server, checks auth and models, then shuts down.
export async function probeCodexBridge({ launcher, env = process.env, timeoutMs = PROTOCOL_TIMEOUT_MS } = {}) {
  const client = new CodexAppServer({ launcher, env, protocolTimeoutMs: timeoutMs })
  const started = Date.now()
  try {
    await client.start({ timeoutMs })
    const account = await client.accountRead()
    let models = []
    try { models = (await client.modelList({ limit: 5 })).map((model) => model?.id).filter(Boolean).slice(0, 5) } catch { models = [] }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      authMode: account.account?.type || null,
      requiresOpenaiAuth: account.requiresOpenaiAuth,
      signedIn: Boolean(account.account) || account.requiresOpenaiAuth === false,
      models,
      diagnostics: client.diagnostics()
    }
  } finally {
    await client.dispose().catch(() => {})
  }
}

// Sandbox variant names drifted across Codex builds (camelCase in early docs,
// kebab-case in the current CLI). Map one to the other for one-shot retries.
const SANDBOX_TYPE_ALIASES = Object.freeze({
  'workspace-write': ['workspace-write', 'workspaceWrite'],
  'read-only': ['read-only', 'readOnly'],
  'danger-full-access': ['danger-full-access', 'dangerFullAccess']
})

function alternateSandboxType(type) {
  const entry = Object.entries(SANDBOX_TYPE_ALIASES).find(([, variants]) => variants.includes(type))
  if (!entry) return null
  return entry[1].find((variant) => variant !== type) || null
}

export const CODEX_SANDBOX_PRESETS = Object.freeze({
  workspaceWrite: (writableRoots, { networkAccess = true } = {}) => ({
    type: 'workspace-write',
    writableRoots: Array.isArray(writableRoots) ? writableRoots : [writableRoots],
    networkAccess: Boolean(networkAccess)
  })
})

export function codexConfiguredDirExists(configDir = path.join(os.homedir(), '.codex')) {
  try { return fs.existsSync(configDir) } catch { return false }
}
