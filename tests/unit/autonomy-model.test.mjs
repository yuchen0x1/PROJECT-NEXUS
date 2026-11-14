import { describe, expect, it } from 'vitest'
import {
  PRIORITIES, priorityFromFinding, canTransitionTask, assertTaskTransition,
  canTransitionAgent, assertAgentTransition, AGENT_STATES,
  evaluateIssueLifecycle, ISSUE_LIFECYCLES, manifestRequirement,
  requiresHumanConfirmation, ALWAYS_REQUIRES_HUMAN,
  eventFingerprint, idempotencyKey, redactSecrets, isPathSensitive,
  MONITOR_RESOURCES
} from '../../server/autonomy/model.mjs'
import { buildTaskPackage, renderTaskPackage, auditPackageSecrets, packageHash } from '../../server/autonomy/task-package.mjs'

describe('autonomy domain model', () => {
  it('orders P0-P4 and derives priority from real finding kinds', () => {
    expect(PRIORITIES).toEqual(['P0', 'P1', 'P2', 'P3', 'P4'])
    expect(priorityFromFinding({ kind: 'secret_leak' })).toBe('P0')
    expect(priorityFromFinding({ kind: 'security:cve', severity: 'high' })).toBe('P1')
    expect(priorityFromFinding({ kind: 'build_failure' })).toBe('P1')
    expect(priorityFromFinding({ kind: 'bug' })).toBe('P2')
    expect(priorityFromFinding({ kind: 'porting' })).toBe('P3')
    expect(priorityFromFinding({ kind: 'documentation' })).toBe('P4')
  })

  it('forbids jumping straight from QUEUED to ACCEPTED', () => {
    expect(canTransitionTask('QUEUED', 'DISPATCHED')).toBe(true)
    expect(canTransitionTask('QUEUED', 'ACCEPTED')).toBe(false)
    expect(() => assertTaskTransition('QUEUED', 'ACCEPTED')).toThrowError(/Illegal task transition/)
    expect(canTransitionTask('ACCEPTED', 'QUEUED')).toBe(false)
  })

  it('defines all 16 desktop agent states with legal transitions only', () => {
    expect(AGENT_STATES).toHaveLength(16)
    expect(canTransitionAgent('NOT_STARTED', 'STARTING')).toBe(true)
    expect(canTransitionAgent('RUNNING', 'AWAITING_AUTHORIZATION')).toBe(true)
    expect(canTransitionAgent('SUCCEEDED', 'RUNNING')).toBe(false)
    expect(() => assertAgentTransition('SUCCEEDED', 'RUNNING')).toThrowError(/Illegal agent transition/)
  })

  it('never treats a closed GitHub issue as resolved without evidence', () => {
    const closed = { state: 'closed' }
    expect(ISSUE_LIFECYCLES).toHaveLength(9)
    expect(evaluateIssueLifecycle(closed, {})).toBe('UNCONFIRMABLE')
    expect(evaluateIssueLifecycle(closed, {
      linkedPullRequest: 12, pullRequestMerged: true, relatedCommits: ['abc'],
      fixPresentInTargetBranch: true, testsPassed: true, reproducible: false,
      reviewApproved: true
    })).toBe('VERIFIED_RESOLVED')
    expect(evaluateIssueLifecycle(closed, {
      linkedPullRequest: 12, pullRequestMerged: true, relatedCommits: ['abc'],
      fixPresentInTargetBranch: false, testsPassed: false, reproducible: false,
      reviewApproved: false
    })).toBe('UNRESOLVED')
  })

  it('detects regressions and reappearance from new comments', () => {
    expect(evaluateIssueLifecycle({ state: 'closed' }, { regressionDetected: true })).toBe('REAPPEARED')
    expect(evaluateIssueLifecycle({ state: 'closed' }, { newCommentsReportingProblem: 1 })).toBe('REAPPEARED')
    expect(evaluateIssueLifecycle({ state: 'open' }, { previouslyVerified: true })).toBe('REAPPEARED')
  })

  it('requires a manifest only for stacks that actually need one', () => {
    expect(manifestRequirement('node')).toMatchObject({ required: true, files: ['package.json'] })
    expect(manifestRequirement('python').files).toContain('pyproject.toml')
    expect(manifestRequirement('documentation-only')).toMatchObject({ required: false, files: [] })
    expect(manifestRequirement('')).toMatchObject({ required: false })
  })

  it('always requires human confirmation for destructive actions', () => {
    for (const action of ALWAYS_REQUIRES_HUMAN) {
      expect(requiresHumanConfirmation(action, 'autonomous')).toBe(true)
    }
    expect(requiresHumanConfirmation('merge_pull_request', 'repair')).toBe(true)
    expect(requiresHumanConfirmation('create_branch', 'observe')).toBe(true)
    expect(requiresHumanConfirmation('create_branch', 'autonomous')).toBe(false)
  })

  it('produces stable fingerprints and idempotency keys', () => {
    const first = eventFingerprint({ repoId: 'r1', kind: 'issues', externalId: '42', version: 'v1' })
    expect(first).toBe(eventFingerprint({ repoId: 'r1', kind: 'issues', externalId: '42', version: 'v1' }))
    expect(first).not.toBe(eventFingerprint({ repoId: 'r1', kind: 'issues', externalId: '42', version: 'v2' }))
    expect(idempotencyKey(['r1', 'fix', 'a,b'])).toBe(idempotencyKey(['r1', 'fix', 'a,b']))
  })

  it('redacts credentials and flags sensitive paths', () => {
    const leaked = `token=ghp_${'a'.repeat(30)} and AI_API_KEY=supersecret123`
    const redacted = redactSecrets(leaked)
    expect(redacted).not.toContain('ghp_')
    expect(redacted).toContain('[REDACTED_BY_NEXUS]')
    expect(isPathSensitive('.env')).toBe(true)
    expect(isPathSensitive('src/server/id_rsa')).toBe(true)
    expect(isPathSensitive('src/app.ts')).toBe(false)
  })

  it('covers 13 monitored resource definitions', () => {
    expect(MONITOR_RESOURCES.length).toBeGreaterThanOrEqual(13)
    const ids = MONITOR_RESOURCES.map((r) => r.id)
    for (const required of ['issues', 'pull_requests', 'commits', 'releases', 'actions_runs', 'dependabot_alerts', 'code_scanning_alerts', 'secret_scanning_alerts', 'repository']) {
      expect(ids).toContain(required)
    }
  })
})

describe('task package', () => {
  const repo = { fullName: 'acme/widget', defaultBranch: 'main' }
  const workspace = { path: 'C:/work/wt', branch: 'nexus/auto/t1', baseSha: 'deadbeef', isolated: true, worktree: true, taskId: 'task_1' }
  const findings = [{ id: 'f1', kind: 'bug', severity: 'high', priority: 'P1', title: 'Crash on startup', evidence: { number: 7 }, reproduction: 'Launch twice', expectedOutcome: 'No crash' }]

  it('contains every required section from directive 6.3', () => {
    const pkg = buildTaskPackage({ repo, workspace, findings, task: { id: 'task_1' } })
    expect(pkg.workspace.baseCommitSha).toBe('deadbeef')
    expect(pkg.findings).toHaveLength(1)
    expect(pkg.linkedIssues).toEqual(['#7'])
    expect(pkg.tests.length).toBeGreaterThan(0)
    expect(pkg.acceptance.length).toBeGreaterThan(0)
    expect(pkg.documentation.length).toBeGreaterThan(0)
    expect(pkg.forbidden.join(' ')).toContain('push')
    const rendered = renderTaskPackage(pkg)
    for (const heading of ['Repository and workspace', 'Problems', 'Strictly forbidden', 'Required tests', 'Acceptance criteria']) {
      expect(rendered).toContain(heading)
    }
    expect(rendered).toContain('deadbeef')
  })

  it('redacts credentials at construction and still blocks hand-crafted leaks', () => {
    const token = `ghp_${'b'.repeat(30)}`
    const safe = buildTaskPackage({ repo, workspace, findings, task: { id: 'task_2' }, plan: { summary: `use ${token}` } })
    expect(safe.objective).not.toContain('ghp_')
    expect(auditPackageSecrets(safe).safe).toBe(true)
    const raw = { ...safe, objective: `use ghp_${'c'.repeat(30)}` }
    const audit = auditPackageSecrets(raw)
    expect(audit.safe).toBe(false)
    expect(audit.leaked).toContain('GitHub token')
  })

  it('changes the hash when the content changes', () => {
    const a = buildTaskPackage({ repo, workspace, findings, task: { id: 'task_3' } })
    const b = buildTaskPackage({ repo, workspace, findings: [], task: { id: 'task_3' } })
    expect(packageHash(a)).not.toBe(packageHash(b))
  })
})
