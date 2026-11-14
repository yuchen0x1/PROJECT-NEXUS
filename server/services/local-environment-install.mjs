import { execFile } from 'node:child_process'
import { detectDevelopmentEnvironment } from './local-environment.mjs'

// One-click download-and-install support for the environment report. Missing
// tools are mapped to winget package ids so every installer comes from a
// signed, catalogued source instead of arbitrary download URLs. `provides`
// lists sibling tool ids the same package installs as a side effect, which
// keeps the plan from "installing" npm or pip separately when Node.js or
// Python already brings them along.
const wingetPackageByTool = Object.freeze({
  git: { packageId: 'Git.Git', provides: [] },
  'github-cli': { packageId: 'GitHub.cli', provides: [] },
  node: { packageId: 'OpenJS.NodeJS.LTS', provides: ['npm'] },
  python: { packageId: 'Python.Python.3.12', provides: ['pip', 'python-launcher'] },
  uv: { packageId: 'astral-sh.uv', provides: [] },
  java: { packageId: 'EclipseAdoptium.Temurin.21.JDK', provides: [] },
  maven: { packageId: 'Apache.Maven', provides: [] },
  gradle: { packageId: 'Gradle.Gradle', provides: [] },
  'powershell-core': { packageId: 'Microsoft.PowerShell', provides: [] },
  'windows-terminal': { packageId: 'Microsoft.WindowsTerminal', provides: [] },
  rustc: { packageId: 'Rustlang.Rustup', provides: ['cargo'] },
  dotnet: { packageId: 'Microsoft.DotNet.SDK.8', provides: [] },
  docker: { packageId: 'Docker.DockerDesktop', provides: [] },
  pnpm: { packageId: 'pnpm.pnpm', provides: [] },
  yarn: { packageId: 'Yarn.Yarn', provides: [] }
})

const wingetInstallArgs = Object.freeze([
  'install', '--id', '', '--exact', '--silent', '--disable-interactivity',
  '--accept-package-agreements', '--accept-source-agreements'
])

// Installers such as Docker Desktop can legitimately run for many minutes on
// slow links; anything beyond this is treated as a hung winget run.
const perPackageTimeoutMs = 30 * 60 * 1000

function runFile(file, args, { timeoutMs = 2500, maxBuffer = 32 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: error?.killed === true })
    })
  })
}

function outputText(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim().replace(/\s+/g, ' ').slice(0, 220)
}

function readRegistryPath(result) {
  const match = /Path\s+REG(?:_EXPAND)?_SZ\s+(.*)/i.exec(`${result.stdout || ''}`)
  return match ? match[1].trim() : ''
}

function expandPathVariables(value, env) {
  return value.replace(/%([^%]+)%/g, (whole, name) => (env[name] !== undefined ? env[name] : whole))
}

/**
 * Installers write PATH changes to the registry, not to the running process.
 * Re-reading HKLM + HKCU PATH and folding it into process.env lets the
 * follow-up environment scan find freshly installed tools without an app
 * restart. Best effort: returns false when the registry could not be read.
 */
export async function refreshProcessPathFromRegistry({ runCommand = runFile, env = process.env } = {}) {
  const machine = await runCommand('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path'], { timeoutMs: 4000, maxBuffer: 64 * 1024 })
  const user = await runCommand('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], { timeoutMs: 4000, maxBuffer: 64 * 1024 })
  const machinePath = expandPathVariables(readRegistryPath(machine), env)
  const userPath = expandPathVariables(readRegistryPath(user), env)
  if (!machinePath && !userPath) return false
  const current = (env.Path || env.PATH || '').split(';').filter(Boolean)
  const merged = [...new Set([
    ...current,
    ...machinePath.split(';').filter(Boolean),
    ...userPath.split(';').filter(Boolean)
  ])]
  env.Path = merged.join(';')
  return true
}

export async function resolveWingetExecutable({ runCommand = runFile } = {}) {
  const located = await runCommand('where.exe', ['winget.exe'], { timeoutMs: 2000, maxBuffer: 16 * 1024 })
  const candidate = located.ok
    ? located.stdout.split(/\r?\n/).map((item) => item.trim()).filter((item) => item && item.length < 32000)[0]
    : null
  const winget = candidate || (process.platform === 'win32' ? 'winget.exe' : null)
  if (!winget) return null
  const probe = await runCommand(winget, ['--version'], { timeoutMs: 15000, maxBuffer: 16 * 1024 })
  return probe.ok ? winget : null
}

/**
 * Pure planner: given a scan report, return the winget packages to install,
 * skipping missing tools that a planned package installs as a side effect.
 */
export function planMissingInstalls(report) {
  if (!report || !Array.isArray(report.tools)) return []
  const planned = []
  for (const tool of report.tools) {
    if (tool.status !== 'MISSING') continue
    if (planned.some((item) => item.provides.includes(tool.id))) continue
    const entry = wingetPackageByTool[tool.id]
    if (entry) planned.push({ toolId: tool.id, label: tool.label, packageId: entry.packageId, provides: [...entry.provides] })
  }
  return planned
}

/**
 * Runs a prepared plan sequentially. Every package goes through winget with
 * silent, agreement-accepting flags; PATH is refreshed before each install so
 * packages with install-time dependencies (pnpm/yarn need npm) can succeed.
 */
export async function installDevelopmentTools({
  planned,
  winget = null,
  platform = process.platform,
  runCommand = runFile,
  refreshPath = refreshProcessPathFromRegistry,
  scan = detectDevelopmentEnvironment,
  onProgress = () => {}
} = {}) {
  const emptyResult = { ok: true, reason: 'COMPLETE', installed: [], failed: [], skipped: [], report: null }
  if (platform !== 'win32') return { ...emptyResult, ok: false, reason: 'UNSUPPORTED_PLATFORM' }
  if (!Array.isArray(planned) || !planned.length) return { ...emptyResult, reason: 'ALL_PRESENT' }

  const resolvedWinget = winget || await resolveWingetExecutable({ runCommand })
  if (!resolvedWinget) {
    await refreshPath({ runCommand })
    const report = await scan()
    return { ...emptyResult, ok: false, reason: 'WINGET_MISSING', report }
  }

  const installed = []
  const failed = []
  for (let index = 0; index < planned.length; index += 1) {
    const item = planned[index]
    onProgress({ phase: 'installing', current: index + 1, total: planned.length, toolId: item.toolId, label: item.label })
    await refreshPath({ runCommand })
    const args = [...wingetInstallArgs]
    args[2] = item.packageId
    const result = await runCommand(resolvedWinget, args, { timeoutMs: perPackageTimeoutMs, maxBuffer: 1024 * 1024 })
    const output = `${result.stdout || ''}\n${result.stderr || ''}`
    const succeeded = result.ok || result.code === 3010 || /already installed/i.test(output)
    if (succeeded) installed.push({ toolId: item.toolId, label: item.label, packageId: item.packageId })
    else failed.push({ toolId: item.toolId, label: item.label, packageId: item.packageId, detail: outputText(result) })
  }

  onProgress({ phase: 'refreshing', current: planned.length, total: planned.length, toolId: null, label: null })
  await refreshPath({ runCommand })
  onProgress({ phase: 'finalizing', current: planned.length, total: planned.length, toolId: null, label: null })
  const report = await scan()
  return { ok: failed.length === 0, reason: 'COMPLETE', installed, failed, skipped: [], report }
}
