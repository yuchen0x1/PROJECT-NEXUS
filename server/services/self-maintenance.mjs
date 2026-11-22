import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EvolutionStore } from './evolution-store.mjs'
import { runCommand } from './agent/executor.mjs'
import { redactSecrets } from './ai-provider.mjs'

const fail = (code, message) => Object.assign(new Error(message), { code })
export class SelfMaintenance {
  constructor({ dataDir, engine, scheduler, project, request, execute = runCommand }) {
    this.policy = new EvolutionStore(dataDir, 'self-policy'); this.assessments = new EvolutionStore(dataDir, 'self-assessments')
    this.engine = engine; this.scheduler = scheduler; this.project = project; this.request = request; this.execute = execute
    this.controllers = new Map()
    this.starting = false; this.lastError = null
  }
  async getPolicy() { return await this.policy.get('nexus') || { id: 'nexus', enabled: false, projectId: null, intervalMinutes: 1440, allowCandidate: false, installationRequiresConfirmation: true, remoteWrites: false } }
  async setPolicy({ confirm, projectId, enabled, intervalMinutes = 1440, allowCandidate = false }) {
    if (confirm !== true || typeof enabled !== 'boolean' || typeof allowCandidate !== 'boolean') throw fail('SELF_POLICY_CONFIRM_REQUIRED', 'Explicit self-maintenance policy confirmation is required.')
    await this.project(projectId)
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 60 || intervalMinutes > 10080) throw fail('SELF_POLICY_INVALID', 'Choose a self-maintenance interval between 60 minutes and one week.')
    return this.policy.update('nexus', () => ({ id: 'nexus', projectId, enabled, intervalMinutes, allowCandidate, installationRequiresConfirmation: true, remoteWrites: false }))
  }
  async startAssessment(projectId) {
    if (this.controllers.size || this.starting) throw fail('SELF_MAINTENANCE_BUSY', 'A self-maintenance diagnostic is already running.')
    this.starting = true
    try {
    await this.project(projectId)
    const id = crypto.randomUUID(), controller = new AbortController()
    const record = await this.assessments.update(id, () => ({ id, projectId, status: 'Queued', createdAt: new Date().toISOString(), installationAuthorized: false }))
    this.controllers.set(id, controller)
    void this.assess(projectId, { signal: controller.signal, assessmentId: id }).catch(async (cause) => {
      this.lastError = { code: cause.code || cause.name, at: new Date().toISOString() }
      await this.assessments.update(id, (current) => ({ ...current, status: 'Blocked', errorCode: cause.code || cause.name, finishedAt: new Date().toISOString() })).catch(() => {})
    }).finally(() => this.controllers.delete(id))
    return record
    } finally { this.starting = false }
  }
  async tick() {
    const policy = await this.getPolicy()
    if (!policy.enabled || this.controllers.size || (Date.now() - Date.parse(policy.lastAssessmentAt || '1970-01-01')) < policy.intervalMinutes * 60000) return
    await this.startAssessment(policy.projectId)
    await this.policy.update('nexus', (record) => ({ ...record, lastAssessmentAt: new Date().toISOString() }))
  }
  async assess(projectId, { signal, assessmentId } = {}) {
    const project = await this.project(projectId)
    const manifest = JSON.parse(await fs.readFile(path.join(project.path, 'package.json'), 'utf8'))
    if (manifest.name !== 'project-nexus') throw fail('SELF_PROJECT_MISMATCH', 'Self maintenance only accepts the registered PROJECT NEXUS source repository.')
    const remote = await this.execute({ cwd: project.path, command: 'git remote get-url origin', timeoutMs: 15000, signal })
    if (!remote.ok || !/^(?:git@github\.com:|https:\/\/github\.com\/)yuchen0x1\/PROJECT-NEXUS(?:\.git)?$/i.test(remote.stdout.trim())) throw fail('SELF_REMOTE_MISMATCH', 'The selected source repository must have the expected PROJECT NEXUS origin.')
    const id = assessmentId || crypto.randomUUID()
    await this.assessments.update(id, () => ({ id, projectId, status: 'Running', createdAt: new Date().toISOString(), version: manifest.version, checks: [] }))
    try {
      const [head, dirty, audit, outdated, latest] = await Promise.all([
        this.execute({ cwd: project.path, command: 'git rev-parse HEAD', timeoutMs: 15000, signal }),
        this.execute({ cwd: project.path, command: 'git status --porcelain', timeoutMs: 15000, signal }),
        this.execute({ cwd: project.path, command: 'npm audit --json --package-lock-only --registry=https://registry.npmjs.org', timeoutMs: 120000, outputLimitBytes: 2000000, signal }),
        this.execute({ cwd: project.path, command: 'npm outdated --json --registry=https://registry.npmjs.org', timeoutMs: 120000, outputLimitBytes: 2000000, signal }),
        this.request('/repos/yuchen0x1/PROJECT-NEXUS/releases/latest')
      ])
      signal?.throwIfAborted()
      let auditReport, outdatedReport
      try { auditReport = JSON.parse(audit.stdout); outdatedReport = JSON.parse(outdated.stdout || '{}') } catch { throw fail('SELF_DIAGNOSIS_UNAVAILABLE', 'Dependency diagnostics returned an invalid response; no clean assessment can be claimed.') }
      if (!head.ok || !dirty.ok || auditReport.error || !auditReport.metadata?.vulnerabilities || outdatedReport.error || ![0, 1].includes(outdated.exitCode)) throw fail('SELF_DIAGNOSIS_UNAVAILABLE', 'A required source or dependency diagnostic was unavailable.')
      const suggestions = []
      if (auditReport.metadata.vulnerabilities.total) suggestions.push({ title: 'Review dependency vulnerabilities with compatible version changes', priority: 'P1', source: 'npm-audit' })
      if (Object.keys(outdatedReport).length) suggestions.push({ title: 'Review outdated dependencies and compatibility', priority: 'P3', source: 'npm-outdated' })
      if (!manifest.scripts?.lint) suggestions.push({ title: 'Add a source correctness lint gate', priority: 'P2', source: 'package.json:scripts' })
      return await this.assessments.update(id, (record) => ({ ...record, status: 'Completed', finishedAt: new Date().toISOString(), headSha: head.stdout.trim(), workingTreeClean: !dirty.stdout.trim(), latestRelease: { tag: latest.tag_name, publishedAt: latest.published_at, url: latest.html_url }, vulnerabilities: auditReport.metadata.vulnerabilities, outdated: Object.entries(outdatedReport).slice(0, 100).map(([name, value]) => ({ name, current: value.current, wanted: value.wanted, latest: value.latest })), quality: { lintConfigured: Boolean(manifest.scripts?.lint), typecheckConfigured: Boolean(manifest.scripts?.typecheck), testConfigured: Boolean(manifest.scripts?.test), testsExecutedByAssessment: false }, suggestions, installationAuthorized: false }))
    } catch (cause) {
      await this.assessments.update(id, (record) => ({ ...record, status: 'Blocked', errorCode: cause.code || cause.name, finishedAt: new Date().toISOString() }))
      throw cause
    }
  }
  async candidate(assessmentId, { projectId, confirm, sourceDisclosureConfirmed, executionConsent, providerIds = {}, requestId }) {
    const assessment = await this.assessments.get(assessmentId), policy = await this.getPolicy()
    if (!assessment || assessment.status !== 'Completed') throw fail('SELF_ASSESSMENT_REQUIRED', 'Complete a source assessment before generating a candidate.')
    if (confirm !== true || sourceDisclosureConfirmed !== true || executionConsent !== true || !policy.allowCandidate || policy.projectId !== assessment.projectId || projectId !== assessment.projectId) throw fail('SELF_CANDIDATE_CONFIRM_REQUIRED', 'The independent self-maintenance policy and this candidate both require explicit confirmation for the selected project.')
    const project = await this.project(assessment.projectId)
    const [head, dirty] = await Promise.all([this.execute({ cwd: project.path, command: 'git rev-parse HEAD', timeoutMs: 15000 }), this.execute({ cwd: project.path, command: 'git status --porcelain', timeoutMs: 15000 })])
    if (!head.ok || !dirty.ok || dirty.stdout.trim() || head.stdout.trim() !== assessment.headSha) throw fail('SELF_SOURCE_CHANGED', 'Source changed or has uncommitted work; reassess a clean source tree before generating a candidate.')
    const workflow = await this.engine.create({ projectId: assessment.projectId, kind: 'self-maintenance', requestId, providerIds, prompt: redactSecrets(`Maintain PROJECT NEXUS in a separate development workspace. Address only the verified assessment findings below with compatible, focused changes and regression tests. Do not modify the running installation, install an update, push or publish.\n${JSON.stringify({ vulnerabilities: assessment.vulnerabilities, outdated: assessment.outdated, suggestions: assessment.suggestions })}`), metadata: { assessmentId, sourceDisclosureConfirmed: true, executionConsent: true, installationAuthorized: false } })
    await this.assessments.update(assessmentId, (record) => ({ ...record, candidateWorkflowId: workflow.id, candidateStatus: 'Queued' }))
    this.scheduler.enqueue(workflow.id)
    return workflow
  }
}
