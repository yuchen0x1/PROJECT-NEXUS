import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openAutonomyStore } from '../../server/autonomy/db.mjs'
import {
  detectVerificationCommands, runCommand, verifyTask, scanDiffForSecrets,
  computeNextVersion, classifyChange, buildReleaseNotes, evaluateReleaseGate
} from '../../server/autonomy/reviewer.mjs'
import { createWorkspaceManager } from '../../server/autonomy/workspace.mjs'
import {
  assessReadiness, detectStackHint, licenseAssessment, discoverPeerProjects,
  analyzePortingOpportunity, createPortingProposal
} from '../../server/autonomy/intelligence.mjs'

const dirs = []
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-autonomy-review-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 })))
})

const cleanDiff = { fileCount: 1, changedFiles: [{ path: 'src/a.ts', status: 'M' }], deletedFiles: [], sensitiveFiles: [], patch: '+ const fixed = true', baseSha: 'abc', stat: '1 file' }

describe('independent reviewer', () => {
  it('discovers commands from package.json and CI without assuming npm test exists', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build', lint: 'eslint .' } }))
    await fs.mkdir(path.join(dir, '.github', 'workflows'), { recursive: true })
    await fs.writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'), 'jobs:\n  build:\n    steps:\n      - run: npm ci\n      - run: npm test\n')
    const found = await detectVerificationCommands(dir)
    expect(found.commands.map((c) => c.name)).toEqual(['test', 'build', 'lint'])
    expect(found.hasTests).toBe(true)
    expect(found.ciCommands).toContain('npm test')
    expect(found.commands[0].argv[0]).toMatch(/^npm(\.cmd)?$/)

    const empty = await detectVerificationCommands(await tempDir())
    expect(empty.commands).toHaveLength(0)
    expect(empty.notes.join(' ')).toContain('No package.json')
  })

  it('refuses commands outside the program allowlist', async () => {
    const result = await runCommand(['powershell.exe', '-Command', 'Remove-Item -Recurse -Force C:\\'], { cwd: await tempDir() })
    expect(result.pass).toBe(false)
    expect(result.output).toContain('not allowlisted')
  })

  it('passes only with real command results, scope and security all clean', async () => {
    const store = openAutonomyStore({ file: ':memory:' })
    const workspace = { taskId: 't1', repoId: 'r1', path: await tempDir() }
    const execImpl = (_program, _args, _options, callback) => callback(null, 'all tests passed', '')
    const pass = await verifyTask({
      store, workspace, diff: cleanDiff,
      commands: { commands: [{ name: 'test', argv: ['npm', 'run', 'test'], source: 'package.json', required: true }], hasTests: true, hasBuild: false, notes: [] },
      execImpl, scopeReview: { pass: true, violations: [] }
    })
    expect(pass.verdict).toBe('PASS')
    expect(pass.results[0].pass).toBe(true)
    expect(store.count('verification_reports')).toBe(1)

    const failing = await verifyTask({
      store, workspace, diff: cleanDiff,
      commands: { commands: [{ name: 'test', argv: ['npm', 'run', 'test'], source: 'package.json', required: true }], hasTests: true, hasBuild: false, notes: [] },
      execImpl: (_p, _a, _o, cb) => cb(new Error('tests failed'), '', 'FAIL'),
      scopeReview: { pass: true, violations: [] }
    })
    expect(failing.verdict).toBe('FAIL')
    expect(failing.failures[0].code).toBe('REQUIRED_COMMAND_FAILED')
  })

  it('fails acceptance for opaque installation credentials, authorization fields, deletion or no change', () => {
    expect(scanDiffForSecrets(cleanDiff).pass).toBe(true)
    const installationToken = `ghs_${'k9.m-R_s'.repeat(65)}`
    expect(scanDiffForSecrets({ ...cleanDiff, patch: `const token = '${installationToken}'` }).pass).toBe(false)
    expect(scanDiffForSecrets({ ...cleanDiff, patch: `const headers = { Authorization: 'Bearer ${installationToken}' }` }).pass).toBe(false)
    expect(scanDiffForSecrets({ ...cleanDiff, deletedFiles: ['src/important.ts'] }).pass).toBe(false)
  })

  it('computes semantic versions from change nature, not on every scan', () => {
    expect(computeNextVersion('1.2.3', 'patch')).toBe('1.2.4')
    expect(computeNextVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(computeNextVersion('1.2.3', 'major')).toBe('2.0.0')
    expect(classifyChange([{ kind: 'bug fix', title: 'fix crash' }], cleanDiff)).toBe('patch')
    expect(classifyChange([{ kind: 'feature', title: 'new capability' }], cleanDiff)).toBe('minor')
    expect(classifyChange([{ kind: 'breaking', title: 'remove api' }], cleanDiff)).toBe('major')
  })

  it('blocks a release unless every independent gate is open', () => {
    const report = { id: 'v1', verdict: 'PASS', security: { pass: true }, results: [{ pass: true }] }
    const base = { repo: { id: 'r1', fullName: 'acme/a', autoRelease: true }, task: { id: 't1' }, diff: cleanDiff, report,
      automationMode: 'autonomous', remoteWritesEnabled: true, explicitApproval: true }
    const open = evaluateReleaseGate(base)
    expect(open.allowed).toBe(true)
    expect(open.contentFingerprint).toMatch(/^[a-f0-9]{32}$/)
    expect(evaluateReleaseGate({ ...base, report: { ...report, verdict: 'FAIL' } }).blockers[0].code).toBe('VERIFICATION_FAILED')
    expect(evaluateReleaseGate({ ...base, automationMode: 'repair' }).blockers.map((b) => b.code)).toContain('AUTOMATION_MODE_INSUFFICIENT')
    expect(evaluateReleaseGate({ ...base, explicitApproval: false }).blockers.map((b) => b.code)).toContain('RELEASE_APPROVAL_MISSING')
    expect(evaluateReleaseGate({ ...base, existingRelease: { contentFingerprint: open.contentFingerprint } }).blockers.map((b) => b.code)).toContain('DUPLICATE_RELEASE')
    expect(evaluateReleaseGate({ ...base, criticalFindings: 1 }).blockers.map((b) => b.code)).toContain('CRITICAL_FINDINGS_OPEN')
    const notes = buildReleaseNotes({ version: '1.0.1', repo: base.repo, task: base.task, findings: [], report, diff: cleanDiff })
    expect(notes).toContain('v1.0.1')
    expect(notes).toContain('PASS')
  })
})

describe('git worktree isolation', () => {
  it('refuses to work on a dirty original tree', async () => {
    const dir = await tempDir()
    const execImpl = (_program, args, _options, callback) => {
      if (args[0] === 'status') return callback(null, ' M src/user-edit.ts\n', '')
      return callback(null, 'abc123', '')
    }
    const manager = createWorkspaceManager({ dataDir: dir, execImpl })
    await expect(manager.prepare({ id: 'r1', fullName: 'acme/a', localPath: dir }, { taskId: 't1' }))
      .rejects.toThrowError(/uncommitted changes|USER_WORKTREE_DIRTY/)
  })

  it('creates an isolated branch off HEAD, never on main/master', async () => {
    const dir = await tempDir()
    const calls = []
    const execImpl = (_program, args, _options, callback) => {
      calls.push(args)
      if (args[0] === 'status') return callback(null, '', '')
      if (args[0] === 'rev-parse') return callback(null, 'abc123', '')
      return callback(null, '', '')
    }
    const manager = createWorkspaceManager({ dataDir: dir, execImpl })
    const ws = await manager.prepare({ id: 'r1', fullName: 'acme/a', localPath: dir }, { taskId: 't1' })
    expect(ws.branch).toBe('nexus/auto/t1')
    expect(ws.baseSha).toBe('abc123')
    expect(ws.isolated).toBe(true)
    expect(calls.some((args) => args[0] === 'worktree' && args[1] === 'add')).toBe(true)
    expect(manager.reviewScope({ ...cleanDiff, deletedFiles: ['src/a.ts'] }).pass).toBe(false)
    expect(manager.reviewScope({ ...cleanDiff, sensitiveFiles: ['.env'] }).pass).toBe(false)
    expect(manager.reviewScope({ fileCount: 0, changedFiles: [], deletedFiles: [], sensitiveFiles: [], patch: '' }).pass).toBe(false)
  })
})

describe('readiness and project intelligence', () => {
  it('does NOT block desktop mode when no AI API key is configured', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'package.json'), '{}')
    const store = openAutonomyStore({ file: ':memory:' })
    const adapters = [{ id: 'chatgpt-desktop', name: 'ChatGPT Desktop', installed: true, running: true, loginState: 'UNKNOWN', uia: { available: true } }]
    const result = await assessReadiness({
      store, repo: { localPath: dir, agentAdapterId: 'chatgpt-desktop', automationMode: 'repair' },
      mode: 'desktop', aiApiConfigured: false, adapters, hasScanned: true, taskCount: 1
    })
    expect(result.overall).toBe('READY')
    expect(result.blockingCodes).toEqual([])
    expect(result.desktopIndependentOfApi).toBe(true)
    expect(result.checks.find((c) => c.id === 'AI_API').blocks).toEqual([])

    const apiMode = await assessReadiness({ store, repo: { localPath: dir }, mode: 'api', aiApiConfigured: false, adapters, hasScanned: true, taskCount: 1 })
    expect(apiMode.blockingCodes).toContain('AI_API_NOT_CONFIGURED')
  })

  it('reports non-blocking conditions separately from hard blockers', async () => {
    const store = openAutonomyStore({ file: ':memory:' })
    const result = await assessReadiness({ store, repo: {}, mode: 'desktop', aiApiConfigured: false, adapters: [], hasScanned: false, taskCount: 0 })
    expect(result.blockingCodes).toContain('DESKTOP_CLIENT_NOT_CONNECTED')
    expect(result.conditions).toContain('NO_TASK_GENERATED')
    expect(result.conditions).toContain('REPOSITORY_SCAN_PENDING')
    expect(result.conditions).not.toContain('AI_API_NOT_CONFIGURED')
    expect(await detectStackHint(await tempDir())).toBe('generic')
  })

  it('enforces licence compatibility and prohibits copying unlicensed code', () => {
    expect(licenseAssessment('MIT').compatible).toBe(true)
    expect(licenseAssessment('Apache-2.0').compatible).toBe(true)
    expect(licenseAssessment('GPL-3.0').compatible).toBe(false)
    expect(licenseAssessment(null).prohibited).toBe(true)
    expect(licenseAssessment('SSPL-1.0').compatible).toBe(false)
  })

  it('produces a 12-point porting analysis with a licence verdict', () => {
    const analysis = analyzePortingOpportunity({
      peer: { fullName: 'peer/tool', license: 'MIT' },
      change: { title: 'feat: add offline queue', body: 'Adds a durable queue for offline tasks.' },
      currentProject: { existingCapabilities: [], candidateFiles: ['server/queue.mjs'] }
    })
    expect(analysis.analysis).toHaveLength(12)
    expect(analysis.copyPermitted).toBe(true)
    expect(analysis.attributionRequired).toBe(true)
    const blocked = analyzePortingOpportunity({
      peer: { fullName: 'peer/gpl', license: 'GPL-3.0' },
      change: { title: 'feat: offline queue', body: 'Adds a queue.' }, currentProject: { existingCapabilities: [] }
    })
    expect(blocked.copyPermitted).toBe(false)
    expect(blocked.requiresLegalReview).toBe(true)

    const store = openAutonomyStore({ file: ':memory:' })
    const proposal = createPortingProposal({ store, repo: { id: 'r1', fullName: 'acme/a' }, peer: { fullName: 'peer/tool' }, change: {}, analysis })
    expect(proposal.status).toBe('SUGGESTED')
    expect(store.count('porting_proposals')).toBe(1)
  })

  it('discovers real peer repositories through the GitHub Search API shape', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ total_count: 1, items: [{
        full_name: 'peer/tool', name: 'tool', description: 'A tool', language: 'TypeScript',
        stargazers_count: 1200, forks_count: 90, license: { spdx_id: 'MIT' },
        pushed_at: '2026-01-01T00:00:00Z', topics: ['ai'], html_url: 'https://github.com/peer/tool',
        default_branch: 'main', open_issues_count: 3
      }] })
    })
    const found = await discoverPeerProjects({ query: 'ai agent', topics: ['ai'], token: 'test', fetchImpl })
    expect(found.ok).toBe(true)
    expect(found.items[0]).toMatchObject({ fullName: 'peer/tool', license: 'MIT', discoverySource: 'github-search-api' })
    expect(found.items[0].qualitySource).toBe('code-and-release-analysis')
  })
})
