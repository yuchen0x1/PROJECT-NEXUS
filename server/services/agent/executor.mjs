import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

// Bounded local command execution for agent tasks.
// Commands are tokenized and spawned without a shell wherever possible.
// Windows .cmd/.bat shims (npm, pnpm, npx…) are routed through cmd.exe with
// fully quoted, metacharacter-free arguments — the only concession needed to
// run Node toolchain launchers, with injection characters rejected up front.
// The child environment strips credential-bearing variables so a command can
// never exfiltrate host secrets into model-visible output.

export const DEFAULT_ALLOWED_PROGRAMS = Object.freeze([
  'node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'deno', 'tsc', 'tsx', 'vite', 'eslint',
  'prettier', 'jest', 'vitest', 'mocha', 'playwright', 'next', 'webpack', 'rollup', 'esbuild',
  'python', 'python3', 'pip', 'pip3', 'pytest', 'ruff', 'mypy', 'black', 'uvicorn',
  'git', 'cargo', 'rustc', 'rustup', 'dotnet', 'dotnet-build', 'go', 'gofmt', 'golangci-lint',
  'java', 'javac', 'mvn', 'gradle', 'make', 'cmake', 'g++', 'gcc', 'clang',
  'ruff-format', 'poetry', 'uv', 'hatch', 'tox', 'blackd'
])

export const EXECUTOR_DEFAULTS = Object.freeze({
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  outputLimitBytes: 256 * 1024,
  maxBufferPerChunk: 64 * 1024
})

// Credential-bearing environment variables are never passed to agent commands.
const envDenyPatterns = [
  /^(?:GITHUB|GH|GITEE|HUGGINGFACE|OPENAI|ANTHROPIC|GEMINI|GOOGLE|AWS|AZURE|GCP|GOOGLE_APPLICATION)_/i,
  /^(?:NEXUS_LOCAL_API_TOKEN|NEXUS_AI_PROVIDERS_JSON|NEXUS_AI_ROUTING_JSON|AI_API_KEY|AI_BASE_URL|AI_MODEL|GITHUB_APP_PRIVATE_KEY)$/i,
  /^ZCODE_/i,
  /(?:API_KEY|ACCESS_TOKEN|SECRET|PRIVATE_KEY|PASSWORD|PASSWD|CREDENTIALS?)$/i
]

const cmdMetacharacters = /[&|<>^%$`"'\r\n\u0000]/

function executorError(code, message) {
  return Object.assign(new Error(message), { code })
}

function tokenizeCommand(command) {
  if (typeof command !== 'string' || !command.trim()) throw executorError('COMMAND_EMPTY', 'A command string is required.')
  if (command.length > 4_096) throw executorError('COMMAND_TOO_LONG', 'Commands are limited to 4096 characters.')
  if (/[\r\n\u0000]/.test(command)) throw executorError('COMMAND_INVALID', 'Multi-line commands are not supported; run one command per tool call.')
  const tokens = []
  let current = ''
  let quote = null
  let hasToken = false
  for (const character of command) {
    if (quote) {
      if (character === quote) { quote = null; continue }
      current += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; hasToken = true; continue }
    if (/\s/.test(character)) {
      if (hasToken) { tokens.push(current); current = ''; hasToken = false }
      continue
    }
    current += character
    hasToken = true
  }
  if (quote) throw executorError('COMMAND_INVALID', 'Unterminated quote in command.')
  if (hasToken) tokens.push(current)
  if (!tokens.length) throw executorError('COMMAND_EMPTY', 'A command string is required.')
  if (tokens.some((token) => cmdMetacharacters.test(token))) {
    throw executorError('COMMAND_METACHARACTER', 'Command arguments must not contain shell metacharacters (& | < > ^ % quotes or newlines); quote or escape the argument differently.')
  }
  return tokens
}

function commandBaseName(token) {
  return path.win32.basename(token.replace(/\//g, '\\')).replace(/\.(exe|com|cmd|bat)$/i, '').toLowerCase()
}

async function findWindowsExecutable(program) {
  if (/[\\/]/.test(program)) {
    // Absolute or relative path: resolve against the working directory only.
    const resolved = path.resolve(program)
    return resolved
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const pathDirectories = [
    ...(process.env.PATH || '').split(';').filter(Boolean),
    path.join(systemRoot, 'System32'),
    path.join(systemRoot)
  ]
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const directory of pathDirectories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, program.endsWith(extension.toLowerCase()) || /\.[a-z]+$/i.test(program) && extension.toLowerCase() === path.extname(program).toLowerCase() ? program : program + extension)
      try {
        const info = await fs.stat(candidate)
        if (info.isFile()) return candidate
      } catch { /* keep searching */ }
    }
  }
  return null
}

function buildChildEnv() {
  const childEnv = {}
  const allowPrefixes = ['APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'COMSPEC', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'WINDIR', 'COMMONPROGRAMFILES', 'PROCESSOR', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'HOME', 'LANG', 'LC_', 'TERM', 'NODE_']
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (envDenyPatterns.some((pattern) => pattern.test(upper))) continue
    if (allowPrefixes.some((prefix) => upper.startsWith(prefix))) childEnv[key] = value
  }
  childEnv.NEXUS_AGENT_SANDBOX = '1'
  childEnv.NO_COLOR = '1'
  childEnv.CI = '1'
  if (process.platform === 'win32' && !childEnv.ComSpec) childEnv.ComSpec = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  return childEnv
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
  } else {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

export function isProgramAllowed(command, allowedPrograms = DEFAULT_ALLOWED_PROGRAMS) {
  const tokens = tokenizeCommand(command)
  const base = commandBaseName(tokens[0])
  return allowedPrograms.map((program) => program.toLowerCase()).includes(base)
}

export async function runCommand({ cwd, command, timeoutMs = EXECUTOR_DEFAULTS.timeoutMs, outputLimitBytes = EXECUTOR_DEFAULTS.outputLimitBytes, signal = null, allowedPrograms = DEFAULT_ALLOWED_PROGRAMS } = {}) {
  if (!cwd || !path.isAbsolute(cwd)) throw executorError('COMMAND_CWD_INVALID', 'Command execution requires an absolute working directory inside the task workspace.')
  const info = await fs.stat(cwd).catch(() => null)
  if (!info?.isDirectory()) throw executorError('COMMAND_CWD_MISSING', `The working directory does not exist: ${cwd}`)

  const tokens = tokenizeCommand(command)
  const program = tokens[0]
  const args = tokens.slice(1)
  const base = commandBaseName(program)
  const allowed = allowedPrograms.map((item) => item.toLowerCase()).includes(base)
  const effectiveTimeout = Math.min(EXECUTOR_DEFAULTS.maxTimeoutMs, Math.max(1_000, Number(timeoutMs) || EXECUTOR_DEFAULTS.timeoutMs))
  const childEnv = buildChildEnv()

  let file = program
  let spawnArgs = args
  let usedShellWrapper = false
  if (process.platform === 'win32') {
    const resolved = await findWindowsExecutable(program)
    if (!resolved) throw executorError('COMMAND_NOT_FOUND', `Executable "${program}" was not found on PATH.`)
    const extension = path.extname(resolved).toLowerCase()
    if (extension === '.cmd' || extension === '.bat') {
      // Node refuses to spawn .cmd/.bat directly (CVE mitigation). Route the
      // fully tokenized, metacharacter-free command through cmd.exe instead.
      // cmd's /S quote handling strips the outer quote pair, so the entire
      // command line is wrapped in one extra pair: /c ""C:\path with spaces\npm.cmd" args".
      const comspec = childEnv.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
      const quoted = [resolved, ...args].map((token) => /[ \t]/.test(token) ? `"${token}"` : token).join(' ')
      file = comspec
      spawnArgs = ['/d', '/s', '/c', `"${quoted}"`]
      usedShellWrapper = true
    } else {
      file = resolved
    }
  }

  return await new Promise((resolve) => {
    let child
    try {
      child = spawn(file, spawnArgs, {
        cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: usedShellWrapper,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve({ ok: false, exitCode: null, signal: null, timedOut: false, truncated: false, stdout: '', stderr: String(error.message).slice(0, 4_000), durationMs: 0, program: base, allowed, command })
      return
    }

    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let stdoutBytes = 0
    let stderrBytes = 0

    const appendOutput = (channel, chunk) => {
      const target = channel === 'stdout' ? () => { stdout += chunk; stdoutBytes += Buffer.byteLength(chunk) } : () => { stderr += chunk; stderrBytes += Buffer.byteLength(chunk) }
      const currentBytes = channel === 'stdout' ? stdoutBytes : stderrBytes
      if (currentBytes + Buffer.byteLength(chunk) > outputLimitBytes) {
        const remaining = Math.max(0, outputLimitBytes - currentBytes)
        if (remaining > 0) target()
        truncated = true
        killProcessTree(child)
        return
      }
      target()
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => appendOutput('stdout', chunk))
    child.stderr.on('data', (chunk) => appendOutput('stderr', chunk))

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, effectiveTimeout)

    const onAbort = () => killProcessTree(child)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = (exitCode, signalName) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({
        ok: !timedOut && !signal?.aborted && exitCode === 0,
        exitCode,
        signal: signalName || null,
        timedOut,
        cancelled: Boolean(signal?.aborted),
        truncated,
        stdout: stdout.slice(0, outputLimitBytes),
        stderr: stderr.slice(0, outputLimitBytes),
        stdoutBytes,
        stderrBytes,
        durationMs: Date.now() - started,
        program: base,
        allowed,
        command
      })
    }

    child.on('error', (error) => {
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({
        ok: false, exitCode: null, signal: null, timedOut, cancelled: Boolean(signal?.aborted), truncated,
        stdout: stdout.slice(0, outputLimitBytes),
        stderr: `${stderr}\n${String(error.message)}`.trim().slice(0, outputLimitBytes),
        stdoutBytes, stderrBytes,
        durationMs: Date.now() - started,
        program: base, allowed, command
      })
    })
    child.on('close', finish)
  })
}
