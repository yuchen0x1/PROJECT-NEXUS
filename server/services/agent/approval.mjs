import crypto from 'node:crypto'

// Approval management for agent tasks. Pending approvals live inside the
// persisted task record so they survive restarts and the UI can always render
// them. The model can never approve its own high-risk action: only a resolver
// call (API endpoint driven by the user's UI decision) flips the state.

export const APPROVAL_STATUSES = Object.freeze(['pending', 'approved', 'denied', 'expired'])
export const MAX_APPROVALS_PER_TASK = 50
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000

function approvalError(code, message) {
  return Object.assign(new Error(message), { code })
}

function safeSummary(value, limit = 400) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit)
}

export function createApprovalRecord({ tool, args, risk, reason, action }) {
  return {
    id: `appr_${crypto.randomUUID().slice(0, 12)}`,
    tool: safeSummary(tool, 80),
    risk: ['low', 'medium', 'high'].includes(risk) ? risk : 'high',
    reason: safeSummary(reason, 1_000),
    action: safeSummary(action, 2_000),
    argsSummary: safeSummary(JSON.stringify(sanitizeApprovalArgs(args)), 1_000),
    status: 'pending',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null
  }
}

function sanitizeApprovalArgs(args) {
  if (!args || typeof args !== 'object') return {}
  const safe = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') safe[key] = value.length > 300 ? `${value.slice(0, 300)}…(${value.length} chars)` : value
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) safe[key] = value
    else safe[key] = String(value).slice(0, 120)
  }
  return safe
}

export function resolveApprovalInTask(task, approvalId, decision, resolvedBy = 'user') {
  if (!task || !Array.isArray(task.approvals)) return null
  const approval = task.approvals.find((item) => item.id === approvalId)
  if (!approval || approval.status !== 'pending') return null
  if (!['approved', 'denied'].includes(decision)) throw approvalError('APPROVAL_DECISION_INVALID', 'Decision must be approved or denied.')
  approval.status = decision
  approval.resolvedAt = new Date().toISOString()
  approval.resolvedBy = safeSummary(resolvedBy, 80)
  return approval
}

export function expireStaleApprovals(task, timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS) {
  if (!task || !Array.isArray(task.approvals)) return false
  let changed = false
  const now = Date.now()
  for (const approval of task.approvals) {
    if (approval.status !== 'pending') continue
    const age = now - Date.parse(approval.createdAt)
    if (Number.isFinite(age) && age > timeoutMs) {
      approval.status = 'expired'
      approval.resolvedAt = new Date().toISOString()
      approval.resolvedBy = 'timeout'
      changed = true
    }
  }
  return changed
}

// Approval decision policy: maps a tool's effective permission to whether a
// live user approval is required under the task's approval policy.
export function approvalRequired({ permission, policy, workspaceWrite = false }) {
  if (permission === 'high') return true
  if (policy === 'supervised') return permission !== 'low'
  if (policy === 'standard') return false
  if (policy === 'workspace-auto') return false
  return permission !== 'low'
}

export const APPROVAL_POLICIES = Object.freeze(['supervised', 'standard', 'workspace-auto'])
