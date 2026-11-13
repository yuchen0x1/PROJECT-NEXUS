import { CollaborationEngine, AGENT_ROLES } from './collaboration-engine.mjs'
import { createCollaborationRoles } from './collaboration-roles.mjs'
import { ProjectMemory } from './project-memory.mjs'
import { ResourceGovernor } from './resource-governor.mjs'
import { WorkflowScheduler } from './workflow-scheduler.mjs'
import { listLocalProjects } from './local-projects.mjs'
import { resolveProviderForInvocation } from './provider-store.mjs'
import { SelfMaintenance } from './self-maintenance.mjs'
import { SoftwareUpdates } from './software-updates.mjs'
import { getLocalAgentTask } from './local-agent-tasks.mjs'

export function registerEvolutionApi({ app, dataDir, version, guard, request, getResearchEvidence, isProposalLinked = async () => false }) {
  const memory = new ProjectMemory(dataDir), governor = new ResourceGovernor({ dataDir })
  let engine
  const roles = createCollaborationRoles({ dataDir, memory, getResearchEvidence, onTask: async (workflowId, nodeId, taskId) => {
    await engine.store.update(workflowId, (record) => { record.nodes.find((node) => node.id === nodeId).taskId = taskId; return record })
  }, onProvider: async (workflowId, role, provider) => {
    await engine.store.update(workflowId, (record) => { const node = record.nodes.find((item) => item.role === role && item.status === 'Running'); if (node) node.provider = provider; return record })
  } })
  engine = new CollaborationEngine({ dataDir, handlers: roles, admission: () => governor.sample() })
  const scheduler = new WorkflowScheduler({ engine, governor, onFinished: (workflow) => memory.recordExperience(workflow), validateOwner: async (workflow) => {
    if (workflow.kind === 'research-implementation') return isProposalLinked(workflow)
    if (workflow.kind === 'self-maintenance') return (await self.assessments.get(workflow.metadata.assessmentId))?.candidateWorkflowId === workflow.id
    return true
  } })
  const route = (method, endpoint, handler) => app[method](endpoint, async (req, res) => {
    if (!guard(req, res)) return
    try { await handler(req, res) }
    catch (cause) { res.status(cause.code === 'AI_NOT_CONFIGURED' ? 424 : /CONFLICT|UNCERTAIN|CHECKPOINT|LEASE/.test(cause.code || '') ? 409 : 400).json({ code: cause.code || 'EVOLUTION_REQUEST_FAILED', message: cause.code ? cause.message : 'The operation could not complete. Existing data was preserved.' }) }
  })
  async function project(id) {
    const item = (await listLocalProjects({ dataDir })).find((candidate) => candidate.id === id && candidate.available)
    if (!item) throw Object.assign(new Error('Select an available registered local project.'), { code: 'LOCAL_PROJECT_NOT_AVAILABLE' })
    return item
  }
  route('get', '/api/evolution/status', async (_req, res) => res.json({ roles: AGENT_ROLES, scheduler: scheduler.status(), resources: await governor.sample(), execution: { modes: ['trusted-local', 'strict-isolation'], strictAvailable: false, strictReason: 'A verified native isolation host is not configured; strict tasks are blocked instead of falling back to trusted execution.' } }))
  route('get', '/api/evolution/resources', async (_req, res) => res.json({ current: await governor.sample(), history: governor.history(), scheduler: scheduler.status() }))
  route('get', '/api/evolution/workflows', async (_req, res) => res.json({ workflows: (await engine.store.list({ map: ({ id, projectId, prompt, kind, status, createdAt, updatedAt, usage, nodes, errorCode }) => ({ id, projectId, label: prompt.split('\n')[0].slice(0, 160), kind, status, createdAt, updatedAt, usage, errorCode, nodes: nodes.map(({ id: nodeId, role, status: nodeStatus, taskId }) => ({ id: nodeId, role, status: nodeStatus, taskId })) }) })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200) }))
  route('get', '/api/evolution/workflows/:id', async (req, res) => {
    const record = await engine.store.get(req.params.id)
    if (!record) return res.status(404).json({ code: 'WORKFLOW_NOT_FOUND' })
    for (const node of record.nodes) if (node.taskId) {
      const task = await getLocalAgentTask({ dataDir, taskId: node.taskId })
      if (task && task.projectId === record.projectId) { node.runtimeStatus = task.status; node.runtimePhase = task.phase; node.runtimeProviderCalls = task.providerCalls || task.runtimeResult?.providerCalls || 0; node.needsApproval = (task.approvals || []).some((approval) => approval.status === 'pending') }
    }
    res.json({ workflow: record })
  })
  route('post', '/api/evolution/workflows', async (req, res) => {
    const body = req.body || {}
    await project(body.projectId)
    if (body.sourceDisclosureConfirmed !== true || body.executionConsent !== true) throw Object.assign(new Error('Explicit source disclosure and trusted script execution consent are required.'), { code: 'WORKFLOW_CONSENT_REQUIRED' })
    if (body.executionMode && body.executionMode !== 'trusted-local') throw Object.assign(new Error('Strict isolation requires a verified native host. No fallback execution was started.'), { code: 'STRICT_ISOLATION_UNAVAILABLE' })
    for (const role of AGENT_ROLES) if (!await resolveProviderForInvocation({ dataDir, providerId: body.providerIds?.[role], taskType: role === 'developer' ? 'coding' : role === 'reviewer' ? 'review' : 'planning' })) throw Object.assign(new Error('Configure a usable provider for every selected role.'), { code: 'AI_NOT_CONFIGURED' })
    const workflow = await engine.create({ projectId: body.projectId, prompt: body.prompt, requestId: body.requestId, providerIds: body.providerIds, limits: body.limits, metadata: { sourceDisclosureConfirmed: true, executionConsent: true } })
    scheduler.enqueue(workflow.id)
    res.status(202).json({ workflow })
  })
  route('post', '/api/evolution/workflows/:id/cancel', async (req, res) => res.json({ workflow: await engine.cancel(req.params.id) }))
  route('post', '/api/evolution/workflows/:id/pause', async (req, res) => res.json({ workflow: await engine.pause(req.params.id) }))
  route('post', '/api/evolution/workflows/:id/resume', async (req, res) => {
    const workflow = await engine.resume(req.params.id, { confirm: req.body?.confirm, validateCheckpoint: roles.validateCheckpoint, recoverWritingCheckpoint: roles.recoverWritingCheckpoint })
    scheduler.enqueue(workflow.id); res.status(202).json({ workflow })
  })
  route('get', '/api/evolution/memory/:projectId', async (req, res) => { await project(req.params.projectId); res.json({ memory: await memory.store.get(req.params.projectId) }) })
  route('post', '/api/evolution/memory/:projectId/refresh', async (req, res) => res.json({ memory: await memory.refresh(await project(req.params.projectId)) }))
  route('post', '/api/evolution/memory/:projectId/facts', async (req, res) => { await project(req.params.projectId); res.json({ memory: await memory.remember(req.params.projectId, { text: req.body?.text, category: req.body?.category, verified: req.body?.verified === true, source: req.body?.source }) }) })
  route('get', '/api/evolution/memory/:projectId/export', async (req, res) => { await project(req.params.projectId); res.json({ memory: await memory.export(req.params.projectId) }) })
  route('delete', '/api/evolution/memory/:projectId', async (req, res) => { await project(req.params.projectId); res.json(await memory.clear(req.params.projectId, { confirm: req.body?.confirm })) })
  const self = new SelfMaintenance({ dataDir, engine, scheduler, project, request })
  const updates = new SoftwareUpdates({ dataDir, version, request, publisher: process.env.NEXUS_UPDATE_PUBLISHER || '' })
  const downloads = new Map()
  route('get', '/api/evolution/self-maintenance', async (_req, res) => res.json({ policy: await self.getPolicy(), assessments: await self.assessments.list() }))
  route('put', '/api/evolution/self-maintenance/policy', async (req, res) => res.json({ policy: await self.setPolicy(req.body || {}) }))
  route('post', '/api/evolution/self-maintenance/assess', async (req, res) => {
    if (req.body?.confirm !== true) throw Object.assign(new Error('Confirm analysis of the registered NEXUS source repository.'), { code: 'SELF_ASSESSMENT_CONFIRM_REQUIRED' })
    res.status(202).json({ assessment: await self.startAssessment(req.body.projectId) })
  })
  route('post', '/api/evolution/self-maintenance/:id/candidate', async (req, res) => res.status(202).json({ workflow: await self.candidate(req.params.id, req.body || {}) }))
  route('get', '/api/evolution/updates', async (_req, res) => res.json({ currentVersion: version, publisherConfigured: Boolean(updates.publisher), candidates: await updates.store.list() }))
  route('post', '/api/evolution/updates/check', async (_req, res) => res.json({ candidate: await updates.check() }))
  route('post', '/api/evolution/updates/:id/download', async (req, res) => {
    if (req.body?.confirm !== true) throw Object.assign(new Error('Confirm downloading this update.'), { code: 'UPDATE_DOWNLOAD_CONFIRM_REQUIRED' })
    const candidate = await updates.store.get(req.params.id)
    if (!candidate) return res.status(404).json({ code: 'UPDATE_NOT_FOUND' })
    if (!downloads.has(candidate.id)) {
      await updates.store.update(candidate.id, (record) => ({ ...record, downloadRequestedAt: new Date().toISOString() }))
      const controller = new AbortController(); downloads.set(candidate.id, controller)
      void updates.download(candidate.id, { signal: controller.signal }).catch(() => {}).finally(() => downloads.delete(candidate.id))
    }
    res.status(202).json({ candidate: await updates.store.get(candidate.id) })
  })
  route('post', '/api/evolution/updates/:id/prepare-install', async (req, res) => res.json({ preparation: await updates.prepareInstall(req.params.id, req.body || {}) }))
  const maintenanceTimer = setInterval(() => void self.tick().catch(() => {}), 60000); maintenanceTimer.unref?.()
  return { engine, memory, governor, scheduler, roles, route, project, self, updates, async recover() { await updates.recover(); for (const record of await self.assessments.list()) if (['Queued', 'Running'].includes(record.status)) await self.assessments.update(record.id, (current) => ({ ...current, status: 'Interrupted', errorCode: 'HOST_RESTARTED' })); await scheduler.recover() }, async stop() { clearInterval(maintenanceTimer); for (const controller of downloads.values()) controller.abort(); for (const controller of self.controllers.values()) controller.abort(); await scheduler.stop() } }
}
