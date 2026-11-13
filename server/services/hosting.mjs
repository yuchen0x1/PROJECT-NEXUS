// PHASE 1: repository hosting policies and inspection run records.
//
// Every managed repository can carry a hosting policy that describes how the
// 24-hour autonomous scheduler should treat it. Policies are stored inline on
// the project record (`project.hosting`); inspection runs are persisted in
// `state.hostingRuns` so the UI can render per-repository maintenance history.

export const HOSTING_STRATEGIES = ['observe', 'maintain', 'autonomous']
export const HOSTING_INSPECTION_DEPTHS = ['light', 'full']

// Allowed inspection intervals: the spec presets (15/30/60/120 minutes) plus a
// bounded custom range so power users can tune the cadence safely.
export const HOSTING_MIN_INTERVAL_MINUTES = 5
export const HOSTING_MAX_INTERVAL_MINUTES = 1440

export function defaultHostingPolicy() {
  return {
    enabled: false,
    strategy: 'observe',
    intervalMinutes: 30,
    autoPush: false,
    autoPullRequest: false,
    autoMerge: false,
    autoPublish: false,
    closeIssueAfterRelease: true,
    closeIssueAfterMerge: false,
    requireApprovalForHighRisk: true,
    executionMode: 'blocked',
    allowNoCI: false,
    requiredChecks: [],
    allowSourceOnlyRelease: false,
    allowUnsignedArtifacts: false,
    updatedAt: null
  }
}

function clampInterval(value) {
  const minutes = Number(value)
  if (!Number.isFinite(minutes)) return null
  const rounded = Math.round(minutes)
  if (rounded < HOSTING_MIN_INTERVAL_MINUTES || rounded > HOSTING_MAX_INTERVAL_MINUTES) return null
  return rounded
}

export function normalizeHostingPolicy(input) {
  const base = defaultHostingPolicy()
  if (!input || typeof input !== 'object') return base
  const strategy = HOSTING_STRATEGIES.includes(input.strategy) ? input.strategy : base.strategy
  const interval = clampInterval(input.intervalMinutes ?? base.intervalMinutes)
  const policy = {
    ...base,
    enabled: input.enabled === true,
    strategy,
    intervalMinutes: interval || base.intervalMinutes,
    autoPush: input.autoPush === true,
    autoPullRequest: input.autoPullRequest === true,
    autoMerge: input.autoMerge === true,
    autoPublish: input.autoPublish === true,
    closeIssueAfterRelease: input.closeIssueAfterRelease !== false,
    closeIssueAfterMerge: input.closeIssueAfterMerge === true,
    requireApprovalForHighRisk: input.requireApprovalForHighRisk !== false,
    executionMode: input.executionMode === 'trusted-local' ? 'trusted-local' : 'blocked',
    allowNoCI: input.allowNoCI === true,
    requiredChecks: Array.isArray(input.requiredChecks) ? [...new Set(input.requiredChecks.filter((name) => typeof name === 'string' && name.length > 0 && name.length <= 100))].slice(0, 20) : [],
    allowSourceOnlyRelease: input.allowSourceOnlyRelease === true,
    allowUnsignedArtifacts: input.allowUnsignedArtifacts === true,
    updatedAt: input.updatedAt || null
  }
  return policy
}

// Strategy presets: picking a strategy pre-fills the delivery gates in a safe
// way (PART 13). Explicit flags still win once the user edits them.
export const STRATEGY_PRESETS = {
  observe: { autoPush: false, autoPullRequest: false, autoMerge: false, autoPublish: false },
  maintain: { autoPush: true, autoPullRequest: true, autoMerge: false, autoPublish: false },
  autonomous: { autoPush: true, autoPullRequest: true, autoMerge: true, autoPublish: true }
}

export function applyStrategyPreset(policy, strategy) {
  const preset = STRATEGY_PRESETS[strategy] || {}
  return { ...policy, ...preset, strategy }
}

export function getHostingPolicy(project) {
  return normalizeHostingPolicy(project?.hosting)
}

export function hostingStatus(project) {
  const policy = getHostingPolicy(project)
  return {
    enabled: policy.enabled,
    strategy: policy.strategy,
    intervalMinutes: policy.intervalMinutes,
    lastInspectionAt: project?.hosting?.lastInspectionAt || null,
    lastLightScanAt: project?.hosting?.lastLightScanAt || null,
    lastFullScanAt: project?.hosting?.lastFullScanAt || null,
    lastOutcome: project?.hosting?.lastOutcome || null,
    currentTaskId: project?.hosting?.currentTaskId || null,
    workspace: project?.localWorkspace || null
  }
}

export function nextInspectionDueAt(policy, project) {
  if (!policy.enabled) return null
  const reference = project?.hosting?.lastInspectionAt || project?.hosting?.updatedAt || null
  const base = reference ? new Date(reference).getTime() : 0
  return new Date(base + policy.intervalMinutes * 60 * 1000).toISOString()
}

export function recordHostingRun(state, run) {
  state.hostingRuns.unshift(run)
  state.hostingRuns = state.hostingRuns.slice(0, 1000)
}

export function summarizeFindings(findings = []) {
  const byPriority = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 }
  for (const finding of findings) {
    if (byPriority[finding.priority] !== undefined) byPriority[finding.priority] += 1
  }
  return { total: findings.length, byPriority }
}
