import crypto from 'node:crypto'
import { redactSecrets } from './ai-provider.mjs'
import { getHostingPolicy } from './hosting.mjs'

export const OVERVIEW_EVENT_LIMIT = 120
const STAGES = ['inspection', 'analysis', 'execution', 'verification', 'delivery', 'research']
const time = (value) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0
const statusOf = (value) => ({ Running: 'running', Queued: 'queued', Pending: 'queued', Paused: 'blocked', Blocked: 'blocked', Interrupted: 'blocked', Failed: 'failed', TimedOut: 'failed', Cancelled: 'cancelled', Success: 'success', Succeeded: 'success', Completed: 'success' }[value] || 'idle')
const stageOf = (phase) => /verif|review|test|build|lint/i.test(phase || '') ? 'verification' : /deliver|push|publish|merge|release|pull.request/i.test(phase || '') ? 'delivery' : /execut|repair|edit|implement/i.test(phase || '') ? 'execution' : 'analysis'

/** A read-only, bounded projection. No prompts, credentials or workspaces. */
export function buildProjectOverview({ state, localTasks = [], providers = [], github = {}, paused = false, activeResearch = [], projectId = '', secrets = [], warnings = [], now = new Date().toISOString() }) {
  const clean = (value, limit = 1000) => {
    let result = String(value ?? '')
    for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) result = result.replaceAll(secret, '[REDACTED]')
    return redactSecrets(result).slice(0, limit)
  }
  const projects = (state.projects || []).filter((project) => project.repositoryAvailable !== false)
  const byId = new Map(projects.map((project) => [project.id, project]))
  const byName = new Map(projects.map((project) => [project.fullName, project.id]))
  const tasks = [], events = [], linked = new Set()
  const localById = new Map(localTasks.map((task) => [task.id, task]))
  const add = (source, raw, repositoryId, stage, extra = {}) => {
    const task = { id: `${source}:${raw.id}`, source, taskId: raw.id, projectId: byId.has(repositoryId) ? repositoryId : null, label: clean(raw.label || raw.repository || raw.projectName || raw.type || raw.id, 200), status: statusOf(raw.status), stage, providerId: raw.providerId || raw.provider?.id || null, at: raw.updatedAt || raw.finishedAt || raw.startedAt || raw.createdAt || now, error: clean(raw.error, 500) || null, ...extra }
    tasks.push(task)
    for (const event of (raw.events || []).slice(-12)) {
      const output = typeof event.metadata?.resultSummary === 'string' ? event.metadata.resultSummary : ''
      const detail = clean(`${event.detail || event.message || ''}${output ? `\n${output}` : ''}`)
      if (!detail) continue
      const at = event.at || task.at
      events.push({ id: crypto.createHash('sha256').update(`${task.id}:${at}:${event.type}:${detail}`).digest('hex').slice(0, 20), taskId: task.id, projectId: task.projectId, at, stage, status: task.status, detail })
    }
    if (!(raw.events || []).length && (task.error || raw.logs?.length)) {
      const detail = clean(task.error || raw.logs.slice(-2).join('\n'))
      events.push({ id: `${task.id}:${task.at}`, taskId: task.id, projectId: task.projectId, at: task.at, stage, status: task.status, detail })
    }
    return task
  }
  for (const job of state.hostedJobs || []) {
    const taskId = job.taskId || job.checkpoint?.taskId || job.events?.findLast((event) => event.type === 'task_created')?.metadata?.taskId
    const local = localById.get(taskId)
    if (local) linked.add(local.id)
    const delivery = job.executionStatus === 'Succeeded' || local?.status === 'Succeeded' || job.deliveryStatus === 'Incomplete'
    const task = add('hosted', job, job.projectId, delivery ? 'delivery' : stageOf(local?.phase), { providerId: local?.providerId || local?.provider?.id || null, localTaskId: local?.id || null, executionStatus: clean(job.executionStatus, 40), deliveryStatus: clean(job.deliveryStatus, 40) })
    // Runtime success is not delivery success. Incomplete delivery stays blocked.
    if (job.deliveryStatus === 'Incomplete' && task.status === 'success') task.status = 'blocked'
    if (local) {
      for (const event of (local.events || []).slice(-12)) {
        const detail = clean(`${event.detail || ''}${typeof event.metadata?.resultSummary === 'string' ? `\n${event.metadata.resultSummary}` : ''}`)
        if (detail) events.push({ id: `${task.id}:runtime:${crypto.createHash('sha256').update(`${event.at}:${detail}`).digest('hex').slice(0, 16)}`, taskId: task.id, projectId: task.projectId, at: event.at || task.at, stage: stageOf(local.phase), status: task.status, detail })
      }
    }
  }
  for (const task of localTasks) if (!linked.has(task.id)) add('agent', task, byId.has(task.projectId) ? task.projectId : byName.get(task.issue?.repository || task.projectName), stageOf(task.phase))
  for (const job of state.integrationJobs || []) add('integration', job, job.projectId, job.type === 'scan' ? 'inspection' : stageOf(job.currentStep))
  for (const run of state.hostingRuns || []) add('inspection', { ...run, createdAt: run.startedAt, events: [{ at: run.finishedAt || run.startedAt, type: 'inspection', detail: run.error || (run.findings || []).map((finding) => finding.summary).join('\n') }] }, run.projectId, 'inspection')
  for (const report of state.researchReports || []) add('research', { ...report, events: [{ at: report.createdAt, type: 'research', detail: report.analysis?.summary || report.analysis?.recommendation || report.query || '' }] }, report.projectId, 'research')
  for (const run of activeResearch) add('research-live', { ...run, status: 'Running', label: run.repository }, run.projectId, 'research')
  tasks.sort((a, b) => time(b.at) - time(a.at) || a.id.localeCompare(b.id))
  const taskGroups = new Map()
  for (const task of tasks) {
    if (!task.projectId) continue
    if (!taskGroups.has(task.projectId)) taskGroups.set(task.projectId, [])
    taskGroups.get(task.projectId).push(task)
  }
  const repositories = projects.map((project) => {
    const related = taskGroups.get(project.id) || []
    const work = related.filter((task) => !['inspection', 'research'].includes(task.source))
    const latest = related.find((task) => task.status === 'running') || related.find((task) => task.status === 'queued') || work.find((task) => task.status !== 'idle') || related[0]
    const policy = getHostingPolicy(project)
    return { id: project.id, name: clean(project.name || project.fullName, 200), fullName: clean(project.fullName, 240), owner: clean(project.owner, 100), enabled: policy.enabled, strategy: policy.strategy, intervalMinutes: policy.intervalMinutes, openIssues: Number(project.openIssues) || 0, status: latest?.status || 'idle', stage: latest?.stage || null, latestTaskId: latest?.id || null, lastInspectionAt: project.hosting?.lastInspectionAt || null }
  }).sort((a, b) => a.fullName.localeCompare(b.fullName))
  const running = tasks.filter((task) => task.status === 'running')
  // Keep every live flow in the map, but scope historical task details to the
  // selected repository before applying the cap.
  const visibleTasks = [...running, ...tasks.filter((task) => task.status !== 'running' && (!projectId || task.projectId === projectId)).slice(0, 200)]
  const scoped = events.filter((event) => !projectId || event.projectId === projectId).sort((a, b) => time(b.at) - time(a.at) || a.id.localeCompare(b.id))
  return {
    updatedAt: now, paused, warnings,
    account: { login: clean(github.owner, 100) || null, configured: Boolean(github.configured) },
    repositories, providers: providers.map((provider) => ({ id: provider.id, name: clean(provider.name, 120), model: clean(provider.model, 200), kind: provider.kind, configured: Boolean(provider.configured) })),
    tasks: visibleTasks, events: scoped.slice(0, OVERVIEW_EVENT_LIMIT), eventsScope: projectId || null, eventsTruncated: scoped.length > OVERVIEW_EVENT_LIMIT,
    services: STAGES.map((stage) => ({ id: stage, running: running.filter((task) => task.stage === stage).length, total: tasks.filter((task) => task.stage === stage).length })),
    stats: { repositories: repositories.length, enabled: repositories.filter((repo) => repo.enabled).length, running: running.length, queued: tasks.filter((task) => task.status === 'queued').length, attention: repositories.filter((repo) => ['blocked', 'failed'].includes(repo.status)).length }
  }
}
