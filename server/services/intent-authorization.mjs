// Action Intent authorization for every operation that can change an external
// resource. Identity is separate from intent: a role says who is asking, an
// intent says exactly what is allowed, for which resource, until when, and by
// which explicit approval. High-risk actions never inherit a lower grant.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const INTENT_ACTIONS = Object.freeze({
  READ: 'read',
  LOCAL_FILE_WRITE: 'local_file_write',
  GIT_COMMIT: 'git_commit',
  GITHUB_ISSUE: 'github_issue',
  PULL_REQUEST_CREATE: 'pull_request_create',
  PULL_REQUEST_MERGE: 'pull_request_merge',
  RELEASE_PUBLISH: 'release_publish',
  REPOSITORY_DESTRUCTIVE: 'repository_destructive'
})

export const INTENT_RISK = Object.freeze({
  read: 'none',
  local_file_write: 'medium',
  git_commit: 'medium',
  github_issue: 'medium',
  pull_request_create: 'high',
  pull_request_merge: 'high',
  release_publish: 'critical',
  repository_destructive: 'critical'
})

const ROLE_RANK = Object.freeze({ Viewer: 1, Operator: 2, Administrator: 3 })
const REQUIRED_ROLE = Object.freeze({
  read: 'Viewer',
  local_file_write: 'Operator',
  git_commit: 'Operator',
  github_issue: 'Operator',
  pull_request_create: 'Operator',
  pull_request_merge: 'Administrator',
  release_publish: 'Administrator',
  repository_destructive: 'Administrator'
})

const DURATIONS = Object.freeze({ once: 10 * 60_000, session: 12 * 60 * 60_000, day: 24 * 60 * 60_000 })

function denied(code, message, detail = {}) {
  return Object.assign(new Error(message), { code, status: 403, detail })
}

function normalizeScope(scope = {}) {
  const repository = typeof scope.repository === 'string' ? scope.repository.trim().slice(0, 200) : null
  const workspace = typeof scope.workspace === 'string' ? path.resolve(scope.workspace) : null
  const branch = typeof scope.branch === 'string' ? scope.branch.trim().slice(0, 240) : null
  const issue = Number.isInteger(scope.issue) && scope.issue > 0 ? scope.issue : null
  return {
    repository, workspace, branch, issue,
    pullRequest: Number.isInteger(scope.pullRequest) && scope.pullRequest > 0 ? scope.pullRequest : null,
    tag: typeof scope.tag === 'string' && /^v?\d+\.\d+\.\d+$/.test(scope.tag) ? scope.tag : null,
    path: typeof scope.path === 'string' ? scope.path.replace(/\\/g, '/').slice(0, 600) : null
  }
}

function scopeMatches(grantScope, requestedScope, action) {
  if (!grantScope.repository || !requestedScope.repository) return false
  if (grantScope.repository !== requestedScope.repository) return false
  for (const key of ['workspace', 'branch', 'path', 'issue', 'pullRequest', 'tag']) {
    if (grantScope[key] !== null && grantScope[key] !== requestedScope[key]) return false
  }
  if (action === INTENT_ACTIONS.GITHUB_ISSUE && grantScope.issue && !requestedScope.issue) return false
  if (action === INTENT_ACTIONS.PULL_REQUEST_CREATE && grantScope.branch && !requestedScope.branch) return false
  if (action === INTENT_ACTIONS.PULL_REQUEST_MERGE && grantScope.pullRequest && !requestedScope.pullRequest) return false
  if (action === INTENT_ACTIONS.RELEASE_PUBLISH && grantScope.tag && !requestedScope.tag) return false
  return true
}

export function defaultPrincipal({ id = 'local-owner', role = 'Administrator', source = 'desktop-local' } = {}) {
  return { schemaVersion: 1, id: String(id).slice(0, 80), role, source, displayName: 'Local workstation owner' }
}

export class IntentAuthorizer {
  constructor({ store, clock = () => Date.now(), actor = defaultPrincipal() } = {}) {
    if (!store) throw new Error('An autonomy store is required for intent authorization.')
    this.store = store
    this.clock = clock
    this.actor = actor
    this._load()
  }

  _load() {
    const saved = this.store.getSetting('intentAuthorization') || {}
    this.policy = {
      defaultAllowed: Array.isArray(saved.defaultAllowed) ? saved.defaultAllowed.filter((action) => Object.hasOwn(INTENT_ACTIONS, String(action).toUpperCase())) : [],
      requireApproval: Array.isArray(saved.requireApproval) ? saved.requireApproval : Object.values(INTENT_ACTIONS),
      durableWrites: saved.durableWrites === true
    }
  }

  _save() {
    this.store.setSetting('intentAuthorization', this.policy)
  }

  principal() {
    return { ...this.actor }
  }

  setPolicy(patch = {}) {
    if (patch.defaultAllowed !== undefined) {
      if (!Array.isArray(patch.defaultAllowed) || patch.defaultAllowed.length > Object.keys(INTENT_ACTIONS).length) {
        throw Object.assign(new Error('defaultAllowed must be an action list.'), { code: 'INTENT_POLICY_INVALID' })
      }
      this.policy.defaultAllowed = [...new Set(patch.defaultAllowed)]
    }
    if (patch.durableWrites !== undefined) this.policy.durableWrites = patch.durableWrites === true
    this._save()
    return { ...this.policy }
  }

  grants({ action = null, repository = null } = {}) {
    const nowMs = this.clock()
    return this.store.list('intent_grants', {
      order: 'desc',
      filter: (grant) => grant.status === 'ACTIVE'
        && (!action || grant.action === action)
        && (!repository || grant.scope?.repository === repository)
        && Date.parse(grant.expiresAt) > nowMs
    }).map((grant) => ({ ...grant }))
  }

  /** Create an explicit grant. Grants are scoped, expiring and auditable. */
  grant({ action, scope = {}, reason = '', duration = 'session', approvedBy = null } = {}) {
    if (this.actor.role !== 'Administrator') throw denied('INSUFFICIENT_ROLE', 'Only an Administrator can grant writable intents.')
    if (!Object.values(INTENT_ACTIONS).includes(action) || action === INTENT_ACTIONS.READ) {
      throw Object.assign(new Error('A writable, known action is required.'), { code: 'INTENT_ACTION_INVALID' })
    }
    const normalized = normalizeScope(scope)
    if (!normalized.repository) throw Object.assign(new Error('An exact repository is required for a writable intent.'), { code: 'INTENT_SCOPE_REQUIRED' })
    if (!['once', 'session', 'day'].includes(duration)) throw Object.assign(new Error('Grant duration is invalid.'), { code: 'INTENT_DURATION_INVALID' })
    const nowMs = this.clock()
    const record = {
      id: `intent_${crypto.randomUUID()}`,
      schemaVersion: 1,
      action, risk: INTENT_RISK[action], scope: normalized,
      status: 'ACTIVE', duration, reason: String(reason).slice(0, 500),
      approvedBy: approvedBy || this.actor.id,
      approvedByRole: this.actor.role,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + DURATIONS[duration]).toISOString()
    }
    this.store.put('intent_grants', record.id, record)
    this.store.audit(this.actor.id, 'intent-granted', normalized.repository, { grantId: record.id, action, risk: record.risk, expiresAt: record.expiresAt })
    return record
  }

  revoke(grantId, reason = 'Revoked by owner') {
    if (this.actor.role !== 'Administrator') throw denied('INSUFFICIENT_ROLE', 'Only an Administrator can revoke writable intents.')
    const grant = this.store.get('intent_grants', grantId)
    if (!grant) return null
    if (grant.status === 'REVOKED') return grant
    const updated = this.store.put('intent_grants', grantId, { ...grant, status: 'REVOKED', revokedAt: new Date(this.clock()).toISOString(), revokeReason: String(reason).slice(0, 300) })
    this.store.audit(this.actor.id, 'intent-revoked', grant.scope?.repository || grantId, { grantId, action: grant.action })
    return updated
  }

  /** Fail-closed authorization. No write is performed by this method. */
  authorize({ action, scope = {}, confirm = false, on = null } = {}) {
    if (!Object.values(INTENT_ACTIONS).includes(action)) throw denied('INTENT_ACTION_INVALID', 'Unknown intent action.')
    const requiredRole = REQUIRED_ROLE[action]
    const role = this.actor.role
    if (!Object.hasOwn(ROLE_RANK, role) || ROLE_RANK[role] < ROLE_RANK[requiredRole]) {
      throw denied('INSUFFICIENT_ROLE', `${action} requires ${requiredRole}.`)
    }
    const requested = normalizeScope(scope)
    if (action !== INTENT_ACTIONS.READ && !requested.repository) {
      throw denied('INTENT_SCOPE_REQUIRED', 'This action requires an exact repository scope.')
    }
    if (action !== INTENT_ACTIONS.READ && confirm !== true) {
      throw denied('CONFIRMATION_REQUIRED', 'An explicit confirm=true request is required for this action.')
    }
    const grant = this.grants({ action, repository: requested.repository })
      .find((candidate) => scopeMatches(candidate.scope, requested, action))
    if (!grant) {
      throw denied('INTENT_NOT_GRANTED', `No active intent grants ${action} for ${requested.repository || 'this resource'}.`, { action, scope: requested })
    }
    if (grant.duration === 'once' && this.store.list('intent_uses', { filter: (use) => use.grantId === grant.id }).length > 0) {
      throw denied('INTENT_CONSUMED', 'The one-time intent grant has already been used.', { grantId: grant.id })
    }
    const expiresAt = Date.parse(grant.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= this.clock()) throw denied('INTENT_EXPIRED', 'The matching intent has expired.')
    if (grant.status !== 'ACTIVE') throw denied('INTENT_REVOKED', 'The matching intent was revoked.')
    const record = {
      id: `intent_use_${crypto.randomUUID()}`,
      grantId: grant.id, action, scope: requested, principalId: this.actor.id,
      role, status: 'AUTHORIZED', permittedAt: new Date(this.clock()).toISOString()
    }
    this.store.put('intent_uses', record.id, record)
    this.store.audit(this.actor.id, `intent-use:${action}`, requested.repository, { grantId: grant.id, useId: record.id })
    if (on) on(record)
    return { allowed: true, grant, record }
  }

  complete(useId, { outcome = 'SUCCEEDED', detail = {}, error = null } = {}) {
    const use = this.store.get('intent_uses', useId)
    if (!use) return null
    const updated = this.store.put('intent_uses', useId, {
      ...use, status: outcome, completedAt: new Date(this.clock()).toISOString(),
      detail: { ...(use.detail || {}), ...detail }, error: error ? String(error).slice(0, 800) : null
    })
    this.store.audit(this.actor.id, `intent-outcome:${use.action}`, updated.scope?.repository || useId, { useId, outcome })
    return updated
  }

  async backup(file = null) {
    const grants = this.store.list('intent_grants')
    const uses = this.store.list('intent_uses')
    const metadata = { schemaVersion: 1, exportedAt: new Date(this.clock()).toISOString(), principal: this.principal(), policy: this.policy, grants, uses }
    if (file) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
      await fs.writeFile(temporary, JSON.stringify(metadata, null, 2), { mode: 0o600 })
      await fs.rename(temporary, file)
    }
    return metadata
  }
}
