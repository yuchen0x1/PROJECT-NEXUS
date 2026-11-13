import crypto from 'node:crypto'
import path from 'node:path'
import { EvolutionStore, safeRecordId } from './evolution-store.mjs'
import { acquireFileLease } from './file-lease.mjs'
import { redactSecrets } from './ai-provider.mjs'

export const AGENT_ROLES = Object.freeze(['planner', 'researcher', 'developer', 'tester', 'security', 'reviewer'])
const dependencies = { planner: [], researcher: ['planner'], developer: ['researcher'], tester: ['developer'], security: ['developer'], reviewer: ['tester', 'security'] }
const now = () => new Date().toISOString()
const error = (code, message) => Object.assign(new Error(message), { code })
const terminal = new Set(['Completed', 'Failed', 'Blocked', 'Cancelled', 'Interrupted', 'TimedOut'])
const bounded = (value, fallback, minimum, maximum) => {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) throw error('WORKFLOW_INVALID_LIMIT', 'Workflow limit is outside the supported range.')
  return value
}
export function validateAgentGraph(nodes) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 18) throw error('WORKFLOW_INVALID_GRAPH', 'A workflow requires 1–18 nodes.')
  const byId = new Map()
  for (const node of nodes) {
    safeRecordId(node.id)
    if (byId.has(node.id) || !AGENT_ROLES.includes(node.role) || !Array.isArray(node.dependencies)) throw error('WORKFLOW_INVALID_GRAPH', 'Invalid or duplicate role node.')
    byId.set(node.id, node)
  }
  const active = new Set(), complete = new Set()
  function visit(id) {
    if (active.has(id) || !byId.has(id)) throw error('WORKFLOW_INVALID_GRAPH', 'Workflow dependencies contain a cycle or unknown node.')
    if (complete.has(id)) return
    active.add(id)
    for (const dependency of byId.get(id).dependencies) visit(dependency)
    active.delete(id); complete.add(id)
  }
  nodes.forEach((node) => visit(node.id))
  return nodes
}
function event(record, type, detail, nodeId = null) {
  record.events = [...(record.events || []), { id: crypto.randomUUID(), at: now(), type, nodeId, detail: redactSecrets(String(detail)).slice(0, 1000) }].slice(-300)
}
export class CollaborationEngine {
  constructor({ dataDir, handlers, admission = async () => ({ allowed: true }) }) {
    this.store = new EvolutionStore(dataDir, 'workflows')
    this.dataDir = dataDir; this.handlers = handlers; this.admission = admission
    this.controllers = new Map()
  }
  async create({ projectId, prompt, providerIds = {}, kind = 'development', limits = {}, nodes, metadata = {}, requestId }) {
    safeRecordId(projectId)
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) throw error('WORKFLOW_INVALID_PROMPT', 'Provide a task description within 20,000 characters.')
    if (!['development', 'research-implementation', 'self-maintenance'].includes(kind)) throw error('WORKFLOW_INVALID_KIND', 'Unsupported workflow kind.')
    const graph = validateAgentGraph(nodes || AGENT_ROLES.map((role) => ({ id: role, role, dependencies: dependencies[role] })))
    const config = { concurrency: bounded(limits.concurrency, 2, 1, 4), tokenBudget: bounded(limits.tokenBudget, 300000, 1000, 2000000), wallClockMs: bounded(limits.wallClockMs, 1800000, 100, 7200000), stepTimeoutMs: bounded(limits.stepTimeoutMs, 600000, 50, 1800000), maxAttempts: bounded(limits.maxAttempts, 2, 1, 3) }
    const id = requestId ? safeRecordId(requestId) : crypto.randomUUID()
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ projectId, prompt, providerIds, kind, limits: config, graph, metadata })).digest('hex')
    if (await this.store.count() >= 1000 && !await this.store.get(id)) throw error('WORKFLOW_STORE_FULL', 'Workflow history reached its bounded capacity; export and review old records first.')
    return this.store.update(id, (current) => {
      if (current) {
        if (current.requestFingerprint !== fingerprint) throw error('WORKFLOW_REQUEST_CONFLICT', 'This request ID already belongs to a different workflow.')
        return current
      }
      return { id, requestFingerprint: fingerprint, projectId, prompt: redactSecrets(prompt.trim()), providerIds: Object.fromEntries(AGENT_ROLES.filter((role) => typeof providerIds[role] === 'string').map((role) => [role, safeRecordId(providerIds[role])])), kind, status: 'Queued', createdAt: now(), limits: config, usage: { totalTokens: 0, uncertainTokens: 0 }, elapsedMs: 0, messages: [], events: [], metadata, nodes: graph.map(({ id: nodeId, role, dependencies: deps }) => ({ id: nodeId, role, dependencies: [...new Set(deps)], status: 'Pending', attempts: 0, result: null, checkpoint: null })) }
    })
  }
  async recover() {
    for (const workflow of await this.store.list({ map: ({ id, status }) => ({ id, status }) })) if (workflow.status === 'Running') {
      await this.store.update(workflow.id, (record) => {
        record.status = 'Interrupted'
        if (record.activeStartedAt) { record.elapsedMs += Math.max(0, Date.now() - Date.parse(record.activeStartedAt)); record.activeStartedAt = null }
        for (const node of record.nodes) if (node.status === 'Running') {
          node.status = 'Interrupted'; node.errorCode = 'HOST_RESTARTED'
          const reservation = node.reservedTokens || 0
          record.usage.uncertainTokens += reservation; node.failedReservation = reservation; node.reservedTokens = 0
        }
        event(record, 'interrupted', 'Host restarted. Completed receipts are retained; uncertain steps will not be replayed.')
        return record
      })
    }
  }
  async resume(id, { confirm, validateCheckpoint, recoverWritingCheckpoint }) {
    if (confirm !== true) throw error('WORKFLOW_CONFIRM_REQUIRED', 'Review checkpoints and explicitly confirm resume.')
    const lease = await acquireFileLease(`${this.store.file(id)}.run.lock`)
    try {
      const record = await this.store.get(id)
      if (!record || !['Interrupted', 'Failed', 'Blocked', 'TimedOut'].includes(record.status)) throw error('WORKFLOW_NOT_RESUMABLE', 'This workflow is not awaiting recovery.')
      for (const node of record.nodes.filter((item) => item.status === 'Completed')) {
        const validDigest = node.checkpoint?.resultSha256 === crypto.createHash('sha256').update(JSON.stringify(node.result)).digest('hex')
        if (!validDigest || !await validateCheckpoint?.(record, node)) throw error('WORKFLOW_CHECKPOINT_INVALID', 'A completed checkpoint changed or could not be verified.')
      }
      // Reconcile a durable child receipt or a verified conversation boundary.
      // No adapter means no authority to replay a potentially completed write.
      const recoveries = new Map()
      for (const node of record.nodes.filter((item) => item.role === 'developer' && item.attempts > 0 && item.status !== 'Completed')) {
        const recovered = await recoverWritingCheckpoint?.(record, node)
        if (!recovered) throw error('WORKFLOW_WRITE_UNCERTAIN', 'An interrupted writing step has no verified safe checkpoint; it cannot be replayed.')
        recoveries.set(node.id, recovered)
      }
      return await this.store.update(id, (current) => {
        for (const node of current.nodes) if (node.status !== 'Completed') {
          const recovered = recoveries.get(node.id)
          if (recovered?.result) {
            node.result = recovered.result; node.status = 'Completed'; node.finishedAt = now()
            node.checkpoint = { resultSha256: crypto.createHash('sha256').update(JSON.stringify(node.result)).digest('hex'), at: now() }
            current.usage.totalTokens += node.result.totalTokens
            current.usage.uncertainTokens = Math.max(0, current.usage.uncertainTokens - (node.failedReservation || 0)) + (node.result.uncertainTokens || 0)
            node.failedReservation = 0
            continue
          }
          if (node.attempts >= current.limits.maxAttempts) throw error('WORKFLOW_ATTEMPTS_EXHAUSTED', 'A role exhausted its retry limit.')
          if (recovered?.resumable === true) { node.resumeVerified = true; current.usage.uncertainTokens = Math.max(0, current.usage.uncertainTokens - (node.failedReservation || 0)); node.failedReservation = 0 }
          node.status = 'Pending'; node.errorCode = null
        }
        current.status = 'Queued'; current.errorCode = null; delete current.finishedAt; event(current, 'resume_confirmed', 'Verified checkpoints retained; remaining safe steps queued.'); return current
      }, record.revision)
    } finally { await lease.release() }
  }
  async cancel(id) {
    const record = await this.store.get(id)
    if (!record) throw error('WORKFLOW_NOT_FOUND', 'Workflow not found.')
    this.controllers.get(id)?.abort(error('WORKFLOW_CANCELLED', 'Cancelled by user.'))
    return this.store.update(id, (current) => {
      if (!terminal.has(current.status)) { current.status = 'Cancelled'; event(current, 'cancelled', 'Cancellation requested; active operations are stopping.') }
      return current
    })
  }
  async pause(id) {
    const record = await this.store.get(id)
    if (!record || !['Queued', 'Running'].includes(record.status)) throw error('WORKFLOW_NOT_RUNNING', 'Only queued or running workflows can pause.')
    this.controllers.get(id)?.abort(error('WORKFLOW_PAUSED', 'Paused by user; verify the last durable boundary before resuming.'))
    return this.store.update(id, (current) => { current.status = 'Interrupted'; current.errorCode = 'WORKFLOW_PAUSED'; event(current, 'interrupted', 'Pause requested. In-flight effects require checkpoint validation before resuming.'); return current })
  }
  async run(id) {
    const lease = await acquireFileLease(`${this.store.file(id)}.run.lock`)
    const controller = new AbortController(); this.controllers.set(id, controller)
    const started = Date.now()
    let running = false
    try {
      const initial = await this.store.get(id)
      if (!initial || initial.status !== 'Queued') throw error('WORKFLOW_NOT_QUEUED', 'Only queued workflows can run.')
      if (initial.elapsedMs >= initial.limits.wallClockMs || initial.usage.totalTokens + initial.usage.uncertainTokens >= initial.limits.tokenBudget) throw error('WORKFLOW_BUDGET_EXHAUSTED', 'The total task budget is exhausted.')
      await this.store.update(id, (record) => { record.status = 'Running'; record.startedAt ||= now(); record.activeStartedAt = now(); event(record, 'started', 'Role workflow started.'); return record })
      running = true
      const remainingMs = initial.limits.wallClockMs - initial.elapsedMs
      const overall = AbortSignal.any([controller.signal, AbortSignal.timeout(remainingMs)])
      while (true) {
        const record = await this.store.get(id)
        if (['Cancelled', 'Interrupted'].includes(record.status)) break
        overall.throwIfAborted()
        if (record.nodes.some((node) => ['Failed', 'Interrupted', 'TimedOut', 'Blocked'].includes(node.status))) break
        if (record.usage.totalTokens + record.usage.uncertainTokens >= record.limits.tokenBudget) throw error('WORKFLOW_BUDGET_EXHAUSTED', 'The total token budget is exhausted.')
        if (record.nodes.every((node) => node.status === 'Completed')) {
          const roles = Object.fromEntries(record.nodes.map((node) => [node.role, node.result]))
          const accepted = roles.tester?.verified === true && roles.security?.safe === true && roles.reviewer?.verdict === 'approve'
          return await this.store.update(id, (current) => { current.status = accepted ? 'Completed' : 'Blocked'; current.finishedAt = now(); event(current, 'arbitration', accepted ? 'Tests, security and independent review accepted the candidate. Applying or publishing remains a separate action.' : 'Required verification, security or review evidence is missing.'); return current })
        }
        const ready = record.nodes.filter((node) => node.status === 'Pending' && node.dependencies.every((dependency) => record.nodes.find((item) => item.id === dependency)?.status === 'Completed'))
        if (!ready.length) throw error('WORKFLOW_NO_PROGRESS', 'No runnable node remains.')
        const admission = await this.admission(record)
        if (!admission.allowed) throw error('WORKFLOW_RESOURCE_BLOCKED', 'Resource limits currently prevent starting more work.')
        // Reserve a separate slice of the remaining budget for every concurrently running node.
        const batch = ready.slice(0, Math.min(record.limits.concurrency, admission.concurrency || record.limits.concurrency))
        const weights = { developer: 6, tester: 2 }
        const remainingWeight = record.nodes.filter((node) => node.status === 'Pending').reduce((sum, node) => sum + (weights[node.role] || 1), 0)
        const availableTokens = record.limits.tokenBudget - record.usage.totalTokens - record.usage.uncertainTokens
        await Promise.all(batch.map((node) => this.runNode(record, node, overall, Math.floor(availableTokens * (weights[node.role] || 1) / remainingWeight))))
      }
      return await this.store.update(id, (record) => {
        if (!['Cancelled', 'Interrupted'].includes(record.status)) record.status = 'Blocked'
        record.finishedAt = now(); return record
      })
    } catch (cause) {
      if (!running) throw cause
      await this.store.update(id, (record) => {
        if (!record) throw cause
        if (!['Cancelled', 'Interrupted'].includes(record.status)) record.status = cause.name === 'TimeoutError' ? 'TimedOut' : 'Blocked'
        record.errorCode = cause.code || cause.name; event(record, 'stopped', 'Workflow stopped; review the recorded reason and checkpoints.'); return record
      })
      throw cause
    } finally {
      try { if (running) await this.store.update(id, (record) => { record.elapsedMs += Date.now() - started; record.activeStartedAt = null; return record }) }
      finally { this.controllers.delete(id); await lease.release() }
    }
  }
  async runNode(workflow, snapshot, parentSignal, tokenBudget) {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(workflow.limits.stepTimeoutMs)])
    let writerLease, invoked = false
    try {
      if (snapshot.role === 'developer') writerLease = await acquireFileLease(path.join(this.dataDir, 'evolution', 'writer-leases', `${workflow.projectId}.lock`))
      await this.store.update(workflow.id, (record) => {
        const node = record.nodes.find((item) => item.id === snapshot.id)
        if (node.attempts >= record.limits.maxAttempts) throw error('WORKFLOW_ATTEMPTS_EXHAUSTED', 'A role exhausted its retry limit.')
        node.status = 'Running'; node.attempts++; node.startedAt = now(); node.reservedTokens = tokenBudget
        event(record, 'role_started', snapshot.role, snapshot.id); return record
      })
      const handler = this.handlers[snapshot.role]
      if (typeof handler !== 'function') throw error('WORKFLOW_HANDLER_UNAVAILABLE', 'The selected role has no execution adapter.')
      signal.throwIfAborted()
      const context = workflow.nodes.filter((node) => snapshot.dependencies.includes(node.id)).map((node) => ({ role: node.role, result: structuredClone(node.result) }))
      invoked = true
      const result = await handler({ workflow: structuredClone(workflow), node: structuredClone(snapshot), context, signal, tokenBudget, send: async (to, message) => {
        if (!workflow.nodes.some((node) => node.id === to) || typeof message !== 'string') throw error('WORKFLOW_INVALID_MESSAGE', 'Invalid role message.')
        await this.store.update(workflow.id, (record) => { record.messages = [...record.messages, { id: crypto.randomUUID(), at: now(), from: snapshot.id, to, message: redactSecrets(message).slice(0, 2000) }].slice(-100); return record })
      } })
      signal.throwIfAborted()
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Number.isSafeInteger(result.totalTokens) || result.totalTokens < 0 || !Number.isSafeInteger(result.uncertainTokens || 0) || (result.uncertainTokens || 0) < 0 || result.totalTokens + (result.uncertainTokens || 0) > tokenBudget) throw error('WORKFLOW_INVALID_RESULT', 'Role result or token accounting is invalid.')
      const clean = JSON.parse(redactSecrets(JSON.stringify(result)))
      if (Buffer.byteLength(JSON.stringify(clean)) > 64000) throw error('WORKFLOW_RESULT_TOO_LARGE', 'Role result exceeded its storage budget.')
      await this.store.update(workflow.id, (record) => {
        const node = record.nodes.find((item) => item.id === snapshot.id)
        node.result = clean; node.status = 'Completed'; node.finishedAt = now(); node.reservedTokens = 0
        node.checkpoint = { resultSha256: crypto.createHash('sha256').update(JSON.stringify(clean)).digest('hex'), at: now() }
        record.usage.totalTokens += result.totalTokens
        record.usage.uncertainTokens += result.uncertainTokens || 0
        event(record, 'role_completed', snapshot.role, snapshot.id); return record
      })
    } catch (cause) {
      // An unreceipted request may have consumed its entire reserved model budget.
      await this.store.update(workflow.id, (record) => {
        const node = record.nodes.find((item) => item.id === snapshot.id)
        node.status = signal.aborted ? 'Interrupted' : 'Failed'; node.errorCode = cause.code || cause.name; node.errorSummary = redactSecrets(String(cause.message)).slice(0, 400); node.finishedAt = now()
        // Missing responses have unknown usage; reserve the upper bound separately from known usage.
        if (invoked) { record.usage.uncertainTokens += tokenBudget; node.failedReservation = tokenBudget }
        node.reservedTokens = 0
        event(record, 'role_failed', `${snapshot.role}: ${node.errorCode}`, snapshot.id); return record
      })
    } finally { await writerLease?.release() }
  }
}
