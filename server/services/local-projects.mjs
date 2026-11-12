import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const LOCAL_PROJECT_SCAN_LIMITS = Object.freeze({ maxEntries: 900, maxDepth: 2, maxMarkers: 80 })

const registryFileName = 'local-projects.json'
const skippedDirectories = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'target', 'bin', 'obj', '.next', '.venv', 'venv'])
const markerNames = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'requirements.txt', 'pyproject.toml', 'pipfile', 'cargo.toml', 'cargo.lock', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'go.mod', 'dockerfile', 'compose.yaml',
  'docker-compose.yml', 'makefile', '.sln', 'global.json', 'directory.build.props'
])

function validateDataDirectory(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('A writable absolute application data directory is required.')
  return path.resolve(dataDir)
}

function validateProjectId(projectId) {
  if (typeof projectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(projectId)) throw new Error('Invalid local project id.')
  return projectId
}

function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b
}

async function loadRegistry(dataDir) {
  const directory = validateDataDirectory(dataDir)
  await fs.mkdir(directory, { recursive: true })
  let text
  try { text = await fs.readFile(path.join(directory, registryFileName), 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, projects: [] }
    throw error
  }
  let document
  try { document = JSON.parse(text) }
  catch (error) { throw Object.assign(new Error(`Local project registry is invalid JSON; refusing to replace it: ${error.message}`), { code: 'LOCAL_REGISTRY_INVALID' }) }
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.projects) || document.projects.length > 200) {
    throw Object.assign(new Error('Local project registry has an unsupported shape; refusing to replace it.'), { code: 'LOCAL_REGISTRY_INVALID' })
  }
  for (const project of document.projects) {
    if (!project || !/^[0-9a-f-]{36}$/i.test(String(project.id || '')) || typeof project.name !== 'string' || typeof project.path !== 'string' || !path.isAbsolute(project.path)) {
      throw Object.assign(new Error('Local project registry contains an invalid project record; refusing to replace it.'), { code: 'LOCAL_REGISTRY_INVALID' })
    }
  }
  return document
}

async function saveRegistry(dataDir, document) {
  const directory = validateDataDirectory(dataDir)
  const target = path.join(directory, registryFileName)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.mkdir(directory, { recursive: true })
  try {
    await fs.writeFile(temporary, JSON.stringify(document, null, 2), { encoding: 'utf8', flag: 'wx' })
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function resolvePickedDirectory(folderPath) {
  if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath) || folderPath.length > 32000) {
    throw new Error('Choose an absolute local folder path.')
  }
  const selected = path.resolve(folderPath)
  const selectedInfo = await fs.lstat(selected)
  if (selectedInfo.isSymbolicLink() || !selectedInfo.isDirectory()) throw new Error('The selected project must be a real directory, not a link or file.')
  const canonical = path.normalize(await fs.realpath(selected))
  const canonicalInfo = await fs.stat(canonical)
  if (!canonicalInfo.isDirectory()) throw new Error('The selected project folder is no longer available.')
  return canonical
}

export async function listLocalProjects({ dataDir }) {
  const registry = await loadRegistry(dataDir)
  return await Promise.all(registry.projects.map(async (project) => {
    try {
      const stat = await fs.lstat(project.path)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { ...project, available: false, availability: 'PATH_CHANGED' }
      const canonical = path.normalize(await fs.realpath(project.path))
      const available = samePath(canonical, project.path)
      return { ...project, available, availability: available ? 'AVAILABLE' : 'PATH_CHANGED' }
    } catch (error) {
      if (error.code === 'ENOENT') return { ...project, available: false, availability: 'MISSING' }
      return { ...project, available: false, availability: 'PATH_CHANGED' }
    }
  }))
}

export async function registerLocalProject({ dataDir, folderPath }) {
  const directory = await resolvePickedDirectory(folderPath)
  const registry = await loadRegistry(dataDir)
  const existing = registry.projects.find((project) => samePath(project.path, directory))
  if (existing) return { project: { ...existing, available: true, availability: 'AVAILABLE' }, added: false }
  if (registry.projects.length >= 200) throw new Error('The local project list is limited to 200 folders.')
  const project = {
    id: crypto.randomUUID(),
    name: path.basename(directory) || path.parse(directory).root,
    path: directory,
    addedAt: new Date().toISOString(),
    lastScan: null
  }
  registry.projects.push(project)
  await saveRegistry(dataDir, registry)
  return { project: { ...project, available: true, availability: 'AVAILABLE' }, added: true }
}

export async function unregisterLocalProject({ dataDir, projectId }) {
  const id = validateProjectId(projectId)
  const registry = await loadRegistry(dataDir)
  const next = registry.projects.filter((project) => project.id !== id)
  if (next.length === registry.projects.length) return { removed: false }
  registry.projects = next
  await saveRegistry(dataDir, registry)
  return { removed: true }
}

async function getRegisteredProject(dataDir, projectId) {
  const id = validateProjectId(projectId)
  const registry = await loadRegistry(dataDir)
  const project = registry.projects.find((item) => item.id === id)
  if (!project) throw Object.assign(new Error('Local project is no longer registered.'), { code: 'LOCAL_PROJECT_NOT_FOUND' })
  const stat = await fs.lstat(project.path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!stat) throw Object.assign(new Error('This project folder is missing. Remove it from the list or choose the folder again.'), { code: 'LOCAL_PROJECT_MISSING' })
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('This project path is no longer a regular directory. Re-add it from the native folder picker.'), { code: 'LOCAL_PROJECT_PATH_CHANGED' })
  const canonical = path.normalize(await fs.realpath(project.path))
  if (!samePath(canonical, project.path)) throw Object.assign(new Error('The project folder resolves to a different path. Re-add it from the native folder picker.'), { code: 'LOCAL_PROJECT_PATH_CHANGED' })
  return { project, canonical }
}

function techFromMarkers(markers) {
  const names = new Set(markers.map((marker) => path.posix.basename(marker).toLowerCase()))
  const tech = []
  if (names.has('package.json') || ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some((name) => names.has(name))) tech.push('Node.js')
  if (['pyproject.toml', 'requirements.txt', 'pipfile'].some((name) => names.has(name))) tech.push('Python')
  if (names.has('cargo.toml') || names.has('cargo.lock')) tech.push('Rust')
  if ([...names].some((name) => name.endsWith('.sln') || name.endsWith('.csproj')) || names.has('global.json') || names.has('directory.build.props')) tech.push('.NET')
  if (['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'].some((name) => names.has(name))) tech.push('Java')
  if (names.has('go.mod')) tech.push('Go')
  if (names.has('dockerfile') || names.has('compose.yaml') || names.has('docker-compose.yml')) tech.push('Docker')
  if (markers.some((marker) => marker === '.git' || marker.startsWith('.git/'))) tech.push('Git')
  return tech
}

export async function scanLocalProject({ dataDir, projectId, limits = LOCAL_PROJECT_SCAN_LIMITS }) {
  const { project, canonical } = await getRegisteredProject(dataDir, projectId)
  const maxEntries = Math.max(1, Math.min(Number(limits.maxEntries) || LOCAL_PROJECT_SCAN_LIMITS.maxEntries, LOCAL_PROJECT_SCAN_LIMITS.maxEntries))
  const maxDepth = Math.max(0, Math.min(Number(limits.maxDepth) || LOCAL_PROJECT_SCAN_LIMITS.maxDepth, LOCAL_PROJECT_SCAN_LIMITS.maxDepth))
  const markers = []
  const warnings = []
  let visitedEntries = 0
  let truncated = false

  async function walk(current, relative, depth) {
    let entries
    try { entries = await fs.readdir(current, { withFileTypes: true }) }
    catch (error) { warnings.push(`Could not read ${relative || 'project root'} (${error.code || 'ACCESS_ERROR'}).`); return }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      visitedEntries += 1
      if (visitedEntries > maxEntries) { truncated = true; return }
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === '.git') { markers.push('.git'); continue }
        if (depth < maxDepth && !skippedDirectories.has(entry.name.toLowerCase())) await walk(path.join(current, entry.name), childRelative, depth + 1)
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase()
        if (markerNames.has(lower) || (lower.endsWith('.sln') || lower.endsWith('.csproj'))) markers.push(childRelative)
        if (markers.length >= LOCAL_PROJECT_SCAN_LIMITS.maxMarkers) { truncated = true; return }
      }
      if (truncated) return
    }
  }

  await walk(canonical, '', 0)
  const report = {
    projectId: project.id,
    scannedAt: new Date().toISOString(),
    visitedEntries: Math.min(visitedEntries, maxEntries),
    truncated,
    markers,
    technologies: techFromMarkers(markers),
    warnings
  }
  const registry = await loadRegistry(dataDir)
  const record = registry.projects.find((item) => item.id === project.id)
  if (record) {
    record.lastScan = report
    await saveRegistry(dataDir, registry)
  }
  return report
}
