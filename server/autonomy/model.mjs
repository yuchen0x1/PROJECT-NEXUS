// PROJECT NEXUS Autonomy Runtime - canonical domain model.
//
// This module is deliberately dependency-free and side-effect-free so every
// engine, API route and unit test shares exactly one vocabulary. Nothing in
// here pretends a capability exists: states describe observations, not wishes.

import crypto from 'node:crypto'

// ---- Priority -------------------------------------------------------------

export const PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4'])

export const PRIORITY_RULES = Object.freeze({
  P0: 'critical security vulnerability, leaked secret, severe data-loss risk',
  P1: 'critical bug, broken build, important feature unavailable',
  P2: 'ordinary bug, quality issue, dependency upgrade',
  P3: 'feature enhancement, ported peer-project capability',
  P4: 'documentation, UI polish, non-urgent suggestion'
})

export function priorityFromFinding(finding = {}) {
  const kind = String(finding.kind || '').toLowerCase()
  const severity = String(finding.severity || '').toLowerCase()
  if (/secret|credential|token_leak|key_leak/.test(kind) || /critical/.test(severity)) return 'P0'
  if (/security|advisory|cve|code_scanning|dependabot/.test(kind) || /high/.test(severity)) return 'P1'
  if (/build_failure|ci_failure|regression|crash/.test(kind)) return 'P1'
  if (/bug|test_failure|quality|outdated_dependency/.test(kind)) return 'P2'
  if (/porting|feature|enhancement|peer_update/.test(kind)) return 'P3'
  return 'P4'
}

// ---- Task lifecycle -------------------------------------------------------

export const TASK_STATUSES = Object.freeze([
  'QUEUED', 'DISPATCHED', 'IN_PROGRESS', 'AWAITING_HUMAN', 'VERIFYING',
  'ACCEPTED', 'REJECTED', 'CANCELLED', 'FAILED', 'PAUSED', 'EXPIRED', 'BLOCKED'
])

export const TERMINAL_TASK_STATUSES = Object.freeze(['ACCEPTED', 'REJECTED', 'CANCELLED', 'FAILED', 'EXPIRED'])

// Legal transitions. A task may never silently jump from QUEUED to ACCEPTED.
const TASK_TRANSITIONS = Object.freeze({
  QUEUED: ['DISPATCHED', 'AWAITING_HUMAN', 'PAUSED', 'CANCELLED', 'BLOCKED', 'EXPIRED'],
  DISPATCHED: ['IN_PROGRESS', 'AWAITING_HUMAN', 'FAILED', 'CANCELLED', 'BLOCKED', 'EXPIRED'],
  IN_PROGRESS: ['VERIFYING', 'AWAITING_HUMAN', 'FAILED', 'CANCELLED', 'BLOCKED', 'EXPIRED'],
  AWAITING_HUMAN: ['IN_PROGRESS', 'VERIFYING', 'CANCELLED', 'FAILED', 'EXPIRED'],
  VERIFYING: ['ACCEPTED', 'REJECTED', 'FAILED', 'QUEUED', 'AWAITING_HUMAN'],
  PAUSED: ['QUEUED', 'CANCELLED'],
  BLOCKED: ['QUEUED', 'CANCELLED'],
  REJECTED: ['QUEUED', 'CANCELLED'],
  FAILED: ['QUEUED', 'CANCELLED'],
  ACCEPTED: [],
  CANCELLED: [],
  EXPIRED: ['QUEUED', 'CANCELLED']
})

export function canTransitionTask(from, to) {
  return Boolean(TASK_TRANSITIONS[from]?.includes(to))
}

export function assertTaskTransition(from, to) {
  if (!canTransitionTask(from, to)) {
    throw Object.assign(new Error(`Illegal task transition ${from} -> ${to}`), {
      code: 'TASK_ILLEGAL_TRANSITION', from, to
    })
  }
  return true
}

// ---- Desktop AI execution states (directive 6.4) --------------------------

export const AGENT_STATES = Object.freeze([
  'NOT_STARTED', 'STARTING', 'AWAITING_PROJECT_SELECTION', 'AWAITING_SEND',
  'RUNNING', 'READING_FILES', 'MODIFYING_CODE', 'RUNNING_COMMANDS', 'RUNNING_TESTS',
  'AWAITING_AUTHORIZATION', 'AWAITING_HUMAN_INPUT', 'SUCCEEDED', 'FAILED',
  'TIMEOUT', 'CLIENT_EXITED', 'NEEDS_HUMAN_HANDOFF'
])

export const AGENT_TERMINAL_STATES = Object.freeze([
  'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CLIENT_EXITED', 'NEEDS_HUMAN_HANDOFF'
])

const AGENT_TRANSITIONS = Object.freeze({
  NOT_STARTED: ['STARTING', 'AWAITING_HUMAN_INPUT', 'NEEDS_HUMAN_HANDOFF', 'FAILED'],
  STARTING: ['AWAITING_PROJECT_SELECTION', 'AWAITING_SEND', 'FAILED', 'TIMEOUT', 'CLIENT_EXITED', 'NEEDS_HUMAN_HANDOFF'],
  AWAITING_PROJECT_SELECTION: ['AWAITING_SEND', 'AWAITING_HUMAN_INPUT', 'NEEDS_HUMAN_HANDOFF', 'FAILED', 'TIMEOUT'],
  AWAITING_SEND: ['RUNNING', 'AWAITING_HUMAN_INPUT', 'NEEDS_HUMAN_HANDOFF', 'FAILED', 'TIMEOUT'],
  RUNNING: ['READING_FILES', 'MODIFYING_CODE', 'RUNNING_COMMANDS', 'RUNNING_TESTS', 'AWAITING_AUTHORIZATION', 'AWAITING_HUMAN_INPUT', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CLIENT_EXITED', 'NEEDS_HUMAN_HANDOFF'],
  READING_FILES: ['RUNNING', 'MODIFYING_CODE', 'RUNNING_COMMANDS', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CLIENT_EXITED', 'NEEDS_HUMAN_HANDOFF'],
  MODIFYING_CODE: ['RUNNING', 'RUNNING_COMMANDS', 'RUNNING_TESTS', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CLIENT_EXITED', 'NEEDS_HUMAN_HANDOFF'],
  RUNNING_COMMANDS: ['RUNNING', 'RUNNING_TESTS', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CLIENT_EXITED', 'NEEDS_HUMAN_HANDOFF'],
  RUNNING_TESTS: ['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CLIENT_EXITED', 'NEEDS_HUMAN_HANDOFF'],
  AWAITING_AUTHORIZATION: ['RUNNING', 'AWAITING_HUMAN_INPUT', 'NEEDS_HUMAN_HANDOFF', 'TIMEOUT', 'FAILED'],
  AWAITING_HUMAN_INPUT: ['RUNNING', 'NEEDS_HUMAN_HANDOFF', 'FAILED', 'TIMEOUT'],
  NEEDS_HUMAN_HANDOFF: ['AWAITING_HUMAN_INPUT', 'RUNNING', 'FAILED', 'CANCELLED', 'AWAITING_SEND', 'AWAITING_PROJECT_SELECTION'],
  SUCCEEDED: [], FAILED: [], TIMEOUT: [], CLIENT_EXITED: [], 'CANCELLED': []
})

export function canTransitionAgent(from, to) {
  return Boolean(AGENT_TRANSITIONS[from]?.includes(to))
}

export function assertAgentTransition(from, to) {
  if (!canTransitionAgent(from, to)) {
    throw Object.assign(new Error(`Illegal agent transition ${from} -> ${to}`), {
      code: 'AGENT_ILLEGAL_TRANSITION', from, to
    })
  }
  return true
}

// ---- Issue lifecycle (directive 3.2) --------------------------------------

export const ISSUE_LIFECYCLES = Object.freeze([
  'PENDING_ANALYSIS', 'ANALYZED', 'AWAITING_FIX', 'FIXING',
  'AWAITING_VERIFICATION', 'VERIFIED_RESOLVED', 'UNRESOLVED', 'REAPPEARED', 'UNCONFIRMABLE'
])

// A closed GitHub issue is NEVER automatically VERIFIED_RESOLVED.
export function evaluateIssueLifecycle(issue = {}, evidence = {}) {
  const {
    linkedPullRequest = null, pullRequestMerged = false, relatedCommits = [],
    fixPresentInTargetBranch = false, testsPassed = false, reproducible = null,
    newCommentsReportingProblem = 0, regressionDetected = false,
    reviewApproved = false
  } = evidence

  const reopened = String(issue.state || '').toLowerCase() === 'open'
  if (regressionDetected || newCommentsReportingProblem > 0) return 'REAPPEARED'
  if (reopened && (evidence.previouslyVerified || evidence.priorFixMerged)) return 'REAPPEARED'

  // Without positive evidence we refuse to claim resolution.
  const checks = [
    Boolean(linkedPullRequest), Boolean(pullRequestMerged), relatedCommits.length > 0,
    Boolean(fixPresentInTargetBranch), Boolean(testsPassed),
    reproducible === false, Boolean(reviewApproved)
  ]
  const confirmed = checks.filter(Boolean).length
  if (confirmed >= 6 && !reopened) return 'VERIFIED_RESOLVED'

  if (!linkedPullRequest && !relatedCommits.length) {
    return reopened ? 'PENDING_ANALYSIS' : 'UNCONFIRMABLE'
  }
  if (!pullRequestMerged || !fixPresentInTargetBranch) return reopened ? 'FIXING' : 'UNRESOLVED'
  if (!testsPassed) return 'AWAITING_VERIFICATION'
  if (reproducible !== false || !reviewApproved) return 'UNCONFIRMABLE'
  return 'UNCONFIRMABLE'
}

// ---- Blocking conditions (directive 11: keep them DISTINCT) ---------------

export const READINESS_CHECKS = Object.freeze([
  'AI_API', 'DESKTOP_CLIENT', 'REPOSITORY_SCAN', 'MANIFEST', 'TASK_GENERATION', 'TASK_EXECUTABILITY'
])

export const BLOCK_CODES = Object.freeze({
  AI_API_NOT_CONFIGURED: 'AI_API_NOT_CONFIGURED',
  DESKTOP_CLIENT_NOT_CONNECTED: 'DESKTOP_CLIENT_NOT_CONNECTED',
  DESKTOP_CLIENT_NEEDS_LOGIN: 'DESKTOP_CLIENT_NEEDS_LOGIN',
  DESKTOP_CLIENT_UIA_UNAVAILABLE: 'DESKTOP_CLIENT_UIA_UNAVAILABLE',
  REPOSITORY_SCAN_PENDING: 'REPOSITORY_SCAN_PENDING',
  MANIFEST_REQUIRED_MISSING: 'MANIFEST_REQUIRED_MISSING',
  NO_TASK_GENERATED: 'NO_TASK_GENERATED',
  TASK_NOT_EXECUTABLE: 'TASK_NOT_EXECUTABLE',
  PROJECT_SELECTION_UNCERTAIN: 'PROJECT_SELECTION_UNCERTAIN'
})

// Which manifest a given stack actually needs. A documentation-only project
// must never be blocked for lacking package.json.
export const MANIFEST_REQUIREMENTS = Object.freeze({
  node: ['package.json'],
  electron: ['package.json'],
  python: ['pyproject.toml', 'setup.py', 'requirements.txt'],
  dotnet: ['.csproj', '.sln'],
  rust: ['Cargo.toml'],
  go: ['go.mod'],
  generic: []
})

export function manifestRequirement(stack = '') {
  const key = String(stack).toLowerCase()
  for (const [name, files] of Object.entries(MANIFEST_REQUIREMENTS)) {
    if (key.includes(name)) return { stack: name, required: files.length > 0, files }
  }
  return { stack: 'generic', required: false, files: [] }
}

// ---- Automation levels (directive 15) -------------------------------------

export const AUTOMATION_MODES = Object.freeze(['observe', 'repair', 'autonomous'])

export const ALWAYS_REQUIRES_HUMAN = Object.freeze([
  'delete_remote_repository', 'force_push', 'overwrite_uncommitted_changes',
  'delete_user_data', 'modify_credentials', 'handle_critical_security_incident',
  'modify_repository_permissions', 'publish_known_vulnerable_version'
])

export function requiresHumanConfirmation(action, mode = 'observe') {
  if (ALWAYS_REQUIRES_HUMAN.includes(action)) return true
  if (mode === 'observe') return true
  if (mode === 'repair' && /merge|publish|release|close_issue/.test(String(action))) return true
  return false
}

// ---- Monitored resources (directive 3.1) ----------------------------------

export const MONITOR_RESOURCES = Object.freeze([
  { id: 'issues', path: '/issues', label: 'Issues', scope: 'core' },
  { id: 'issue_comments', path: '/issues/comments', label: 'Issue comments', scope: 'core' },
  { id: 'pull_requests', path: '/pulls', label: 'Pull requests', scope: 'core' },
  { id: 'pr_reviews', path: '/pulls/comments', label: 'PR reviews', scope: 'core' },
  { id: 'commits', path: '/commits', label: 'Commits', scope: 'core' },
  { id: 'branches', path: '/branches', label: 'Branches', scope: 'core' },
  { id: 'releases', path: '/releases', label: 'Releases', scope: 'core' },
  { id: 'actions_runs', path: '/actions/runs', label: 'GitHub Actions', scope: 'core' },
  { id: 'security_advisories', path: '/security-advisories', label: 'Security advisories', scope: 'extended' },
  { id: 'dependabot_alerts', path: '/dependabot/alerts', label: 'Dependabot alerts', scope: 'extended' },
  { id: 'code_scanning_alerts', path: '/code-scanning/alerts', label: 'Code scanning', scope: 'extended' },
  { id: 'secret_scanning_alerts', path: '/secret-scanning/alerts', label: 'Secret scanning', scope: 'extended' },
  { id: 'repository', path: '', label: 'Repository config', scope: 'core' }
])

export const DEFAULT_POLL_INTERVALS_MS = Object.freeze({
  '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000
})

// ---- Helpers --------------------------------------------------------------

export function makeId(prefix = 'nx') {
  return `${prefix}_${crypto.randomUUID()}`
}

export function idempotencyKey(parts = []) {
  return crypto.createHash('sha256').update(parts.map(String).join('|')).digest('hex').slice(0, 40)
}

export function eventFingerprint({ repoId, kind, externalId, version = '' }) {
  return crypto.createHash('sha256')
    .update([repoId, kind, externalId, version].map(String).join('|'))
    .digest('hex').slice(0, 40)
}

// Redact anything that must never reach an AI desktop session (directive 7).
const SECRET_PATTERNS = [
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_.-]+/g,
  /["']?\b(?:authorization|proxy-authorization)\b["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic)\s+)?[^\s"',;}]+/gi,
  /["']?\b(?:api[_-]?key|access[_-]?token|github[_-]?token|token|client[_-]?secret|password|private[_-]?key)\b["']?\s*[:=]\s*["']?[^\s"',;}]+/gi,
  /(sk-[A-Za-z0-9_-]{20,})/g,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g,
  /((?:AI_API_KEY|GITHUB_TOKEN|API_KEY|ACCESS_TOKEN|CLIENT_SECRET|PASSWORD)\s*[=:]\s*\S+)/gi
]

export function redactSecrets(text = '') {
  let out = String(text)
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED_BY_NEXUS]')
  return out
}

export const SAFE_PATH_DISALLOW = Object.freeze([
  '.git', 'node_modules', '.env', 'id_rsa', 'id_ed25519', '.npmrc',
  'provider-keys.json', 'github-credentials.json', 'state.json'
])

export function isPathSensitive(relativePath = '') {
  const normalized = String(relativePath).replace(/\\/g, '/').toLowerCase()
  return SAFE_PATH_DISALLOW.some((part) => normalized.split('/').includes(part.toLowerCase())) ||
    /\.(pem|p12|pfx|key)$/i.test(normalized)
}
