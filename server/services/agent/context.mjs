import fs from 'node:fs/promises'
import path from 'node:path'
import { redactSecrets } from '../ai-provider.mjs'

// Task context selection. Chooses a bounded, relevant file set for an agent
// task instead of dumping the repository: manifests first, then prompt-keyword
// matches, symbol hits, import neighbors, and finally structural files, all
// under a byte budget with per-file windows and secret redaction.

export const CONTEXT_DEFAULTS = Object.freeze({
  budgetBytes: 120 * 1024,
  maxFiles: 24,
  maxFileWindowBytes: 24 * 1024,
  headBytes: 16 * 1024,
  tailBytes: 6 * 1024
})

const PRIORITY_MANIFEST = 0
const PRIORITY_KEYWORD = 1
const PRIORITY_SYMBOL = 2
const PRIORITY_IMPORT_NEIGHBOR = 3
const PRIORITY_STRUCTURAL = 4

function contextError(code, message) {
  return Object.assign(new Error(message), { code })
}

function tokenizePrompt(prompt) {
  const raw = String(prompt || '')
  const tokens = new Set()
  for (const match of raw.matchAll(/[A-Za-z_$][\w$.-]{2,48}/g)) {
    const token = match[0].toLowerCase()
    tokens.add(token)
    if (token.includes('.') && token.split('.').every((part) => part.length >= 2)) tokens.add(token)
    for (const part of token.split(/[._-]+/)) if (part.length >= 4) tokens.add(part)
  }
  return [...tokens].slice(0, 60)
}

function isExcludedFromContext(filePath) {
  const segments = filePath.split('/')
  return segments.some((segment) => ['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', 'vendor', '__pycache__'].includes(segment.toLowerCase()))
}

function scoreFileForPrompt(file, tokens) {
  const lowerPath = file.path.toLowerCase()
  let score = 0
  const base = path.posix.basename(lowerPath)
  for (const token of tokens) {
    if (lowerPath.includes(token)) score += token.length >= 6 ? 6 : 3
    if (base.includes(token)) score += 4
  }
  return score
}

export function selectTaskContext({ index, prompt, budgetBytes = CONTEXT_DEFAULTS.budgetBytes, maxFiles = CONTEXT_DEFAULTS.maxFiles } = {}) {
  if (!index || !Array.isArray(index.files)) throw contextError('CONTEXT_INDEX_INVALID', 'A project index is required for context selection.')
  const tokens = tokenizePrompt(prompt)
  const candidates = new Map()

  const addCandidate = (filePath, priority, reason) => {
    if (!filePath || candidates.has(filePath)) return
    const file = index.files.find((item) => item.path === filePath)
    if (!file || isExcludedFromContext(filePath)) return
    candidates.set(filePath, { path: filePath, size: file.size, priority, reason })
  }

  for (const manifest of index.manifests || []) addCandidate(manifest.path, PRIORITY_MANIFEST, 'project manifest/config')
  if (tokens.length) {
    for (const file of index.files) {
      if (candidates.size >= maxFiles * 4) break
      const score = scoreFileForPrompt(file, tokens)
      if (score >= 6) addCandidate(file.path, PRIORITY_KEYWORD, `matches task keywords (score ${score})`)
    }
    const search = searchSymbols(index, tokens)
    for (const filePath of search) addCandidate(filePath, PRIORITY_SYMBOL, 'matches indexed symbols')
  }
  for (const entry of index.entryPoints || []) addCandidate(entry.path, PRIORITY_STRUCTURAL, `entry point (${entry.reason})`)
  for (const testPath of (index.testPaths || []).slice(0, 6)) addCandidate(testPath, PRIORITY_STRUCTURAL, 'test file')
  // Import neighbors of keyword/symbol matches deepen the context when budget allows.
  const matched = [...candidates.keys()]
  for (const filePath of matched) {
    const imports = index.imports?.[filePath] || []
    for (const target of imports) {
      const resolved = resolveImportPath(index, filePath, target)
      if (resolved) addCandidate(resolved, PRIORITY_IMPORT_NEIGHBOR, `imported by ${filePath}`)
    }
    for (const [otherPath, otherImports] of Object.entries(index.imports || {})) {
      if (otherImports.some((target) => resolveImportPath(index, otherPath, target) === filePath)) {
        addCandidate(otherPath, PRIORITY_IMPORT_NEIGHBOR, `imports ${filePath}`)
      }
    }
  }

  const ordered = [...candidates.values()].sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path, 'en'))
  const selected = []
  let remaining = Math.max(1024, budgetBytes)
  let remainingFiles = maxFiles
  for (const candidate of ordered) {
    if (remainingFiles <= 0) break
    const cost = Math.min(candidate.size, CONTEXT_DEFAULTS.maxFileWindowBytes)
    if (cost > remaining) continue
    remaining -= cost
    remainingFiles -= 1
    selected.push(candidate)
  }
  return { files: selected.map(({ path: filePath, reason, priority }) => ({ path: filePath, reason, priority })), budgetBytes, usedBytesEstimate: budgetBytes - remaining, promptTokens: tokens }
}

function searchSymbols(index, tokens) {
  const hits = []
  for (const [filePath, symbols] of Object.entries(index.symbols || {})) {
    for (const symbol of symbols) {
      const lower = symbol.name.toLowerCase()
      if (tokens.some((token) => token === lower || (token.length >= 4 && lower.includes(token)))) {
        hits.push(filePath)
        break
      }
    }
  }
  return hits.slice(0, 12)
}

function resolveImportPath(index, fromPath, importTarget) {
  if (!importTarget || importTarget.startsWith('node:') || !importTarget.startsWith('.')) return null
  const fromDirectory = path.posix.dirname(fromPath)
  const base = path.posix.normalize(path.posix.join(fromDirectory, importTarget))
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']
  for (const extension of extensions) {
    const candidate = `${base}${extension}`
    if ((index.files || []).some((file) => file.path === candidate)) return candidate
  }
  return null
}

export async function readContextFileContent(sourceRoot, relativePath, { redact = true } = {}) {
  const segments = String(relativePath || '').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/.test(segment))) {
    throw contextError('CONTEXT_PATH_INVALID', `Context path is invalid: ${JSON.stringify(String(relativePath || ''))}`)
  }
  const absolute = path.join(path.resolve(sourceRoot), ...segments)
  const canonicalRoot = path.resolve(sourceRoot)
  if (!absolute.startsWith(canonicalRoot + path.sep) && absolute !== canonicalRoot) {
    throw contextError('CONTEXT_PATH_ESCAPE', 'Context path escaped the project root.')
  }
  let bytes
  try { bytes = await fs.readFile(absolute) }
  catch (error) {
    if (error.code === 'ENOENT') throw contextError('CONTEXT_FILE_MISSING', `Context file no longer exists: ${relativePath}`)
    throw error
  }
  let content
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return { path: relativePath, content: null, truncated: false, binary: true } }
  let truncated = false
  if (bytes.byteLength > CONTEXT_DEFAULTS.maxFileWindowBytes) {
    const head = content.slice(0, Math.floor(CONTEXT_DEFAULTS.headBytes / 2))
    const tail = content.slice(-Math.floor(CONTEXT_DEFAULTS.tailBytes / 2))
    content = `${head}\n... [file truncated for context window: ${bytes.byteLength} bytes total] ...\n${tail}`
    truncated = true
  }
  if (redact) content = redactSecrets(content)
  return { path: relativePath, content, truncated, binary: false }
}

export async function buildTaskContextBundle({ sourceRoot, index, prompt, budgetBytes, maxFiles, redact = true } = {}) {
  const selection = selectTaskContext({ index, prompt, budgetBytes, maxFiles })
  const files = []
  let usedBytes = 0
  for (const { path: filePath } of selection.files) {
    try {
      const file = await readContextFileContent(sourceRoot, filePath, { redact })
      if (file.binary) { files.push({ path: filePath, reason: 'binary content skipped', content: null, truncated: false }); continue }
      usedBytes += Buffer.byteLength(file.content, 'utf8')
      files.push({ path: filePath, content: file.content, truncated: file.truncated })
    } catch (error) {
      if (['CONTEXT_PATH_INVALID', 'CONTEXT_PATH_ESCAPE'].includes(error.code)) throw error
      files.push({ path: filePath, content: null, truncated: false, error: String(error.message).slice(0, 200) })
    }
  }
  return {
    files,
    usedBytes,
    budgetBytes: selection.budgetBytes,
    disclosedPaths: files.filter((file) => file.content !== null).map((file) => file.path)
  }
}
