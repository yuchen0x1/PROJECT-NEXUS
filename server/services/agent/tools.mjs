import fs from 'node:fs/promises'
import path from 'node:path'
import { runCommand, isProgramAllowed, DEFAULT_ALLOWED_PROGRAMS } from './executor.mjs'
import { searchProjectIndex } from './indexer.mjs'

// Agent tool registry. Every tool declares a permission level (low/medium/high),
// a bounded input schema, and returns a compact observation. The agent runtime
// enforces approvals based on the declared permission and the task's approval
// policy — tools never decide permissions themselves.

export const TOOL_PERMISSIONS = Object.freeze(['low', 'medium', 'high'])

const TOOL_LIMITS = Object.freeze({
  maxReadFileBytes: 512 * 1024,
  maxReadFilesPerCall: 40,
  maxListEntries: 500,
  maxSearchResults: 50,
  maxSearchTotalBytes: 8 * 1024 * 1024,
  maxSearchFileBytes: 512 * 1024,
  maxWriteContentBytes: 512 * 1024,
  maxOperationsPerBatch: 20,
  maxCommandTimeoutMs: 600_000,
  maxDiffChars: 60_000,
  maxListDepthPreview: 2
})

const binaryExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tar', '.rar',
  '.7z', '.exe', '.dll', '.so', '.dylib', '.msi', '.apk', '.jar', '.class', '.woff', '.woff2',
  '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.wav', '.sqlite', '.db', '.wasm', '.node', '.bin', '.pak', '.asar'
])

const excludedDirectories = new Set([
  '.git', 'node_modules', 'dist', 'build', 'target', 'coverage', '.next', '.venv', 'venv', '__pycache__', 'release'
])

function toolError(code, message) {
  return Object.assign(new Error(message), { code })
}

function validateArgs(args, schema, toolName) {
  if (args === undefined || args === null) args = {}
  if (typeof args !== 'object' || Array.isArray(args)) throw toolError('TOOL_ARGS_INVALID', `${toolName} arguments must be an object; expected keys: ${Object.keys(schema).join(', ')}.`)
  for (const [key, rule] of Object.entries(schema)) {
    const value = args[key]
    if (value === undefined || value === null || value === '') {
      if (rule.required) throw toolError('TOOL_ARGS_INVALID', `${toolName} requires "${key}" (${rule.type}). Expected argument keys: ${Object.keys(schema).join(', ')}.`)
      continue
    }
    if (rule.type === 'string') {
      if (typeof value !== 'string') throw toolError('TOOL_ARGS_INVALID', `${toolName} argument "${key}" must be a string.`)
      if (rule.maxLength && value.length > rule.maxLength) throw toolError('TOOL_ARGS_INVALID', `${toolName} argument "${key}" exceeds ${rule.maxLength} characters.`)
      if (rule.noNewlines && /[\r\n\u0000]/.test(value)) throw toolError('TOOL_ARGS_INVALID', `${toolName} argument "${key}" must not contain newlines or control characters.`)
    } else if (rule.type === 'number') {
      const number = Number(value)
      if (!Number.isFinite(number)) throw toolError('TOOL_ARGS_INVALID', `${toolName} argument "${key}" must be a number.`)
      if (rule.min !== undefined && number < rule.min) throw toolError('TOOL_ARGS_INVALID', `${toolName} argument "${key}" must be >= ${rule.min}.`)
      if (rule.max !== undefined && number > rule.max) throw toolError('TOOL_ARGS_INVALID', `${toolName} argument "${key}" must be <= ${rule.max}.`)
    } else if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') throw toolError('TOOL_ARGS_INVALID', `${toolName} argument "${key}" must be a boolean.`)
    }
  }
  const extraKeys = Object.keys(args).filter((key) => !schema[key])
  if (extraKeys.length) throw toolError('TOOL_ARGS_INVALID', `${toolName} received unknown arguments: ${extraKeys.join(', ')}.`)
  return args
}

function normalizeRelativePath(value, { allowMissing = true } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw toolError('TOOL_PATH_INVALID', 'A workspace-relative path is required.')
  if (value.length > 600 || /[\u0000-\u001f\u007f]/.test(value)) throw toolError('TOOL_PATH_INVALID', 'Path contains invalid characters.')
  const clean = value.replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.')
  if (!clean.length) throw toolError('TOOL_PATH_INVALID', 'A workspace-relative path is required.')
  if (clean.some((segment) => segment === '..')) throw toolError('TOOL_PATH_ESCAPE', 'Paths must stay inside the workspace.')
  const lower = clean.join('/').toLowerCase()
  const secretLike = clean.some((segment) =>
    segment === '.git' || segment === '.ssh' || segment === '.aws' ||
    /^\.env/.test(segment) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(segment) ||
    /\.(pem|key|p12|pfx|keystore)$/.test(segment) || ['credentials.json', '.netrc'].includes(segment))
  if (secretLike) throw toolError('TOOL_PATH_SENSITIVE', 'Secret-like paths are not accessible to the agent.')
  for (const segment of clean) {
    if (segment.length > 255 || /[<>:"|?*]/.test(segment)) throw toolError('TOOL_PATH_INVALID', `Path segment "${segment}" is invalid on this platform.`)
  }
  return { segments: clean, relative: clean.join('/') }
}

function isCodeExtension(relative) {
  return ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.json', '.md'].includes(path.posix.extname(relative).toLowerCase())
}

function syntaxSanityWarning(relative, content) {
  const ext = path.posix.extname(relative).toLowerCase()
  if (ext === '.json') {
    try { JSON.parse(content) } catch (error) { return `JSON parse failed after edit: ${String(error.message).slice(0, 200)}` }
    return null
  }
  if (!['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) return null
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  const pairs = { '{': '}', '(': ')', '[': ']' }
  const stack = []
  for (const character of stripped) {
    if (pairs[character]) stack.push(pairs[character])
    else if (Object.values(pairs).includes(character)) {
      if (stack.pop() !== character) return `Unbalanced "${character}" after edit — the edit introduced a syntax error.`
    }
  }
  if (stack.length) return `${stack.length} unclosed bracket(s) after edit — the edit likely introduced a syntax error.`
  return null
}

async function readWorkspaceTextFile(adapter, relative) {
  const files = await adapter.readFiles([relative], { maxFiles: 1, maxBytes: TOOL_LIMITS.maxReadFileBytes })
  const file = files.find((item) => item.path === relative)
  if (!file) throw toolError('TOOL_FILE_MISSING', `File not found in workspace: ${relative}`)
  return file.content
}

function createToolContext({ adapter, index, projectPath, manifests = [], allowedPrograms = DEFAULT_ALLOWED_PROGRAMS, onEvent = () => {}, signal = null, approvalPolicy = 'standard' }) {
  return {
    adapter,
    index,
    projectPath,
    manifests,
    allowedPrograms,
    onEvent,
    signal,
    approvalPolicy,
    cwd: adapter.source
  }
}

function defineTools() {
  const tools = []

  const define = (definition, handler) => {
    tools.push({
      permission: 'low',
      schema: {},
      ...definition,
      handler
    })
  }

  // ---- File tools ----

  define({
    name: 'read_file',
    description: 'Read a UTF-8 text file from the task workspace. Returns the file content, truncated if it exceeds the size limit.',
    permission: 'low',
    summary: (args) => `read ${args?.path || ''}`,
    schema: { path: { type: 'string', required: true, maxLength: 600 } }
  }, async (args, ctx) => {
    const { relative } = normalizeRelativePath(args.path)
    const content = await readWorkspaceTextFile(ctx.adapter, relative)
    const truncated = Buffer.byteLength(content, 'utf8') > TOOL_LIMITS.maxReadFileBytes
    return { path: relative, content: truncated ? content.slice(0, TOOL_LIMITS.maxReadFileBytes) : content, truncated, bytes: Buffer.byteLength(content, 'utf8') }
  })

  define({
    name: 'list_directory',
    description: 'List the direct children of a workspace directory with file sizes. Omit path for the workspace root.',
    permission: 'low',
    summary: (args) => `list ${args?.path || '.'}`,
    schema: { path: { type: 'string', maxLength: 600 } }
  }, async (args, ctx) => {
    const segments = args.path ? normalizeRelativePath(args.path).segments : []
    const target = path.join(ctx.adapter.source, ...segments)
    let entries
    try { entries = await fs.readdir(target, { withFileTypes: true }) }
    catch (error) {
      if (error.code === 'ENOENT') throw toolError('TOOL_FILE_MISSING', `Directory does not exist: ${args.path || '.'}`)
      throw error
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    const listed = []
    for (const entry of entries.slice(0, TOOL_LIMITS.maxListEntries)) {
      const info = await fs.stat(path.join(target, entry.name)).catch(() => null)
      listed.push({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
        size: info?.isFile() ? info.size : null
      })
    }
    return { path: segments.join('/') || '.', entries: listed, truncated: entries.length > TOOL_LIMITS.maxListEntries }
  })

  define({
    name: 'search_files',
    description: 'Search the project index for files by path or symbol name (ranked). Use for locating relevant files.',
    permission: 'low',
    summary: (args) => `search files "${args?.query || ''}"`,
    schema: { query: { type: 'string', required: true, maxLength: 200 } }
  }, async (args, ctx) => {
    if (!ctx.index) throw toolError('TOOL_INDEX_UNAVAILABLE', 'The project index is not loaded.')
    const results = searchProjectIndex(ctx.index, args.query, { limit: TOOL_LIMITS.maxSearchResults })
    return { query: args.query, matches: results }
  })

  define({
    name: 'search_code',
    description: 'Search file contents across the workspace for a literal string or /regex/. Returns matching file paths, line numbers and line text (bounded).',
    permission: 'low',
    summary: (args) => `search code "${args?.query || ''}"`,
    schema: { query: { type: 'string', required: true, maxLength: 300 }, regex: { type: 'boolean' } }
  }, async (args, ctx) => {
    const query = String(args.query)
    let matcher
    if (args.regex) {
      if (query.length > 200) throw toolError('TOOL_ARGS_INVALID', 'Regex queries are limited to 200 characters.')
      try { matcher = new RegExp(query, 'i') } catch (error) { throw toolError('TOOL_ARGS_INVALID', `Invalid regex: ${String(error.message).slice(0, 120)}`) }
    } else {
      const needle = query.toLowerCase()
      matcher = { test: (line) => line.toLowerCase().includes(needle) }
    }
    const results = []
    let totalBytes = 0
    const fileList = (ctx.index?.files || []).filter((file) => !binaryExtensions.has(file.ext || '') && file.size <= TOOL_LIMITS.maxSearchFileBytes && !excludedDirectories.has(file.path.split('/')[0].toLowerCase()))
    for (const file of fileList) {
      if (results.length >= TOOL_LIMITS.maxSearchResults || totalBytes >= TOOL_LIMITS.maxSearchTotalBytes) break
      const segments = file.path.split('/')
      if (segments.some((segment) => excludedDirectories.has(segment.toLowerCase()))) continue
      let content
      try { content = await fs.readFile(path.join(ctx.adapter.source, ...segments), 'utf8') }
      catch { continue }
      totalBytes += Buffer.byteLength(content)
      const lines = content.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        if (matcher.test(lines[index])) {
          results.push({ path: file.path, line: index + 1, text: lines[index].slice(0, 240) })
          if (results.length >= TOOL_LIMITS.maxSearchResults) break
        }
      }
    }
    return { query, regex: Boolean(args.regex), matches: results, truncated: results.length >= TOOL_LIMITS.maxSearchResults, scannedFiles: fileList.length, scannedBytes: totalBytes }
  })

  define({
    name: 'create_file',
    description: 'Create a new file with full UTF-8 content. Fails if the file already exists (use write_file to replace).',
    permission: 'medium',
    summary: (args) => `create ${args?.path || ''}`,
    schema: { path: { type: 'string', required: true, maxLength: 600 }, content: { type: 'string', required: true, maxLength: 4_000_000 } }
  }, async (args, ctx) => {
    const { relative } = normalizeRelativePath(args.path)
    if (Buffer.byteLength(args.content, 'utf8') > TOOL_LIMITS.maxWriteContentBytes) throw toolError('TOOL_CONTENT_TOO_LARGE', `File content exceeds the ${TOOL_LIMITS.maxWriteContentBytes}-byte limit.`)
    const applied = await ctx.adapter.applyOperations([{ action: 'create', path: relative, content: args.content }])
    const warning = syntaxSanityWarning(relative, args.content)
    return { path: relative, created: true, bytes: Buffer.byteLength(args.content, 'utf8'), ...(warning ? { warning } : {}) , applied }
  })

  define({
    name: 'write_file',
    description: 'Replace an existing file with full UTF-8 content. The file must already exist in the workspace.',
    permission: 'medium',
    summary: (args) => `write ${args?.path || ''}`,
    schema: { path: { type: 'string', required: true, maxLength: 600 }, content: { type: 'string', required: true, maxLength: 4_000_000 } }
  }, async (args, ctx) => {
    const { relative } = normalizeRelativePath(args.path)
    if (Buffer.byteLength(args.content, 'utf8') > TOOL_LIMITS.maxWriteContentBytes) throw toolError('TOOL_CONTENT_TOO_LARGE', `File content exceeds the ${TOOL_LIMITS.maxWriteContentBytes}-byte limit.`)
    const applied = await ctx.adapter.applyOperations([{ action: 'replace', path: relative, content: args.content }])
    const warning = syntaxSanityWarning(relative, args.content)
    return { path: relative, written: true, bytes: Buffer.byteLength(args.content, 'utf8'), ...(warning ? { warning } : {}), applied }
  })

  define({
    name: 'edit_file',
    description: 'Replace one exact occurrence of oldText with newText inside a file. oldText must match exactly once (including whitespace). Line endings (CRLF/LF) are matched and preserved automatically. Prefer this over rewriting whole files.',
    permission: 'medium',
    summary: (args) => `edit ${args?.path || ''}`,
    schema: {
      path: { type: 'string', required: true, maxLength: 600 },
      oldText: { type: 'string', required: true, maxLength: 200_000 },
      newText: { type: 'string', required: true, maxLength: 400_000 }
    }
  }, async (args, ctx) => {
    const { relative } = normalizeRelativePath(args.path)
    const original = await readWorkspaceTextFile(ctx.adapter, relative)
    // Windows projects commonly use CRLF. Normalize both the file and the
    // model-provided text to LF for matching, then restore the file's dominant
    // ending so we never silently rewrite the whole file's line endings.
    const usesCrlf = original.includes('\r\n')
    const toLf = (value) => value.replace(/\r\n/g, '\n')
    const fromLf = (value) => usesCrlf ? value.replace(/\n/g, '\r\n') : value
    const contentLf = toLf(original)
    const oldTextLf = toLf(args.oldText)
    const newTextLf = toLf(args.newText)
    const occurrences = contentLf.split(oldTextLf).length - 1
    if (occurrences === 0) {
      // Teach, don't just fail: point the model at the closest matching
      // region with exact line numbers it can copy from.
      const anchorLine = oldTextLf.split('\n').map((line) => line.trim()).find(Boolean) || ''
      const lines = contentLf.split('\n')
      let bestIndex = -1
      let bestScore = 0
      for (let index = 0; index < lines.length; index += 1) {
        const trimmed = lines[index].trim()
        if (!trimmed) continue
        let score = 0
        if (trimmed === anchorLine.trim()) score = 100
        else if (trimmed.includes(anchorLine.trim()) && anchorLine.length > 8) score = 60
        else {
          const anchorWords = anchorLine.trim().split(/\s+/).filter((word) => word.length > 2)
          const overlap = anchorWords.filter((word) => trimmed.includes(word)).length
          score = anchorWords.length ? (overlap / anchorWords.length) * 40 : 0
        }
        if (score > bestScore) { bestScore = score; bestIndex = index }
      }
      let excerpt = ''
      if (bestIndex >= 0 && bestScore >= 25) {
        const from = Math.max(0, bestIndex - 2)
        const to = Math.min(lines.length, bestIndex + 3)
        excerpt = lines.slice(from, to).map((line, offset) => `${from + offset + 1}: ${line}`).join('\n')
        excerpt = `\nClosest matching region in ${relative} (copy the exact text from these lines):\n${excerpt}`
      }
      throw toolError('TOOL_EDIT_NO_MATCH', `oldText not found in ${relative}.${excerpt} Read the file and copy the exact text including indentation and comment symbols.`)
    }
    if (occurrences > 1) throw toolError('TOOL_EDIT_AMBIGUOUS', `oldText matches ${occurrences} times in ${relative}. Provide more surrounding lines so it matches exactly once.`)
    const updatedLf = contentLf.replace(oldTextLf, newTextLf)
    const updated = fromLf(updatedLf)
    if (Buffer.byteLength(updated, 'utf8') > TOOL_LIMITS.maxWriteContentBytes) throw toolError('TOOL_CONTENT_TOO_LARGE', 'The edited file would exceed the content size limit.')
    await ctx.adapter.applyOperations([{ action: 'replace', path: relative, content: updated }])
    const warning = syntaxSanityWarning(relative, updatedLf)
    return { path: relative, edited: true, lineEndings: usesCrlf ? 'crlf' : 'lf', bytes: Buffer.byteLength(updated, 'utf8'), ...(warning ? { warning } : {}) }
  })

  define({
    name: 'delete_file',
    description: 'Delete one file from the workspace. Files that existed at task start can be restored later. Deleting many files or build outputs requires approval.',
    permission: 'high',
    summary: (args) => `delete ${args?.path || ''}`,
    schema: { path: { type: 'string', required: true, maxLength: 600 } }
  }, async (args, ctx) => {
    const { relative } = normalizeRelativePath(args.path)
    const deleted = await ctx.adapter.deleteFile(relative)
    return { path: deleted, deleted: true }
  })

  define({
    name: 'move_file',
    description: 'Move or rename a file inside the workspace.',
    permission: 'medium',
    summary: (args) => `move ${args?.from || ''} -> ${args?.to || ''}`,
    schema: { from: { type: 'string', required: true, maxLength: 600 }, to: { type: 'string', required: true, maxLength: 600 } }
  }, async (args, ctx) => {
    const from = normalizeRelativePath(args.from)
    const to = normalizeRelativePath(args.to)
    const content = await readWorkspaceTextFile(ctx.adapter, from.relative)
    await ctx.adapter.applyOperations([{ action: 'create', path: to.relative, content }])
    await ctx.adapter.deleteFile(from.relative)
    return { from: from.relative, to: to.relative, moved: true }
  })

  define({
    name: 'get_file_diff',
    description: 'Show the current before/after diff for one file versus the task baseline.',
    permission: 'low',
    summary: (args) => `diff ${args?.path || ''}`,
    schema: { path: { type: 'string', required: true, maxLength: 600 } }
  }, async (args, ctx) => {
    const { relative } = normalizeRelativePath(args.path)
    const changes = await ctx.adapter.listChanges()
    const change = changes.find((item) => item.path === relative)
    if (!change) return { path: relative, changed: false }
    const diff = await ctx.adapter.diff()
    const section = diff.diff || ''
    return { path: relative, changed: true, action: change.action, diff: section.slice(0, TOOL_LIMITS.maxDiffChars) }
  })

  // ---- Project tools ----

  define({
    name: 'inspect_project',
    description: 'Summarize the project: technology stack, entry points, file counts, test files, route/API candidates.',
    permission: 'low',
    summary: () => 'inspect project',
    schema: {}
  }, async (_args, ctx) => {
    if (!ctx.index) throw toolError('TOOL_INDEX_UNAVAILABLE', 'The project index is not loaded.')
    const { index } = ctx
    return {
      stats: index.stats,
      entryPoints: index.entryPoints,
      testPaths: (index.testPaths || []).slice(0, 30),
      routeCandidates: (index.routeCandidates || []).slice(0, 15),
      apiCandidates: (index.apiCandidates || []).slice(0, 15),
      manifests: (index.manifests || []).map((manifest) => manifest.path),
      languageCounts: index.files.reduce((counts, file) => {
        if (file.language) counts[file.language] = (counts[file.language] || 0) + 1
        return counts
      }, {})
    }
  })

  define({
    name: 'inspect_dependencies',
    description: 'List declared dependencies from package.json / pyproject.toml style manifests.',
    permission: 'low',
    summary: () => 'inspect dependencies',
    schema: {}
  }, async (_args, ctx) => {
    const dependencies = (ctx.manifests || []).filter((manifest) => manifest.dependencies || manifest.devDependencies || manifest.kind === 'pyproject.toml')
      .map((manifest) => ({ path: manifest.path, kind: manifest.kind, dependencies: manifest.dependencies || [], devDependencies: manifest.devDependencies || [], name: manifest.name || null }))
    return { dependencies }
  })

  define({
    name: 'inspect_project_config',
    description: 'Read the raw content of the project manifest/config files (package.json, tsconfig, etc.).',
    permission: 'low',
    summary: () => 'inspect config files',
    schema: {}
  }, async (_args, ctx) => {
    const configPaths = (ctx.manifests || []).slice(0, 10).map((manifest) => manifest.path)
    const configs = []
    for (const configPath of configPaths) {
      try {
        const files = await ctx.adapter.readFiles([configPath], { maxFiles: 1, maxBytes: 128 * 1024 })
        const file = files.find((item) => item.path === configPath)
        if (file) configs.push({ path: configPath, content: file.content.slice(0, 20_000) })
      } catch { configs.push({ path: configPath, error: 'unreadable' }) }
    }
    return { configs }
  })

  define({
    name: 'inspect_entry_points',
    description: 'Show detected entry points and their role.',
    permission: 'low',
    summary: () => 'inspect entry points',
    schema: {}
  }, async (_args, ctx) => {
    if (!ctx.index) throw toolError('TOOL_INDEX_UNAVAILABLE', 'The project index is not loaded.')
    return { entryPoints: ctx.index.entryPoints }
  })

  define({
    name: 'inspect_tests',
    description: 'Show detected test files and the test command from the project manifest scripts.',
    permission: 'low',
    summary: () => 'inspect tests',
    schema: {}
  }, async (_args, ctx) => {
    if (!ctx.index) throw toolError('TOOL_INDEX_UNAVAILABLE', 'The project index is not loaded.')
    const scripts = ctx.manifests.find((manifest) => manifest.scripts)?.scripts || {}
    return { testPaths: (ctx.index.testPaths || []).slice(0, 40), scripts }
  })

  define({
    name: 'inspect_routes',
    description: 'Show files that likely declare routes/pages.',
    permission: 'low',
    summary: () => 'inspect routes',
    schema: {}
  }, async (_args, ctx) => {
    if (!ctx.index) throw toolError('TOOL_INDEX_UNAVAILABLE', 'The project index is not loaded.')
    return { routeCandidates: (ctx.index.routeCandidates || []).slice(0, 30) }
  })

  define({
    name: 'inspect_api',
    description: 'Show files that likely declare API endpoints or handlers.',
    permission: 'low',
    summary: () => 'inspect api',
    schema: {}
  }, async (_args, ctx) => {
    if (!ctx.index) throw toolError('TOOL_INDEX_UNAVAILABLE', 'The project index is not loaded.')
    return { apiCandidates: (ctx.index.apiCandidates || []).slice(0, 30) }
  })

  // ---- Git tools ----

  define({
    name: 'git_status',
    description: 'Show git status. In worktree mode it reflects the isolated worktree; in copy mode it is read-only against the original project.',
    permission: 'low',
    summary: () => 'git status',
    schema: {}
  }, async (_args, ctx) => {
    const cwd = ctx.adapter.kind === 'worktree' ? ctx.adapter.source : ctx.projectPath
    if (!cwd) throw toolError('TOOL_GIT_UNAVAILABLE', 'git is not available for this workspace mode.')
    const result = await runCommand({ cwd, command: 'git status --porcelain -b', timeoutMs: 20_000, signal: ctx.signal })
    return { output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 8_000), exitCode: result.exitCode, mode: ctx.adapter.kind }
  })

  define({
    name: 'git_diff',
    description: 'Show the full git diff of the task workspace (worktree mode) or a compact summary in copy mode.',
    permission: 'low',
    summary: () => 'git diff',
    schema: {}
  }, async (_args, ctx) => {
    if (ctx.adapter.kind === 'worktree') {
      const { diff } = await ctx.adapter.diff()
      return { diff: diff.slice(0, TOOL_LIMITS.maxDiffChars), mode: 'worktree' }
    }
    const changes = await ctx.adapter.listChanges()
    return { changes: changes.map((change) => ({ action: change.action, path: change.path })), mode: 'copy', note: 'Full diff lives in the workspace diff endpoint.' }
  })

  define({
    name: 'git_log',
    description: 'Show the recent commit history (read-only).',
    permission: 'low',
    summary: () => 'git log',
    schema: {}
  }, async (_args, ctx) => {
    const cwd = ctx.adapter.kind === 'worktree' ? ctx.adapter.source : ctx.projectPath
    if (!cwd) throw toolError('TOOL_GIT_UNAVAILABLE', 'git is not available for this workspace mode.')
    const result = await runCommand({ cwd, command: 'git log --oneline -20', timeoutMs: 20_000, signal: ctx.signal })
    return { output: result.stdout.slice(0, 4_000), exitCode: result.exitCode }
  })

  define({
    name: 'git_branch',
    description: 'List local branches (read-only).',
    permission: 'low',
    summary: () => 'git branch',
    schema: {}
  }, async (_args, ctx) => {
    const cwd = ctx.adapter.kind === 'worktree' ? ctx.adapter.source : ctx.projectPath
    if (!cwd) throw toolError('TOOL_GIT_UNAVAILABLE', 'git is not available for this workspace mode.')
    const result = await runCommand({ cwd, command: 'git branch', timeoutMs: 20_000, signal: ctx.signal })
    return { output: result.stdout.slice(0, 4_000), exitCode: result.exitCode }
  })

  define({
    name: 'git_create_branch',
    description: 'Create a new branch in the task worktree (worktree mode only).',
    permission: 'medium',
    summary: (args) => `git branch ${args?.name || ''}`,
    schema: { name: { type: 'string', required: true, maxLength: 100, noNewlines: true } }
  }, async (args, ctx) => {
    if (ctx.adapter.kind !== 'worktree') throw toolError('TOOL_GIT_UNAVAILABLE', 'Branch operations require worktree mode.')
    if (!/^[a-z0-9][a-z0-9._/-]{1,98}$/i.test(args.name)) throw toolError('TOOL_ARGS_INVALID', 'Branch names must be 2-100 safe characters.')
    const result = await runCommand({ cwd: ctx.adapter.source, command: `git branch ${args.name}`, timeoutMs: 20_000, signal: ctx.signal })
    return { created: result.ok, output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2_000) }
  })

  define({
    name: 'git_checkout',
    description: 'Check out a branch or file revision inside the task worktree (worktree mode only).',
    permission: 'medium',
    summary: (args) => `git checkout ${args?.target || ''}`,
    schema: { target: { type: 'string', required: true, maxLength: 200, noNewlines: true } }
  }, async (args, ctx) => {
    if (ctx.adapter.kind !== 'worktree') throw toolError('TOOL_GIT_UNAVAILABLE', 'Checkout requires worktree mode.')
    if (!/^[a-z0-9][a-z0-9._/-]{1,198}$/i.test(args.target)) throw toolError('TOOL_ARGS_INVALID', 'Checkout targets must be safe branch or file names.')
    const result = await runCommand({ cwd: ctx.adapter.source, command: `git checkout ${args.target}`, timeoutMs: 30_000, signal: ctx.signal })
    return { ok: result.ok, output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2_000) }
  })

  define({
    name: 'git_commit',
    description: 'Commit all current workspace changes on the task branch (worktree mode only). Never pushes.',
    permission: 'medium',
    summary: (args) => `git commit "${(args?.message || '').slice(0, 60)}"`,
    schema: { message: { type: 'string', required: true, maxLength: 500, noNewlines: true } }
  }, async (args, ctx) => {
    if (ctx.adapter.kind !== 'worktree') throw toolError('TOOL_GIT_UNAVAILABLE', 'Commits require worktree mode.')
    const add = await runCommand({ cwd: ctx.adapter.source, command: 'git add -A', timeoutMs: 30_000, signal: ctx.signal })
    if (!add.ok) return { ok: false, output: add.stderr.slice(0, 2_000) }
    const safeMessage = args.message.replace(/["\r\n\u0000]/g, ' ').trim() || 'Agent changes'
    const commit = await runCommand({ cwd: ctx.adapter.source, command: `git -c user.name="PROJECT NEXUS Agent" -c user.email="agent@nexus.local" commit -m "${safeMessage.slice(0, 300)}"`, timeoutMs: 30_000, signal: ctx.signal })
    return { ok: commit.ok, output: `${commit.stdout}\n${commit.stderr}`.trim().slice(0, 2_000) }
  })

  define({
    name: 'git_restore',
    description: 'Restore one workspace file to its task-start state (worktree: HEAD; copy: baseline snapshot).',
    permission: 'medium',
    summary: (args) => `git restore ${args?.path || ''}`,
    schema: { path: { type: 'string', required: true, maxLength: 600 } }
  }, async (args, ctx) => {
    const { relative } = normalizeRelativePath(args.path)
    const result = await ctx.adapter.restoreFile(relative)
    return { path: relative, ...result }
  })

  // ---- Development execution tools ----

  // run_command's effective permission is dynamic: allowlisted development
  // programs are medium (workspace-scoped), anything else is high risk and
  // always requires a live user approval.
  define({
    name: 'run_command',
    description: 'Run one shell command inside the task workspace. Commands are tokenized and spawn without a shell; allowlisted development programs run automatically, anything else requires user approval.',
    permission: 'medium',
    permissionFor: (args) => isProgramAllowed(String(args?.command || '')) ? 'medium' : 'high',
    summary: (args) => `run: ${(args?.command || '').slice(0, 80)}`,
    schema: { command: { type: 'string', required: true, maxLength: 4_096 }, timeoutMs: { type: 'number', min: 1_000, max: 600_000 } }
  }, async (args, ctx) => {
    const result = await runCommand({
      cwd: ctx.adapter.source,
      command: args.command,
      timeoutMs: args.timeoutMs || 120_000,
      signal: ctx.signal,
      allowedPrograms: ctx.allowedPrograms
    })
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      allowedProgram: result.allowed,
      stdout: result.stdout.slice(0, 32_000),
      stderr: result.stderr.slice(0, 32_000),
      durationMs: result.durationMs
    }
  })

  const scriptRunner = (scriptKey, toolName, description) => define({
    name: toolName,
    description,
    permission: 'medium',
    summary: () => toolName,
    schema: { command: { type: 'string', maxLength: 4_096 } }
  }, async (args, ctx) => {
    let command = args.command
    if (!command) {
      const scripts = ctx.manifests.find((manifest) => manifest.scripts)?.scripts || {}
      command = scripts[scriptKey] || scripts[`${scriptKey}:ci`]
      if (!command) {
        return { ok: false, skipped: true, note: `No "${scriptKey}" script found in the project manifest and no explicit command was provided. Scripts: ${JSON.stringify(Object.keys(scripts)).slice(0, 400)}` }
      }
      command = `${ctx.manifests.find((manifest) => manifest.scripts)?.kind === 'package.json' ? 'npm run' : ''} ${scriptKey}`.trim()
    }
    const result = await runCommand({
      cwd: ctx.adapter.source,
      command,
      timeoutMs: 300_000,
      signal: ctx.signal,
      allowedPrograms: ctx.allowedPrograms
    })
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      stdout: result.stdout.slice(0, 32_000),
      stderr: result.stderr.slice(0, 32_000),
      durationMs: result.durationMs,
      command
    }
  })

  scriptRunner('test', 'run_tests', 'Run the project test script (auto-detected from the manifest) or an explicit command inside the task workspace.')
  scriptRunner('build', 'build_project', 'Build the project using the manifest build script or an explicit command inside the task workspace.')
  scriptRunner('lint', 'run_linter', 'Run the project lint script inside the task workspace.')
  scriptRunner('typecheck', 'run_typecheck', 'Run type checking inside the task workspace.')

  define({
    name: 'install_dependencies',
    description: 'Install project dependencies (npm/pnpm/yarn/pip/cargo) inside the task workspace. High risk: requires user approval and may use the network.',
    permission: 'high',
    summary: (args) => `install dependencies (${args?.manager || 'auto'})`,
    schema: { manager: { type: 'string', maxLength: 40, noNewlines: true }, frozenLockfile: { type: 'boolean' } }
  }, async (args, ctx) => {
    const lockFiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'pyproject.toml', 'Cargo.lock']
    const existing = []
    for (const lockFile of lockFiles) {
      try {
        const info = await fs.stat(path.join(ctx.adapter.source, lockFile))
        if (info.isFile()) existing.push(lockFile)
      } catch { /* not present */ }
    }
    let command
    if (args.manager) {
      const allowedManagers = { npm: 'npm ci || npm install', pnpm: 'pnpm install', yarn: 'yarn install', pip: 'pip install -r requirements.txt', cargo: 'cargo fetch' }
      command = allowedManagers[args.manager]
      if (!command) throw toolError('TOOL_ARGS_INVALID', `Unsupported dependency manager: ${args.manager}.`)
    } else if (existing.includes('pnpm-lock.yaml')) command = 'pnpm install'
    else if (existing.includes('yarn.lock')) command = 'yarn install'
    else if (existing.includes('package-lock.json')) command = args.frozenLockfile ? 'npm ci' : 'npm install'
    else if (existing.includes('requirements.txt')) command = 'pip install -r requirements.txt'
    else if (existing.includes('Cargo.lock') || existing.includes('pyproject.toml')) command = existing.includes('Cargo.lock') ? 'cargo fetch' : 'pip install -e .'
    else return { ok: false, skipped: true, note: 'No dependency manifest detected in the workspace.' }
    const result = await runCommand({ cwd: ctx.adapter.source, command, timeoutMs: 420_000, signal: ctx.signal, allowedPrograms: ctx.allowedPrograms })
    return { ok: result.ok, exitCode: result.exitCode, command, stdout: result.stdout.slice(0, 16_000), stderr: result.stderr.slice(0, 16_000), durationMs: result.durationMs, manifests: existing }
  })

  // ---- Helper tools ----

  define({
    name: 'report_progress',
    description: 'Report visible progress to the user (one sentence). Use between phases.',
    permission: 'low',
    summary: (args) => `progress: ${(args?.message || '').slice(0, 60)}`,
    schema: { message: { type: 'string', required: true, maxLength: 500 } }
  }, async (args) => ({ reported: true, message: String(args.message).slice(0, 500) }))

  define({
    name: 'request_approval',
    description: 'Ask the user to approve a specific action that is outside the normal policy. The task pauses until the user answers.',
    permission: 'medium',
    summary: (args) => `approval request: ${(args?.reason || '').slice(0, 60)}`,
    schema: { reason: { type: 'string', required: true, maxLength: 1_000 }, action: { type: 'string', maxLength: 2_000 } }
  }, async (args, ctx) => {
    if (!ctx.requestApproval) throw toolError('TOOL_APPROVAL_UNAVAILABLE', 'No approval channel is configured for this task.')
    return await ctx.requestApproval({ tool: 'request_approval', reason: String(args.reason).slice(0, 1_000), action: String(args.action || '').slice(0, 2_000) })
  })

  define({
    name: 'save_checkpoint',
    description: 'Persist a short checkpoint note (current understanding, next step) so the task can be resumed coherently.',
    permission: 'low',
    summary: (args) => `checkpoint: ${(args?.note || '').slice(0, 60)}`,
    schema: { note: { type: 'string', required: true, maxLength: 2_000 } }
  }, async (args) => ({ saved: true, note: String(args.note).slice(0, 2_000) }))

  return tools
}

const toolDefinitions = defineTools()
const toolByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]))

export function listTools() {
  return toolDefinitions.map(({ name, description, permission, schema, summary }) => ({ name, description, permission, schema, summary }))
}

export function getTool(name) {
  return toolByName.get(String(name || '')) || null
}

export async function executeTool(name, args, ctx) {
  const tool = getTool(name)
  if (!tool) throw toolError('TOOL_UNKNOWN', `Unknown tool: ${name}.`)
  const validated = validateArgs(args, tool.schema, tool.name)
  const result = await tool.handler(validated, ctx)
  return result
}

export { TOOL_LIMITS, createToolContext, normalizeRelativePath, validateArgs, syntaxSanityWarning }
