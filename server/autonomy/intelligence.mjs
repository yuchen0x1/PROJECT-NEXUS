// (1) Precise readiness diagnostics (directive 11) and
// (2) Independent Project Intelligence Engine (directive 5).
//
// The six blocking conditions are deliberately kept SEPARATE. In particular,
// desktop-client mode must NOT be blocked merely because no AI API key exists.

import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  READINESS_CHECKS, BLOCK_CODES, manifestRequirement, makeId
} from './model.mjs'

// ---- Readiness ------------------------------------------------------------

function check(id, state, { blocks = null, detail = '', evidence = null } = {}) {
  return { id, state, blocks: blocks === null ? [] : blocks, detail, evidence }
}

export async function assessReadiness({
  store, repo = {}, mode = 'api', aiApiConfigured = false, adapters = [],
  selectedAdapterId = null, hasScanned = false, taskCount = 0,
  remoteWritesEnabled = false, manifestFiles = null, fsImpl = fsp
} = {}) {
  const checks = []
  const isDesktop = mode === 'desktop' || mode === 'hybrid'

  // 1. AI API - only relevant to API/hybrid analysis, NEVER a desktop blocker.
  checks.push(check('AI_API', aiApiConfigured ? 'ready' : 'not_configured', {
    blocks: aiApiConfigured ? [] : (mode === 'api' ? ['API_MODE'] : []),
    detail: aiApiConfigured ? 'AI API credentials are configured.' :
      'AI API is not configured. Desktop-client mode remains fully available; only API analysis is unavailable.',
    evidence: { configured: aiApiConfigured }
  }))

  // 2. Desktop client - distinct states, never merged into NEEDS_PROVIDER.
  const adapter = adapters.find((item) => item.id === (selectedAdapterId || repo.agentAdapterId)) || null
  let clientState = 'not_connected'
  let clientBlocks = []
  let clientDetail = 'No desktop client is bound to this repository.'
  if (adapter) {
    if (!adapter.installed) {
      clientState = 'not_installed'
      clientDetail = `${adapter.name} is not installed on this Windows host.`
      if (isDesktop) clientBlocks.push('DESKTOP_CLIENT_ABSENT')
    } else if (!adapter.running) {
      clientState = 'installed_not_running'
      clientDetail = `${adapter.name} is installed but not running; NEXUS can launch it.`
    } else if (adapter.uia && !adapter.uia.available) {
      // Degraded, NOT blocked: reliable human handoff remains available.
      clientState = 'uia_unavailable'
      clientDetail = `${adapter.name} is running, but UI Automation is unavailable (${adapter.uia.reason}); tasks will use human handoff.`
    } else {
      clientState = 'ready'
      clientDetail = `${adapter.name} is running and UI Automation is available. Login state still requires human confirmation.`
    }
  } else if (isDesktop) {
    clientBlocks.push('DESKTOP_CLIENT_ABSENT')
  }
  checks.push(check('DESKTOP_CLIENT', clientState, {
    blocks: clientBlocks, detail: clientDetail,
    evidence: adapter ? { id: adapter.id, installed: adapter.installed, running: adapter.running, uia: adapter.uia } : null
  }))

  // 3. Repository scan - a distinct condition from provider availability.
  checks.push(check('REPOSITORY_SCAN', hasScanned ? 'complete' : 'pending', {
    blocks: hasScanned ? [] : ['FULL_ANALYSIS'],
    detail: hasScanned ? 'At least one incremental repository scan has completed.' : 'No repository scan has completed yet; monitoring can still run.',
    evidence: { hasScanned }
  }))

  // 4. Manifest - required ONLY when the detected stack needs one.
  const localPath = String(repo.localPath || '')
  const stackHint = String(repo.stack || (await detectStackHint(localPath, { fsImpl })) || 'generic')
  const requirement = manifestRequirement(stackHint)
  let present = []
  if (manifestFiles) present = manifestFiles
  else if (localPath) {
    for (const file of requirement.files) {
      try { await fsImpl.stat(path.join(localPath, file)); present.push(file) } catch { /* missing */ }
    }
  }
  const manifestState = !requirement.required ? 'not_required'
    : present.length ? 'present' : 'missing_required'
  checks.push(check('MANIFEST', manifestState, {
    blocks: manifestState === 'missing_required' ? ['LOCAL_VERIFICATION'] : [],
    detail: !requirement.required
      ? `Stack '${requirement.stack}' does not require a manifest; no manifest will be demanded.`
      : `Stack '${requirement.stack}' expects ${requirement.files.join(' or ')}; found ${present.join(', ') || 'none'}.`,
    evidence: { stack: requirement.stack, required: requirement.required, expected: requirement.files, present }
  }))

  // 5. Task generation.
  checks.push(check('TASK_GENERATION', taskCount > 0 ? 'tasks_available' : 'no_tasks', {
    blocks: [], detail: taskCount > 0 ? `${taskCount} task(s) available.` : 'No task has been generated yet; this is a normal idle state, not a provider failure.'
  }))

  // 6. Task executability: permissions, local binding, clean tree.
  const executable = Boolean(localPath) && repo.automationMode !== 'observe'
  checks.push(check('TASK_EXECUTABILITY', executable ? 'ready' : 'restricted', {
    blocks: [],
    detail: !localPath ? 'No local project directory is bound.'
      : repo.automationMode === 'observe' ? 'Observe mode: monitoring and analysis only, code changes require a higher automation level.'
      : 'Write tasks are permitted under the current automation level.',
    evidence: { automationMode: repo.automationMode || 'observe', remoteWritesEnabled, localBound: Boolean(localPath) }
  }))

  // Only genuine hard gates belong in blockingCodes. Idle states such as
  // "no task generated" are separate, non-blocking conditions (directive 11).
  const blockingCodes = []
  const conditions = []
  if (mode === 'api' && !aiApiConfigured) blockingCodes.push(BLOCK_CODES.AI_API_NOT_CONFIGURED)
  if (isDesktop && clientBlocks.length) blockingCodes.push(BLOCK_CODES.DESKTOP_CLIENT_NOT_CONNECTED)
  if (manifestState === 'missing_required') blockingCodes.push(BLOCK_CODES.MANIFEST_REQUIRED_MISSING)
  if (isDesktop && clientState === 'uia_unavailable') conditions.push(BLOCK_CODES.DESKTOP_CLIENT_UIA_UNAVAILABLE)
  if (!hasScanned) conditions.push(BLOCK_CODES.REPOSITORY_SCAN_PENDING)
  if (!taskCount) conditions.push(BLOCK_CODES.NO_TASK_GENERATED)
  if (!executable) conditions.push(BLOCK_CODES.TASK_NOT_EXECUTABLE)

  const hardBlocked = blockingCodes.length > 0
  return {
    overall: hardBlocked ? 'BLOCKED' : conditions.length ? 'DEGRADED' : 'READY',
    mode, checks, blockingCodes, conditions,
    desktopIndependentOfApi: true,
    summary: hardBlocked
      ? `Execution blocked for ${mode} mode; see individual checks.`
      : `System is operational in ${mode} mode; ${conditions.length} non-blocking condition(s) recorded.`,
    assessedAt: new Date().toISOString()
  }
}

export async function detectStackHint(localPath, { fsImpl = fsp } = {}) {
  if (!localPath) return 'generic'
  const probes = [
    ['package.json', 'node'], ['pyproject.toml', 'python'], ['requirements.txt', 'python'],
    ['Cargo.toml', 'rust'], ['go.mod', 'go'], ['.sln', 'dotnet']
  ]
  for (const [file, stack] of probes) {
    try { await fsImpl.stat(path.join(localPath, file)); return stack } catch { /* keep probing */ }
  }
  return 'generic'
}

// ---- Project Intelligence -------------------------------------------------

// Compatibility against an MIT-licensed target (this project's LICENSE).
// Copying source code from incompatible licences is prohibited; ideas may
// still be studied and independently reimplemented.
const LICENSE_COMPATIBILITY = Object.freeze({
  'mit': { compatible: true, note: 'MIT: compatible, attribution required.' },
  'isc': { compatible: true, note: 'ISC: compatible, attribution required.' },
  'bsd-2-clause': { compatible: true, note: 'BSD-2-Clause: compatible, attribution required.' },
  'bsd-3-clause': { compatible: true, note: 'BSD-3-Clause: compatible, attribution + no-endorsement required.' },
  '0bsd': { compatible: true, note: '0BSD: compatible.' },
  'apache-2.0': { compatible: true, note: 'Apache-2.0: compatible, NOTICE and patent terms apply.' },
  'unlicense': { compatible: true, note: 'Public domain dedication.' },
  'mpl-2.0': { compatible: false, note: 'MPL-2.0: file-level copyleft; do not copy source into MIT files.' },
  'lgpl-2.1': { compatible: false, note: 'LGPL: copyleft; study the approach, reimplement independently.' },
  'lgpl-3.0': { compatible: false, note: 'LGPL: copyleft; study the approach, reimplement independently.' },
  'gpl-2.0': { compatible: false, note: 'GPL-2.0: incompatible with MIT redistribution; do not copy code.' },
  'gpl-3.0': { compatible: false, note: 'GPL-3.0: incompatible with MIT redistribution; do not copy code.' },
  'agpl-3.0': { compatible: false, note: 'AGPL-3.0: strong copyleft; do not copy code.' },
  'sspl-1.0': { compatible: false, note: 'SSPL: not OSI-approved; do not copy code.' },
  'bsl-1.1': { compatible: false, note: 'Business Source License: restricted; do not copy code.' }
})

export function licenseAssessment(license) {
  const key = String(license || '').toLowerCase().trim()
  if (!key || key === 'none' || key === 'noassertion') {
    return { compatible: false, prohibited: true, note: 'No licence declared: all rights reserved. Studying is allowed; copying code is prohibited.' }
  }
  const match = LICENSE_COMPATIBILITY[key]
  if (match) return { compatible: match.compatible, prohibited: false, note: match.note }
  return { compatible: false, prohibited: false, note: `Licence '${license}' is not in the verified matrix; manual legal review is required.` }
}

/** Discover similar real repositories via the GitHub Search API. */
export async function discoverPeerProjects({
  query, topics = [], token = process.env.GITHUB_TOKEN || '',
  apiBase = 'https://api.github.com', fetchImpl = globalThis.fetch, limit = 10,
  source = 'github-search-api'
} = {}) {
  const terms = [query, ...topics.map((topic) => `topic:${topic}`)].filter(Boolean).join(' ')
  const url = `${apiBase}/search/repositories?q=${encodeURIComponent(terms)}&sort=stars&order=desc&per_page=${Math.min(100, Math.max(1, limit))}`
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'PROJECT-NEXUS-Intelligence/2.0' }
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetchImpl(url, { headers })
  if (!response.ok) {
    return { ok: false, code: 'PEER_SEARCH_FAILED', status: response.status, items: [] }
  }
  const body = await response.json()
  const items = (body.items || []).map((item) => ({
    fullName: item.full_name, name: item.name, description: String(item.description || '').slice(0, 500),
    stack: item.language || null, stars: item.stargazers_count, forks: item.forks_count,
    license: item.license?.spdx_id || null, pushedAt: item.pushed_at,
    topics: item.topics || [], htmlUrl: item.html_url,
    defaultBranch: item.default_branch, openIssues: item.open_issues_count,
    // Trending is a discovery source only and is NEVER used as a quality score.
    discoverySource: source, qualitySource: 'code-and-release-analysis'
  }))
  return { ok: true, totalCount: body.total_count || items.length, items, query: terms }
}

/** Persist a discovered peer; re-discovery updates rather than duplicates. */
export function savePeerProjects(store, items = [], { repoId = null } = {}) {
  const saved = []
  for (const item of items) {
    const id = `peer:${String(item.fullName).toLowerCase()}`
    const previous = store.get('peer_projects', id)
    const record = store.put('peer_projects', id, {
      ...(previous || {}), ...item, id, relatedRepoId: repoId || previous?.relatedRepoId || null,
      discoveredAt: previous?.discoveredAt || new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      relevance: previous?.relevance ?? null
    })
    saved.push(record)
  }
  return saved
}

/** Track real upstream changes (commits / releases), not just README text. */
export async function trackPeerChanges({
  peer, token = process.env.GITHUB_TOKEN || '', apiBase = 'https://api.github.com',
  fetchImpl = globalThis.fetch
} = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'PROJECT-NEXUS-Intelligence/2.0' }
  if (token) headers.Authorization = `Bearer ${token}`
  const out = { fullName: peer.fullName, releases: [], commits: [], issues: [], pullRequests: [], errors: [] }
  const endpoints = [
    ['releases', `/repos/${peer.fullName}/releases?per_page=5`],
    ['commits', `/repos/${peer.fullName}/commits?per_page=10`],
    ['issues', `/repos/${peer.fullName}/issues?state=open&per_page=5`],
    ['pullRequests', `/repos/${peer.fullName}/pulls?state=closed&per_page=5`]
  ]
  for (const [key, endpoint] of endpoints) {
    try {
      const response = await fetchImpl(`${apiBase}${endpoint}`, { headers })
      if (!response.ok) { out.errors.push({ resource: key, status: response.status }); continue }
      const body = await response.json()
      out[key] = (Array.isArray(body) ? body : []).map((item) => ({
        id: item.id || item.sha || item.number, title: String(item.name || item.tag_name || item.title || item.commit?.message || '').slice(0, 300),
        at: item.published_at || item.created_at || item.commit?.committer?.date || item.closed_at || null,
        body: String(item.body || item.commit?.message || '').slice(0, 1500),
        merged: item.merged ?? null, url: item.html_url || null
      }))
    } catch (error) { out.errors.push({ resource: key, message: String(error.message).slice(0, 200) }) }
  }
  out.checkedAt = new Date().toISOString()
  return out
}

/** The 12-point porting analysis required by directive 5.3. */
export function analyzePortingOpportunity({
  peer = {}, change = {}, currentProject = {}, license = 'MIT'
} = {}) {
  const licence = licenseAssessment(peer.license || license)
  const title = String(change.title || 'Upstream change').slice(0, 300)
  const description = String(change.body || '')
  const introducesFeature = /feat|add|introduce|support|new /i.test(`${title} ${description}`)
  const fixesBug = /fix|bug|patch|regression|crash|security/i.test(`${title} ${description}`)
  const hasEquivalent = (currentProject.existingCapabilities || []).some((capability) =>
    String(capability).toLowerCase().split(/\s+/).some((word) => word.length > 4 && title.toLowerCase().includes(word)))
  const risky = /breaking|migration|deprecat|remove|rewrite|major/i.test(`${title} ${description}`)
  const extraDeps = /dependenc|install|package|require|add library|sdk/i.test(description)
  const analysis = [
    { key: 'what_added', question: 'What capability did the peer add?', answer: introducesFeature ? title : `Change: ${title}` },
    { key: 'problem_solved', question: 'What problem does it solve?', answer: fixesBug ? 'Addresses a reported defect or security issue.' : 'Extends capability or improves quality.' },
    { key: 'implementation', question: 'How was it implemented upstream?', answer: description.slice(0, 600) || 'Not documented in the release/commit body; requires reading upstream code.' },
    { key: 'already_have', question: 'Does NEXUS already have an equivalent?', answer: hasEquivalent ? 'A similar capability exists; verify parity before acting.' : 'No equivalent was detected.' },
    { key: 'same_defect', question: 'Does our project share the same defect?', answer: fixesBug ? 'Possible; a local reproduction test is required before porting.' : 'Not applicable to a defect.' },
    { key: 'worth_porting', question: 'Is it worth porting?', answer: hasEquivalent ? 'Low value: capability already present.' : introducesFeature ? 'Potentially valuable; needs prioritisation.' : 'Only if the defect is reproduced locally.' },
    { key: 'better_approach', question: 'Is there a better implementation?', answer: 'Evaluate a NEXUS-native design before importing upstream structure.' },
    { key: 'license', question: 'Licence compatibility and attribution?', answer: `${licence.note}${licence.compatible ? ' Attribution must be retained.' : ' Do NOT copy upstream source; reimplement independently.'}` },
    { key: 'dependencies', question: 'Would it add unnecessary dependencies?', answer: extraDeps ? 'Upstream mentions dependency changes; audit before adoption.' : 'No new dependency indicated.' },
    { key: 'architecture', question: 'Would it break existing architecture?', answer: risky ? 'High risk: breaking/migration language detected.' : 'No obvious architectural conflict.' },
    { key: 'files', question: 'Which files would change?', answer: (currentProject.candidateFiles || []).join(', ') || 'To be determined by a local code analysis task.' },
    { key: 'tests', question: 'How would it be tested?', answer: 'Add regression/feature tests in the isolated worktree, then run the project verification suite and independent review.' }
  ]
  const recommended = licence.compatible && !licence.prohibited && !hasEquivalent && !risky && (introducesFeature || fixesBug)
  const priority = fixesBug && /security|critical/i.test(title) ? 'P1' : introducesFeature ? 'P3' : 'P4'
  return {
    featureName: title, sourceProject: peer.fullName, sourceLicence: peer.license || null,
    analysis, licence, recommended, priority,
    risk: risky ? 'high' : extraDeps ? 'medium' : 'low',
    estimatedEffort: risky ? 'large' : extraDeps ? 'medium' : 'small',
    copyPermitted: licence.compatible && !licence.prohibited,
    attributionRequired: licence.compatible,
    requiresLegalReview: !licence.compatible
  }
}

export function createPortingProposal({ store, repo, peer, change, analysis }) {
  const proposal = {
    id: makeId('proposal'), repoId: repo.id, repository: repo.fullName,
    peerId: peer.id || `peer:${String(peer.fullName).toLowerCase()}`,
    featureName: analysis.featureName, sourceProject: analysis.sourceProject,
    sourceLicence: analysis.sourceLicence, analysis: analysis.analysis,
    licenceCompatible: analysis.licence.compatible, recommended: analysis.recommended,
    priority: analysis.priority, risk: analysis.risk, estimatedEffort: analysis.estimatedEffort,
    copyPermitted: analysis.copyPermitted, attributionRequired: analysis.attributionRequired,
    requiresLegalReview: analysis.requiresLegalReview,
    status: analysis.recommended ? 'SUGGESTED' : 'REJECTED',
    createdAt: new Date().toISOString()
  }
  store.put('porting_proposals', proposal.id, proposal)
  store.audit('intelligence', 'porting-proposal', repo.fullName, {
    feature: proposal.featureName, recommended: proposal.recommended, licenceCompatible: proposal.licenceCompatible
  })
  return proposal
}

export { READINESS_CHECKS, BLOCK_CODES }
