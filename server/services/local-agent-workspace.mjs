import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const LOCAL_AGENT_WORKSPACE_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxFiles: 4_000,
  maxBytes: 256 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxDepth: 16,
  maxOperations: 30,
  maxOperationBytes: 512 * 1024,
  maxOperationBatchBytes: 5 * 1024 * 1024,
  maxReadFiles: 20,
  maxReadBytes: 2 * 1024 * 1024,
  maxGitignoreFiles: 64,
  maxGitignoreBytes: 256 * 1024,
  maxGitignoreRules: 2_048,
  maxGitignorePatternLength: 1_024
})

const excludedDirectories = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'target',
  'bin', 'obj', '.next', '.nuxt', '.output', '.turbo', '.cache', 'coverage',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv',
  'env', 'release', 'out', 'artifacts'
])

const reservedWindowsNames = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i
const secretName = /(?:^\.env(?:$|\.)|(?:^|[._-])(?:secret|secrets|credential|credentials|private|password|passwd|token)(?:[._-]|$))/i
const secretExtensions = new Set(['.pem', '.key', '.p12', '.pfx', '.p7b', '.p7c', '.cer', '.crt', '.der', '.keystore'])
const secretFiles = new Set(['.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'known_hosts', 'authorized_keys', 'credentials.json'])

function error(message, code = 'LOCAL_AGENT_WORKSPACE_INVALID') {
  return Object.assign(new Error(message), { code })
}

function isMissing(errorValue) {
  return errorValue?.code === 'ENOENT'
}

function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b
}

function isInsidePath(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function pathsOverlap(left, right) {
  return isInsidePath(left, right) || isInsidePath(right, left)
}

function validateIdentifier(value, label, { uuid = false } = {}) {
  if (typeof value !== 'string' || value.length > 100) throw error('Project ' + label + ' is invalid.')
  if (uuid ? !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) : !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) {
    throw error('Project ' + label + ' is invalid.')
  }
  return value
}

function validateProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw error('A registered local project is required.')
  const id = validateIdentifier(project.id, 'id', { uuid: true })
  if (typeof project.name !== 'string' || !project.name.trim() || project.name.length > 160 || /[\u0000-\u001f\u007f]/.test(project.name)) {
    throw error('Project name is invalid.')
  }
  if (typeof project.path !== 'string' || !path.isAbsolute(project.path) || !path.win32.isAbsolute(project.path) && process.platform === 'win32') {
    throw error('Project path must be absolute.')
  }
  const projectPath = path.resolve(project.path)
  if (samePath(projectPath, path.parse(projectPath).root)) throw error('A filesystem root cannot be used as a project.')
  return { id, name: project.name.trim(), requestedPath: projectPath }
}

function validateWorkspaceId(value) {
  const id = value || crypto.randomUUID()
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) throw error('Workspace id is invalid.')
  return id
}

function normalizeLimits(overrides = {}) {
  const result = {}
  for (const key of Object.keys(LOCAL_AGENT_WORKSPACE_LIMITS)) {
    const ceiling = LOCAL_AGENT_WORKSPACE_LIMITS[key]
    const value = overrides[key] === undefined ? ceiling : Number(overrides[key])
    if (!Number.isSafeInteger(value) || value < 0) throw error('Workspace limit ' + key + ' must be a non-negative integer.')
    result[key] = Math.min(value, ceiling)
  }
  if (result.maxEntries < 1 || result.maxFiles < 1 || result.maxFileBytes < 1 || result.maxBytes < 1 ||
      result.maxOperations < 1 || result.maxOperationBytes < 1 || result.maxOperationBatchBytes < 1 ||
      result.maxReadFiles < 1 || result.maxReadBytes < 1 || result.maxGitignoreFiles < 1 ||
      result.maxGitignoreBytes < 1 || result.maxGitignoreRules < 1 || result.maxGitignorePatternLength < 1) {
    throw error('Workspace file and operation limits must be greater than zero.')
  }
  return result
}

function segmentIsSecretLike(segment) {
  const lower = segment.toLowerCase()
  const extension = path.posix.extname(lower)
  return lower === '.ssh' || lower === '.aws' || lower === '.azure' ||
    secretFiles.has(lower) || secretName.test(segment) || secretExtensions.has(extension)
}

function isExcludedPath(segments) {
  return segments.some((segment) => excludedDirectories.has(segment.toLowerCase()) || segmentIsSecretLike(segment))
}

const gitignoreSupportedSyntax = 'literals, *, ?, ** as a path component, optional leading /, trailing /, and file negation (!).'

function gitignorePatternError(filePath, line, kind, detail, code = 'LOCAL_AGENT_GITIGNORE_UNSUPPORTED') {
  return error(`.gitignore "${filePath}" line ${line} ${kind}: ${detail}. Supported syntax is ${gitignoreSupportedSyntax}`, code)
}

function escapeRegexCharacter(character) {
  return /[|\\{}()[\]^$+?.]/.test(character) ? '\\' + character : character
}

function compileGitignoreGlob(pattern, filePath, line) {
  const parts = pattern.split('/')
  let source = ''
  if (parts.length === 1 && parts[0] === '**') source = '.*'
  else {
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      if (part === '**') {
        if (index === 0) source += '(?:[^/]+/)*'
        else if (index === parts.length - 1) source += '(?:/[^/]+)*'
        else source += '(?:/[^/]+)*/'
        continue
      }
      if (index > 0 && parts[index - 1] !== '**') source += '/'
      for (let characterIndex = 0; characterIndex < part.length; characterIndex += 1) {
        const character = part[characterIndex]
        if (character === '*') {
          while (part[characterIndex + 1] === '*') characterIndex += 1
          source += '[^/]*'
        } else if (character === '?') source += '[^/]'
        else source += escapeRegexCharacter(character)
      }
    }
  }
  try { return new RegExp('^' + source + '$', process.platform === 'win32' ? 'i' : '') }
  catch (cause) {
    throw gitignorePatternError(filePath, line, 'is malformed', 'the glob could not be compiled', 'LOCAL_AGENT_GITIGNORE_INVALID')
  }
}

function compileGitignoreFiles(gitignoreFiles, limits) {
  if (!Array.isArray(gitignoreFiles) || gitignoreFiles.length > limits.maxGitignoreFiles) {
    throw error(`Project has more than ${limits.maxGitignoreFiles} .gitignore files (maxGitignoreFiles).`, 'LOCAL_AGENT_GITIGNORE_LIMIT')
  }
  const seenFiles = new Set()
  const rules = []
  let totalBytes = 0
  for (const item of gitignoreFiles) {
    if (!item || typeof item.path !== 'string' || typeof item.content !== 'string') {
      throw error('Frozen .gitignore policy contains an invalid file record.', 'LOCAL_AGENT_GITIGNORE_INVALID')
    }
    const segments = pathSegments(item.path)
    if (segments.at(-1) !== '.gitignore') throw error(`Frozen .gitignore path "${item.path}" must name a .gitignore file.`, 'LOCAL_AGENT_GITIGNORE_INVALID')
    const canonicalPath = segments.join('/')
    const fileKey = canonicalPath.normalize('NFC').toLocaleLowerCase('en-US')
    if (seenFiles.has(fileKey)) throw error(`Frozen .gitignore policy repeats "${canonicalPath}".`, 'LOCAL_AGENT_GITIGNORE_INVALID')
    seenFiles.add(fileKey)
    const bytes = Buffer.byteLength(item.content, 'utf8')
    totalBytes += bytes
    if (totalBytes > limits.maxGitignoreBytes) {
      throw error(`Project .gitignore content exceeds ${limits.maxGitignoreBytes} bytes (maxGitignoreBytes).`, 'LOCAL_AGENT_GITIGNORE_LIMIT')
    }
    const filePath = canonicalPath
    const baseSegments = segments.slice(0, -1)
    const lines = item.content.split('\n')
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      let pattern = lines[lineIndex].replace(/\r$/, '')
      const line = lineIndex + 1
      if (pattern.length > limits.maxGitignorePatternLength) {
        throw error(`.gitignore "${filePath}" line ${line} exceeds ${limits.maxGitignorePatternLength} characters (maxGitignorePatternLength).`, 'LOCAL_AGENT_GITIGNORE_LIMIT')
      }
      pattern = pattern.replace(/ +$/, '')
      if (!pattern || pattern.startsWith('#')) continue
      let negate = false
      if (pattern.startsWith('!')) {
        negate = true
        pattern = pattern.slice(1)
      }
      if (!pattern) throw gitignorePatternError(filePath, line, 'is malformed', 'the pattern is empty', 'LOCAL_AGENT_GITIGNORE_INVALID')
      if (/\\/.test(pattern)) throw gitignorePatternError(filePath, line, 'uses unsupported syntax', 'backslash escapes are not supported')
      if (/[\[\]]/.test(pattern)) throw gitignorePatternError(filePath, line, 'uses unsupported syntax', 'character classes are not supported')
      if (/[\u0000-\u001f\u007f]/.test(pattern)) throw gitignorePatternError(filePath, line, 'uses unsupported syntax', 'control characters are not supported')
      const directoryOnly = pattern.endsWith('/')
      if (directoryOnly) pattern = pattern.slice(0, -1)
      if (negate && directoryOnly) throw gitignorePatternError(filePath, line, 'uses unsupported syntax', 'directory negation is not supported')
      const anchored = pattern.startsWith('/')
      if (anchored) pattern = pattern.slice(1)
      if (!pattern || pattern.startsWith('/') || pattern.includes('//')) {
        throw gitignorePatternError(filePath, line, 'is malformed', 'empty path components are not supported', 'LOCAL_AGENT_GITIGNORE_INVALID')
      }
      const parts = pattern.split('/')
      if (parts.some((part) => !part || part === '.' || part === '..')) {
        throw gitignorePatternError(filePath, line, 'is malformed', 'empty, . and .. path components are not supported', 'LOCAL_AGENT_GITIGNORE_INVALID')
      }
      const hasSlash = pattern.includes('/')
      const regex = compileGitignoreGlob(pattern, filePath, line)
      rules.push({
        filePath,
        line,
        baseSegments,
        baseDepth: baseSegments.length,
        order: line,
        pattern,
        anchored,
        hasSlash,
        directoryOnly,
        negate,
        regex
      })
      if (rules.length > limits.maxGitignoreRules) {
        throw error(`Project .gitignore files contain more than ${limits.maxGitignoreRules} rules (maxGitignoreRules).`, 'LOCAL_AGENT_GITIGNORE_LIMIT')
      }
    }
  }
  return { files: gitignoreFiles.map(({ path: filePath, content }) => ({ path: filePath, content })), rules }
}

function isPathPrefix(prefix, segments) {
  return prefix.length <= segments.length && prefix.every((segment, index) => segment === segments[index])
}

function ruleMatchesPath(rule, segments, isDirectory) {
  if (segments.length <= rule.baseDepth || !isPathPrefix(rule.baseSegments, segments)) return false
  if (rule.directoryOnly && !isDirectory) return false
  const relative = segments.slice(rule.baseDepth).join('/')
  if (!rule.anchored && !rule.hasSlash) return rule.regex.test(segments.at(-1))
  return rule.regex.test(relative)
}

function winningGitignoreRule(segments, isDirectory, rules) {
  let winner = null
  for (const rule of rules) {
    if (rule.negate && isDirectory) continue
    if (!ruleMatchesPath(rule, segments, isDirectory)) continue
    if (!winner || rule.baseDepth > winner.baseDepth || (rule.baseDepth === winner.baseDepth && rule.order > winner.order)) winner = rule
  }
  return winner
}

function gitignoreDirectoryIsExcluded(segments, rules) {
  let excluded = false
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const prefix = segments.slice(0, depth)
    const winner = winningGitignoreRule(prefix, true, rules)
    if (winner && !winner.negate) excluded = true
  }
  return excluded
}

function gitignoreFileDecision(segments, rules) {
  const parentExcluded = gitignoreDirectoryIsExcluded(segments.slice(0, -1), rules)
  const winner = winningGitignoreRule(segments, false, rules)
  if (parentExcluded && winner?.negate) {
    throw gitignorePatternError(winner.filePath, winner.line, 'cannot safely reinclude a file', `"${segments.join('/')}" is under an ignored directory`, 'LOCAL_AGENT_GITIGNORE_UNSAFE_NEGATION')
  }
  return { ignored: parentExcluded || Boolean(winner && !winner.negate), winner }
}

function assertGitignoreAllowsFile(segments, rules) {
  if (gitignoreFileDecision(segments, rules).ignored) {
    throw error('Project .gitignore excludes this file from local Agent access.', 'LOCAL_AGENT_GITIGNORE_EXCLUDED')
  }
}

function pathSegments(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 1024 || /[\u0000-\u001f\u007f]/.test(relativePath)) {
    throw error('Workspace file path is invalid.')
  }
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) throw error('Workspace file path must be relative.')
  const segments = relativePath.replace(/\\/g, '/').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw error('Unsafe workspace file path.')
  for (const segment of segments) {
    if (segment.length > 255 || /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || reservedWindowsNames.test(segment)) {
      throw error('Workspace file path contains a Windows-reserved or invalid name.')
    }
  }
  if (isExcludedPath(segments)) throw error('Secret-like or excluded files cannot be accessed by the local agent.')
  return segments
}

async function lstatOrNull(target) {
  try { return await fs.lstat(target) }
  catch (cause) {
    if (isMissing(cause)) return null
    throw cause
  }
}

async function ensureDirectoryTree(target) {
  const absolute = path.resolve(target)
  const parsed = path.parse(absolute)
  const segments = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)
  let current = parsed.root
  for (const segment of segments) {
    current = path.join(current, segment)
    let info = await lstatOrNull(current)
    if (!info) {
      try { await fs.mkdir(current) }
      catch (cause) {
        if (cause.code !== 'EEXIST') throw cause
      }
      info = await fs.lstat(current)
    }
    if (info.isSymbolicLink()) throw error('Workspace paths cannot contain symbolic links or junctions.')
    if (!info.isDirectory()) throw error('Workspace path component is not a directory.')
  }
  return await fs.realpath(absolute)
}

async function resolvePlannedDirectory(target) {
  const absolute = path.resolve(target)
  const remaining = []
  let current = absolute
  while (true) {
    const info = await lstatOrNull(current)
    if (info) {
      if (info.isSymbolicLink()) throw error('Workspace paths cannot contain symbolic links or junctions.')
      if (!info.isDirectory() && remaining.length) throw error('Workspace parent path is not a directory.')
      const canonical = await fs.realpath(current)
      return path.resolve(canonical, ...remaining.reverse())
    }
    const parent = path.dirname(current)
    if (parent === current) throw error('Workspace path has no existing directory ancestor.')
    remaining.push(path.basename(current))
    current = parent
  }
}

async function assertNoSymlinks(root, target, { allowMissingLeaf = false } = {}) {
  const canonicalRoot = path.resolve(root)
  const absoluteTarget = path.resolve(target)
  if (!isInsidePath(canonicalRoot, absoluteTarget)) throw error('Workspace path escaped its authorized root.', 'LOCAL_AGENT_PATH_ESCAPE')
  const relative = path.relative(canonicalRoot, absoluteTarget)
  let current = canonicalRoot
  const segments = relative ? relative.split(path.sep) : []
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index])
    const info = await lstatOrNull(current)
    if (!info) {
      if (allowMissingLeaf || index < segments.length - 1) continue
      throw error('Workspace file does not exist.')
    }
    if (info.isSymbolicLink()) throw error('Symbolic links and junctions are not allowed in workspace paths.')
    if (index < segments.length - 1 && !info.isDirectory()) throw error('Workspace path parent is not a directory.')
  }
  return absoluteTarget
}

async function verifyProjectDirectory(project) {
  const info = await fs.lstat(project.requestedPath).catch((cause) => {
    if (isMissing(cause)) throw error('Registered project directory does not exist.', 'LOCAL_PROJECT_MISSING')
    throw cause
  })
  if (info.isSymbolicLink() || !info.isDirectory()) throw error('Registered project must be a real directory, not a link or file.')
  const canonical = path.normalize(await fs.realpath(project.requestedPath))
  const canonicalInfo = await fs.stat(canonical)
  if (!canonicalInfo.isDirectory()) throw error('Registered project path is not a directory.')
  return canonical
}

async function readRegularFile(sourceRoot, sourceFile, expectedInfo) {
  const canonical = await fs.realpath(sourceFile)
  if (!isInsidePath(sourceRoot, canonical)) throw error('Source path escaped the selected project.', 'LOCAL_AGENT_PATH_ESCAPE')
  const before = await fs.lstat(sourceFile)
  if (before.isSymbolicLink() || !before.isFile()) throw error('Source file changed while it was being copied.')
  if (expectedInfo && (before.dev !== expectedInfo.dev || before.ino !== expectedInfo.ino)) throw error('Source file changed while it was being copied.')
  const bytes = await fs.readFile(sourceFile)
  const after = await fs.lstat(sourceFile)
  const canonicalAfter = await fs.realpath(sourceFile)
  if (after.isSymbolicLink() || !after.isFile() || !isInsidePath(sourceRoot, canonicalAfter) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw error('Source file changed while it was being copied.')
  }
  return bytes
}

async function writeWorkspaceFile(target, bytes, { exclusive = false } = {}) {
  const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.' + crypto.randomUUID() + '.tmp')
  await fs.writeFile(temporary, bytes, { flag: 'wx' })
  try {
    if (exclusive) await fs.link(temporary, target)
    else await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

async function collectGitignoreFiles(sourceRoot, limits) {
  const gitignoreFiles = []
  let totalBytes = 0
  let entriesSeen = 0
  let policy = compileGitignoreFiles(gitignoreFiles, limits)

  async function walk(sourceDirectory, relativeSegments, depth) {
    await assertNoSymlinks(sourceRoot, sourceDirectory)
    const ignorePath = path.join(sourceDirectory, '.gitignore')
    const ignoreInfo = await lstatOrNull(ignorePath)
    if (ignoreInfo?.isFile() && !ignoreInfo.isSymbolicLink()) {
      if (gitignoreFiles.length + 1 > limits.maxGitignoreFiles) {
        throw error(`Project has more than ${limits.maxGitignoreFiles} .gitignore files (maxGitignoreFiles).`, 'LOCAL_AGENT_GITIGNORE_LIMIT')
      }
      if (totalBytes + ignoreInfo.size > limits.maxGitignoreBytes) {
        throw error(`Project .gitignore content exceeds ${limits.maxGitignoreBytes} bytes (maxGitignoreBytes).`, 'LOCAL_AGENT_GITIGNORE_LIMIT')
      }
      const bytes = await readRegularFile(sourceRoot, ignorePath, ignoreInfo)
      totalBytes += bytes.byteLength
      let content
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { throw error(`Project .gitignore file "${[...relativeSegments, '.gitignore'].join('/')}" is not valid UTF-8 text.`, 'LOCAL_AGENT_GITIGNORE_UTF8') }
      gitignoreFiles.push({ path: [...relativeSegments, '.gitignore'].join('/'), content })
      policy = compileGitignoreFiles(gitignoreFiles, limits)
    }

    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      entriesSeen += 1
      if (entriesSeen > limits.maxEntries) throw error('Project exceeds the local workspace entry limit while reading .gitignore files.', 'LOCAL_AGENT_MAX_ENTRIES')
      if (entry.isSymbolicLink()) continue
      const segments = [...relativeSegments, entry.name]
      if (isExcludedPath(segments)) continue
      const sourcePath = path.join(sourceDirectory, entry.name)
      const info = await fs.lstat(sourcePath)
      if (info.isSymbolicLink() || !info.isDirectory()) continue
      if (gitignoreDirectoryIsExcluded(segments, policy.rules)) continue
      if (depth >= limits.maxDepth) throw error('Project exceeds the local workspace depth limit while reading .gitignore files.', 'LOCAL_AGENT_MAX_DEPTH')
      await walk(sourcePath, segments, depth + 1)
    }
  }

  await walk(sourceRoot, [], 0)
  return policy
}

async function collectBaseline(sourceRoot, copyRoot, baselineRoot, limits) {
  const files = []
  const stats = { entries: 0, files: 0, bytes: 0, skippedSymlinks: 0 }
  const gitignorePolicy = await collectGitignoreFiles(sourceRoot, limits)

  async function walk(sourceDirectory, destinationDirectory, snapshotDirectory, relativeSegments, depth, copyEnabled = true) {
    await assertNoSymlinks(sourceRoot, sourceDirectory)
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      stats.entries += 1
      if (stats.entries > limits.maxEntries) throw error('Project exceeds the local workspace entry limit.', 'LOCAL_AGENT_MAX_ENTRIES')
      const sourcePath = path.join(sourceDirectory, entry.name)
      const segments = [...relativeSegments, entry.name]
      if (entry.isSymbolicLink()) {
        stats.skippedSymlinks += 1
        continue
      }
      if (isExcludedPath(segments)) continue
      const info = await fs.lstat(sourcePath)
      if (info.isSymbolicLink()) {
        stats.skippedSymlinks += 1
        continue
      }
      if (info.isDirectory()) {
        const includeDirectory = copyEnabled && !gitignoreDirectoryIsExcluded(segments, gitignorePolicy.rules)
        if (depth >= limits.maxDepth) throw error('Project exceeds the local workspace depth limit.', 'LOCAL_AGENT_MAX_DEPTH')
        if (includeDirectory) {
          const destinationPath = path.join(destinationDirectory, entry.name)
          await ensureDirectoryTree(destinationPath)
          const baselineDirectory = path.join(snapshotDirectory, entry.name)
          await ensureDirectoryTree(baselineDirectory)
          await walk(sourcePath, destinationPath, baselineDirectory, segments, depth + 1, true)
        } else {
          await walk(sourcePath, null, null, segments, depth + 1, false)
        }
        continue
      }
      if (!info.isFile()) continue
      const decision = gitignoreFileDecision(segments, gitignorePolicy.rules)
      if (!copyEnabled || decision.ignored) continue
      if (info.size > limits.maxFileBytes) throw error('Project contains a file larger than the local workspace file limit.', 'LOCAL_AGENT_MAX_FILE_SIZE')
      if (stats.files + 1 > limits.maxFiles) throw error('Project exceeds the local workspace file-count limit.', 'LOCAL_AGENT_MAX_FILES')
      if (stats.bytes + info.size > limits.maxBytes) throw error('Project exceeds the local workspace byte limit.', 'LOCAL_AGENT_MAX_BYTES')

      const bytes = await readRegularFile(sourceRoot, sourcePath, info)
      if (stats.bytes + bytes.byteLength > limits.maxBytes) throw error('Project exceeds the local workspace byte limit.', 'LOCAL_AGENT_MAX_BYTES')
      const relative = segments.join('/')
      const destinationPath = path.join(destinationDirectory, entry.name)
      await ensureDirectoryTree(path.dirname(destinationPath))
      await fs.writeFile(destinationPath, bytes, { flag: 'wx' })
      const baselinePath = path.join(snapshotDirectory, entry.name)
      await ensureDirectoryTree(path.dirname(baselinePath))
      await fs.writeFile(baselinePath, bytes, { flag: 'wx' })
      files.push({ path: relative, size: bytes.byteLength, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
      stats.files += 1
      stats.bytes += bytes.byteLength
    }
  }

  await walk(sourceRoot, copyRoot, baselineRoot, [], 0)
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return { files, stats, gitignoreFiles: gitignorePolicy.files }
}

function assertWorkspaceShape(workspace) {
  if (!workspace || typeof workspace !== 'object' || typeof workspace.workspaceRoot !== 'string' || typeof workspace.root !== 'string' ||
      typeof workspace.source !== 'string' || typeof workspace.baselinePath !== 'string' || typeof workspace.baselineFiles !== 'string' ||
      !path.isAbsolute(workspace.workspaceRoot) || !path.isAbsolute(workspace.root) || !path.isAbsolute(workspace.source) ||
      !path.isAbsolute(workspace.baselinePath) || !path.isAbsolute(workspace.baselineFiles)) {
    throw error('A local Agent workspace handle is required.')
  }
  const expectedSource = path.join(path.resolve(workspace.root), 'source')
  const expectedManifest = path.join(path.resolve(workspace.root), 'baseline.json')
  const expectedBaselineFiles = path.join(path.resolve(workspace.root), 'baseline-files')
  if (!samePath(expectedSource, workspace.source) || !samePath(expectedManifest, workspace.baselinePath) || !samePath(expectedBaselineFiles, workspace.baselineFiles) ||
      !isInsidePath(workspace.workspaceRoot, workspace.root)) {
    throw error('Local Agent workspace paths do not match the managed workspace layout.', 'LOCAL_AGENT_PATH_ESCAPE')
  }
}

async function validateWorkspace(workspace) {
  assertWorkspaceShape(workspace)
  const workspaceRoot = path.resolve(workspace.workspaceRoot)
  const root = path.resolve(workspace.root)
  const source = path.resolve(workspace.source)
  const canonicalWorkspaceRoot = await fs.realpath(workspaceRoot)
  const canonicalRoot = await fs.realpath(root)
  const canonicalSource = await fs.realpath(source)
  const canonicalBaselineFiles = await fs.realpath(path.join(canonicalRoot, 'baseline-files'))
  if (!samePath(canonicalWorkspaceRoot, workspaceRoot) || !isInsidePath(canonicalWorkspaceRoot, canonicalRoot) ||
      !samePath(canonicalSource, source) || !samePath(canonicalSource, path.join(canonicalRoot, 'source')) ||
      !samePath(canonicalBaselineFiles, path.join(canonicalRoot, 'baseline-files'))) {
    throw error('Local Agent workspace resolved outside its managed directory.', 'LOCAL_AGENT_PATH_ESCAPE')
  }
  await assertNoSymlinks(canonicalWorkspaceRoot, canonicalRoot)
  await assertNoSymlinks(canonicalRoot, canonicalSource)
  await assertNoSymlinks(canonicalRoot, canonicalBaselineFiles)
  return { workspaceRoot: canonicalWorkspaceRoot, root: canonicalRoot, source: canonicalSource, baselinePath: path.join(canonicalRoot, 'baseline.json'), baselineFiles: canonicalBaselineFiles }
}

async function readManifest(workspaceState) {
  const manifestPath = await assertNoSymlinks(workspaceState.root, workspaceState.baselinePath)
  const manifestInfo = await fs.lstat(manifestPath)
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 8 * 1024 * 1024) throw error('Workspace baseline manifest is invalid.')
  let manifest
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) }
  catch (cause) { throw error('Workspace baseline manifest could not be read: ' + cause.message) }
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.gitignoreFiles) || !manifest.limits || typeof manifest.limits !== 'object') {
    throw error('Workspace baseline manifest has an unsupported shape.')
  }
  if (manifest.files.length > LOCAL_AGENT_WORKSPACE_LIMITS.maxFiles) throw error('Workspace baseline manifest exceeds the file limit.')
  manifest.limits = normalizeLimits(manifest.limits)
  const gitignorePolicy = compileGitignoreFiles(manifest.gitignoreFiles, manifest.limits)
  for (const gitignoreFile of gitignorePolicy.files) {
    const baseSegments = pathSegments(gitignoreFile.path).slice(0, -1)
    if (gitignoreDirectoryIsExcluded(baseSegments, gitignorePolicy.rules)) {
      throw error(`Workspace baseline policy includes nested .gitignore "${gitignoreFile.path}" beneath an ignored directory.`, 'LOCAL_AGENT_GITIGNORE_INVALID')
    }
  }
  manifest.gitignoreFiles = gitignorePolicy.files
  manifest.gitignoreRules = gitignorePolicy.rules
  const seen = new Set()
  let aggregateFileBytes = 0
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw error('Workspace baseline manifest contains an invalid file entry.')
    }
    const normalizedPath = pathSegments(file.path).join('/')
    const key = normalizedPath.normalize('NFC').toLocaleLowerCase('en-US')
    if (gitignoreFileDecision(normalizedPath.split('/'), gitignorePolicy.rules).ignored) {
      throw error(`Workspace baseline manifest includes a file excluded by .gitignore: "${normalizedPath}".`, 'LOCAL_AGENT_GITIGNORE_INVALID')
    }
    aggregateFileBytes += file.size
    if (seen.has(key) || file.size > manifest.limits.maxFileBytes || aggregateFileBytes > manifest.limits.maxBytes) {
      throw error('Workspace baseline manifest contains an unsafe, duplicate, or oversized file entry.')
    }
    seen.add(key)
  }
  return manifest
}

export async function createLocalAgentWorkspace({ dataDir, project, taskId, workspaceRoot, workspaceId, limits: limitOverrides } = {}) {
  const projectInfo = validateProject(project)
  const sourceRoot = await verifyProjectDirectory(projectInfo)
  const id = validateWorkspaceId(taskId || workspaceId)
  const limits = normalizeLimits(limitOverrides)
  const requestedWorkspaceRoot = workspaceRoot || (dataDir
    ? path.join(dataDir, 'agent-workspaces', 'local')
    : process.env.NEXUS_AGENT_WORKSPACE_ROOT || path.join(process.env.NEXUS_DATA_DIR || path.resolve('data'), 'agent-workspaces', 'local'))
  if (typeof requestedWorkspaceRoot !== 'string' || !path.isAbsolute(requestedWorkspaceRoot)) throw error('Workspace root must be an absolute directory.')
  if (dataDir !== undefined && (typeof dataDir !== 'string' || !path.isAbsolute(dataDir))) throw error('Data directory must be an absolute path.')
  const workspaceRootPath = path.resolve(requestedWorkspaceRoot)
  const plannedWorkspaceRoot = await resolvePlannedDirectory(workspaceRootPath)
  if (pathsOverlap(sourceRoot, plannedWorkspaceRoot)) throw error('Workspace root cannot overlap the selected project directory.')
  const canonicalWorkspaceRoot = await ensureDirectoryTree(workspaceRootPath)
  if (pathsOverlap(sourceRoot, canonicalWorkspaceRoot)) throw error('Workspace root cannot overlap the selected project directory.')
  const projectDirectory = path.join(canonicalWorkspaceRoot, projectInfo.id)
  await ensureDirectoryTree(projectDirectory)
  const root = path.join(projectDirectory, id)
  if (!isInsidePath(canonicalWorkspaceRoot, root)) throw error('Workspace path escaped its managed root.', 'LOCAL_AGENT_PATH_ESCAPE')
  if (await lstatOrNull(root)) throw error('A workspace with this id already exists.', 'LOCAL_AGENT_WORKSPACE_EXISTS')
  await fs.mkdir(root)
  const source = path.join(root, 'source')
  const baselineFiles = path.join(root, 'baseline-files')
  try {
    await fs.mkdir(source)
    await fs.mkdir(baselineFiles)
    const copied = await collectBaseline(sourceRoot, source, baselineFiles, limits)
    const createdAt = new Date().toISOString()
    const baselinePath = path.join(root, 'baseline.json')
    const manifest = {
      schemaVersion: 1,
      workspaceId: id,
      project: { id: projectInfo.id, name: projectInfo.name, originalPath: sourceRoot },
      createdAt,
      limits,
      stats: copied.stats,
      gitignoreFiles: copied.gitignoreFiles,
      files: copied.files
    }
    await fs.writeFile(baselinePath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' })
    return {
      id,
      projectId: projectInfo.id,
      projectName: projectInfo.name,
      workspaceRoot: canonicalWorkspaceRoot,
      root,
      source,
      baselinePath,
      baselineFiles,
      createdAt,
      limits,
      stats: copied.stats
    }
  } catch (cause) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    throw cause
  }
}

export async function readLocalAgentFiles(workspace, relativePaths, { maxFiles, maxBytes } = {}) {
  const workspaceState = await validateWorkspace(workspace)
  const manifest = await readManifest(workspaceState)
  if (relativePaths !== undefined && !Array.isArray(relativePaths)) throw error('A list of workspace-relative file paths is required.')
  const limits = workspace.limits || LOCAL_AGENT_WORKSPACE_LIMITS
  const requestedFileLimit = maxFiles === undefined ? limits.maxReadFiles : Number(maxFiles)
  const requestedByteLimit = maxBytes === undefined ? limits.maxReadBytes : Number(maxBytes)
  if (!Number.isSafeInteger(requestedFileLimit) || requestedFileLimit < 1 || !Number.isSafeInteger(requestedByteLimit) || requestedByteLimit < 1) {
    throw error('Local read limits must be positive integers.')
  }
  const fileLimit = Math.min(requestedFileLimit, limits.maxReadFiles)
  const byteLimit = Math.min(requestedByteLimit, limits.maxReadBytes)
  const requestedPaths = relativePaths === undefined ? manifest.files.slice(0, fileLimit).map((file) => file.path) : relativePaths
  if (requestedPaths.length > fileLimit) throw error('Selected file list exceeds the local read limit.', 'LOCAL_AGENT_MAX_READ_FILES')
  const selected = []
  const seen = new Set()
  let selectedBytes = 0
  for (const inputPath of requestedPaths) {
    const segments = pathSegments(inputPath)
    assertGitignoreAllowsFile(segments, manifest.gitignoreRules)
    const relative = segments.join('/')
    const key = process.platform === 'win32' ? relative.toLocaleLowerCase('en-US') : relative
    if (seen.has(key)) continue
    seen.add(key)
    if (selected.length >= fileLimit) throw error('Selected file list exceeds the local read limit.', 'LOCAL_AGENT_MAX_READ_FILES')
    const target = path.join(workspaceState.source, ...segments)
    await assertNoSymlinks(workspaceState.source, target)
    const info = await fs.lstat(target)
    if (info.isSymbolicLink() || !info.isFile()) throw error('Selected workspace path is not a regular file.')
    if (info.size > Math.min(limits.maxFileBytes, byteLimit)) throw error('Selected file exceeds the local read limit.', 'LOCAL_AGENT_MAX_READ_BYTES')
    const bytes = await fs.readFile(target)
    if (selectedBytes + bytes.byteLength > byteLimit) {
      throw error('Selected files exceed the local read byte limit.', 'LOCAL_AGENT_MAX_READ_BYTES')
    }
    let content
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw error('Selected file is not valid UTF-8 text.') }
    selected.push({ path: relative, content })
    selectedBytes += bytes.byteLength
  }
  return selected
}

export async function applyLocalAgentOperations(workspace, operations) {
  const workspaceState = await validateWorkspace(workspace)
  const manifest = await readManifest(workspaceState)
  if (!Array.isArray(operations) || operations.length > workspace.limits.maxOperations) throw error('File operation list is invalid or exceeds the local operation limit.')
  const seen = new Set()
  const validated = []
  let totalBytes = 0
  const existingFiles = await collectCurrentFiles(workspaceState.source, workspace.limits, manifest.gitignoreRules)
  const existingByKey = new Map(existingFiles.map((file) => [file.path.normalize('NFC').toLocaleLowerCase('en-US'), file]))
  let finalFileCount = existingFiles.length
  let finalBytes = existingFiles.reduce((sum, file) => sum + file.size, 0)
  const existingDirectories = new Set(existingFiles.directories)
  const newDirectories = new Set()
  for (const operation of operations) {
    if (!operation || !['create', 'replace'].includes(operation.action) || typeof operation.path !== 'string' || typeof operation.content !== 'string') {
      throw error('Only bounded create and replace operations are supported; deletion is not available.')
    }
    const segments = pathSegments(operation.path)
    assertGitignoreAllowsFile(segments, manifest.gitignoreRules)
    const relative = segments.join('/')
    if (segments.length - 1 > workspace.limits.maxDepth) throw error('File operation exceeds the local workspace depth limit.', 'LOCAL_AGENT_MAX_DEPTH')
    const key = relative.normalize('NFC').toLocaleLowerCase('en-US')
    if (seen.has(key)) throw error('A workspace path may appear only once in an operation batch.')
    if ([...seen].some((other) => other.startsWith(key + '/') || key.startsWith(other + '/'))) {
      throw error('File operation paths cannot contain another operation path as a parent.')
    }
    seen.add(key)
    const bytes = Buffer.from(operation.content, 'utf8')
    if (bytes.byteLength > workspace.limits.maxOperationBytes) throw error('File operation content exceeds the local operation limit.', 'LOCAL_AGENT_MAX_OPERATION_BYTES')
    totalBytes += bytes.byteLength
    if (totalBytes > workspace.limits.maxOperationBatchBytes) throw error('File operation batch exceeds the local byte limit.', 'LOCAL_AGENT_MAX_OPERATION_BYTES')
    const target = path.join(workspaceState.source, ...segments)
    await assertNoSymlinks(workspaceState.source, target, { allowMissingLeaf: operation.action === 'create' })
    const info = await lstatOrNull(target)
    if (operation.action === 'create' && info) throw error('Refusing to overwrite an existing workspace file.')
    if (operation.action === 'replace' && (!info || info.isSymbolicLink() || !info.isFile())) throw error('Replace operation requires an existing regular workspace file.')
    if (bytes.byteLength > workspace.limits.maxFileBytes) throw error('File operation content exceeds the workspace file limit.', 'LOCAL_AGENT_MAX_FILE_SIZE')
    const existing = existingByKey.get(key)
    if (operation.action === 'create') {
      finalFileCount += 1
      finalBytes += bytes.byteLength
    } else {
      if (!existing) throw error('Replace operation target is not part of the bounded workspace.')
      finalBytes += bytes.byteLength - existing.size
    }
    if (finalFileCount > workspace.limits.maxFiles) throw error('File operation would exceed the workspace file limit.', 'LOCAL_AGENT_MAX_FILES')
    if (finalBytes > workspace.limits.maxBytes) throw error('File operation would exceed the workspace byte limit.', 'LOCAL_AGENT_MAX_BYTES')
    const parentSegments = []
    for (const segment of segments.slice(0, -1)) {
      parentSegments.push(segment)
      const directoryKey = parentSegments.join('/').normalize('NFC').toLocaleLowerCase('en-US')
      if (!existingDirectories.has(directoryKey)) newDirectories.add(directoryKey)
    }
    validated.push({ action: operation.action, path: relative, target, bytes })
  }
  const createdFiles = validated.filter((operation) => operation.action === 'create').length
  if (existingFiles.entriesSeen + newDirectories.size + createdFiles > workspace.limits.maxEntries) {
    throw error('File operations would exceed the workspace entry limit.', 'LOCAL_AGENT_MAX_ENTRIES')
  }
  const applied = []
  for (const operation of validated) {
    const parent = path.dirname(operation.target)
    await ensureDirectoryTree(parent)
    await assertNoSymlinks(workspaceState.source, parent)
    if (operation.action === 'create') {
      await writeWorkspaceFile(operation.target, operation.bytes, { exclusive: true })
    } else {
      const current = await fs.lstat(operation.target)
      if (current.isSymbolicLink() || !current.isFile()) throw error('Workspace file changed before it could be replaced.')
      await writeWorkspaceFile(operation.target, operation.bytes)
    }
    applied.push(operation.path)
  }
  return applied
}

async function collectCurrentFiles(sourceRoot, limits, gitignoreRules = []) {
  const files = []
  const directories = new Set()
  let bytesTotal = 0
  let entriesSeen = 0
  async function walk(directory, relativeSegments, depth) {
    await assertNoSymlinks(sourceRoot, directory)
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      entriesSeen += 1
      if (entriesSeen > limits.maxEntries) throw error('Workspace exceeds the local entry limit.', 'LOCAL_AGENT_MAX_ENTRIES')
      const segments = [...relativeSegments, entry.name]
      if (entry.isSymbolicLink()) continue
      if (isExcludedPath(segments)) continue
      const target = path.join(directory, entry.name)
      const info = await fs.lstat(target)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        if (depth >= limits.maxDepth) throw error('Workspace exceeds the local diff depth limit.', 'LOCAL_AGENT_MAX_DEPTH')
        if (!gitignoreDirectoryIsExcluded(segments, gitignoreRules)) {
          directories.add(segments.join('/').normalize('NFC').toLocaleLowerCase('en-US'))
        }
        await walk(target, segments, depth + 1)
      } else if (info.isFile()) {
        if (gitignoreFileDecision(segments, gitignoreRules).ignored) continue
        if (info.size > limits.maxFileBytes || files.length + 1 > limits.maxFiles || bytesTotal + info.size > limits.maxBytes) {
          throw error('Workspace exceeds the local diff size limit.', 'LOCAL_AGENT_DIFF_LIMIT')
        }
        const canonical = await fs.realpath(target)
        if (!isInsidePath(sourceRoot, canonical)) throw error('Workspace path escaped its source directory.', 'LOCAL_AGENT_PATH_ESCAPE')
        const bytes = await fs.readFile(target)
        const after = await fs.lstat(target)
        if (after.isSymbolicLink() || !after.isFile() || info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size) {
          throw error('Workspace file changed while it was being inspected.')
        }
        const relative = segments.join('/')
        files.push({ path: relative, size: bytes.byteLength, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
        bytesTotal += bytes.byteLength
      }
    }
  }
  await walk(sourceRoot, [], 0)
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  Object.defineProperties(files, {
    directories: { value: directories },
    entriesSeen: { value: entriesSeen }
  })
  return files
}

export async function listLocalAgentChanges(workspace) {
  const workspaceState = await validateWorkspace(workspace)
  const manifest = await readManifest(workspaceState)
  const baseline = new Map(manifest.files.map((file) => [file.path.normalize('NFC').toLocaleLowerCase('en-US'), file]))
  const currentFiles = await collectCurrentFiles(workspaceState.source, manifest.limits, manifest.gitignoreRules)
  const current = new Map(currentFiles.map((file) => [file.path.normalize('NFC').toLocaleLowerCase('en-US'), file]))
  const changes = []
  let diffContentBytes = 0
  const maxDiffContentBytes = 1024 * 1024
  for (const file of currentFiles) {
    const previous = baseline.get(file.path.normalize('NFC').toLocaleLowerCase('en-US'))
    if (previous && previous.path === file.path && previous.sha256 === file.sha256) continue
    const action = previous ? 'modified' : 'added'
    const beforePath = previous ? path.join(workspaceState.baselineFiles, ...pathSegments(previous.path)) : null
    const afterPath = path.join(workspaceState.source, ...pathSegments(file.path))
    const contentBytes = (previous?.size || 0) + file.size
    let before = null
    let after = null
    let contentStatus = 'available'
    if (diffContentBytes + contentBytes > maxDiffContentBytes) {
      contentStatus = 'omitted-size-limit'
    } else {
      try {
        if (beforePath) await assertNoSymlinks(workspaceState.baselineFiles, beforePath)
        await assertNoSymlinks(workspaceState.source, afterPath)
        const beforeBuffer = beforePath ? await fs.readFile(beforePath) : null
        const afterBuffer = await fs.readFile(afterPath)
        if ((beforeBuffer && crypto.createHash('sha256').update(beforeBuffer).digest('hex') !== previous.sha256) ||
            crypto.createHash('sha256').update(afterBuffer).digest('hex') !== file.sha256) {
          throw error('Workspace file changed while its diff was being read.')
        }
        before = beforeBuffer ? new TextDecoder('utf-8', { fatal: true }).decode(beforeBuffer) : null
        after = new TextDecoder('utf-8', { fatal: true }).decode(afterBuffer)
        const encodedContentBytes = Buffer.byteLength(JSON.stringify({ before, after }))
        if (diffContentBytes + encodedContentBytes > maxDiffContentBytes) {
          before = null
          after = null
          contentStatus = 'omitted-size-limit'
        } else diffContentBytes += encodedContentBytes
      } catch (cause) {
        if (cause instanceof TypeError) contentStatus = 'binary-content'
        else throw cause
      }
    }
    changes.push({ action, path: file.path, before, after, contentStatus })
  }
  for (const file of manifest.files) {
    if (current.has(file.path.normalize('NFC').toLocaleLowerCase('en-US'))) continue
    let before = null
    let contentStatus = 'available'
    if (diffContentBytes + file.size > maxDiffContentBytes) {
      contentStatus = 'omitted-size-limit'
    } else {
      try {
        const beforePath = path.join(workspaceState.baselineFiles, ...pathSegments(file.path))
        await assertNoSymlinks(workspaceState.baselineFiles, beforePath)
        const beforeBuffer = await fs.readFile(beforePath)
        if (crypto.createHash('sha256').update(beforeBuffer).digest('hex') !== file.sha256) throw error('Baseline file changed while its diff was being read.')
        before = new TextDecoder('utf-8', { fatal: true }).decode(beforeBuffer)
        const encodedContentBytes = Buffer.byteLength(JSON.stringify({ before, after: null }))
        if (diffContentBytes + encodedContentBytes > maxDiffContentBytes) {
          before = null
          contentStatus = 'omitted-size-limit'
        } else diffContentBytes += encodedContentBytes
      } catch (cause) {
        if (cause instanceof TypeError) contentStatus = 'binary-content'
        else throw cause
      }
    }
    changes.push({ action: 'deleted', path: file.path, before, after: null, contentStatus })
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}
