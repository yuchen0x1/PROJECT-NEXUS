import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export const emptyState = Object.freeze({
  schemaVersion: 4,
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
  integrationSchedules: [],
  hostingRuns: [],
  securityFindings: [],
  researchReports: [],
  hostedJobs: []
})

function persistedState(value) {
  const safe = structuredClone(value)
  for (const installation of safe.githubInstallations || []) delete installation.accessToken
  return safe
}

export function migrateState(input) {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw Object.assign(new Error('State document must be a JSON object.'), { code: 'STATE_INVALID' })
  }
  const source = input || {}
  const sourceVersion = Number(source.schemaVersion || 1)
  if (!Number.isInteger(sourceVersion) || sourceVersion < 1 || sourceVersion > 4) {
    throw Object.assign(new Error(`Unsupported state schema version: ${source.schemaVersion}`), { code: 'STATE_SCHEMA_UNSUPPORTED' })
  }
  const next = { ...structuredClone(emptyState), ...structuredClone(source) }
  next.schemaVersion = 4
  for (const key of [
    'projects', 'tasks', 'activity', 'githubInstallations', 'githubWebhookEvents',
    'updateConfigs', 'auditLogs', 'integrationReports', 'integrationJobs', 'integrationSchedules',
    'hostingRuns', 'securityFindings', 'researchReports', 'hostedJobs'
  ]) {
    if (!Array.isArray(next[key])) next[key] = []
  }
  next.settings = { ...emptyState.settings, ...(next.settings && typeof next.settings === 'object' ? next.settings : {}), ...(next.settings?.hostingPaused === undefined ? {} : { hostingPaused: next.settings.hostingPaused === true }) }
  // v3 → v4: per-project hosting policy/repo-meta/workspace records are added
  // lazily by the hosting service; the migration only reserves the collection.
  for (const project of next.projects) {
    if (project && typeof project === 'object' && !project.hosting) project.hosting = null
    if (project && typeof project === 'object' && !project.repoMeta) project.repoMeta = null
    if (project && typeof project === 'object' && !project.localWorkspace) project.localWorkspace = null
  }
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
  if (Number(parsed?.schemaVersion || 1) < 4) await fs.writeFile(`${file}.pre-v4.bak`, JSON.stringify(persistedState(parsed), null, 2), { flag: 'wx', mode: 0o600 }).catch((error) => { if (error.code !== 'EEXIST') throw error })
  if (Number(parsed?.schemaVersion || 1) < 4) await saveStateFile(file, migrated)
  return migrated
}

export async function saveStateFile(file, value) {
  const directory = path.dirname(file)
  await fs.mkdir(directory, { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(persistedState(value), null, 2), 'utf8'); await handle.sync() } finally { await handle.close() }
    // Retain the last valid document. Never replace this backup with corrupt
    // input, and never silently restore it over the user's live state.
    const previous = await fs.readFile(file, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
    if (previous !== null) {
      try { const parsed = JSON.parse(previous); await fs.writeFile(`${file}.bak`, JSON.stringify(persistedState(parsed), null, 2), { encoding: 'utf8', mode: 0o600 }) }
      catch (error) { if (!(error instanceof SyntaxError)) throw error }
    }
    // Windows indexers/antivirus can briefly hold a replacement target open.
    // Retry only transient sharing/permission errors; retain the atomic rename and fail closed.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error
        await new Promise((resolve) => setTimeout(resolve, 20 * (2 ** attempt)))
      }
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
