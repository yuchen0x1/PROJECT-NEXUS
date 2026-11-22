// Structured task package sent to a desktop AI coding client (directive 6.3).
//
// A one-line "fix all bugs" prompt is explicitly forbidden. The package carries
// evidence, scope limits, test requirements and acceptance criteria, and is
// redacted before it can ever leave NEXUS (directive 7: no tokens, passwords,
// keys or private files may reach an AI session).

import crypto from 'node:crypto'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { redactSecrets, isPathSensitive, SAFE_PATH_DISALLOW } from './model.mjs'

export const TASK_PACKAGE_VERSION = 2

export function packageHash(pkg) {
  return crypto.createHash('sha256').update(JSON.stringify(pkg)).digest('hex').slice(0, 32)
}

function safeText(value, limit = 4000) {
  return redactSecrets(String(value ?? '')).slice(0, limit)
}

/**
 * Build a complete, self-contained task package.
 *
 * @param {object} input
 * @param {object} input.repo        repository record
 * @param {object} input.workspace   { path, branch, baseSha, taskId }
 * @param {object[]} input.findings  traceable problem records
 * @param {object[]} input.references peer-project / release references
 * @param {object} input.plan        { summary, recommendedApproach, forbidden, tests, acceptance }
 */
export function buildTaskPackage({ repo = {}, workspace = {}, findings = [], references = [], plan = {}, task = {} } = {}) {
  const items = findings.map((finding) => ({
    id: safeText(finding.id, 120),
    kind: safeText(finding.kind, 80),
    severity: safeText(finding.severity, 40),
    priority: safeText(finding.priority, 10),
    title: safeText(finding.title, 400),
    evidence: redactSecrets(JSON.stringify(finding.evidence || {})).slice(0, 2000),
    relatedIssue: finding.evidence?.number ? `#${finding.evidence.number}` : null,
    codeLocations: Array.isArray(finding.codeLocations) ? finding.codeLocations.map((p) => safeText(p, 300)) : [],
    reproduction: safeText(finding.reproduction || 'See the linked issue / CI log for reproduction steps.', 1500),
    expectedOutcome: safeText(finding.expectedOutcome || 'The reported behaviour no longer occurs and a regression test covers it.', 1000)
  }))

  const pkg = {
    version: TASK_PACKAGE_VERSION,
    taskId: safeText(task.id || workspace.taskId || 'unknown', 120),
    generatedAt: new Date().toISOString(),
    repository: {
      fullName: safeText(repo.fullName, 200),
      remote: safeText(repo.remote || `https://github.com/${repo.fullName}`, 300),
      defaultBranch: safeText(repo.defaultBranch || 'main', 120)
    },
    workspace: {
      localPath: safeText(workspace.path || repo.localPath || '', 500),
      branch: safeText(workspace.branch || '', 200),
      baseCommitSha: safeText(workspace.baseSha || '', 64),
      isolated: Boolean(workspace.isolated),
      worktree: Boolean(workspace.worktree)
    },
    objective: safeText(plan.summary || 'Analyse the project, fix the listed problems, run the full verification suite and report the result.', 2000),
    findings: items,
    linkedIssues: items.map((item) => item.relatedIssue).filter(Boolean),
    peerReferences: references.map((reference) => ({
      project: safeText(reference.project, 200),
      license: safeText(reference.license, 80),
      change: safeText(reference.change, 500),
      note: safeText(reference.note, 500),
      licenseCompatible: Boolean(reference.licenseCompatible)
    })).filter((reference) => reference.licenseCompatible !== false || reference.note),
    recommendedApproach: safeText(plan.recommendedApproach || 'Read the affected code first, make the smallest correct change, then add or update tests.', 3000),
    forbidden: [
      'Do not modify .git internals, lockfiles of unrelated packages, or any credential/secret file.',
      'Do not run destructive git commands (reset --hard, push --force, clean -fd, branch -D).',
      'Do not commit, push, create PRs or publish releases - NEXUS performs delivery after independent acceptance.',
      'Do not add dependencies without explaining why in the report.',
      ...SAFE_PATH_DISALLOW.map((entry) => `Do not read or modify ${entry}.`),
      ...(plan.forbidden || []).map((entry) => safeText(entry, 300))
    ],
    tests: (plan.tests && plan.tests.length ? plan.tests : ['Run the project test suite', 'Run the build', 'Run lint / typecheck where configured'])
      .map((entry) => safeText(entry, 300)),
    acceptance: (plan.acceptance && plan.acceptance.length ? plan.acceptance : [
      'Every listed problem is addressed with a code change.',
      'All tests and the build pass in the isolated workspace.',
      'The diff contains no secret, no deleted user file and no out-of-scope change.',
      'NEXUS independently re-runs verification; a self-reported "done" is not acceptance.'
    ]).map((entry) => safeText(entry, 400)),
    documentation: [
      'Update README / docs where behaviour changes.',
      'Add a CHANGELOG entry describing the fix (no version bump; NEXUS computes the version).',
      'Report changed files, test commands and results at the end of the session.'
    ],
    reportFormat: 'End with a short report: changed files, tests executed, remaining risks.'
  }
  pkg.hash = packageHash(pkg)
  return pkg
}

export function renderTaskPackage(pkg) {
  const lines = [
    `# PROJECT NEXUS autonomous task ${pkg.taskId}`,
    '',
    `Package version ${pkg.version} · generated ${pkg.generatedAt} · hash ${pkg.hash}`,
    '',
    '## Repository and workspace',
    '',
    `- Repository: ${pkg.repository.fullName}`,
    `- Remote: ${pkg.repository.remote}`,
    `- Default branch: ${pkg.repository.defaultBranch}`,
    `- Local path (work here ONLY): ${pkg.workspace.localPath}`,
    `- Task branch: ${pkg.workspace.branch || '(not set)'}`,
    `- Base commit SHA: ${pkg.workspace.baseCommitSha || '(not set)'}`,
    `- Isolated worktree: ${pkg.workspace.worktree ? 'yes' : 'no'}`,
    '',
    '## Objective',
    '',
    pkg.objective,
    '',
    `## Problems (${pkg.findings.length})`,
    ''
  ]
  for (const [index, finding] of pkg.findings.entries()) {
    lines.push(`### ${index + 1}. [${finding.priority}/${finding.severity}] ${finding.title}`, '')
    lines.push(`- ID: ${finding.id}`, `- Kind: ${finding.kind}`)
    if (finding.relatedIssue) lines.push(`- Linked issue: ${finding.relatedIssue}`)
    if (finding.codeLocations.length) lines.push(`- Code locations: ${finding.codeLocations.join(', ')}`)
    lines.push(`- Evidence: ${finding.evidence}`, '')
    lines.push(`- Reproduction: ${finding.reproduction}`, '')
    lines.push(`- Expected outcome: ${finding.expectedOutcome}`, '')
  }
  if (pkg.peerReferences.length) {
    lines.push('## Peer-project references (license checked)', '')
    for (const ref of pkg.peerReferences) lines.push(`- ${ref.project} (${ref.license || 'license unknown'}): ${ref.change} ${ref.note}`)
    lines.push('')
  }
  lines.push('## Recommended approach', '', pkg.recommendedApproach, '')
  lines.push('## Strictly forbidden', '')
  for (const entry of pkg.forbidden) lines.push(`- ${entry}`)
  lines.push('', '## Required tests', '')
  for (const entry of pkg.tests) lines.push(`- ${entry}`)
  lines.push('', '## Acceptance criteria (verified independently by NEXUS)', '')
  for (const entry of pkg.acceptance) lines.push(`- ${entry}`)
  lines.push('', '## Documentation and changelog', '')
  for (const entry of pkg.documentation) lines.push(`- ${entry}`)
  lines.push('', pkg.reportFormat, '')
  return redactSecrets(lines.join('\n'))
}

/** Scan BOTH the structured package and its rendering before it may leave. */
export function auditPackageSecrets(pkg) {
  // renderTaskPackage redacts its output, so checking only the rendered text
  // would always pass. Inspect the raw structured fields as well.
  const raw = JSON.stringify({
    objective: pkg.objective, findings: pkg.findings, peerReferences: pkg.peerReferences,
    recommendedApproach: pkg.recommendedApproach, workspace: pkg.workspace,
    tests: pkg.tests, acceptance: pkg.acceptance
  })
  const leaked = []
  const patterns = [
    [/\bgh[pousr]_[A-Za-z0-9_.-]+/g, 'GitHub token'],
    [/\bgithub_pat_[A-Za-z0-9_.-]+/g, 'GitHub fine-grained token'],
    [/sk-[A-Za-z0-9_-]{20,}/g, 'API key'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'private key']
  ]
  const rendered = renderTaskPackage(pkg)
  for (const [pattern, label] of patterns) {
    pattern.lastIndex = 0
    if (pattern.test(raw) || pattern.test(rendered)) {
      if (!leaked.includes(label)) leaked.push(label)
    }
  }
  const sensitivePaths = [...pkg.findings.flatMap((f) => f.codeLocations || []), pkg.workspace.localPath]
    .filter((entry) => isPathSensitive(entry))
  return { safe: leaked.length === 0 && sensitivePaths.length === 0, leaked, sensitivePaths }
}

export async function writeTaskPackage(directory, pkg) {
  await fsp.mkdir(directory, { recursive: true })
  const file = path.join(directory, `task-${String(pkg.taskId).replace(/[^A-Za-z0-9._-]/g, '_')}.md`)
  await fsp.writeFile(file, renderTaskPackage(pkg), 'utf8')
  return file
}
