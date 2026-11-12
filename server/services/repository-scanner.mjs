import { inspectComponents } from '../integrations/registry.mjs'
import { assessComponents } from './update-assessor.mjs'
import { repositoryApiPath, repositoryTreePath } from './github-paths.mjs'

const MAX_FILES = 1200
const MAX_READS = 48
const MAX_TREE_REQUESTS = 100
const MAX_FILE_BYTES = 256 * 1024

const sourcePriority = [
  /(^|\/)(package\.json|pnpm-workspace\.yaml|Cargo\.toml|tauri\.conf\.json|pyproject\.toml|requirements\.txt|setup\.py|[^/]+\.csproj|[^/]+\.sln|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|AndroidManifest\.xml|pubspec\.yaml|CMakeLists\.txt|Dockerfile|docker-compose\.ya?ml)$/i,
  /(^|\/)([^/]+\.xcodeproj\/project\.pbxproj|[^/]+\.xcworkspace\/contents\.xcworkspacedata|Package\.swift)$/i,
  /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i,
  /(electron-builder|latest(?:-mac)?\.yml|appcast\.xml|update(?:r)?\.json|manifest\.webmanifest|service-worker\.js|(^|\/)sw\.js$|\.spec$)/i,
  /(^|\/)(main|index|updater|auto.?updater|update.?service|update.?client|version.?check)\.[cm]?[jt]sx?$|(^|\/)(Program|App|Updater|UpdateService)\.cs$/i,
  /(^|\/)(README(?:\.[^/]*)?|Makefile)$/i
]

function selectFiles(entries) {
  return entries.filter((entry) => entry.type === 'blob' && typeof entry.size === 'number' && entry.size <= MAX_FILE_BYTES && sourcePriority.some((pattern) => pattern.test(entry.path)))
    .sort((left, right) => {
      const leftRank = sourcePriority.findIndex((pattern) => pattern.test(left.path))
      const rightRank = sourcePriority.findIndex((pattern) => pattern.test(right.path))
      return leftRank - rightRank || left.path.localeCompare(right.path)
    }).slice(0, MAX_READS)
}

function ensureNotCancelled(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Integration job was cancelled.'), { code: 'JOB_CANCELLED' })
}

async function getGitTree(project, githubFetchForProject, signal) {
  ensureNotCancelled(signal)
  const base = repositoryApiPath(project.fullName)
  const branchResponse = await githubFetchForProject(project, `${base}/git/ref/heads/${encodeURIComponent(project.defaultBranch)}`, { signal })
  const commitSha = branchResponse.object?.sha
  if (!commitSha) throw new Error(`Could not resolve branch ${project.defaultBranch}`)
  const commit = await githubFetchForProject(project, `${base}/git/commits/${encodeURIComponent(commitSha)}`, { signal })
  const treeSha = commit.tree?.sha
  if (!treeSha) throw new Error('GitHub did not return the commit tree SHA.')
  const first = await githubFetchForProject(project, repositoryTreePath(project.fullName, treeSha, true), { signal })
  let entries = first.tree || []
  let truncated = Boolean(first.truncated)
  let treeRequests = 1
  if (truncated) {
    entries = []
    const queue = [treeSha]
    const visited = new Set()
    while (queue.length && entries.length < MAX_FILES && treeRequests < MAX_TREE_REQUESTS) {
      ensureNotCancelled(signal)
      const currentSha = queue.shift()
      if (visited.has(currentSha)) continue
      visited.add(currentSha)
      const tree = await githubFetchForProject(project, repositoryTreePath(project.fullName, currentSha), { signal })
      treeRequests += 1
      for (const item of tree.tree || []) {
        if (item.type === 'tree') queue.push(item.sha)
        else entries.push(item)
        if (entries.length >= MAX_FILES) break
      }
    }
    truncated = queue.length > 0 || entries.length >= MAX_FILES
  }
  return { commitSha, entries: entries.slice(0, MAX_FILES), truncated, treeRequests }
}

export async function scanRepository(project, githubFetchForProject, options = {}) {
  await options.onProgress?.({ step: 'resolving-commit', detail: 'Resolving the default branch to a fixed commit.' })
  const { commitSha, entries, truncated, treeRequests } = await getGitTree(project, githubFetchForProject, options.signal)
  const selected = selectFiles(entries)
  await options.onProgress?.({ step: 'reading-evidence', detail: `Reading up to ${selected.length} selected files at ${commitSha}.` })
  const files = []
  const errors = []
  for (const entry of selected) {
    try {
      ensureNotCancelled(options.signal)
      const blob = await githubFetchForProject(project, `${repositoryApiPath(project.fullName)}/git/blobs/${encodeURIComponent(entry.sha)}`, { signal: options.signal })
      const content = Buffer.from(blob.content || '', blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
      files.push({ path: entry.path, sha: entry.sha, size: entry.size, content: content.slice(0, MAX_FILE_BYTES) })
    } catch (error) {
      if (error.code === 'JOB_CANCELLED' || options.signal?.aborted) throw error
      errors.push({ path: entry.path, message: String(error.message || 'Read failed').slice(0, 300) })
    }
  }
  const components = inspectComponents(files)
  const detectedPlatforms = detectPlatforms(entries)
  await options.onProgress?.({ step: 'assessing', detail: `Assessing ${components.length} detected application component(s).` })
  const assessment = assessComponents(components)
  const report = {
    projectId: project.id, repository: project.fullName, commitSha, defaultBranch: project.defaultBranch,
    scannedAt: new Date().toISOString(), truncated, scannedFileCount: files.length, detectedPlatforms,
    selectedPaths: files.map((file) => file.path), readErrors: errors, components, assessment,
    buildWorkflows: files.filter((file) => file.path.startsWith('.github/workflows/')).map((file) => file.path),
    version: extractVersion(files),
    recommendations: components.map((component) => ({ appRoot: component.appRoot, ...assessment.components.find((entry) => entry.component.adapter === component.adapter)?.assessment?.recommendation })),
    readiness: {
      codeSupportsUpdates: components.some((component) => component.evidence.updaterCode),
      ciBuildsUpdateArtifacts: components.some((component) => component.evidence.workflow),
      releaseConfigurationPresent: components.some((component) => component.evidence.manifest?.length || component.evidence.pwaManifest),
      updateManifestInRepository: components.some((component) => component.evidence.manifest?.length),
      signingConfigured: components.some((component) => component.evidence.signingConfigured),
      signatureCryptographicallyVerified: false,
      oldClientUpdateVerified: false
    },
    limits: { maxFiles: MAX_FILES, maxReads: MAX_READS, maxFileBytes: MAX_FILE_BYTES, maxTreeRequests: MAX_TREE_REQUESTS, treeRequests, ...(options.limits || {}) }
  }
  return report
}

function detectPlatforms(entries) {
  const paths = entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path)
  const android = paths.filter((value) => /(^|\/)(AndroidManifest\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/i.test(value))
  const ios = paths.filter((value) => /(^|\/)([^/]+\.xcodeproj\/project\.pbxproj|[^/]+\.xcworkspace\/contents\.xcworkspacedata|Package\.swift)$/i.test(value))
  return [
    ...(android.length ? [{ platform: 'Android', supported: false, evidencePaths: android.slice(0, 20), status: 'UNSUPPORTED' }] : []),
    ...(ios.length ? [{ platform: 'iOS', supported: false, evidencePaths: ios.slice(0, 20), status: 'UNSUPPORTED' }] : [])
  ]
}

function extractVersion(files) {
  for (const file of files.filter((item) => item.path.endsWith('package.json'))) {
    try { const version = JSON.parse(file.content).version; if (version) return version } catch {}
  }
  for (const file of files.filter((item) => /pyproject\.toml$/.test(item.path))) {
    const match = file.content.match(/^version\s*=\s*["']([^"']+)["']/m)
    if (match) return match[1]
  }
  return null
}

export const scannerLimits = Object.freeze({ MAX_FILES, MAX_READS, MAX_FILE_BYTES, MAX_TREE_REQUESTS })
