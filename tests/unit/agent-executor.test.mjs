import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_ALLOWED_PROGRAMS, isProgramAllowed, runCommand } from '../../server/services/agent/executor.mjs'

let root

beforeEachHelper()

async function beforeEachHelper() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-exec-'))
  await fs.writeFile(path.join(root, 'echo.js'), 'process.stdout.write(process.argv.slice(2).join(" "))\n', 'utf8')
}

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-exec-'))
})

describe('agent command executor', () => {
  it('runs an allowlisted command and captures output and exit code', async () => {
    const result = await runCommand({ cwd: root, command: `node "${path.join(root, 'echo.js')}" hello agent`, timeoutMs: 15_000 })
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hello agent')
    expect(result.program).toBe('node')
    expect(result.allowed).toBe(true)
  }, 30_000)

  it('rejects shell metacharacters and command chaining before spawning', async () => {
    await expect(runCommand({ cwd: root, command: 'node foo & whoami' })).rejects.toMatchObject({ code: 'COMMAND_METACHARACTER' })
    await expect(runCommand({ cwd: root, command: 'node foo | cat' })).rejects.toMatchObject({ code: 'COMMAND_METACHARACTER' })
    await expect(runCommand({ cwd: root, command: 'node "$(whoami)"' })).rejects.toMatchObject({ code: 'COMMAND_METACHARACTER' })
    await expect(runCommand({ cwd: root, command: 'node foo\nnode bar' })).rejects.toMatchObject({ code: 'COMMAND_INVALID' })
    await expect(runCommand({ cwd: root, command: '' })).rejects.toMatchObject({ code: 'COMMAND_EMPTY' })
    await expect(runCommand({ cwd: root, command: 'node "unterminated' })).rejects.toMatchObject({ code: 'COMMAND_INVALID' })
  })

  it('refuses missing working directories and unknown executables', async () => {
    await expect(runCommand({ cwd: 'relative/path', command: 'node -v' })).rejects.toMatchObject({ code: 'COMMAND_CWD_INVALID' })
    await expect(runCommand({ cwd: root, command: 'definitely-not-a-real-program-xyz --version' })).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
    await expect(runCommand({ cwd: path.join(root, 'nope'), command: 'node -v' })).rejects.toMatchObject({ code: 'COMMAND_CWD_MISSING' })
  })

  it('enforces timeouts by killing the process tree', async () => {
    const script = path.join(root, 'sleep.js')
    await fs.writeFile(script, 'setTimeout(() => process.exit(0), 30000)\nsetInterval(() => console.log("tick"), 100)\n', 'utf8')
    const result = await runCommand({ cwd: root, command: `node "${script}"`, timeoutMs: 2_000 })
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.durationMs).toBeLessThan(10_000)
  }, 30_000)

  it('supports cancellation through an abort signal', async () => {
    const script = path.join(root, 'sleep2.js')
    await fs.writeFile(script, 'setTimeout(() => process.exit(0), 30000)\n', 'utf8')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 500)
    const result = await runCommand({ cwd: root, command: `node "${script}"`, timeoutMs: 20_000, signal: controller.signal })
    expect(result.cancelled).toBe(true)
    expect(result.ok).toBe(false)
  }, 30_000)

  it('truncates oversized output at the byte limit', async () => {
    const script = path.join(root, 'flood.js')
    await fs.writeFile(script, 'process.stdout.write("x".repeat(1024 * 1024))\n', 'utf8')
    const result = await runCommand({ cwd: root, command: `node "${script}"`, timeoutMs: 20_000, outputLimitBytes: 64 * 1024 })
    expect(result.truncated).toBe(true)
    expect(result.stdoutBytes).toBeLessThanOrEqual(64 * 1024 + 4096)
  }, 30_000)

  it('strips credential-bearing environment variables from the child environment', async () => {
    process.env.NEXUS_LOCAL_API_TOKEN = 'secret-session-token'
    process.env.GITHUB_TOKEN = 'ghp_secretvalue123456'
    process.env.AI_API_KEY = 'sk-secretvalue123456'
    process.env.ZCODE_SESSION_ID = 'sess-x'
    const script = path.join(root, 'envdump.js')
    await fs.writeFile(script, 'console.log(JSON.stringify(Object.keys(process.env).filter((k) => /TOKEN|API_KEY|ZCODE|NEXUS_LOCAL/.test(k.toUpperCase()))))\n', 'utf8')
    const result = await runCommand({ cwd: root, command: `node "${script}"`, timeoutMs: 15_000 })
    const leaked = JSON.parse(result.stdout.trim() || '[]')
    expect(leaked).toEqual([])
    delete process.env.NEXUS_LOCAL_API_TOKEN
    delete process.env.GITHUB_TOKEN
    delete process.env.AI_API_KEY
    delete process.env.ZCODE_SESSION_ID
  }, 30_000)

  it('classifies allowlisted and unlisted programs', () => {
    expect(isProgramAllowed('npm test')).toBe(true)
    expect(isProgramAllowed('npm run build -- --watch')).toBe(true)
    expect(isProgramAllowed('"C:\\Program Files\\nodejs\\npm.cmd" test')).toBe(true)
    expect(isProgramAllowed('pytest -q')).toBe(true)
    expect(isProgramAllowed('python -m pytest')).toBe(true)
    expect(isProgramAllowed('curl https://example.com')).toBe(false)
    expect(isProgramAllowed('regedit')).toBe(false)
    expect(isProgramAllowed('powershell -Command "x"')).toBe(false)
    expect(DEFAULT_ALLOWED_PROGRAMS).toContain('git')
  })

  it('reports non-zero exit codes as failures with stderr', async () => {
    const script = path.join(root, 'fail.js')
    await fs.writeFile(script, 'console.error("boom");process.exit(2)\n', 'utf8')
    const result = await runCommand({ cwd: root, command: `node "${script}"`, timeoutMs: 15_000 })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('boom')
  }, 30_000)
})
