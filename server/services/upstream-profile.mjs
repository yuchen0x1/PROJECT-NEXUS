// Repository Upstream Profile (master directive PART 3): for every managed
// repository, determine where it came from and keep the evidence.
//
// Types (directive §3.1):
//  - fork-verified          GitHub confirms the fork relation (repo.parent/source).
//  - clone-common-history   no formal fork, but the compare API proves a common
//                           ancestor (merge base) with the upstream repository.
//  - zip-reupload-declared  user-declared ZIP re-upload; no shared git history.
//  - third-party-declared   user-declared continuation of someone else's fork.
//  - unknown                nothing verified; a candidate is NEVER auto-bound
//                           from the repo name alone (directive §3.1).
//
// All GitHub access is injected (fetchRepo/fetchCompare) so the logic is unit
// testable without network.

export const UPSTREAM_PROFILE_TYPES = Object.freeze([
  'fork-verified',
  'clone-common-history',
  'zip-reupload-declared',
  'third-party-declared',
  'unknown'
])

const REPO_FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/

export function upstreamProfileError(code, message) {
  return Object.assign(new Error(message), { code })
}

export function emptyUpstreamProfile() {
  return {
    type: 'unknown',
    upstreamFullName: null,
    upstreamDefaultBranch: null,
    confidence: 0,
    evidence: [],
    declared: null,
    mergeBase: null,
    checkedAt: null
  }
}

function pushEvidence(profile, kind, detail, extra = {}) {
  profile.evidence = [...(profile.evidence || []), { at: new Date().toISOString(), kind, detail: String(detail).slice(0, 500), ...extra }].slice(-20)
}

export function normalizeUpstreamFullName(value) {
  const candidate = String(value || '').trim()
  if (!candidate || !REPO_FULL_NAME.test(candidate)) {
    throw upstreamProfileError('UPSTREAM_REPO_INVALID', 'The upstream repository must be given as owner/repo.')
  }
  return candidate
}

// Type A: GitHub itself confirms the fork relation. repo.parent is the direct
// origin; repo.source (fork-of-fork) points at the root repository.
export function profileFromGitHubRepo(repo) {
  if (!repo || typeof repo !== 'object') return null
  const parent = repo.parent && typeof repo.parent === 'object' ? repo.parent : null
  const source = repo.source && typeof repo.source === 'object' ? repo.source : null
  if (!parent && !source) return null
  const profile = emptyUpstreamProfile()
  profile.type = 'fork-verified'
  profile.upstreamFullName = (source || parent)?.full_name || null
  profile.upstreamDefaultBranch = (source || parent)?.default_branch || null
  profile.confidence = 1
  if (parent) pushEvidence(profile, 'github-parent', `GitHub reports fork parent ${parent.full_name}.`, { repository: parent.full_name })
  if (source && source.full_name !== parent?.full_name) pushEvidence(profile, 'github-source', `Fork chain root is ${source.full_name}.`, { repository: source.full_name })
  profile.checkedAt = new Date().toISOString()
  return profile
}

// Type B: the compare API proves (or disproves) a shared git history between
// the user repository and a candidate upstream — without fetching locally.
export async function probeCommonHistory({ fetchCompare, userRepo, upstreamRepo, userBranch, upstreamBranch }) {
  if (typeof fetchCompare !== 'function') throw upstreamProfileError('UPSTREAM_FETCH_MISSING', 'A compare fetcher is required.')
  if (!REPO_FULL_NAME.test(String(userRepo || '')) || !REPO_FULL_NAME.test(String(upstreamRepo || ''))) {
    throw upstreamProfileError('UPSTREAM_REPO_INVALID', 'Both repositories must be owner/repo strings.')
  }
  const basehead = `${upstreamRepo.split('/')[0]}:${upstreamBranch}...${userRepo.split('/')[0]}:${userBranch}`
  try {
    const result = await fetchCompare(basehead)
    const mergeBase = result?.merge_base_commit?.sha || null
    if (!mergeBase) return null
    return {
      status: result.status || 'diverged',
      mergeBaseSha: mergeBase,
      aheadBy: Number(result.ahead_by || 0),
      behindBy: Number(result.behind_by || 0),
      totalCommits: Number(result.total_commits || 0)
    }
  } catch (error) {
    // GitHub answers "No common ancestor" for unrelated histories; treat every
    // compare failure as "not proven" instead of guessing.
    return null
  }
}

// Types C/D: user declaration. The upstream is NOT auto-bound from heuristics;
// a declaration is explicit input, stored with who/when/what.
export function applyDeclaration(profile, { upstreamFullName, kind = 'zip-reupload', ref = null, version = null, note = '' }) {
  const cleanRepo = normalizeUpstreamFullName(upstreamFullName)
  if (!['zip-reupload', 'third-party'].includes(kind)) {
    throw upstreamProfileError('UPSTREAM_KIND_INVALID', 'A declaration kind must be zip-reupload or third-party.')
  }
  const next = cloneProfile(profile)
  next.declared = {
    upstreamFullName: cleanRepo,
    kind,
    ref: ref ? String(ref).slice(0, 200) : null,
    version: version ? String(version).slice(0, 100) : null,
    note: String(note || '').slice(0, 1000),
    declaredAt: new Date().toISOString()
  }
  next.upstreamFullName = cleanRepo
  next.type = kind === 'zip-reupload' ? 'zip-reupload-declared' : 'third-party-declared'
  next.confidence = 0.5
  pushEvidence(next, 'declared', `User declared ${kind} from ${cleanRepo}${version ? ` (version ${version})` : ''}.`, { repository: cleanRepo })
  return next
}

export function mergeUpstreamProfile(existing, next) {
  const base = cloneProfile(existing)
  const merged = { ...base, ...next }
  merged.evidence = [...(base.evidence || []), ...(next.evidence || [])].slice(-20)
  // A declaration is user input: a new evidence-only profile must not wipe it.
  merged.declared = next.declared || base.declared || null
  // A verified type always outranks a declaration; a declaration is kept as
  // declared metadata but the type follows the strongest evidence.
  const rank = { 'fork-verified': 3, 'clone-common-history': 2, 'zip-reupload-declared': 1, 'third-party-declared': 1, unknown: 0 }
  if ((rank[next.type] ?? 0) < (rank[base.type] ?? 0)) {
    merged.type = base.type
    merged.confidence = base.confidence
    merged.upstreamFullName = base.upstreamFullName
    merged.upstreamDefaultBranch = base.upstreamDefaultBranch
    merged.mergeBase = base.mergeBase
  }
  merged.checkedAt = next.checkedAt || new Date().toISOString()
  return sanitizeProfile(merged)
}

function cloneProfile(profile) {
  const base = profile && typeof profile === 'object' ? { ...profile } : emptyUpstreamProfile()
  base.evidence = Array.isArray(base.evidence) ? [...base.evidence] : []
  return base
}

function sanitizeProfile(profile) {
  const clean = emptyUpstreamProfile()
  clean.type = UPSTREAM_PROFILE_TYPES.includes(profile.type) ? profile.type : 'unknown'
  clean.upstreamFullName = typeof profile.upstreamFullName === 'string' && REPO_FULL_NAME.test(profile.upstreamFullName) ? profile.upstreamFullName : null
  clean.upstreamDefaultBranch = typeof profile.upstreamDefaultBranch === 'string' ? profile.upstreamDefaultBranch.slice(0, 200) : null
  clean.confidence = Math.max(0, Math.min(1, Number(profile.confidence) || 0))
  clean.evidence = (Array.isArray(profile.evidence) ? profile.evidence : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({ at: String(entry.at || ''), kind: String(entry.kind || '').slice(0, 60), detail: String(entry.detail || '').slice(0, 500), ...(entry.repository ? { repository: String(entry.repository).slice(0, 200) } : {}) }))
    .slice(-20)
  clean.declared = profile.declared && typeof profile.declared === 'object'
    ? {
        upstreamFullName: normalizeUpstreamFullName(profile.declared.upstreamFullName),
        kind: ['zip-reupload', 'third-party'].includes(profile.declared.kind) ? profile.declared.kind : 'zip-reupload',
        ref: profile.declared.ref ? String(profile.declared.ref).slice(0, 200) : null,
        version: profile.declared.version ? String(profile.declared.version).slice(0, 100) : null,
        note: String(profile.declared.note || '').slice(0, 1000),
        declaredAt: String(profile.declared.declaredAt || '')
      }
    : null
  clean.mergeBase = profile.mergeBase && typeof profile.mergeBase === 'object'
    ? {
        status: String(profile.mergeBase.status || '').slice(0, 40),
        mergeBaseSha: /^[a-f0-9]{40}$/i.test(String(profile.mergeBase.mergeBaseSha || '')) ? profile.mergeBase.mergeBaseSha : null,
        aheadBy: Number(profile.mergeBase.aheadBy) || 0,
        behindBy: Number(profile.mergeBase.behindBy) || 0,
        totalCommits: Number(profile.mergeBase.totalCommits) || 0
      }
    : null
  clean.checkedAt = profile.checkedAt || null
  return clean
}

// Full derivation for one project. Fetchers:
//   fetchRepo(fullName) → GitHub repo object (includes parent/source)
//   fetchCompare(basehead) → compare object
export async function deriveUpstreamProfile({ project, profile, candidateUpstream = null, fetchRepo, fetchCompare }) {
  if (typeof fetchRepo !== 'function') throw upstreamProfileError('UPSTREAM_FETCH_MISSING', 'A repo fetcher is required.')
  const userRepo = String(project.fullName || '')
  const userBranch = String(project.defaultBranch || 'main')
  let current = cloneProfile(profile)
  let next = null

  // 1. Type A — ask GitHub about the fork relation.
  const repo = await fetchRepo(userRepo)
  const forkProfile = profileFromGitHubRepo(repo)
  if (forkProfile) next = forkProfile

  // 2. Type B — a candidate upstream (explicit request, prior profile, or a
  // user declaration) gets verified through the compare API.
  const candidate = candidateUpstream || next?.upstreamFullName || current.upstreamFullName || current.declared?.upstreamFullName || null
  if (!next && candidate) {
    const cleanCandidate = normalizeUpstreamFullName(candidate)
    const upstreamRepo = await fetchRepo(cleanCandidate)
    const upstreamBranch = upstreamRepo?.default_branch || 'main'
    const history = await probeCommonHistory({ fetchCompare, userRepo, upstreamRepo: cleanCandidate, userBranch, upstreamBranch })
    if (history) {
      next = emptyUpstreamProfile()
      next.type = 'clone-common-history'
      next.upstreamFullName = cleanCandidate
      next.upstreamDefaultBranch = upstreamBranch
      next.confidence = 0.9
      next.mergeBase = history
      pushEvidence(next, 'compare-merge-base', `Common ancestor ${history.mergeBaseSha.slice(0, 12)} with ${cleanCandidate} (${history.status}; +${history.aheadBy}/-${history.behindBy}).`, { repository: cleanCandidate })
    } else if (current.declared?.upstreamFullName === cleanCandidate) {
      // Unrelated histories with a declaration: keep the declaration, record
      // the failed proof honestly.
      next = cloneProfile(current)
      pushEvidence(next, 'no-common-ancestor', `No common ancestor between ${userRepo} and ${cleanCandidate}; declaration kept without git proof.`, { repository: cleanCandidate })
      next.checkedAt = new Date().toISOString()
    } else {
      next = cloneProfile(current)
      next.type = 'unknown'
      next.confidence = 0
      pushEvidence(next, 'no-common-ancestor', `Candidate ${cleanCandidate} shares no common ancestor with ${userRepo}; not bound.`, { repository: cleanCandidate })
    }
  }

  if (!next) {
    next = cloneProfile(current)
    next.type = current.declared ? current.type : 'unknown'
    next.confidence = current.declared ? current.confidence : 0
    pushEvidence(next, 'no-fork-relation', 'GitHub reports no fork relation for this repository.')
  }

  const merged = mergeUpstreamProfile(current, next)
  return merged
}
