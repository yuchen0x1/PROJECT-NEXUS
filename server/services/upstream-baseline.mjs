import fs from 'node:fs/promises'
import path from 'node:path'

// ZIP baseline content-level three-way diff (master directive PART 3.2).
//
// A baseline captures the upstream file manifest (path → git blob SHA) at
// declaration time. A comparison then classifies every path across three
// trees — baseline (upstream at capture), user repository (current), upstream
// (latest) — WITHOUT downloading file contents: GitHub tree entries carry blob
// SHAs, and equal SHAs mean equal content.
//
// Classification (directive §3.2): upstream-added / upstream-deleted /
// user-modified / user-added / both-modified (conflict) / already-synced.

export const BASELINE_STORE_FILE = 'upstream-baselines.json'
export const BASELINE_SCHEMA_VERSION = 1
export const MAX_BASELINE_FILES = 20_000
export const MAX_RESULT_ENTRIES = 400

export function baselineError(code, message) {
  return Object.assign(new Error(message), { code })
}

function storePath(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw baselineError('BASELINE_INVALID_DATA_DIR', 'dataDir must be an absolute directory path.')
  return path.join(path.resolve(dataDir), BASELINE_STORE_FILE)
}

export async function loadBaselineStore(dataDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath(dataDir), 'utf8'))
    if (!parsed || parsed.schemaVersion !== BASELINE_SCHEMA_VERSION || typeof parsed.baselines !== 'object' || Array.isArray(parsed.baselines)) {
      throw baselineError('BASELINE_STORE_INVALID', 'The baseline store has an unsupported shape.')
    }
    return parsed
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: BASELINE_SCHEMA_VERSION, baselines: {} }
    throw error
  }
}

export async function saveBaselineStore(dataDir, store) {
  const target = storePath(dataDir)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(store, null, 2), 'utf8')
  await fs.rename(temporary, target)
}

export function getBaseline(store, projectId) {
  const baseline = store.baselines?.[projectId]
  if (!baseline || typeof baseline.files !== 'object') return null
  return baseline
}

// GitHub tree response (git/trees/{ref}?recursive=1) → { path: blobSha } map.
// Only blobs are tracked; submodules (commit entries) are skipped and counted.
export function baselineFilesFromTree(treeResponse) {
  const entries = Array.isArray(treeResponse?.tree) ? treeResponse.tree : []
  const files = {}
  let skipped = 0
  for (const entry of entries) {
    if (entry?.type !== 'blob' || typeof entry.path !== 'string' || typeof entry.sha !== 'string') {
      if (entry?.type && entry.type !== 'blob') skipped += 1
      continue
    }
    files[entry.path] = entry.sha
  }
  const truncated = treeResponse?.truncated === true || Object.keys(files).length > MAX_BASELINE_FILES
  const clipped = {}
  const keys = Object.keys(files).slice(0, MAX_BASELINE_FILES)
  for (const key of keys) clipped[key] = files[key]
  return { files: clipped, total: Object.keys(files).length, skipped, truncated }
}

export async function captureBaseline({ dataDir, projectId, upstreamFullName, ref, capturedAt = new Date().toISOString(), fetchTree }) {
  if (typeof fetchTree !== 'function') throw baselineError('BASELINE_FETCH_MISSING', 'A tree fetcher is required.')
  const cleanRepo = String(upstreamFullName || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(cleanRepo)) throw baselineError('UPSTREAM_REPO_INVALID', 'The upstream repository must be given as owner/repo.')
  if (typeof ref !== 'string' || !ref.trim()) throw baselineError('BASELINE_REF_REQUIRED', 'A baseline upstream ref (branch, tag or commit sha) is required.')
  const tree = await fetchTree(cleanRepo, ref.trim())
  const manifest = baselineFilesFromTree(tree)
  if (!manifest.total) throw baselineError('BASELINE_TREE_EMPTY', 'The upstream tree contains no files.')

  const store = await loadBaselineStore(dataDir)
  store.baselines[projectId] = {
    upstreamFullName: cleanRepo,
    ref: ref.trim(),
    refSha: typeof tree?.sha === 'string' ? tree.sha : null,
    capturedAt,
    files: manifest.files,
    fileCount: manifest.total,
    truncated: manifest.truncated,
    skipped: manifest.skipped,
    comparison: null
  }
  await saveBaselineStore(dataDir, store)
  return publicBaseline(store.baselines[projectId])
}

function cappedList(list, kind) {
  const total = list.length
  return { kind, total, entries: list.slice(0, MAX_RESULT_ENTRIES) }
}

// The classification matrix over the union of the three file sets.
export function classifyThreeWay({ baselineFiles, userFiles, upstreamFiles }) {
  const paths = new Set([...Object.keys(baselineFiles), ...Object.keys(userFiles), ...Object.keys(upstreamFiles)])
  const conflicts = []
  const upstreamChanges = []
  const userChanges = []
  const upstreamDeletes = []
  const synced = []
  let unchanged = 0

  for (const filePath of paths) {
    const b = baselineFiles[filePath] || null
    const c = userFiles[filePath] || null
    const u = upstreamFiles[filePath] || null
    if (b && c && u) {
      if (c === b && u === b) { unchanged += 1; continue }
      if (c !== b && u === b) { userChanges.push(filePath); continue }
      if (c === b && u !== b) { upstreamChanges.push(filePath); continue }
      // Both sides moved away from the baseline.
      if (c === u) { synced.push(filePath); continue }
      conflicts.push({ path: filePath, kind: 'both-modified' })
      continue
    }
    if (b && !c && u) { conflicts.push({ path: filePath, kind: 'user-deleted-upstream-present' }); continue }
    if (b && c && !u) {
      if (c === b) upstreamDeletes.push(filePath)
      else conflicts.push({ path: filePath, kind: 'user-modified-upstream-deleted' })
      continue
    }
    if (!b && c && u) {
      if (c === u) { synced.push(filePath); continue }
      conflicts.push({ path: filePath, kind: 'both-added' })
      continue
    }
    if (!b && c && !u) { userChanges.push(filePath); continue }
    if (!b && !c && u) { upstreamChanges.push(filePath); continue }
    // b && !c && !u: both deleted — no action possible.
  }

  return {
    unchanged,
    synced: cappedList(synced, 'already-synced'),
    conflicts: cappedList(conflicts, 'conflict'),
    upstreamChanges: cappedList(upstreamChanges, 'upstream-change'),
    upstreamDeletes: cappedList(upstreamDeletes, 'upstream-delete'),
    userChanges: cappedList(userChanges, 'user-change'),
    totals: {
      trackedPaths: paths.size,
      conflicts: conflicts.length,
      upstreamChanges: upstreamChanges.length,
      upstreamDeletes: upstreamDeletes.length,
      userChanges: userChanges.length,
      synced: synced.length
    }
  }
}

export function publicBaseline(baseline) {
  if (!baseline) return null
  return {
    upstreamFullName: baseline.upstreamFullName,
    ref: baseline.ref,
    refSha: baseline.refSha || null,
    capturedAt: baseline.capturedAt,
    fileCount: baseline.fileCount,
    truncated: Boolean(baseline.truncated),
    skipped: baseline.skipped || 0,
    comparison: baseline.comparison || null
  }
}

// Fetch the two current trees and classify against the stored baseline. The
// summary is persisted on the baseline so the UI can show it without refetch.
// "Upstream latest" resolves the upstream repository's current default branch
// through fetchRepo when no explicit ref is given — not the baseline ref.
export async function runThreeWayComparison({ dataDir, projectId, projectFullName, projectDefaultBranch = 'main', upstreamDefaultBranch = null, fetchTree, fetchRepo = null }) {
  if (typeof fetchTree !== 'function') throw baselineError('BASELINE_FETCH_MISSING', 'A tree fetcher is required.')
  const store = await loadBaselineStore(dataDir)
  const baseline = getBaseline(store, projectId)
  if (!baseline) throw baselineError('BASELINE_MISSING', 'Capture a baseline before running a comparison.')

  let resolvedUpstreamRef = upstreamDefaultBranch
  if (!resolvedUpstreamRef) {
    if (typeof fetchRepo === 'function') {
      const upstreamRepo = await fetchRepo(baseline.upstreamFullName)
      resolvedUpstreamRef = upstreamRepo?.default_branch || baseline.ref
    } else {
      resolvedUpstreamRef = baseline.ref
    }
  }

  const [userTree, upstreamTree] = await Promise.all([
    fetchTree(projectFullName, projectDefaultBranch),
    fetchTree(baseline.upstreamFullName, resolvedUpstreamRef)
  ])
  const userManifest = baselineFilesFromTree(userTree)
  const upstreamManifest = baselineFilesFromTree(upstreamTree)
  const classification = classifyThreeWay({ baselineFiles: baseline.files, userFiles: userManifest.files, upstreamFiles: upstreamManifest.files })

  const comparison = {
    at: new Date().toISOString(),
    userRef: projectDefaultBranch,
    userTruncated: userManifest.truncated,
    upstreamRef: resolvedUpstreamRef,
    upstreamTruncated: upstreamManifest.truncated,
    ...classification
  }
  baseline.comparison = comparison
  await saveBaselineStore(dataDir, store)
  return { baseline: publicBaseline(baseline), comparison }
}
