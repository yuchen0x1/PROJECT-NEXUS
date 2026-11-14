import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexAppServer, resolveCodexCommand, CODEX_SANDBOX_PRESETS } from '../../server/services/agent/codex-app-server.mjs'

// Fake `codex app-server` child process driven by a scripted server side.
function createFakeChild(script) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = new EventEmitter()
  child.stdin = stdin
  child.stdout = stdout
  child.stderr = stderr
  child.killed = false
  child.kill = () => {
    child.killed = true
    queueMicrotask(() => child.emit('close', 0, null))
    return true
  }
  const received = []
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      received.push(message)
      script(message, (response) => stdout.write(`${JSON.stringify(response)}\n`))
    }
  })
  return { child, received, send: (payload) => stdout.write(`${JSON.stringify(payload)}\n`) }
}

function handshakeScript(message, send) {
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'codex-test' } })
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thr_test', modelProvider: 'openai' } } })
  if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' }, requiresOpenaiAuth: true } })
}

function flush(ms = 25) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('codex app-server protocol client', () => {
  it('completes the handshake, starts threads and streams turn notifications', async () => {
    const fake = createFakeChild((message, send) => {
      handshakeScript(message, send)
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn_1', status: 'inProgress', items: [], error: null } } })
        queueMicrotask(() => fake.send({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed', items: [], error: null } } }))
      }
    })
    const client = new CodexAppServer({ launcher: { command: 'codex', args: [] }, spawnImpl: () => fake.child })
    await client.start()
    const thread = await client.threadStart({ cwd: os.tmpdir(), approvalPolicy: 'never', sandbox: 'workspaceWrite' })
    expect(thread.id).toBe('thr_test')
    const turns = []
    client.onNotification('turn/completed', (params) => turns.push(params.turn))
    const started = await client.turnStart({ threadId: thread.id, input: [{ type: 'text', text: 'fix the bug' }] })
    expect(started.turn.status).toBe('inProgress')
    await flush()
    expect(turns).toHaveLength(1)
    expect(turns[0].status).toBe('completed')
    // initialize must precede everything else on the wire.
    expect(fake.received[0].method).toBe('initialize')
    expect(fake.received[1].method).toBe('initialized')
    await client.dispose()
  })

  it('strips account emails before the value can reach logs or records', async () => {
    const fake = createFakeChild((message, send) => handshakeScript(message, send))
    const client = new CodexAppServer({ launcher: { command: 'codex', args: [] }, spawnImpl: () => fake.child })
    await client.start()
    const account = await client.accountRead()
    expect(account.account).toEqual({ type: 'chatgpt', planType: 'pro' })
    expect(JSON.stringify(account)).not.toContain('user@example.com')
    await client.dispose()
  })

  it('answers server-initiated approval requests with an explicit decline', async () => {
    const fake = createFakeChild((message, send) => handshakeScript(message, send))
    const client = new CodexAppServer({ launcher: { command: 'codex', args: [] }, spawnImpl: () => fake.child })
    await client.start()
    client.serverRequestHandler = (message) => {
      if (String(message.method).includes('requestApproval')) return { decision: 'decline' }
      throw new Error('unsupported')
    }
    fake.send({ method: 'item/commandExecution/requestApproval', id: 4242, params: { itemId: 'item_1' } })
    await flush()
    const response = fake.received.find((message) => message.id === 4242)
    expect(response).toEqual({ id: 4242, result: { decision: 'decline' } })
    await client.dispose()
  })

  it('rejects pending requests when the app server exits and times out silent methods', async () => {
    const fake = createFakeChild(() => {}) // never answers anything
    const client = new CodexAppServer({ launcher: { command: 'codex', args: [] }, spawnImpl: () => fake.child, protocolTimeoutMs: 60 })
    await expect(client.start()).rejects.toMatchObject({ code: 'CODEX_RPC_TIMEOUT' })
    await expect(client.threadStart({ cwd: os.tmpdir() })).rejects.toMatchObject({ code: 'CODEX_RPC_TIMEOUT' })
    fake.child.kill()
    await flush(10)
    await expect(client.threadStart({ cwd: os.tmpdir() })).rejects.toMatchObject({ code: 'CODEX_APP_SERVER_CLOSED' })
  })

  it('survives malformed lines without breaking the stream', async () => {
    const fake = createFakeChild((message, send) => handshakeScript(message, send))
    const client = new CodexAppServer({ launcher: { command: 'codex', args: [] }, spawnImpl: () => fake.child })
    // Bypass start(): attach the reader manually and feed broken output.
    client.child = fake.child
    client.exitPromise = new Promise((resolve) => fake.child.once('close', (code) => resolve({ code })))
    client.exitHandler = client.exitPromise
    client.attachStdout(fake.child.stdout)
    fake.child.stdout.write('not-json-at-all\n{"broken":\n')
    await flush(5)
    expect(client.parseErrorCount).toBe(2)
    // The stream still processes a valid response afterwards (model/list is
    // not answered by the script, so the explicit send below resolves it).
    const pending = client.request('model/list')
    await flush(5)
    expect(client.lineCount).toBe(0)
    fake.send({ id: 1, result: { data: [] } })
    await expect(pending).resolves.toMatchObject({ data: [] })
    expect(client.lineCount).toBe(1)
    expect(client.parseErrorCount).toBe(2)
  })

  it('builds workspace-scoped sandbox policies', () => {
    const policy = CODEX_SANDBOX_PRESETS.workspaceWrite(['E:/ws/source'], { networkAccess: false })
    expect(policy).toEqual({ type: 'workspace-write', writableRoots: ['E:/ws/source'], networkAccess: false })
  })

  it('falls back to the alternate sandbox spelling when the server rejects one', async () => {
    const accepted = []
    const fake = createFakeChild((message, send) => {
      if (message.method === 'thread/start') {
        const variant = message.params.sandbox
        accepted.push(variant)
        if (variant === 'workspace-write') {
          send({ id: message.id, error: { code: -32600, message: "Invalid request: unknown variant `workspace-write`, expected one of `read-only`, `workspaceWrite`" } })
        } else {
          send({ id: message.id, result: { thread: { id: 'thr_alt', modelProvider: 'openai' } } })
        }
        return
      }
      handshakeScript(message, send)
    })
    const client = new CodexAppServer({ launcher: { command: 'codex', args: [] }, spawnImpl: () => fake.child })
    await client.start()
    const thread = await client.threadStart({ cwd: os.tmpdir(), approvalPolicy: 'never', sandbox: 'workspace-write' })
    expect(thread.id).toBe('thr_alt')
    expect(accepted).toEqual(['workspace-write', 'workspaceWrite'])
    await client.dispose()
  })
})

describe('resolveCodexCommand', () => {
  it('honors the NEXUS_CODEX_PATH override for real binaries', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-codex-'))
    const binary = path.join(dir, 'codex.exe')
    await fs.writeFile(binary, 'binary', 'utf8')
    const command = await resolveCodexCommand({ env: { NEXUS_CODEX_PATH: binary } })
    expect(command).toMatchObject({ command: binary, args: [] })
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('wraps .cmd shims in an explicit shell command', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-codex-'))
    const shim = path.join(dir, 'codex.cmd')
    await fs.writeFile(shim, '@echo off', 'utf8')
    const command = await resolveCodexCommand({ env: { NEXUS_CODEX_PATH: shim } })
    expect(command.command).toBe(process.env.ComSpec || 'cmd.exe')
    expect(command.windowsVerbatimArguments).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns null when no launcher exists on the PATH', async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-codex-empty-'))
    const command = await resolveCodexCommand({ env: { PATH: emptyDir, Path: emptyDir } })
    expect(command).toBeNull()
    await fs.rm(emptyDir, { recursive: true, force: true })
  })
})
