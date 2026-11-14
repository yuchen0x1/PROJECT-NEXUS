import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openAutonomyStore, AUTONOMY_SCHEMA_VERSION, SQLITE_AVAILABLE, AUTONOMY_MIGRATIONS } from '../../server/autonomy/db.mjs'

const dirs = []
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-autonomy-store-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 40 })))
})

describe('autonomy durable store', () => {
  it('opens the SQLite backend with the current schema and migrations', () => {
    const store = openAutonomyStore({ file: ':memory:' })
    expect(store.backend).toBe('sqlite')
    expect(store.schemaVersion).toBe(AUTONOMY_SCHEMA_VERSION)
    expect(AUTONOMY_MIGRATIONS).toHaveLength(2)
    expect(SQLITE_AVAILABLE).toBe(true)
    expect(store.stats().collections.repositories).toBe(0)
    store.close()
  })

  it('supports CRUD, ordered listing, filtering and counting', () => {
    const store = openAutonomyStore({ file: ':memory:' })
    store.put('repositories', 'r1', { fullName: 'acme/a' })
    store.put('repositories', 'r2', { fullName: 'acme/b' })
    expect(store.get('repositories', 'r1')).toMatchObject({ id: 'r1', fullName: 'acme/a' })
    expect(store.patch('repositories', 'r1', { enabled: false })).toMatchObject({ fullName: 'acme/a', enabled: false })
    expect(store.count('repositories')).toBe(2)
    expect(store.list('repositories', { filter: (item) => item.enabled === false })).toHaveLength(1)
    expect(store.list('repositories', { order: 'desc' })[0].id).toBe('r2')
    expect(store.list('repositories', { limit: 1 })).toHaveLength(1)
    expect(store.append('events', { kind: 'issues' })).toHaveProperty('id')
    expect(store.delete('repositories', 'r1')).toBe(true)
    expect(store.get('repositories', 'r1')).toBeNull()
    store.close()
  })

  it('keeps audit_log and task_events append-only', () => {
    const store = openAutonomyStore({ file: ':memory:' })
    const entry = store.audit('monitor', 'sync', 'acme/a', { events: 2 })
    expect(entry).toMatchObject({ actor: 'monitor', action: 'sync', target: 'acme/a' })
    expect(store.count('audit_log')).toBe(1)
    expect(() => store.delete('audit_log', entry.id)).toThrowError(/append-only/)
    expect(() => store.clear('task_events')).toThrowError(/append-only/)
    store.close()
  })

  it('persists settings and data across a real reopen of the database file', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'autonomy.db')
    const first = openAutonomyStore({ file })
    first.setSetting('autonomySettings', { enabled: true, maxConcurrent: 3 })
    first.put('repositories', 'r1', { fullName: 'acme/persisted' })
    first.append('audit_log', { action: 'created' })
    first.close()

    const second = openAutonomyStore({ file })
    expect(second.get('repositories', 'r1')).toMatchObject({ fullName: 'acme/persisted' })
    expect(second.getSetting('autonomySettings')).toMatchObject({ maxConcurrent: 3 })
    expect(second.count('audit_log')).toBe(1)
    expect(second.schemaVersion).toBe(AUTONOMY_SCHEMA_VERSION)
    second.close()
  })

  it('falls back to an atomic JSON store with the same interface', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'fallback.json')
    const first = openAutonomyStore({ file, forceBackend: 'json' })
    expect(first.backend).toBe('json-fallback')
    first.put('tasks', 't1', { status: 'QUEUED' })
    first.audit('control', 'start', 'global')
    first.close()

    const second = openAutonomyStore({ file, forceBackend: 'json' })
    expect(second.get('tasks', 't1')).toMatchObject({ status: 'QUEUED' })
    expect(second.count('audit_log')).toBe(1)
    expect(second.stats().backend).toBe('json-fallback')
    second.close()
  })

  it('refuses to silently replace a corrupt fallback document', async () => {
    const dir = await tempDir()
    const file = path.join(dir, 'corrupt.json')
    await fs.writeFile(file, '{broken', 'utf8')
    expect(() => openAutonomyStore({ file, forceBackend: 'json' })).toThrowError(/corrupt/)
    expect(await fs.readFile(file, 'utf8')).toBe('{broken')
  })
})
