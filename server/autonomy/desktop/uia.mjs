// Node-side bridge to the Windows UI Automation driver.
//
// Honesty rule: we NEVER assume UIA works. Every adapter capability derived
// from this driver is gated on an actual `probe` call. A blocked/failed probe
// returns `available: false` with a machine-readable reason so the engine can
// fall back to human handoff instead of pretending the client was automated.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fsp from 'node:fs/promises'

const DEFAULT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'uia-driver.ps1')
const PROBE_TTL_MS = 5 * 60_000

function parseJsonOutput(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return { ok: false, code: 'UIA_NO_OUTPUT', message: 'The driver produced no output.' }
  // PowerShell may emit banners/warnings around the JSON payload. Take the
  // outermost object rather than assuming stdout is exactly one JSON document.
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)) } catch { /* fall through */ }
  }
  return { ok: false, code: 'UIA_OUTPUT_UNPARSEABLE', message: String(trimmed).slice(0, 300) }
}

export function createUiaDriver({
  scriptPath = DEFAULT_SCRIPT,
  spawnImpl = spawn,
  timeoutMs = 20_000,
  clock = () => Date.now(),
  platform = process.platform,
  powershell = 'powershell.exe'
} = {}) {
  let cached = null
  let cachedAt = 0

  function execute(action, args = {}) {
    return new Promise((resolve) => {
      // -ExecutionPolicy Bypass is required for an unsigned local helper on
      // stock Windows; without it PowerShell writes nothing to stdout and the
      // capability is wrongly reported as unavailable.
      const parameters = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Action', action]
      const mapping = {
        windowMatch: 'WindowMatch', processName: 'ProcessName', controlName: 'ControlName',
        automationId: 'AutomationId', controlType: 'ControlType', value: 'Value',
        valueFile: 'ValueFile', outputPath: 'OutputPath'
      }
      for (const [key, flag] of Object.entries(mapping)) {
        const value = args[key]
        if (value !== undefined && value !== null && value !== '') parameters.push(`-${flag}`, String(value))
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      let child
      const finish = (result) => { if (!settled) { settled = true; resolve(result) } }
      try {
        child = spawnImpl(powershell, parameters, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        finish({ ok: false, code: 'UIA_SPAWN_FAILED', message: String(error.message || error).slice(0, 300) })
        return
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
        finish({ ok: false, code: 'UIA_TIMEOUT', message: `${action} exceeded ${timeoutMs}ms` })
      }, timeoutMs)
      timer.unref?.()
      child.stdout?.on('data', (chunk) => { stdout += chunk })
      child.stderr?.on('data', (chunk) => { stderr += chunk })
      child.on('error', (error) => {
        clearTimeout(timer)
        finish({ ok: false, code: 'UIA_SPAWN_FAILED', message: String(error.message || error).slice(0, 300) })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const parsed = parseJsonOutput(stdout)
        if (parsed.ok) { finish({ ...parsed, exitCode: code }); return }
        finish({ ...parsed, exitCode: code, stderr: String(stderr).slice(0, 300) })
      })
    })
  }

  return {
    get scriptPath() { return scriptPath },

    async probe({ force = false } = {}) {
      if (platform !== 'win32') {
        cached = { available: false, reason: 'UNSUPPORTED_PLATFORM', platform, checkedAt: new Date(clock()).toISOString() }
        cachedAt = clock()
        return cached
      }
      if (!force && cached && clock() - cachedAt < PROBE_TTL_MS) return cached
      const result = await execute('probe')
      const available = Boolean(result.uiaAvailable) && result.ok !== false
      cached = {
        available,
        reason: available ? 'UIA_LOADED' : (result.code || 'UIA_UNAVAILABLE'),
        message: [result.message || result.note, result.stderr].filter(Boolean).join(' | ').slice(0, 500) || null,
        diagnostics: result.diagnostics || null,
        platform: result.platform || platform,
        checkedAt: new Date(clock()).toISOString()
      }
      cachedAt = clock()
      return cached
    },

    async windows({ windowMatch = '', processName = '' } = {}) {
      const capability = await this.probe()
      if (!capability.available) return { ok: false, code: 'UIA_UNAVAILABLE', capability }
      return execute('windows', { windowMatch, processName })
    },

    async find(window, control = {}) {
      const capability = await this.probe()
      if (!capability.available) return { ok: false, code: 'UIA_UNAVAILABLE', capability }
      return execute('find', { windowMatch: window.windowMatch, processName: window.processName, ...control })
    },

    async setValue(window, control, value, { valueFile = '' } = {}) {
      const capability = await this.probe()
      if (!capability.available) return { ok: false, code: 'UIA_UNAVAILABLE', capability }
      return execute('set-value', { windowMatch: window.windowMatch, processName: window.processName, ...control, value, valueFile })
    },

    async invoke(window, control) {
      const capability = await this.probe()
      if (!capability.available) return { ok: false, code: 'UIA_UNAVAILABLE', capability }
      return execute('invoke', { windowMatch: window.windowMatch, processName: window.processName, ...control })
    },

    async readText(window) {
      const capability = await this.probe()
      if (!capability.available) return { ok: false, code: 'UIA_UNAVAILABLE', capability }
      return execute('read-text', { windowMatch: window.windowMatch, processName: window.processName })
    },

    async screenshot(window, outputPath) {
      const capability = await this.probe()
      if (!capability.available) return { ok: false, code: 'UIA_UNAVAILABLE', capability }
      await fsp.mkdir(path.dirname(outputPath), { recursive: true }).catch(() => {})
      return execute('screenshot', { windowMatch: window.windowMatch, processName: window.processName, outputPath })
    },

    status() { return cached || { available: false, reason: 'NOT_PROBED' } }
  }
}

/**
 * Interpret UIA text into an execution signal. This is a heuristic over *real*
 * UI text, never a fixed sleep. It deliberately refuses to claim success from
 * text alone - final acceptance always comes from git diff + tests.
 */
export function classifyUiText(lines = []) {
  const text = lines.join('\n').toLowerCase()
  if (/approve|allow|authorize|permission required|需要授权|允许访问/.test(text)) return 'AWAITING_AUTHORIZATION'
  if (/waiting for your (input|response)|ask|需要你|请输入/.test(text)) return 'AWAITING_HUMAN_INPUT'
  if (/running tests|npm test|pytest|测试/.test(text)) return 'RUNNING_TESTS'
  if (/executing|running command|terminal|命令/.test(text)) return 'RUNNING_COMMANDS'
  if (/editing|writing|patch|apply|修改/.test(text)) return 'MODIFYING_CODE'
  if (/reading|searching|analyzing|读取/.test(text)) return 'READING_FILES'
  if (/error|failed|exception|失败/.test(text)) return 'FAILED'
  return null
}
