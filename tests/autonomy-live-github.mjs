// Real, read-only acceptance for the Autonomy Runtime.
//
//   node tests/autonomy-live-github.mjs
//
// Requires GITHUB_TOKEN in the environment. It NEVER writes to GitHub: all
// calls are GETs against the public REST API. It also performs a real Windows
// UI Automation window discovery (read-only, no clicks, no typing).
//
// Results are written to docs/evidence/autonomy-v2-live-acceptance.json.
// No token or credential value is ever written to that file.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openAutonomyStore } from '../server/autonomy/db.mjs'
import { RepositoryMonitor } from '../server/autonomy/monitor.mjs'
import { buildTaskPackage, renderTaskPackage } from '../server/autonomy/task-package.mjs'
import { createUiaDriver } from '../server/autonomy/desktop/uia.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const token = process.env.GITHUB_TOKEN || ''
const repoName = process.env.NEXUS_LIVE_REPO || 'yuchen0x1/PROJECT-NEXUS'
const apiBase = 'https://api.github.com'

const report = {
  ranAt: new Date().toISOString(),
  credentialPresent: Boolean(token),
  repository: repoName,
  mode: 'read-only-live',
  checks: []
}

const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`)
  return pass
}

async function githubProbe() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'PROJECT-NEXUS-Acceptance/2.0',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
  const endpoints = [
    ['rate_limit', '/rate_limit'],
    ['repository', `/repos/${repoName}`],
    ['issues', `/repos/${repoName}/issues?state=all&per_page=3`],
    ['pull_requests', `/repos/${repoName}/pulls?state=all&per_page=3`],
    ['commits', `/repos/${repoName}/commits?per_page=3`],
    ['actions_runs', `/repos/${repoName}/actions/runs?per_page=3`],
    ['releases', `/repos/${repoName}/releases?per_page=3`]
  ]
  const results = []
  for (const [name, endpoint] of endpoints) {
    try {
      const response = await fetch(`${apiBase}${endpoint}`, { headers })
      const body = await response.json()
      results.push({
        name, status: response.status, hasEtag: Boolean(response.headers.get('etag')),
        rateRemaining: response.headers.get('x-ratelimit-remaining'),
        sample: Array.isArray(body) ? { count: body.length }
          : name === 'repository' ? { default_branch: body.default_branch, pushed_at: body.pushed_at }
            : name === 'rate_limit' ? { core: body.resources?.core } : { total_count: body.total_count }
      })
    } catch (error) {
      results.push({ name, error: String(error.message).slice(0, 200) })
    }
  }
  return results
}

async function incrementalSync() {
  const store = openAutonomyStore({ file: ':memory:' })
  const repo = store.put('repositories', 'live_repo', {
    id: 'live_repo', fullName: repoName, defaultBranch: 'main',
    localPath: root, pollIntervalMs: 900_000, enabled: true,
    monitorItems: ['issues', 'pull_requests', 'commits', 'releases', 'actions_runs', 'repository'],
    automationMode: 'observe'
  })
  const monitor = new RepositoryMonitor({ store, token })
  const resources = repo.monitorItems
  const first = await monitor.syncRepository(repo, { resources })
  const second = await monitor.syncRepository(repo, { resources })
  const cursors = store.list('sync_cursors')
  const result = {
    backend: store.backend, schemaVersion: store.schemaVersion,
    first: { verdict: first.verdict, resources: first.resources.length, eventCount: first.eventCount, errors: first.errors.length },
    second: { notModified: second.resources.filter((r) => r.notModified).length, eventCount: second.eventCount },
    cursors: cursors.length, etagsPersisted: cursors.filter((c) => c.etag).length,
    events: store.count('events'), findings: store.count('findings'), monitorRuns: store.count('monitor_runs')
  }
  store.close()
  return result
}

async function uiAutomation() {
  const uia = createUiaDriver()
  const probe = await uia.probe({ force: true })
  if (!probe.available) return { available: false, reason: probe.reason, windows: [] }
  const targets = []
  for (const [id, windowMatch, processName] of [
    ['chatgpt-desktop', 'ChatGPT', 'ChatGPT'],
    ['workbuddy-desktop', 'WorkBuddy', 'WorkBuddy']
  ]) {
    const result = await uia.windows({ windowMatch, processName })
    targets.push({
      id, ok: result.ok, code: result.code || null, count: result.count ?? 0,
      windows: (result.windows || []).slice(0, 3).map((w) => ({
        name: w.name, processName: w.processName, processId: w.processId, className: w.className
      }))
    })
  }
  return { available: true, reason: probe.reason, diagnostics: probe.diagnostics, targets }
}

async function packageSafety() {
  const pkg = buildTaskPackage({
    repo: { fullName: repoName, defaultBranch: 'main' },
    workspace: { path: root, branch: 'nexus/auto/live', baseSha: 'HEAD', worktree: true, isolated: true },
    findings: [{ id: 'live-1', kind: 'security', severity: 'high', priority: 'P1', title: 'Live acceptance sample', evidence: {} }],
    task: { id: 'live_acceptance' }
  })
  const rendered = renderTaskPackage(pkg)
  return {
    sections: ['Repository and workspace', 'Problems', 'Strictly forbidden', 'Required tests', 'Acceptance criteria']
      .filter((section) => rendered.includes(section)),
    containsCredential: /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/.test(rendered),
    hash: pkg.hash
  }
}

async function main() {
  console.log(`\nPROJECT NEXUS Autonomy Runtime — live read-only acceptance`)
  console.log(`Repository: ${repoName} | credential present: ${Boolean(token)}\n`)

  const probe = await githubProbe()
  report.githubProbe = probe
  check('GitHub monitoring endpoints reachable', probe.every((item) => item.status === 200),
    probe.map((item) => `${item.name}:${item.status ?? 'ERR'}`))

  if (!token) {
    check('Incremental sync (requires GITHUB_TOKEN)', false, 'skipped: no credential')
  } else {
    const sync = await incrementalSync()
    report.incrementalSync = sync
    check('First scan establishes baseline over all resources', sync.first.verdict === 'PASS' && sync.first.resources >= 6, sync.first)
    check('Second scan short-circuits with HTTP 304', sync.second.notModified >= 6, sync.second)
    check('ETag cursors persisted durably', sync.etagsPersisted >= 6, { etags: sync.etagsPersisted, cursors: sync.cursors })
    check('No duplicate events across two scans', sync.first.eventCount === sync.second.eventCount && sync.events === sync.first.eventCount,
      { events: sync.events, first: sync.first.eventCount, second: sync.second.eventCount })
  }

  const pkg = await packageSafety()
  report.taskPackage = pkg
  check('Task package contains all required sections', pkg.sections.length === 5, pkg.sections)
  check('Task package leaks no credential', pkg.containsCredential === false)

  if (process.platform === 'win32') {
    const uia = await uiAutomation()
    report.uiAutomation = uia
    check('UI Automation assembly loads', uia.available === true, { reason: uia.reason })
    if (uia.available) {
      const matched = (uia.targets || []).filter((t) => t.ok && t.count > 0)
      check('Desktop client windows identified by name/process (not coordinates)', matched.length >= 1,
        matched.map((t) => `${t.id}:${t.count}`))
    }
  } else {
    report.uiAutomation = { available: false, reason: 'UNSUPPORTED_PLATFORM' }
    check('UI Automation (non-Windows host)', true, 'skipped by platform')
  }

  report.passed = report.checks.filter((item) => item.pass).length
  report.failed = report.checks.filter((item) => !item.pass).length
  const output = path.join(root, 'docs', 'evidence', 'autonomy-v2-live-acceptance.json')
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, JSON.stringify(report, null, 2))
  console.log(`\n${report.passed} passed, ${report.failed} failed. Evidence: docs/evidence/autonomy-v2-live-acceptance.json`)
  if (report.failed) process.exitCode = 1
}

main().catch((error) => {
  console.error('Live acceptance failed:', error)
  process.exitCode = 1
})
