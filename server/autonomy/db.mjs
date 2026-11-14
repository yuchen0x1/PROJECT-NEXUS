// Durable local persistence for the Autonomy Runtime.
//
// Primary backend: node:sqlite (verified available on Node v22.22.2 without a
// launch flag). Fallback: an atomically-replaced JSON document with exactly the
// same interface, so an Electron build whose embedded Node lacks node:sqlite
// still runs instead of crashing the whole workstation.
//
// The store is intentionally a "collection of JSON records" abstraction rather
// than raw SQL scattered across engines: that keeps every engine testable on an
// in-memory database and makes schema migration a single, inspectable step.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const AUTONOMY_SCHEMA_VERSION = 2

let DatabaseSync = null
try {
  ({ DatabaseSync } = await import('node:sqlite'))
} catch {
  DatabaseSync = null
}

export const SQLITE_AVAILABLE = Boolean(DatabaseSync)

const MIGRATIONS = [
  {
    version: 1,
    description: 'initial autonomy schema: records, meta, append-only event log',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS records (
          collection TEXT NOT NULL,
          id TEXT NOT NULL,
          data TEXT NOT NULL,
          seq INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (collection, id)
        );
        CREATE INDEX IF NOT EXISTS records_collection_seq ON records(collection, seq);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `)
    }
  },
  {
    version: 2,
    description: 'add typed indexes and a monotonic audit sequence',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_seq (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS records_collection_updated ON records(collection, updated_at);
      `)
    }
  }
]

const COLLECTIONS = Object.freeze([
  'repositories', 'sync_cursors', 'events', 'issues', 'tasks', 'task_events',
  'adapters', 'agent_sessions', 'peer_projects', 'porting_proposals',
  'verification_reports', 'releases', 'audit_log', 'settings', 'findings',
  'monitor_runs'
])

const APPEND_ONLY = new Set(['audit_log', 'task_events'])

function now() { return new Date().toISOString() }

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

class SqliteStore {
  constructor(file) {
    this.backend = 'sqlite'
    this.file = file
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    // Migrations create the tables; prepared statements must come afterwards.
    this.migrate()
    this._prepare()
  }

  _prepare() {
    this.statements = {
      get: this.db.prepare('SELECT data FROM records WHERE collection = ? AND id = ?'),
      put: this.db.prepare(`INSERT INTO records (collection, id, data, seq, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
      maxSeq: this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM records WHERE collection = ?'),
      all: this.db.prepare('SELECT id, data, seq, created_at, updated_at FROM records WHERE collection = ? ORDER BY seq ASC'),
      del: this.db.prepare('DELETE FROM records WHERE collection = ? AND id = ?'),
      clear: this.db.prepare('DELETE FROM records WHERE collection = ?'),
      count: this.db.prepare('SELECT COUNT(*) AS value FROM records WHERE collection = ?'),
      metaGet: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      metaSet: this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    }
  }

  migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion')
    let current = Number(row?.value || 0)
    for (const migration of MIGRATIONS) {
      if (migration.version > current) {
        migration.up(this.db)
        this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('schemaVersion', String(migration.version))
        current = migration.version
      }
    }
    this.schemaVersion = current
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run('createdAt', now())
  }

  get(collection, id) {
    const row = this.statements.get.get(collection, String(id))
    return row ? JSON.parse(row.data) : null
  }

  put(collection, id, value) {
    if (!COLLECTIONS.includes(collection)) throw Object.assign(new Error(`Unknown collection: ${collection}`), { code: 'AUTONOMY_UNKNOWN_COLLECTION' })
    const key = String(id)
    const existing = this.statements.get.get(collection, key)
    const seq = existing ? undefined : Number(this.statements.maxSeq.get(collection)?.value || 0) + 1
    const at = now()
    const document = clone({ ...value, id: key })
    if (existing) {
      this.db.prepare('UPDATE records SET data = ?, updated_at = ? WHERE collection = ? AND id = ?')
        .run(JSON.stringify(document), at, collection, key)
    } else {
      this.statements.put.run(collection, key, JSON.stringify(document), seq, at, at)
    }
    return document
  }

  patch(collection, id, patch) {
    const current = this.get(collection, id)
    if (!current) return null
    return this.put(collection, id, { ...current, ...patch })
  }

  append(collection, value) {
    const id = `${collection}_${crypto.randomUUID()}`
    return this.put(collection, id, { ...value, id, createdAt: value.createdAt || now() })
  }

  delete(collection, id) {
    if (APPEND_ONLY.has(collection)) throw Object.assign(new Error(`${collection} is append-only`), { code: 'AUTONOMY_APPEND_ONLY' })
    return this.statements.del.run(collection, String(id)).changes > 0
  }

  list(collection, { filter = null, limit = Infinity, order = 'asc' } = {}) {
    const rows = this.statements.all.all(collection)
    let items = rows.map((row) => ({ ...JSON.parse(row.data), _seq: row.seq, _createdAt: row.created_at }))
    if (typeof filter === 'function') items = items.filter((item) => filter(item))
    if (order === 'desc') items.reverse()
    if (Number.isFinite(limit)) items = items.slice(0, limit)
    return items
  }

  count(collection, filter = null) {
    if (!filter) return Number(this.statements.count.get(collection)?.value || 0)
    return this.list(collection, { filter }).length
  }

  clear(collection) {
    if (APPEND_ONLY.has(collection)) throw Object.assign(new Error(`${collection} is append-only`), { code: 'AUTONOMY_APPEND_ONLY' })
    this.statements.clear.run(collection)
  }

  getSetting(key) {
    const row = this.statements.metaGet.get(String(key))
    if (!row) return null
    try { return JSON.parse(row.value) } catch { return row.value }
  }

  setSetting(key, value) {
    this.statements.metaSet.run(String(key), JSON.stringify(value))
    return value
  }

  audit(actor, action, target, detail = {}) {
    const record = {
      at: now(), actor: String(actor).slice(0, 80), action: String(action).slice(0, 120),
      target: String(target).slice(0, 200), detail: clone(detail)
    }
    this.db.prepare('INSERT INTO audit_seq (at) VALUES (?)').run(record.at)
    return this.append('audit_log', record)
  }

  stats() {
    const result = { backend: this.backend, schemaVersion: this.schemaVersion, collections: {} }
    for (const collection of COLLECTIONS) result.collections[collection] = this.count(collection)
    return result
  }

  close() { this.db.close() }
}

class JsonStore {
  constructor(file) {
    this.backend = 'json-fallback'
    this.file = path.resolve(file)
    this.documents = new Map()
    this.meta = {}
    this.seq = 0
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        this.meta = parsed.meta || {}
        this.seq = Number(parsed.seq || 0)
        for (const [key, value] of Object.entries(parsed.records || {})) this.documents.set(key, clone(value))
      } catch (error) {
        throw Object.assign(new Error(`Autonomy JSON store is corrupt; refusing to replace it: ${error.message}`), {
          code: 'AUTONOMY_STORE_CORRUPT'
        })
      }
    }
    this.schemaVersion = Number(this.meta.schemaVersion || 0)
    for (const migration of MIGRATIONS) {
      if (migration.version > this.schemaVersion) { this.schemaVersion = migration.version }
    }
    this.meta.schemaVersion = this.schemaVersion
    this.meta.createdAt ||= now()
    this._flush()
  }

  _flush() {
    const serializable = Object.fromEntries(this.documents)
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ meta: this.meta, seq: this.seq, records: serializable }, null, 2), { mode: 0o600 })
    try {
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`)
    } catch { /* a locked backup must not lose the live write */ }
    fs.renameSync(temporary, this.file)
  }

  get(collection, id) {
    const value = this.documents.get(`${collection}/${id}`)
    return value ? clone(value) : null
  }

  put(collection, id, value) {
    if (!COLLECTIONS.includes(collection)) throw Object.assign(new Error(`Unknown collection: ${collection}`), { code: 'AUTONOMY_UNKNOWN_COLLECTION' })
    const key = `${collection}/${String(id)}`
    const previous = this.documents.get(key)
    const document = clone({ ...value, id: String(id) })
    document._seq = previous?._seq ?? ++this.seq
    document._createdAt = previous?._createdAt ?? now()
    this.documents.set(key, document)
    this._flush()
    const { _seq, _createdAt, ...publicValue } = document
    return { ...publicValue, _seq, _createdAt }
  }

  patch(collection, id, patch) {
    const current = this.get(collection, id)
    if (!current) return null
    return this.put(collection, id, { ...current, ...patch })
  }

  append(collection, value) {
    const id = `${collection}_${crypto.randomUUID()}`
    return this.put(collection, id, { ...value, id, createdAt: value.createdAt || now() })
  }

  delete(collection, id) {
    if (APPEND_ONLY.has(collection)) throw Object.assign(new Error(`${collection} is append-only`), { code: 'AUTONOMY_APPEND_ONLY' })
    const existed = this.documents.delete(`${collection}/${id}`)
    if (existed) this._flush()
    return existed
  }

  list(collection, { filter = null, limit = Infinity, order = 'asc' } = {}) {
    let items = [...this.documents.entries()]
      .filter(([key]) => key.startsWith(`${collection}/`))
      .map(([, value]) => clone(value))
      .sort((a, b) => (a._seq || 0) - (b._seq || 0))
    if (order === 'desc') items.reverse()
    if (typeof filter === 'function') items = items.filter(filter)
    if (Number.isFinite(limit)) items = items.slice(0, limit)
    return items
  }

  count(collection, filter = null) {
    return this.list(collection, filter ? { filter } : {}).length
  }

  clear(collection) {
    if (APPEND_ONLY.has(collection)) throw Object.assign(new Error(`${collection} is append-only`), { code: 'AUTONOMY_APPEND_ONLY' })
    for (const key of this.documents.keys()) if (key.startsWith(`${collection}/`)) this.documents.delete(key)
    this._flush()
  }

  getSetting(key) { return this.meta[String(key)] ?? null }

  setSetting(key, value) { this.meta[String(key)] = value; this._flush(); return value }

  audit(actor, action, target, detail = {}) {
    return this.append('audit_log', {
      at: now(), actor: String(actor).slice(0, 80), action: String(action).slice(0, 120),
      target: String(target).slice(0, 200), detail: clone(detail)
    })
  }

  stats() {
    const result = { backend: this.backend, schemaVersion: this.schemaVersion, collections: {} }
    for (const collection of COLLECTIONS) result.collections[collection] = this.count(collection)
    return result
  }

  close() { this._flush() }
}

/**
 * Open the autonomy store. `file = ':memory:'` gives a fast isolated store for
 * unit tests; the production default is data/autonomy.db next to state.json.
 */
export function openAutonomyStore({ file = ':memory:', forceBackend = null } = {}) {
  const useSqlite = forceBackend === 'json' ? false : forceBackend === 'sqlite' ? true : SQLITE_AVAILABLE
  if (useSqlite && !DatabaseSync) {
    throw Object.assign(new Error('node:sqlite is unavailable and the SQLite backend was forced.'), {
      code: 'AUTONOMY_SQLITE_UNAVAILABLE'
    })
  }
  if (useSqlite) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    return new SqliteStore(file)
  }
  if (file === ':memory:') {
    // A file is still required by the fallback; keep it out of the repo.
    return new JsonStore(path.join(process.cwd(), '.nexus-autonomy-test-store.json'))
  }
  return new JsonStore(file)
}

export function defaultAutonomyDbFile(dataDir) {
  return path.join(dataDir, 'autonomy.db')
}

export const AUTONOMY_COLLECTIONS = COLLECTIONS
export const AUTONOMY_MIGRATIONS = MIGRATIONS.map(({ version, description }) => ({ version, description }))
