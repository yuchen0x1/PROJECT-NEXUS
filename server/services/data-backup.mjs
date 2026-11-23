// Backup and restore for both durable stores. SQLite is checked with
// `PRAGMA integrity_check`, the WAL is checkpointed before copying, every
// manifest is SHA-256 hashed, and a restore is staged and verified before it
// replaces live data. A failed restore never destroys the current state.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const BACKUP_SCHEMA_VERSION = 1

function hashFile(file) {
  return fs.readFile(file).then((bytes) => crypto.createHash('sha256').update(bytes).digest('hex'))
}

async function exists(file) {
  try { await fs.access(file); return true } catch { return false }
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function backupFilePath(directory, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw Object.assign(new Error('Backup manifest contains an invalid file path.'), { code: 'BACKUP_PATH_INVALID' })
  }
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw Object.assign(new Error('Backup manifest contains an unsafe file path.'), { code: 'BACKUP_PATH_INVALID' })
  }
  const root = path.resolve(directory)
  const target = path.resolve(root, normalized)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw Object.assign(new Error('Backup manifest escapes its directory.'), { code: 'BACKUP_PATH_INVALID' })
  }
  return target
}

export async function sqliteIntegrity(db) {
  const rows = db.prepare('PRAGMA integrity_check').all()
  const values = rows.map((row) => Object.values(row)[0]).filter((value) => value !== undefined)
  return { ok: values.length === 1 && values[0] === 'ok', messages: values }
}

/**
 * Create a consistent backup directory. `dbHandle` (optional) is the live
 * DatabaseSync instance; when supplied, its WAL is checkpointed first so the
 * copied file contains every committed transaction.
 */
export async function createDataBackup({
  dataDir, stateFile = null, autonomyDbFile = null, backupRoot = null,
  label = 'manual', db = null, keep = 30, now = () => new Date()
} = {}) {
  if (!dataDir) throw Object.assign(new Error('A data directory is required.'), { code: 'BACKUP_DATA_DIR_REQUIRED' })
  const root = path.resolve(backupRoot || path.join(dataDir, 'backups'))
  const createdAt = now()
  const id = `nexus-backup-${stamp(createdAt)}-${crypto.randomUUID().slice(0, 8)}`
  const target = path.join(root, id)
  await fs.mkdir(target, { recursive: true, mode: 0o700 })
  const files = []
  const state = stateFile ? path.resolve(stateFile) : path.join(dataDir, 'state.json')
  if (await exists(state)) {
    const destination = path.join(target, 'state.json')
    await fs.copyFile(state, destination)
    const sha256 = await hashFile(destination)
    // A copied state file is only trusted if it parses as JSON.
    JSON.parse(await fs.readFile(destination, 'utf8'))
    files.push({ kind: 'state', source: path.basename(state), path: 'state.json', bytes: (await fs.stat(destination)).size, sha256 })
  }
  let integrity = null
  if (autonomyDbFile && await exists(autonomyDbFile)) {
    if (db) {
      const check = await sqliteIntegrity(db)
      if (!check.ok) throw Object.assign(new Error(`SQLite integrity_check failed: ${check.messages.join('; ')}`), { code: 'BACKUP_SQLITE_CORRUPT' })
      integrity = check
      // TRUNCATE keeps the main database complete while still allowing WAL
      // readers; the copy below is then taken from one committed snapshot.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    }
    const destination = path.join(target, 'autonomy.db')
    await fs.copyFile(autonomyDbFile, destination)
    files.push({ kind: 'autonomy-db', source: path.basename(autonomyDbFile), path: 'autonomy.db', bytes: (await fs.stat(destination)).size, sha256: await hashFile(destination) })
  }
  const manifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION, id, label: String(label).slice(0, 80),
    createdAt: createdAt.toISOString(), files, sqliteIntegrity: integrity,
    retention: Math.max(1, Number(keep) || 30)
  }
  const manifestFile = path.join(target, 'manifest.json')
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 })
  const checksums = files.map((file) => `${file.sha256}  ${file.path}`).join('\n')
  await fs.writeFile(path.join(target, 'SHA256SUMS.txt'), `${checksums}\n`, { mode: 0o600 })
  await pruneBackups(root, manifest.retention)
  return { id, directory: target, manifest, manifestSha256: await hashFile(manifestFile) }
}

export async function pruneBackups(root, keep = 30) {
  const entries = (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && /^nexus-backup-/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
    await fs.rm(path.join(root, name), { recursive: true, force: true })
  }
  return { removed: Math.max(0, entries.length - keep), kept: Math.min(entries.length, keep) }
}

export async function verifyDataBackup(directory) {
  const manifestFile = path.join(directory, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION) throw Object.assign(new Error('Unsupported backup manifest version.'), { code: 'BACKUP_VERSION_UNSUPPORTED' })
  for (const file of manifest.files || []) {
    if (!file || !['state', 'autonomy-db'].includes(file.kind)) throw Object.assign(new Error('Backup manifest contains an unsupported file kind.'), { code: 'BACKUP_FILE_INVALID' })
    const full = backupFilePath(directory, file.path)
    if (!await exists(full)) throw Object.assign(new Error(`Backup is missing ${file.path}.`), { code: 'BACKUP_FILE_MISSING' })
    const info = await fs.lstat(full)
    if (!info.isFile()) throw Object.assign(new Error(`Backup entry ${file.path} is not a regular file.`), { code: 'BACKUP_FILE_INVALID' })
    const actual = await hashFile(full)
    if (actual !== file.sha256) throw Object.assign(new Error(`Backup checksum mismatch for ${file.path}.`), { code: 'BACKUP_CHECKSUM_MISMATCH' })
    if (Number.isSafeInteger(file.bytes) && info.size !== file.bytes) throw Object.assign(new Error(`Backup size mismatch for ${file.path}.`), { code: 'BACKUP_SIZE_MISMATCH' })
  }
  return { valid: true, manifest, directory, manifestSha256: await hashFile(manifestFile) }
}

/**
 * Restore after a verified staging pass. The live file is never overwritten
 * until the staged copy passes JSON parsing and, for SQLite, integrity_check.
 */
export async function restoreDataBackup({
  directory, dataDir, stateFile = null, autonomyDbFile = null,
  createDatabase = null, now = () => new Date()
} = {}) {
  if (!directory || !dataDir) throw Object.assign(new Error('Backup directory and data directory are required.'), { code: 'RESTORE_ARGUMENTS_REQUIRED' })
  const verified = await verifyDataBackup(directory)
  const staging = path.join(path.resolve(dataDir), `.restore-${crypto.randomUUID()}`)
  await fs.mkdir(staging, { recursive: true, mode: 0o700 })
  const staged = []
  try {
    for (const file of verified.manifest.files || []) {
      if (!['state', 'autonomy-db'].includes(file.kind)) continue
      if (file.kind === 'autonomy-db' && !autonomyDbFile) continue
      const source = backupFilePath(directory, file.path)
      const destination = backupFilePath(staging, file.path)
      await fs.copyFile(source, destination)
      if (file.kind === 'state') JSON.parse(await fs.readFile(destination, 'utf8'))
      if (file.kind === 'autonomy-db') {
        if (typeof createDatabase !== 'function') throw Object.assign(new Error('A SQLite verifier is required to restore the autonomy database.'), { code: 'RESTORE_SQLITE_VERIFIER_REQUIRED' })
        const db = createDatabase(destination)
        try {
          const check = await sqliteIntegrity(db)
          if (!check.ok) throw Object.assign(new Error(`Staged SQLite integrity_check failed: ${check.messages.join('; ')}`), { code: 'RESTORE_SQLITE_CORRUPT' })
        } finally { db.close?.() }
      }
      staged.push({ file, destination })
    }
    if (!staged.length) throw Object.assign(new Error('The backup contains no restorable files for this target.'), { code: 'RESTORE_NO_APPLICABLE_FILES' })
    const stateTarget = stateFile ? path.resolve(stateFile) : path.join(dataDir, 'state.json')
    const dbTarget = autonomyDbFile ? path.resolve(autonomyDbFile) : null
    const rollback = path.join(staging, '.rollback')
    await fs.mkdir(rollback, { recursive: true })
    for (const { file } of staged) {
      const live = file.kind === 'state' ? stateTarget : file.kind === 'autonomy-db' ? dbTarget : null
      if (!live) continue
      if (await exists(live)) await fs.copyFile(live, path.join(rollback, file.path))
    }
    for (const { file, destination } of staged) {
      const live = file.kind === 'state' ? stateTarget : file.kind === 'autonomy-db' ? dbTarget : null
      if (!live) continue
      await fs.mkdir(path.dirname(live), { recursive: true })
      await fs.copyFile(destination, live)
      if (await hashFile(live) !== file.sha256) throw Object.assign(new Error(`Restored file failed verification: ${file.path}`), { code: 'RESTORE_WRITE_MISMATCH' })
    }
    return {
      restored: true, backupId: verified.manifest.id, manifest: verified.manifest,
      restoredAt: now().toISOString()
    }
  } catch (error) {
    const stateTarget = stateFile ? path.resolve(stateFile) : path.join(dataDir, 'state.json')
    const dbTarget = autonomyDbFile ? path.resolve(autonomyDbFile) : null
    const rollback = path.join(staging, '.rollback')
    for (const { file } of staged) {
      const live = file.kind === 'state' ? stateTarget : file.kind === 'autonomy-db' ? dbTarget : null
      if (!live) continue
      const previous = path.join(rollback, file.path)
      if (await exists(previous)) await fs.copyFile(previous, live).catch(() => {})
      else await fs.rm(live, { force: true }).catch(() => {})
    }
    throw error
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

export async function listDataBackups(backupRoot) {
  const root = path.resolve(backupRoot)
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const result = []
  for (const entry of entries.filter((item) => item.isDirectory() && /^nexus-backup-/.test(item.name)).sort().reverse()) {
    const directory = path.join(root, entry.name)
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'))
      result.push({ id: manifest.id, directory, label: manifest.label, createdAt: manifest.createdAt, files: manifest.files, sqliteIntegrity: manifest.sqliteIntegrity })
    } catch { /* ignore incomplete backups; never display them as valid */ }
  }
  return result
}
