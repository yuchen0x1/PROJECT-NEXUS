export const REPOSITORY_SYNC_INTERVAL_MS = 60_000
export const repositoryAvailable = (project) => project.repositoryAvailable !== false

// Keep records and workspaces for history, but reconcile current membership
// only when the complete authoritative scope was fetched successfully.
export function reconcileRepositories(projects, incoming, { installationId = null, owner = '', complete = true, at = new Date().toISOString() } = {}) {
  const scope = installationId ? `installation:${installationId}` : owner ? `owner:${owner.toLowerCase()}` : 'user'
  const inScope = (project) => Object.hasOwn(project.repositoryMembership || {}, scope) || (installationId ? String(project.installationId) === String(installationId)
    : !project.installationId && (!owner || String(project.owner).toLowerCase() === owner.toLowerCase()))
  for (const project of projects) if (!project.repositoryMembership) {
    const original = project.installationId ? `installation:${project.installationId}` : owner && String(project.owner).toLowerCase() === owner.toLowerCase() ? scope : 'user'
    project.repositoryMembership = { [original]: repositoryAvailable(project) }
  }
  const seen = new Set()
  let unavailable = 0
  for (const next of incoming) {
    let previous = projects.find((item) => item.id === next.id || next.githubId && String(item.githubId) === String(next.githubId))
      || projects.find((item) => (!item.githubId || !next.githubId) && item.fullName.toLowerCase() === next.fullName.toLowerCase())
    if (previous) {
      const retained = {
        id: previous.id,
        workflows: previous.workflows || next.workflows || [],
        stack: previous.stack?.length ? previous.stack : next.stack,
        latestRelease: previous.latestRelease ?? next.latestRelease,
        hosting: previous.hosting ?? next.hosting,
        repoMeta: previous.repoMeta ?? next.repoMeta,
        localWorkspace: previous.localWorkspace ?? next.localWorkspace
      }
      Object.assign(previous, next, retained)
      if (previous.repoMeta) previous.repoMeta.archived = next.archived
    } else { previous = { ...next }; projects.push(previous) }
    previous.repositoryAvailable = true
    previous.unavailableAt = null
    previous.repositoryMembership = { ...previous.repositoryMembership, [scope]: true }
    seen.add(previous.id)
  }
  if (complete) for (const project of projects) {
    if (inScope(project) && !seen.has(project.id)) {
      project.repositoryMembership[scope] = false
      if (!Object.values(project.repositoryMembership).some(Boolean)) {
        if (repositoryAvailable(project)) unavailable++
        project.repositoryAvailable = false
        project.unavailableAt ||= at
      }
    }
  }
  projects.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
  return { imported: incoming.length, unavailable }
}

export function retryDeadline(error, failures, now = Date.now()) {
  const seconds = Number(error.retryAfter)
  const retryAt = Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : Date.parse(error.retryAfter || '')
  const resetAt = error.rateRemaining === '0' ? Number(error.rateReset) * 1000 : 0
  return Math.max(now + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(4, failures - 1)), retryAt || 0, resetAt || 0)
}

export function createSyncGate({ clock = Date.now, interval = REPOSITORY_SYNC_INTERVAL_MS, initial = {} } = {}) {
  let currentTask = null
  const state = { lastAttemptAt: null, lastSuccessAt: null, nextSyncAt: null, failures: 0, lastErrorCode: null, ...initial }
  return {
    status: () => ({ ...state, running: Boolean(currentTask), taskId: currentTask?.id || null, intervalMs: interval }),
    request(automatic, start) {
      if (currentTask) return { task: currentTask, reused: true }
      if (clock() < Date.parse(state.nextSyncAt || '') && (automatic || state.failures)) return { skipped: true, reason: state.failures ? 'backoff' : 'not-due', ...state }
      state.lastAttemptAt = new Date(clock()).toISOString()
      state.nextSyncAt = new Date(clock() + interval).toISOString()
      currentTask = start()
      return { task: currentTask }
    },
    finish(error = null, partial = false) {
      currentTask = null
      if (error) {
        state.failures++
        state.lastErrorCode = error.code || (error.status === 429 || error.status === 403 ? 'GITHUB_RATE_LIMIT_OR_PERMISSION' : 'GITHUB_SYNC_FAILED')
        state.nextSyncAt = new Date(retryDeadline(error, state.failures, clock())).toISOString()
      } else {
        state.failures = 0; state.lastErrorCode = partial ? 'GITHUB_SYNC_PARTIAL' : null
        if (!partial) state.lastSuccessAt = new Date(clock()).toISOString()
        state.nextSyncAt = new Date(clock() + interval).toISOString()
      }
    }
  }
}
