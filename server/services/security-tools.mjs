import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const TOOL_DEFINITIONS = Object.freeze({
  codeql: { label: 'CodeQL', versionArgs: ['version'], install: 'Install GitHub CodeQL CLI and ensure codeql.exe is on PATH.' },
  semgrep: { label: 'Semgrep', versionArgs: ['--version'], install: 'Install Semgrep for Windows and ensure semgrep.exe is on PATH.' },
  gitleaks: { label: 'Gitleaks', versionArgs: ['version'], install: 'Install Gitleaks for Windows and ensure gitleaks.exe is on PATH.' },
  trivy: { label: 'Trivy', versionArgs: ['version'], install: 'Install Trivy for Windows and ensure trivy.exe is on PATH.' }
})

const SARIF_LEVEL_PRIORITY = { error: 'P0', warning: 'P1', note: 'P2', none: 'P3' }

function toolError(code, message) { return Object.assign(new Error(message), { code }) }

function runExecutable(file, args, { cwd, timeoutMs = 300_000, signal, execImpl = execFile } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let child
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    try {
      child = execImpl(file, args, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        finish({ ok: !error, exitCode: error ? (error.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error ? String(error.message || error) : null })
      })
    } catch (error) {
      finish({ ok: false, exitCode: null, stdout: '', stderr: '', error: String(error.message || error) })
      return
    }
    const abort = () => { try { child.kill() } catch {} finish({ ok: false, exitCode: null, stdout: '', stderr: '', error: 'ABORTED', aborted: true }) }
    if (signal) {
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }
  })
}

function priorityForSarif(result) {
  const level = String(result?.level || '').toLowerCase()
  const rule = `${result?.ruleId || ''} ${result?.message?.text || ''}`.toLowerCase()
  if (/critical|secret|credential|private.key|rce|remote.code.execution/.test(rule)) return 'P0'
  if (/high|error|vulnerab|injection|command/.test(rule) || level === 'error') return 'P1'
  return SARIF_LEVEL_PRIORITY[level] || 'P2'
}

export function parseSarif(text, { tool = 'security-tool' } = {}) {
  let document
  try { document = typeof text === 'string' ? JSON.parse(text) : text } catch (error) {
    throw toolError('SARIF_INVALID', `${tool} returned invalid SARIF: ${error.message}`)
  }
  const findings = []
  for (const run of Array.isArray(document?.runs) ? document.runs : []) {
    const rules = new Map((run.tool?.driver?.rules || []).map((rule) => [String(rule.id), rule]))
    for (const result of Array.isArray(run.results) ? run.results : []) {
      const location = result.locations?.[0]?.physicalLocation
      const artifact = location?.artifactLocation?.uri ? String(location.artifactLocation.uri).replace(/^file:\/\//, '') : null
      const line = Number(location?.region?.startLine || 0) || null
      const rule = rules.get(String(result.ruleId || ''))
      const detail = String(result.message?.text || rule?.shortDescription?.text || result.ruleId || 'Security finding').slice(0, 1000)
      const key = crypto.createHash('sha256').update(`${tool}|${result.ruleId || ''}|${artifact || ''}|${line || ''}|${detail}`).digest('hex').slice(0, 24)
      findings.push({
        id: `${tool}:${key}`, tool, key: `${tool}:${result.ruleId || 'finding'}`,
        priority: priorityForSarif(result), ruleId: result.ruleId || null, summary: detail,
        path: artifact, line, level: result.level || null, fingerprint: key
      })
    }
  }
  return findings
}

function detectSupportedLanguages(root) {
  return Promise.all([
    fsp.stat(path.join(root, 'package.json')).then(() => 'javascript-typescript').catch(() => null),
    fsp.stat(path.join(root, 'pyproject.toml')).then(() => 'python').catch(() => null),
    fsp.stat(path.join(root, 'go.mod')).then(() => 'go').catch(() => null),
    fsp.stat(path.join(root, 'pom.xml')).then(() => 'java').catch(() => null),
    fsp.stat(path.join(root, 'Cargo.toml')).then(() => 'rust').catch(() => null)
  ]).then((items) => [...new Set(items.filter(Boolean))])
}

async function probeTool(tool, { execImpl = execFile, timeoutMs = 20_000 } = {}) {
  const definition = TOOL_DEFINITIONS[tool]
  const result = await runExecutable(tool, definition.versionArgs, { execImpl, timeoutMs })
  if (!result.ok) return { tool, installed: false, executable: null, version: null, error: result.error || result.stderr.slice(0, 300), install: definition.install }
  const version = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || 'unknown'
  return { tool, installed: true, executable: tool, version: version.slice(0, 200), error: null, install: definition.install }
}

export async function detectSecurityTools({ execImpl = execFile } = {}) {
  const tools = {}
  for (const tool of Object.keys(TOOL_DEFINITIONS)) tools[tool] = await probeTool(tool, { execImpl })
  return { checkedAt: new Date().toISOString(), platform: process.platform, tools }
}

function commandFor(tool, root, reportPath, reportDir, languages) {
  if (tool === 'semgrep') return { args: ['scan', '--config', 'auto', '--json', '--output', reportPath, root], format: 'json' }
  if (tool === 'gitleaks') return { args: ['detect', '--source', root, '--report-format', 'sarif', '--report-path', reportPath, '--no-banner'], format: 'sarif' }
  if (tool === 'trivy') return { args: ['fs', '--format', 'sarif', '--output', reportPath, '--scanners', 'vuln,secret,misconfig', root], format: 'sarif' }
  if (tool === 'codeql') {
    const language = languages.includes('javascript-typescript') ? 'javascript-typescript' : languages[0]
    const database = path.join(reportDir, 'codeql-db')
    return { setup: ['database', 'create', database, '--language', language, '--source-root', root, '--overwrite'], args: ['database', 'analyze', database, '--format=sarif-latest', `--output=${reportPath}`], format: 'sarif' }
  }
  return null
}

function parseSemgrep(text) {
  let report
  try { report = JSON.parse(text || '{}') } catch { return [] }
  return (report.results || []).map((item) => {
    const key = crypto.createHash('sha256').update(`semgrep|${item.check_id}|${item.path}|${item.start?.line || ''}|${item.extra?.message || ''}`).digest('hex').slice(0, 24)
    return { id: `semgrep:${key}`, tool: 'semgrep', key: `semgrep:${item.check_id || 'finding'}`, priority: item.extra?.severity === 'ERROR' ? 'P1' : item.extra?.severity === 'WARNING' ? 'P2' : 'P3', ruleId: item.check_id || null, summary: String(item.extra?.message || item.check_id || 'Semgrep finding').slice(0, 1000), path: item.path || null, line: item.start?.line || null, level: item.extra?.severity || null, fingerprint: key }
  })
}

async function readReport(reportPath, tool, format, stdout) {
  const content = await fsp.readFile(reportPath, 'utf8').catch(() => stdout || '')
  if (!content.trim()) return []
  return format === 'json' ? parseSemgrep(content) : parseSarif(content, { tool })
}

export async function runExternalSecurityScans({ root, reportDir = path.join(os.tmpdir(), 'project-nexus-security'), signal, execImpl = execFile, tools = null, timeoutMs = 300_000 } = {}) {
  const absoluteRoot = path.resolve(String(root || ''))
  const rootStat = await fsp.stat(absoluteRoot).catch(() => null)
  if (!rootStat?.isDirectory()) throw toolError('SECURITY_ROOT_MISSING', `Security scan root does not exist: ${absoluteRoot}`)
  await fsp.mkdir(reportDir, { recursive: true })
  const detected = await detectSecurityTools({ execImpl })
  const languages = await detectSupportedLanguages(absoluteRoot)
  const selected = Array.isArray(tools) && tools.length ? tools.filter((tool) => TOOL_DEFINITIONS[tool]) : Object.keys(TOOL_DEFINITIONS)
  const results = {}
  const findings = []
  for (const tool of selected) {
    const availability = detected.tools[tool]
    if (tool === 'codeql' && !languages.length) {
      results[tool] = { tool, status: 'NOT_APPLICABLE', installed: Boolean(availability?.installed), reason: 'No CodeQL-supported project language was detected.', languages }
      continue
    }
    if (!availability?.installed) {
      results[tool] = { tool, status: 'NOT_INSTALLED', installed: false, version: null, error: availability?.error || 'executable not found', install: availability?.install }
      continue
    }
    const reportPath = path.join(reportDir, `${tool}-${Date.now()}.${tool === 'semgrep' ? 'json' : 'sarif'}`)
    const command = commandFor(tool, absoluteRoot, reportPath, reportDir, languages)
    if (!command) { results[tool] = { tool, status: 'NOT_APPLICABLE', reason: 'No command adapter exists.' }; continue }
    let setup = null
    if (command.setup) setup = await runExecutable(tool, command.setup, { cwd: absoluteRoot, timeoutMs, signal, execImpl })
    if (setup && !setup.ok) {
      results[tool] = { tool, status: setup.aborted ? 'BLOCKED' : 'FAILED', installed: true, version: availability.version, error: setup.error || setup.stderr.slice(0, 500), reportPath }
      continue
    }
    const run = await runExecutable(tool, command.args, { cwd: absoluteRoot, timeoutMs, signal, execImpl })
    if (run.aborted) { results[tool] = { tool, status: 'BLOCKED', installed: true, version: availability.version, error: 'scan aborted', reportPath }; continue }
    let toolFindings = []
    try { toolFindings = await readReport(reportPath, tool, command.format, run.stdout) } catch (error) {
      results[tool] = { tool, status: 'FAILED', installed: true, version: availability.version, error: error.message, reportPath }
      continue
    }
    findings.push(...toolFindings)
    results[tool] = { tool, status: toolFindings.length ? 'FINDINGS' : (run.ok || run.exitCode === 1 ? 'PASS' : 'FAILED'), installed: true, version: availability.version, findings: toolFindings.length, reportPath, exitCode: run.exitCode, stderr: run.stderr.slice(-1000) }
  }
  const previousPath = path.join(reportDir, 'security-scan-latest.json')
  const previous = JSON.parse(await fsp.readFile(previousPath, 'utf8').catch(() => 'null') || 'null')
  const previousKeys = new Set((previous?.findings || []).map((item) => item.id))
  const newFindings = findings.filter((item) => !previousKeys.has(item.id))
  const required = selected.filter((tool) => !(tool === 'codeql' && !languages.length))
  const blocked = required.some((tool) => ['NOT_INSTALLED', 'FAILED', 'BLOCKED'].includes(results[tool]?.status))
  const status = blocked ? 'BLOCKED' : findings.length ? 'FINDINGS' : 'CLEAN'
  const report = {
    id: `security_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    scannedAt: new Date().toISOString(), root: absoluteRoot, languages, tools: detected.tools, results, findings,
    newFindings, status, requiredTools: required, history: { previousReport: previous?.id || null, newFindingCount: newFindings.length }
  }
  const reportPath = path.join(reportDir, `${report.id}.json`)
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  await fsp.writeFile(previousPath, JSON.stringify(report, null, 2), 'utf8')
  return { ...report, reportPath }
}

export { TOOL_DEFINITIONS }
