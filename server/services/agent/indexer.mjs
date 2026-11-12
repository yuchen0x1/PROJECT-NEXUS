import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// Local project understanding index. Walks a project/workspace root, records a
// file inventory, extracts lightweight symbols and import edges for the most
// common languages, and persists a cache so re-indexing after agent edits only
// re-reads changed files. Regex-based extraction is intentionally approximate;
// it feeds context selection and search, not compiler-grade analysis.

export const PROJECT_INDEX_LIMITS = Object.freeze({
  maxFiles: 8_000,
  maxDepth: 14,
  maxFileBytes: 1_000_000,
  maxSymbolFiles: 4_000,
  maxSymbolsPerFile: 200,
  maxImportsPerFile: 100,
  maxTreeEntries: 60_000
})

const INDEX_SCHEMA_VERSION = 1

const excludedDirectories = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'target', 'bin', 'obj',
  '.next', '.nuxt', '.output', '.turbo', '.cache', 'coverage', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.venv', 'venv', 'env', 'release', 'out', 'artifacts',
  '.idea', '.vscode', '.gradle', '.mvn', 'Pods', '.terraform', 'packages-cache'
])

const binaryExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.pdf', '.zip', '.gz', '.tar',
  '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.msi', '.appx', '.apk', '.ipa', '.jar', '.class',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac',
  '.sqlite', '.db', '.pdb', '.wasm', '.node', '.bin', '.dat', '.pak', '.asar', '.iso', '.dmg'
])

const symbolExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cs'])
const manifestNames = new Set(['package.json', 'tsconfig.json', 'jsconfig.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'composer.json', 'gemfile', 'pubspec.yaml', 'csproj', 'project.json', 'vite.config.ts', 'vite.config.js', 'webpack.config.js', 'rollup.config.js', 'electron-builder.yml'])

const jsSymbolPatterns = [
  { kind: 'function', regex: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'class', regex: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'component', regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*(?:\(|(?:async\s*)?\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/gm },
  { kind: 'export', regex: /^\s*export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm }
]

const pythonSymbolPatterns = [
  { kind: 'function', regex: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm },
  { kind: 'class', regex: /^\s*class\s+([A-Za-z_][\w]*)/gm }
]

const goSymbolPatterns = [
  { kind: 'function', regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/gm },
  { kind: 'class', regex: /^\s*type\s+([A-Za-z_][\w]*)\s+struct/gm }
]

const rustSymbolPatterns = [
  { kind: 'function', regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/gm },
  { kind: 'class', regex: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/gm }
]

const jsImportPatterns = [
  /(?:^|\n)\s*import\s+(?:[\w$*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*(?:const|let|var)\s+[\w${}\s,]+\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:^|\n)\s*export\s+(?:[\w$*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g
]

const pythonImportPatterns = [
  /(?:^|\n)\s*import\s+([\w.]+)/g,
  /(?:^|\n)\s*from\s+([\w.]+)\s+import/g
]

function indexError(code, message) {
  return Object.assign(new Error(message), { code })
}

function extensionOf(filePath) {
  return path.posix.extname(filePath).toLowerCase()
}

function isSymbolTarget(filePath) {
  return symbolExtensions.has(extensionOf(filePath))
}

function extractSymbols(language, content, limits) {
  const patterns = language === 'python' ? pythonSymbolPatterns
    : language === 'go' ? goSymbolPatterns
    : language === 'rust' ? rustSymbolPatterns
    : jsSymbolPatterns
  const symbols = []
  const seen = new Set()
  for (const { kind, regex } of patterns) {
    regex.lastIndex = 0
    let match
    while ((match = regex.exec(content)) && symbols.length < limits.maxSymbolsPerFile) {
      const key = `${kind}:${match[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      const before = content.slice(0, match.index)
      const line = before.split('\n').length
      symbols.push({ kind, name: match[1], line })
    }
    if (symbols.length >= limits.maxSymbolsPerFile) break
  }
  return symbols
}

function extractImports(language, content, limits) {
  const patterns = language === 'python' ? pythonImportPatterns : jsImportPatterns
  const imports = []
  const seen = new Set()
  for (const regex of patterns) {
    regex.lastIndex = 0
    let match
    while ((match = regex.exec(content)) && imports.length < limits.maxImportsPerFile) {
      const target = match[1]
      if (!target || seen.has(target)) continue
      seen.add(target)
      imports.push(target)
    }
    if (imports.length >= limits.maxImportsPerFile) break
  }
  return imports
}

function classifyLanguage(filePath) {
  const ext = extensionOf(filePath)
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) return 'javascript'
  if (['.ts', '.tsx'].includes(ext)) return 'typescript'
  if (ext === '.py') return 'python'
  if (ext === '.go') return 'go'
  if (ext === '.rs') return 'rust'
  return null
}

async function walkProject(root, limits) {
  const files = []
  const stats = { entries: 0, files: 0, skippedBinary: 0, skippedLarge: 0, truncated: false }
  const queue = [{ dir: root, segments: [], depth: 0 }]
  while (queue.length) {
    const { dir, segments, depth } = queue.shift()
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) }
    catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      stats.entries += 1
      if (stats.entries > limits.maxTreeEntries || files.length > limits.maxFiles) { stats.truncated = true; return { files, stats } }
      if (entry.isSymbolicLink()) continue
      const childSegments = [...segments, entry.name]
      if (excludedDirectories.has(entry.name.toLowerCase())) continue
      const childPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth >= limits.maxDepth) { stats.truncated = true; continue }
        queue.push({ dir: childPath, segments: childSegments, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      const relative = childSegments.join('/')
      const ext = extensionOf(relative)
      if (binaryExtensions.has(ext)) { stats.skippedBinary += 1; continue }
      let info
      try { info = await fs.stat(childPath) }
      catch { continue }
      if (info.size > limits.maxFileBytes) { stats.skippedLarge += 1; continue }
      files.push({
        path: relative,
        size: info.size,
        mtimeMs: Math.round(info.mtimeMs),
        ext: ext || null,
        language: classifyLanguage(relative)
      })
      stats.files += 1
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return { files, stats }
}

async function readTextIfSmall(root, file, limits) {
  if (file.size > limits.maxFileBytes || !isSymbolTarget(file.path) && !isManifestCandidate(file.path)) return null
  try {
    const bytes = await fs.readFile(path.join(root, ...file.path.split('/')))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch { return null }
}

function isManifestCandidate(filePath) {
  const base = path.posix.basename(filePath).toLowerCase()
  return manifestNames.has(base) || base.endsWith('.csproj') || base === 'dockerfile' || base === 'makefile'
}

function extractManifestSummary(filePath, content) {
  const base = path.posix.basename(filePath).toLowerCase()
  if (base === 'package.json') {
    try {
      const parsed = JSON.parse(content)
      return {
        path: filePath,
        kind: 'package.json',
        name: typeof parsed.name === 'string' ? parsed.name : null,
        main: typeof parsed.main === 'string' ? parsed.main : null,
        type: parsed.type === 'module' ? 'module' : 'commonjs',
        scripts: parsed.scripts && typeof parsed.scripts === 'object'
          ? Object.fromEntries(Object.entries(parsed.scripts).slice(0, 30).map(([key, value]) => [key, String(value).slice(0, 200)]))
          : {},
        dependencies: Object.keys(parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : {}).slice(0, 100),
        devDependencies: Object.keys(parsed.devDependencies && typeof parsed.devDependencies === 'object' ? parsed.devDependencies : {}).slice(0, 100)
      }
    } catch { return { path: filePath, kind: 'package.json', error: 'unparsable' } }
  }
  if (base === 'pyproject.toml') {
    const project = /\[project\][\s\S]*?(?=\n\[|$)/.exec(content)?.[0] || ''
    const name = /^[ \t]*name[ \t]*=[ \t]*"([^"]+)"/m.exec(project)?.[1] || null
    return { path: filePath, kind: 'pyproject.toml', name, scripts: {} }
  }
  return { path: filePath, kind: base, size: content.length }
}

function detectEntryPoints(files, manifests) {
  const entries = []
  const packageManifest = manifests.find((manifest) => manifest.kind === 'package.json')
  if (packageManifest?.main && files.some((file) => file.path === packageManifest.main)) entries.push({ path: packageManifest.main, reason: 'package.json main' })
  const preferred = ['index.html', 'src/index.ts', 'src/index.tsx', 'src/main.ts', 'src/main.tsx', 'src/index.js', 'src/main.js', 'src/main.py', 'main.py', 'app.py', 'server/index.mjs', 'src/main/java']
  for (const candidate of preferred) {
    const match = files.find((file) => file.path === candidate || (candidate.endsWith('.java') ? file.path.startsWith(candidate) : false))
    if (match && !entries.some((entry) => entry.path === match.path)) entries.push({ path: match.path, reason: 'convention' })
  }
  if (!entries.length) {
    const fallback = files.find((file) => isSymbolTarget(file.path) && /(?:^|\/)(?:index|main|app|server)\.[a-z]+$/.test(file.path))
    if (fallback) entries.push({ path: fallback.path, reason: 'fallback' })
  }
  return entries.slice(0, 12)
}

function detectTestPaths(files) {
  const testFiles = files.filter((file) => /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go|rs)$|test_[\w.]+\.py$/i.test(file.path) && !excludedDirectories.has(file.path.split('/')[0].toLowerCase()))
  return testFiles.slice(0, 200).map((file) => file.path)
}

function routeCandidates(files) {
  return files.filter((file) => /(?:^|\/)(?:routes?|routers?|pages?|views?|screens?|apps?)\.[cm]?[jt]sx?$|(?:routes?)\.(?:py|go|rb)$/i.test(file.path) && isSymbolTarget(file.path)).slice(0, 40).map((file) => file.path)
}

function apiCandidates(files) {
  return files.filter((file) => /(?:^|\/)(?:api|controllers?|endpoints?|handlers?|graphql|resolvers?)(?:\/|[\w.-]*$)/i.test(file.path) && isSymbolTarget(file.path)).slice(0, 60).map((file) => file.path)
}

export async function scanProjectStructure(root, limitOverrides = {}) {
  const limits = { ...PROJECT_INDEX_LIMITS, ...limitOverrides }
  if (!path.isAbsolute(root)) throw indexError('PROJECT_INDEX_INVALID_ROOT', 'Project index root must be an absolute path.')
  const { files, stats } = await walkProject(root, limits)
  const manifests = []
  let totalBytes = 0
  const symbols = new Map()
  const imports = new Map()
  for (const file of files) {
    totalBytes += file.size
    const isTarget = isSymbolTarget(file.path) || isManifestCandidate(file.path)
    if (!isTarget || file.size > limits.maxFileBytes || symbols.size >= limits.maxSymbolFiles && !isManifestCandidate(file.path)) continue
    const content = await readTextIfSmall(root, file, limits)
    if (content === null) continue
    if (isManifestCandidate(file.path) && file.size < 256 * 1024) {
      const summary = extractManifestSummary(file.path, content)
      if (summary) manifests.push(summary)
    }
    if (isSymbolTarget(file.path) && symbols.size < limits.maxSymbolFiles) {
      const language = file.language || classifyLanguage(file.path)
      const fileSymbols = extractSymbols(language, content, limits)
      if (fileSymbols.length) symbols.set(file.path, fileSymbols)
      const fileImports = extractImports(language, content, limits)
      if (fileImports.length) imports.set(file.path, fileImports)
    }
  }
  manifests.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  const summary = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    root: path.resolve(root),
    scannedAt: new Date().toISOString(),
    limits,
    stats: { ...stats, totalBytes, symbolFiles: symbols.size, manifestCount: manifests.length },
    files,
    manifests,
    entryPoints: detectEntryPoints(files, manifests),
    testPaths: detectTestPaths(files),
    routeCandidates: routeCandidates(files),
    apiCandidates: apiCandidates(files),
    symbols: Object.fromEntries(symbols),
    imports: Object.fromEntries(imports)
  }
  return summary
}

export async function buildProjectIndex({ root, cacheFile, limitOverrides = {} } = {}) {
  const fresh = await scanProjectStructure(root, limitOverrides)
  if (!cacheFile) return { index: fresh, changed: [], reindexed: fresh.files.length, cached: false }
  let previous = null
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
    if (parsed?.schemaVersion === INDEX_SCHEMA_VERSION && Array.isArray(parsed.files)) previous = parsed
  } catch { previous = null }
  if (!previous) {
    await persistIndex(cacheFile, fresh)
    return { index: fresh, changed: fresh.files.map((file) => file.path), reindexed: fresh.files.length, cached: false }
  }
  const previousByPath = new Map(previous.files.map((file) => [file.path, file]))
  const freshByPath = new Map(fresh.files.map((file) => [file.path, file]))
  const changed = []
  for (const [filePath, file] of freshByPath) {
    const before = previousByPath.get(filePath)
    if (!before || before.size !== file.size || before.mtimeMs !== file.mtimeMs) changed.push(filePath)
  }
  for (const filePath of previousByPath.keys()) if (!freshByPath.has(filePath)) changed.push(filePath)
  if (!changed.length) return { index: previous, changed: [], reindexed: 0, cached: true }
  // Re-scan only the changed subset for symbols/imports, keep the rest from cache.
  const merged = { ...fresh, files: fresh.files, symbols: { ...previous.symbols }, imports: { ...previous.imports } }
  for (const filePath of changed) {
    delete merged.symbols[filePath]
    delete merged.imports[filePath]
  }
  const refreshSet = new Set(changed.filter((filePath) => freshByPath.has(filePath) && (isSymbolTarget(filePath))))
  if (refreshSet.size) {
    const limits = fresh.limits
    for (const filePath of refreshSet) {
      if (symbolsBudget(merged) >= limits.maxSymbolFiles) break
      const file = freshByPath.get(filePath)
      const content = await readTextIfSmall(root, file, limits)
      if (content === null) continue
      const language = file.language || classifyLanguage(filePath)
      const fileSymbols = extractSymbols(language, content, limits)
      if (fileSymbols.length) merged.symbols[filePath] = fileSymbols
      const fileImports = extractImports(language, content, limits)
      if (fileImports.length) merged.imports[filePath] = fileImports
    }
  }
  merged.stats.symbolFiles = Object.keys(merged.symbols).length
  await persistIndex(cacheFile, merged)
  return { index: merged, changed, reindexed: changed.length, cached: true }
}

function symbolsBudget(index) {
  return Object.keys(index.symbols).length
}

async function persistIndex(cacheFile, index) {
  await fs.mkdir(path.dirname(cacheFile), { recursive: true })
  const temporary = `${cacheFile}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(index), { encoding: 'utf8', flag: 'wx' })
    await fs.rename(temporary, cacheFile)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export function searchProjectIndex(index, query, { limit = 40 } = {}) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return []
  const terms = needle.split(/[\s/._-]+/).filter(Boolean)
  const results = []
  for (const file of index.files || []) {
    const lowerPath = file.path.toLowerCase()
    let score = 0
    if (lowerPath.includes(needle)) score += 60
    for (const term of terms) {
      if (lowerPath.includes(term)) score += 12
      const base = path.posix.basename(lowerPath)
      if (base.includes(term)) score += 8
    }
    const fileSymbols = index.symbols?.[file.path] || []
    for (const symbol of fileSymbols) {
      const lowerName = symbol.name.toLowerCase()
      if (needle === lowerName) score += 50
      else if (lowerName.includes(needle)) score += 20
      else if (terms.some((term) => lowerName.includes(term))) score += 10
    }
    if (score > 0) results.push({ path: file.path, score, ext: file.ext, symbols: fileSymbols.slice(0, 5) })
  }
  return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'en')).slice(0, limit)
}
