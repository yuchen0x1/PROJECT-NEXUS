import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export const emptyState = Object.freeze({
  schemaVersion: 3,
  projects: [],
  tasks: [],
  activity: [],
  settings: { concurrency: 3, notifications: false },
  githubInstallations: [],
  githubWebhookEvents: [],
  updateConfigs: [],
  auditLogs: [],
  integrationReports: [],
  integrationJobs: [],
  integrationSchedules: []
})

export function migrateState(input) {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw Object.assign(new Error('State document must be a JSON object.'), { code: 'STATE_INVALID' })
  }
  const source = input || {}
  const sourceVersion = Number(source.schemaVersion || 1)
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1 || sourceVersion > 3) {
    throw Object.assign(new Error(`Unsupported state schema version: ${source.schemaVersion}`), { code: 'STATE_SCHEMA_UNSUPPORTED' })
  }
  const next = { ...structuredClone(emptyState), ...structuredClone(source) }
  next.schemaVersion = 3
  for (const key of [
    'projects', 'tasks', 'activity', 'githubInstallations', 'githubWebhookEvents',
    'updateConfigs', 'auditLogs', 'integrationReports', 'integrationJobs', 'integrationSchedules'
  ]) {
    if (!Array.isArray(next[key])) next[key] = []
  }
  next.settings = { ...emptyState.settings, ...(next.settings && typeof next.settings === 'object' ? next.settings : {}) }
  return next
}

export async function loadStateFile(file) {
  let content
  try {
    content = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const initial = migrateState(emptyState)
    await saveStateFile(file, initial)
    return initial
  }
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw Object.assign(new Error(`State file is not valid JSON; refusing to replace it: ${error.message}`), { code: 'STATE_INVALID', cause: error })
  }
  const migrated = migrateState(parsed)
  if (Number(parsed?.schemaVersion || 1) < 3) await saveStateFile(file, migrated)
  return migrated
}

export async function saveStateFile(file, value) {
  const directory = path.dirname(file)
  await fs.mkdir(directory, { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
