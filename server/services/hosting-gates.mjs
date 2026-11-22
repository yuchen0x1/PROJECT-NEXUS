import { getHostingPolicy } from './hosting.mjs'

const FLAGS = { push: 'autoPush', pull_request: 'autoPullRequest', merge: 'autoMerge', release: 'autoPublish', upload: 'autoPublish' }

// Read live state immediately before every side effect; never retain a policy snapshot here.
export function assertHostingWrite({ project, enabled, paused, operation }) {
  const policy = getHostingPolicy(project)
  const flag = FLAGS[operation]
  if (!enabled || paused || !policy.enabled || policy.strategy === 'observe' || (flag && !policy[flag])) {
    throw Object.assign(new Error(`Repository permission revoked or disabled for ${operation}; receipts and workspace retained.`), { code: 'REMOTE_WRITES_DISABLED' })
  }
  if (operation === 'close' && policy.closeIssueAfterRelease === false && !policy.closeIssueAfterMerge) {
    throw Object.assign(new Error('Issue closure is disabled.'), { code: 'REMOTE_WRITES_DISABLED' })
  }
}

export function hostingOperation(endpoint, options = {}) {
  if (!options.method || options.method.toUpperCase() === 'GET') return null
  if (/\/merge$/.test(endpoint)) return 'merge'
  if (/\/pulls$/.test(endpoint)) return 'pull_request'
  if (/\/releases(?:\/|$)/.test(endpoint)) return 'release'
  if (/\/issues\/\d+$/.test(endpoint)) return 'close'
  return 'comment'
}

export function automaticFixDecision(policy, classification, issue) {
  if (!policy.enabled || policy.strategy === 'observe' || issue.state === 'closed') return 'observation_only'
  if (!['BUG', 'SECURITY', 'PERFORMANCE'].includes(classification.category)) return 'category_not_actionable'
  if (classification.source !== 'ai' || classification.confidence < 0.8) return 'triage_requires_review'
  if (policy.requireApprovalForHighRisk && (classification.category === 'SECURITY' || ['P0', 'P1'].includes(classification.severity))) return 'high_risk_requires_review'
  return null
}

// Execution and delivery are independent. Legacy status remains a truthful aggregate.
export function hostedResult(outcome, policy) {
  const executionStatus = outcome.status === 'Succeeded' ? 'Succeeded' : 'Failed'
  const d = outcome.delivery || {}
  const required = [
    ...(policy.autoPush ? [['push', d.pushed]] : []),
    ...(policy.autoPullRequest ? [['pull_request', Boolean(d.pullRequest)]] : []),
    ...(policy.autoMerge ? [['merge', d.merged?.merged]] : []),
    ...(policy.autoPublish ? [['release', d.released?.published]] : []),
    ...((policy.autoPublish && policy.closeIssueAfterRelease !== false) || (policy.autoMerge && policy.closeIssueAfterMerge) ? [['close', d.closed?.closed]] : [])
  ]
  const missing = required.filter(([, passed]) => !passed).map(([name]) => name)
  const deliveryStatus = executionStatus === 'Failed' ? 'NotStarted' : !required.length ? 'NotRequested' : missing.length ? 'Incomplete' : 'Succeeded'
  return { executionStatus, deliveryStatus, missing, status: executionStatus === 'Failed' ? 'Failed' : deliveryStatus === 'Incomplete' ? 'Blocked' : 'Succeeded' }
}
