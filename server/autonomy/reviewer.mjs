// Independent Reviewer Engine (directive 8) and release gate (directive 9).
//
// The AI client's own "done" message is NEVER accepted as proof. NEXUS re-runs
// real commands inside the isolated worktree, inspects the real diff, and only
// then decides PASS / FAIL. Publishing has a separate, explicit permission.

import { execFile } from 'node:child_process'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { makeId } from './model.mjs'
import { inspectSensitiveFile, looksLikeSecretContent } from '../services/sensitive-files.mjs'

const SAFE_SCRIPT = /^[A-Za-z0-9:_-]{1,60}$/
const ALLOWED_PROGRAMS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'python3', 'pytest', 'dotnet', 'cargo', 'go'])

function resolveProgram(program, platform = process.platform) {
  if (platform === 'win32' && ['npm', 'npx', 'pnpm', 'yarn'].includes(program)) return `${program}.cmd`
  return program
}

/**
 * Discover verification commands from the project's own files. Never assumes
 * that `npm test` exists. CI workflows are read for context, not executed.
 */
export async function detectVerificationCommands(projectDir, { fsImpl = fsp } = {}) {
  const commands = []
  const sources = []
  const notes = []
  async function readJson(file) {
    try { return JSON.parse(await fsImpl.readFile(path.join(projectDir, file), 'utf8')) } catch { return null }
  }
  async function readText(file) {
    try { return await fsImpl.readFile(path.join(projectDir, file), 'utf8') } catch { return null }
  }

  const pkg = await readJson('package.json')
  if (pkg?.scripts && typeof pkg.scripts === 'object') {
    sources.push('package.json')
    const preferred = ['test', 'build', 'lint', 'typecheck']
    for (const name of preferred) {
      if (!pkg.scripts[name]) continue
      if (!SAFE_SCRIPT.test(name)) { notes.push(`Skipped unsafe script name: ${name}`); continue }
      commands.push({ name, argv: [resolveProgram('npm'), 'run', name], source: 'package.json', required: name === 'test' || name === 'build' })
    }
    if (!pkg.scripts.test) notes.push('No test script in package.json; a regression test may be required.')
    if (!pkg.scripts.build) notes.push('No build script in package.json.')
  } else {
    notes.push('No package.json; this is not a Node project (or it is missing).')
  }

  const pyproject = await readText('pyproject.toml')
  if (pyproject || await readText('pytest.ini')) {
    sources.push('python')
    commands.push({ name: 'pytest', argv: [resolveProgram('python'), '-m', 'pytest', '-q'], source: 'pyproject.toml/pytest.ini', required: true })
  }
  if (await readText('go.mod')) {
    sources.push('go.mod')
    commands.push({ name: 'go-test', argv: [resolveProgram('go'), 'test', './...'], source: 'go.mod', required: true })
  }
  if (await readText('Cargo.toml')) {
    sources.push('Cargo.toml')
    commands.push({ name: 'cargo-test', argv: [resolveProgram('cargo'), 'test'], source: 'Cargo.toml', required: true })
  }

  // CI workflows are evidence of the canonical command set, not an executable
  // source: repository-provided shell lines must never be auto-executed.
  let ciCommands = []
  try {
    const workflowDir = path.join(projectDir, '.github', 'workflows')
    const entries = await fsImpl.readdir(workflowDir)
    for (const entry of entries.filter((name) => /\.ya?ml$/.test(name))) {
      const content = await fsImpl.readFile(path.join(workflowDir, entry), 'utf8')
      ciCommands = ciCommands.concat(content.split('\n').map((line) => line.match(/^\s*(?:-\s*)?run:\s*(.+)$/)?.[1]?.trim()).filter(Boolean).slice(0, 12))
    }
    if (ciCommands.length) sources.push('.github/workflows')
  } catch { /* no workflows */ }

  return {
    commands, sources, notes, ciCommands: ciCommands.slice(0, 30),
    hasTests: commands.some((command) => /test/i.test(command.name)),
    hasBuild: commands.some((command) => /build/i.test(command.name))
  }
}

export function runCommand(argv, { cwd, execImpl = execFile, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    if (!Array.isArray(argv) || !ALLOWED_PROGRAMS.has(String(argv[0] || '').replace(/\.cmd$/i, ''))) {
      resolve({ argv, pass: false, exitCode: null, output: `Command not allowlisted: ${Array.isArray(argv) ? argv[0] : argv}`, durationMs: 0 })
      return
    }
    const started = Date.now()
    execImpl(argv[0], argv.slice(1), { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${String(stdout || '')}${String(stderr || '')}`.slice(-20_000)
      resolve({
        argv, pass: !error, exitCode: error ? (error.code ?? 1) : 0,
        output, durationMs: Date.now() - started,
        timedOut: Boolean(error && /ETIMEDOUT|timed out/i.test(String(error.code || error.message)))
      })
    })
  })
}

/** Independent acceptance: diff scope + real commands + security scan. */
export async function verifyTask({
  store, workspace, diff, commands = null, execImpl = execFile,
  clock = () => Date.now(), timeoutMs = 180_000, scopeReview = null
} = {}) {
  const startedAt = new Date(clock()).toISOString()
  const discovered = commands || await detectVerificationCommands(workspace.path)
  const results = []
  for (const command of discovered.commands) {
    results.push({ name: command.name, required: command.required, ...await runCommand(command.argv, { cwd: workspace.path, execImpl, timeoutMs }) })
  }
  const scope = scopeReview || { pass: true, violations: [] }
  const security = scanDiffForSecrets(diff)
  const requiredFailures = results.filter((result) => result.required && !result.pass)
  const verdict = scope.pass && security.pass && requiredFailures.length === 0 && results.length > 0
    ? 'PASS'
    : 'FAIL'
  const report = {
    id: makeId('verify'), taskId: workspace.taskId, repoId: workspace.repoId,
    startedAt, finishedAt: new Date(clock()).toISOString(), verdict,
    commands: discovered.commands.map((command) => ({ name: command.name, argv: command.argv, source: command.source })),
    results, scope, security,
    discovery: { sources: discovered.sources, notes: discovered.notes, hasTests: discovered.hasTests, hasBuild: discovered.hasBuild },
    changedFileCount: diff.fileCount,
    failures: [
      ...scope.violations.map((item) => ({ kind: 'scope', ...item })),
      ...security.findings.map((item) => ({ kind: 'security', ...item })),
      ...requiredFailures.map((item) => ({ kind: 'test', code: 'REQUIRED_COMMAND_FAILED', detail: `${item.name}: ${String(item.output).slice(-500)}` }))
    ],
    recommendations: []
  }
  if (!discovered.hasTests) report.recommendations.push('Add an automated regression test for this fix before acceptance.')
  if (!results.length) report.recommendations.push('No executable verification command was discovered; manual acceptance is required.')
  if (store) {
    store.put('verification_reports', report.id, report)
    store.audit('reviewer', `verdict:${verdict}`, workspace.taskId, { failures: report.failures.length, commands: results.length })
  }
  return report
}

export function scanDiffForSecrets(diff = {}) {
  const findings = []
  const patch = String(diff.patch || '')
  const patterns = [
    { regex: /\bgh[pousr]_[A-Za-z0-9_.-]+/g, code: 'GITHUB_TOKEN_IN_DIFF' },
    { regex: /\bgithub_pat_[A-Za-z0-9_.-]+/g, code: 'GITHUB_PAT_IN_DIFF' },
    { regex: /sk-[A-Za-z0-9_-]{20,}/g, code: 'API_KEY_IN_DIFF' },
    { regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, code: 'PRIVATE_KEY_IN_DIFF' },
    { regex: /(AI_API_KEY|GITHUB_TOKEN|CLIENT_SECRET|PASSWORD)\s*=\s*['"][^'"]{8,}/gi, code: 'HARDCODED_SECRET_IN_DIFF' },
    { regex: /\b(rm\s+-rf\s+\/|del\s+\/[SQ]\s|git\s+push\s+--force|git\s+reset\s+--hard)\b/gi, code: 'DESTRUCTIVE_COMMAND_IN_DIFF' }
  ]
  for (const { regex, code } of patterns) if (regex.test(patch)) findings.push({ code, detail: `Pattern ${code} found in the change set.` })
  for (const file of diff.sensitiveFiles || []) findings.push({ code: 'SENSITIVE_PATH_IN_DIFF', detail: file })
  for (const file of diff.changedFiles || []) {
    const inspection = inspectSensitiveFile({ relativePath: file.path, content: file.content || '' })
    if (inspection.sensitive && !inspection.pathReasons.includes('VCS_DIRECTORY')) {
      findings.push({ code: 'SENSITIVE_FILE_IN_DIFF', detail: `${file.path}: ${inspection.reasons.join(', ')}` })
    }
  }
  const contentInspection = looksLikeSecretContent(patch)
  for (const reason of contentInspection.reasons) findings.push({ code: `SECRET_CONTENT_${reason}`, detail: `Credential-like content detected (${reason}).` })
  for (const file of diff.deletedFiles || []) findings.push({ code: 'DELETION_IN_DIFF', detail: file })
  return { pass: findings.length === 0, findings }
}

// ---- Versioning & release gate --------------------------------------------

export function computeNextVersion(current = '0.0.0', change = 'patch') {
  const match = String(current).match(/^v?(\d+)\.(\d+)\.(\d+)/)
  let [major, minor, patchValue] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0]
  if (change === 'major') { major++; minor = 0; patchValue = 0 }
  else if (change === 'minor') { minor++; patchValue = 0 }
  else patchValue++
  return `${major}.${minor}.${patchValue}`
}

export function classifyChange(findings = [], diff = {}) {
  if (findings.some((finding) => /breaking|major|migration|remove api/i.test(`${finding.kind} ${finding.title}`))) return 'major'
  if (findings.some((finding) => /feature|enhancement|porting|new capability/i.test(`${finding.kind} ${finding.title}`))) return 'minor'
  const addedFiles = (diff.changedFiles || []).filter((file) => file.status === '??').length
  if (addedFiles >= 3 && !findings.some((finding) => /bug|fix/i.test(finding.kind))) return 'minor'
  return 'patch'
}

export function buildReleaseNotes({ version, repo, task, findings = [], report = {}, diff = {} }) {
  const lines = [
    `## v${version} — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Repository: ${repo.fullName}`,
    `Task: ${task.id}`,
    '',
    '### Changes',
    ''
  ]
  for (const finding of findings) lines.push(`- ${finding.priority} · ${finding.title}`)
  if (!findings.length) lines.push('- Autonomous maintenance changes.')
  lines.push('', '### Verification', '')
  lines.push(`- Independent verdict: ${report.verdict || 'UNKNOWN'}`)
  lines.push(`- Commands executed: ${(report.results || []).length}`)
  lines.push(`- Changed files: ${diff.fileCount || 0}`)
  lines.push(`- Security scan: ${report.security?.pass ? 'PASS' : 'FAIL'}`)
  lines.push('', '---', 'Generated by PROJECT NEXUS Reviewer Engine (not by the executing AI client).', '')
  return lines.join('\n')
}

/**
 * Publishing is gated by independent permissions. All conditions must hold;
 * a single failure blocks the release without exception.
 */
export function evaluateReleaseGate({
  repo = {}, task = {}, report = {}, diff = {}, automationMode = 'observe',
  remoteWritesEnabled = false, explicitApproval = false, existingRelease = null,
  criticalFindings = 0
} = {}) {
  const blockers = []
  if (report.verdict !== 'PASS') blockers.push({ code: 'VERIFICATION_FAILED', detail: 'Independent acceptance did not pass.' })
  if (!report.security?.pass) blockers.push({ code: 'SECURITY_SCAN_FAILED', detail: 'Security scan found violations.' })
  if (criticalFindings > 0) blockers.push({ code: 'CRITICAL_FINDINGS_OPEN', detail: `${criticalFindings} critical findings remain open.` })
  if (automationMode !== 'autonomous') blockers.push({ code: 'AUTOMATION_MODE_INSUFFICIENT', detail: `Mode is ${automationMode}; autonomous mode is required.` })
  if (!remoteWritesEnabled) blockers.push({ code: 'REMOTE_WRITES_DISABLED', detail: 'Remote write permission is off.' })
  if (!repo.autoRelease) blockers.push({ code: 'AUTO_RELEASE_DISABLED', detail: 'Per-repository auto-release switch is off.' })
  if (!explicitApproval) blockers.push({ code: 'RELEASE_APPROVAL_MISSING', detail: 'Explicit release approval is required.' })
  if (!diff.fileCount) blockers.push({ code: 'NO_CHANGES', detail: 'Nothing to release.' })
  const fingerprint = crypto.createHash('sha256')
    .update([diff.baseSha, diff.patch, (diff.changedFiles || []).map((file) => `${file.status}:${file.path}`).join('|')].join('|'))
    .digest('hex').slice(0, 32)
  if (existingRelease && existingRelease.contentFingerprint === fingerprint) {
    blockers.push({ code: 'DUPLICATE_RELEASE', detail: 'Identical content was already released; refusing to republish.' })
  }
  return { allowed: blockers.length === 0, blockers, contentFingerprint: fingerprint }
}

export function createReleaseRecord({ store, repo, task, diff, report, findings = [], version, notes, gate }) {
  const record = {
    id: makeId('release'), repoId: repo.id, repository: repo.fullName, taskId: task.id,
    version, notes, contentFingerprint: gate.contentFingerprint,
    verificationReportId: report.id, verdict: report.verdict,
    changedFiles: (diff.changedFiles || []).map((file) => file.path),
    findings: findings.map((finding) => finding.id), status: 'PREPARED',
    createdAt: new Date().toISOString()
  }
  store.put('releases', record.id, record)
  store.audit('release', 'prepared', repo.fullName, { version, taskId: task.id, verdict: report.verdict })
  return record
}
