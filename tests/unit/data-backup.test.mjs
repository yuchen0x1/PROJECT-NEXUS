import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createDataBackup, restoreDataBackup, verifyDataBackup } from '../../server/services/data-backup.mjs'
import { openAutonomyStore } from '../../server/autonomy/db.mjs'
import { startAutonomyBackupScheduler } from '../../server/autonomy/api.mjs'

const dirs = []
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-backup-test-'))
  dirs.push(dir)
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ schemaVersion: 4, projects: [{ id: 'before' }] }), 'utf8')
  const store = openAutonomyStore({ file: path.join(dir, 'autonomy.db') })
  store.put('tasks', 'task-1', { status: 'QUEUED' })
  return { dir, store }
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }))) })

describe('data backup and restore', () => {
  it('creates checksummed state + SQLite backup and verifies it', async () => {
    const { dir, store } = await fixture()
    const result = await createDataBackup({ dataDir: dir, stateFile: path.join(dir, 'state.json'), autonomyDbFile: path.join(dir, 'autonomy.db'), db: store.databaseHandle(), now: () => new Date('2026-11-23T00:00:00Z') })
    expect(result.manifest.files.map((file) => file.kind)).toEqual(['state', 'autonomy-db'])
    expect((await verifyDataBackup(result.directory)).valid).toBe(true)
    await fs.appendFile(path.join(result.directory, 'state.json'), 'tampered')
    await expect(verifyDataBackup(result.directory)).rejects.toMatchObject({ code: 'BACKUP_CHECKSUM_MISMATCH' })
    store.close()
  })

  it('restores verified state and refuses tampered backups before replacing live data', async () => {
    const { dir, store } = await fixture()
    const result = await createDataBackup({ dataDir: dir, stateFile: path.join(dir, 'state.json'), autonomyDbFile: path.join(dir, 'autonomy.db'), db: store.databaseHandle() })
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ schemaVersion: 4, projects: [{ id: 'after' }] }), 'utf8')
    const restored = await restoreDataBackup({ directory: result.directory, dataDir: dir, stateFile: path.join(dir, 'state.json') })
    expect(restored.restored).toBe(true)
    expect(JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).projects[0].id).toBe('before')
    await fs.writeFile(path.join(result.directory, 'state.json'), '{}', 'utf8')
    await expect(restoreDataBackup({ directory: result.directory, dataDir: dir, stateFile: path.join(dir, 'state.json') })).rejects.toMatchObject({ code: 'BACKUP_CHECKSUM_MISMATCH' })
    expect(JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).projects[0].id).toBe('before')
    store.close()
  })

  it('rejects manifest paths that escape the backup directory', async () => {
    const { dir, store } = await fixture()
    const result = await createDataBackup({ dataDir: dir, stateFile: path.join(dir, 'state.json'), autonomyDbFile: path.join(dir, 'autonomy.db'), db: store.databaseHandle() })
    const manifestFile = path.join(result.directory, 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
    manifest.files[0].path = '../state.json'
    await fs.writeFile(manifestFile, JSON.stringify(manifest), 'utf8')
    await expect(verifyDataBackup(result.directory)).rejects.toMatchObject({ code: 'BACKUP_PATH_INVALID' })
    store.close()
  })

  it('does not report success when a backup has no applicable restore target', async () => {
    const { dir, store } = await fixture()
    const result = await createDataBackup({ dataDir: dir, stateFile: path.join(dir, 'missing-state.json'), autonomyDbFile: path.join(dir, 'autonomy.db'), db: store.databaseHandle() })
    await expect(restoreDataBackup({ directory: result.directory, dataDir: dir, stateFile: path.join(dir, 'state.json'), autonomyDbFile: null })).rejects.toMatchObject({ code: 'RESTORE_NO_APPLICABLE_FILES' })
    store.close()
  })

  it('runs a scheduled backup through the same manifest and audit path', async () => {
    const { dir, store } = await fixture()
    const scheduler = startAutonomyBackupScheduler({ dataDir: dir, store, intervalMs: 60_000, logger: { error() {} } })
    const result = await scheduler.runNow('test-scheduled')
    expect(result.manifest.label).toBe('test-scheduled')
    expect(store.count('backup_runs')).toBe(1)
    expect(store.list('audit_log', { filter: (item) => item.action === 'created' && item.target === result.id })).toHaveLength(1)
    scheduler.stop()
    store.close()
  })
})
