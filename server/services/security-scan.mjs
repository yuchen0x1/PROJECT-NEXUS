import fs from 'node:fs/promises'
import path from 'node:path'
import { runCommand } from './agent/executor.mjs'

// PHASE 4 (spec PART 6): autonomous security and quality scanning for hosted
// repositories. Runs entirely against the NEXUS-managed cache clone; no tools
// are installed (spec PART 6.1) — dependency auditing uses the project's own
// npm/pnpm with the lockfile only, secret scanning is a bounded local read.

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml',
  '.py', '.rb', '.go', '.rs', '.java', '.cs', '.php', '.html', '.css', '.scss', '.vue',
  '.sh', '.ps1', '.toml', '.ini', '.cfg', '.conf', '.xml', '.sql', '.env.example'
])

const SECRET_PATTERNS = [
  { key: 'private_key', priority: 'P0', pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, summary: 'A private key block was committed to the repository.' },
  { key: 'aws_key', priority: 'P0', pattern: /AKIA[0-9A-Z]{16}/, summary: 'An AWS access key id pattern was found.' },
  { key: 'github_token', priority: 'P0', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/, summary: 'A GitHub token pattern was found.' },
  { key: 'slack_token', priority: 'P1', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/, summary: 'A Slack token pattern was found.' },
  { key: 'generic_secret_assignment', priority: 'P2', pattern: /\b(api[_-]?key|secret|password|token)\b\s*[:=]\s*['"][A-Za-z0-9+/_-]{24,}['"]/i, summary: 'A hardcoded credential assignment was found.' }
]

const ELECTRON_RISK_PATTERNS = [
  { key: 'electron_nodeintegration', priority: 'P1', pattern: /nodeIntegration\s*:\s*true/, summary: 'Electron webPreferences enables nodeIntegration.' },
  { key: 'electron_contextisolation_off', priority: 'P1', pattern: /contextIsolation\s*:\s*false/, summary: 'Electron webPreferences disables contextIsolation.' },
  { key: 'electron_shell_openexternal_variable', priority: 'P2', pattern: /shell\.openExternal\((?!['"`])[A-Za-z$_]/, summary: 'shell.openExternal is called with a variable; validate the URL first.' }
]

const DANGEROUS_ACTIONS_PATTERNS = [
  { key: 'workflow_write_all', priority: 'P2', pattern: /permissions\s*:\s*(write-all|[\s\S]{0,80}contents:\s*write)/, summary: 'A GitHub Actions workflow grants broad write permissions.' },
  { key: 'workflow_pull_request_target', priority: 'P2', pattern: /pull_request_target/, summary: 'A workflow uses pull_request_target; verify it cannot execute fork code with secrets.' }
]

const MAX_SCAN_FILES = 400
const MAX_FILE_BYTES = 200_000

function finding(key, priority, summary, detail = null, filePath = null) {
  return { key, priority, summary: String(summary).slice(0, 400), detail: detail ? String(detail).slice(0, 800) : null, path: filePath }
}

function priorityRank(priority) {
  return { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 }[priority] ?? 9
}

export function summarizeFindingsByPriority(findings) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 }
  for (const item of findings) if (counts[item.priority] !== undefined) counts[item.priority] += 1
  return counts
}

async function listTextFiles(root, { limit = MAX_SCAN_FILES } = {}) {
  const files = []
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'vendor', '__pycache__'])
  async function walk(directory, depth = 0) {
    if (files.length >= limit || depth > 6) return
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= limit) return
      if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.env.example') continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase()
        if (entry.name === 'package-lock.json' || entry.name.endsWith('.min.js') || entry.name.endsWith('.map')) continue
        if (TEXT_EXTENSIONS.has(extension) || entry.name === 'Dockerfile' || entry.name === 'Makefile') files.push(full)
      }
    }
  }
  await walk(root)
  return files
}

// Bounded secret scan of tracked text files. Only patterns with very high
// precision report P0/P1; generic assignments stay at P2 to avoid noise.
export async function scanSecrets({ root, signal } = {}) {
  const findings = []
  const files = await listTextFiles(root)
  for (const file of files) {
    if (signal?.aborted) break
    const info = await fs.stat(file).catch(() => null)
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue
    const content = await fs.readFile(file, 'utf8').catch(() => null)
    if (!content) continue
    const relative = path.relative(root, file).replace(/\\/g, '/')
    for (const { key, priority, pattern, summary } of SECRET_PATTERNS) {
      if (pattern.test(content)) {
        const line = content.slice(0, pattern.exec(content)?.index ?? 0).split('\n').length
        findings.push(finding(key, priority, summary, `line ~${line}`, relative))
      }
    }
  }
  return findings
}

export async function scanFrameworkRisks({ root } = {}) {
  const findings = []
  const files = await listTextFiles(root, { limit: 150 })
  for (const file of files) {
    const info = await fs.stat(file).catch(() => null)
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue
    const content = await fs.readFile(file, 'utf8').catch(() => null)
    if (!content) continue
    const relative = path.relative(root, file).replace(/\\/g, '/')
    const isElectronMain = /electron|desktop/i.test(relative) && /\.(mjs|cjs|js|ts)$/.test(relative)
    const isWorkflow = relative.startsWith('.github/workflows/')
    if (isElectronMain) for (const { key, priority, pattern, summary } of ELECTRON_RISK_PATTERNS) {
      if (pattern.test(content)) findings.push(finding(key, priority, summary, null, relative))
    }
    if (isWorkflow) for (const { key, priority, pattern, summary } of DANGEROUS_ACTIONS_PATTERNS) {
      if (pattern.test(content)) findings.push(finding(key, priority, summary, null, relative))
    }
  }
  return findings
}

// Dependency vulnerability audit via the project's own npm binary and lockfile
// only (--package-lock-only downloads no project dependencies). Returns null
// when the project has no npm lockfile.
export async function scanDependencyVulnerabilities({ root, signal, timeoutMs = 240_000 } = {}) {
  const packageJson = await fs.stat(path.join(root, 'package.json')).catch(() => null)
  const hasLock = await fs.stat(path.join(root, 'package-lock.json')).catch(() => null)
  if (!packageJson || !hasLock) return null
  const result = await runCommand({
    cwd: root,
    command: 'npm audit --json --package-lock-only',
    timeoutMs,
    outputLimitBytes: 4_000_000,
    signal
  })
  // npm audit exits non-zero when vulnerabilities exist; parse stdout either way.
  let report = null
  try { report = JSON.parse(result.stdout || '{}') } catch { throw Object.assign(new Error('Dependency audit did not return a valid report.'), { code: 'DEPENDENCY_AUDIT_FAILED' }) }
  if (!report.metadata || report.error) throw Object.assign(new Error('Dependency audit was unavailable; no clean result can be claimed.'), { code: 'DEPENDENCY_AUDIT_FAILED' })
  const findings = []
  for (const [name, advisory] of Object.entries(report.vulnerabilities || {})) {
    const severity = String(advisory.severity || 'low').toLowerCase()
    const priority = severity === 'critical' ? 'P0' : severity === 'high' ? 'P1' : severity === 'moderate' ? 'P2' : 'P3'
    findings.push(finding(
      `dependency_${name}`,
      priority,
      `npm dependency "${name}" has a ${severity} severity vulnerability (${(advisory.via || []).length} advisory channel(s)).`,
      `range: ${advisory.range || 'unknown'}; fix available: ${advisory.fixAvailable ? JSON.stringify(advisory.fixAvailable) === 'true' ? 'yes' : JSON.stringify(advisory.fixAvailable) : 'no'}`,
      'package-lock.json'
    ))
  }
  return findings
}

// Full security pass over a repository cache clone.
export async function runSecurityScan({ root, signal } = {}) {
  const [secrets, framework, dependencies] = await Promise.all([
    scanSecrets({ root, signal }),
    scanFrameworkRisks({ root }),
    scanDependencyVulnerabilities({ root, signal })
  ])
  const findings = [...(secrets || []), ...(framework || []), ...(dependencies || [])]
  findings.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
  return {
    scannedAt: new Date().toISOString(),
    dependencyAuditRan: dependencies !== null,
    findings,
    counts: summarizeFindingsByPriority(findings),
    status: findings.some((item) => item.priority === 'P0') ? 'CRITICAL' : findings.some((item) => item.priority === 'P1') ? 'HIGH_RISK' : findings.length ? 'FINDINGS' : 'CLEAN'
  }
}
