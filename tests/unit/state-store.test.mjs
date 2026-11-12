import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadStateFile, migrateState, saveStateFile } from '../../server/services/state-store.mjs'

const temporaryDirectories = []

async function tempDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-state-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('schema v3 JSON state store', () => {
  it('preserves every v2 record and adds only new collections', () => {
    const v2 = {
      schemaVersion: 2,
      projects: Array.from({ length: 24 }, (_, index) => ({ id: `repo_${index}`, fullName: `owner/repo-${index}`, marker: index })),
      tasks: [{ id: 'task_1', type: 'build', logs: ['kept'] }],
      activity: [{ id: 'activity_1', message: 'kept' }],
      settings: { concurrency: 2, notifications: true, custom: 'kept' },
      githubInstallations: [{ installationId: '123', accessToken: 'keep-the-record' }],
      githubWebhookEvents: [{ deliveryId: 'delivery_1' }],
      updateConfigs: [{ projectId: 'repo_1' }],
      auditLogs: [{ action: 'kept' }],
      customField: { remains: true }
    }
    const migrated = migrateState(v2)
    expect(migrated.schemaVersion).toBe(3)
    expect(migrated.projects).toEqual(v2.projects)
    expect(migrated.tasks).toEqual(v2.tasks)
    expect(migrated.activity).toEqual(v2.activity)
    expect(migrated.githubInstallations).toEqual(v2.githubInstallations)
    expect(migrated.githubWebhookEvents).toEqual(v2.githubWebhookEvents)
    expect(migrated.updateConfigs).toEqual(v2.updateConfigs)
    expect(migrated.auditLogs).toEqual(v2.auditLogs)
    expect(migrated.settings).toEqual(v2.settings)
    expect(migrated.customField).toEqual(v2.customField)
    expect(migrated.integrationReports).toEqual([])
    expect(migrated.integrationJobs).toEqual([])
    expect(migrated.integrationSchedules).toEqual([])
  })

  it('does not overwrite malformed state and initializes only a missing file', async () => {
    const directory = await tempDirectory()
    const corruptFile = path.join(directory, 'corrupt.json')
    await fs.writeFile(corruptFile, '{broken', 'utf8')
    await expect(loadStateFile(corruptFile)).rejects.toMatchObject({ code: 'STATE_INVALID' })
    expect(await fs.readFile(corruptFile, 'utf8')).toBe('{broken')

    const missingFile = path.join(directory, 'new.json')
    const initial = await loadStateFile(missingFile)
    expect(initial.schemaVersion).toBe(3)
    expect(JSON.parse(await fs.readFile(missingFile, 'utf8')).schemaVersion).toBe(3)
  })

  it('atomically replaces an existing state file with serialized state', async () => {
    const directory = await tempDirectory()
    const file = path.join(directory, 'state.json')
    await fs.writeFile(file, '{"schemaVersion":2}', 'utf8')
    await saveStateFile(file, { schemaVersion: 3, projects: [{ id: 'repo_1' }] })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ schemaVersion: 3, projects: [{ id: 'repo_1' }] })
    expect((await fs.readdir(directory)).filter((item) => item.endsWith('.tmp'))).toEqual([])
  })
})
