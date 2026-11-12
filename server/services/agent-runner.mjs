const phaseOrder = ['queued', 'context', 'plan', 'tool_execution', 'observe', 'diagnose', 'repair', 'verify', 'review', 'delivered']
const terminalPhases = new Set(['delivered', 'failed', 'blocked', 'cancelled'])

function timestamp() {
  return new Date().toISOString()
}

function safeText(value, limit = 600) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit)
}

export function createAgentRun({ id, taskId, projectId, repository, requestedBy, maxAttempts = 2 } = {}) {
  const at = timestamp()
  return {
    id: id || null,
    taskId: taskId || null,
    projectId: projectId || null,
    repository: repository || null,
    requestedBy: requestedBy || 'system',
    phase: 'queued',
    attempt: 0,
    maxAttempts: Math.max(1, Math.min(5, Number(maxAttempts) || 2)),
    checkpoint: { phase: 'queued', at },
    events: [{ at, phase: 'queued', status: 'entered', detail: 'Agent run queued.' }],
    createdAt: at,
    updatedAt: at
  }
}

export function transitionAgentRun(run, phase, detail, metadata = {}) {
  if (!run || typeof run !== 'object') throw new Error('Agent run state is required.')
  const next = String(phase)
  if (!terminalPhases.has(next) && !phaseOrder.includes(next)) throw new Error(`Unknown agent phase: ${next}`)
  const currentIndex = phaseOrder.indexOf(run.phase)
  const nextIndex = phaseOrder.indexOf(next)
  if (!terminalPhases.has(run.phase) && !terminalPhases.has(next) && nextIndex < currentIndex) throw new Error(`Agent phase cannot move backwards from ${run.phase} to ${next}.`)
  const at = timestamp()
  run.phase = next
  run.updatedAt = at
  run.checkpoint = { phase: next, at, attempt: run.attempt, ...metadata }
  run.events = [...(Array.isArray(run.events) ? run.events : []), {
    at, phase: next, status: terminalPhases.has(next) ? next : 'entered', detail: safeText(detail), metadata
  }].slice(-200)
  return run
}

export function recordAgentEvent(run, phase, status, detail, metadata = {}) {
  if (!run || typeof run !== 'object') throw new Error('Agent run state is required.')
  const at = timestamp()
  run.updatedAt = at
  run.events = [...(Array.isArray(run.events) ? run.events : []), {
    at, phase: String(phase || run.phase || 'unknown'), status: safeText(status, 80), detail: safeText(detail), metadata
  }].slice(-200)
  return run
}

export function beginAgentAttempt(run) {
  if (!run || typeof run !== 'object') throw new Error('Agent run state is required.')
  if (run.attempt >= run.maxAttempts) return false
  run.attempt += 1
  recordAgentEvent(run, run.phase, 'attempt_started', `Agent attempt ${run.attempt} of ${run.maxAttempts}.`, { attempt: run.attempt, maxAttempts: run.maxAttempts })
  return true
}

export function canRetryAgentRun(run) {
  return Boolean(run && !terminalPhases.has(run.phase) && Number(run.attempt || 0) < Number(run.maxAttempts || 0))
}

export const AGENT_PHASES = Object.freeze([...phaseOrder, 'failed', 'blocked', 'cancelled'])
