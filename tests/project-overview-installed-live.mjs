// View real recorded topology in an isolated profile with scheduling disabled.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const executablePath = process.env.NEXUS_OVERVIEW_LIVE_EXE
if (!executablePath) throw new Error('Set NEXUS_OVERVIEW_LIVE_EXE to the installed executable.')
const before = new Map()
const dataPath = path.join(process.env.LOCALAPPDATA, 'PROJECT NEXUS')
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
// Capture all persisted JSON, including task history and window preferences.
for (const name of await fs.readdir(dataPath)) if (name.endsWith('.json')) before.set(name, await fs.readFile(path.join(dataPath, name)))
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-overview-real-profile-'))
let app
try {
  for (const [name, bytes] of before) await fs.writeFile(path.join(temporary, name), bytes)
  const preferences = JSON.parse(before.get('desktop-settings.json') || '{}')
  await fs.writeFile(path.join(temporary, 'desktop-settings.json'), JSON.stringify({ onboardingStage: 'complete', ...preferences, autoStart: false }))
  const state = JSON.parse(before.get('state.json'))
  // Pause hosting in the copy before startup; integration scans have their own schedule.
  state.settings = { ...state.settings, hostingPaused: true, remoteWritesEnabled: false }
  state.integrationSchedules = (state.integrationSchedules || []).map((item) => ({ ...item, enabled: false }))
  // Startup recovery may otherwise resume a pending scan from the copied profile.
  state.integrationJobs = (state.integrationJobs || []).map((job) => ['Pending', 'Running'].includes(job.status) ? { ...job, status: 'Blocked' } : job)
  await fs.writeFile(path.join(temporary, 'state.json'), JSON.stringify(state))
  const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: temporary, NEXUS_ENABLE_REMOTE_WRITES: 'false' }
  for (const key of Object.keys(env)) if (/^(?:GITHUB_|GH_|AI_|ANTHROPIC_|GEMINI_|GOOGLE_API_KEY$|NEXUS_AI_PROVIDERS_JSON$|ELECTRON_RUN_AS_NODE$)/.test(key)) delete env[key]
  app = await _electron.launch({ executablePath, args: ['--nexus-smoke-test'], env, timeout: 45000 })
  const page = await app.firstWindow()
  // Credential restoration validates GitHub before forwarding provider keys.
  // The window can render first; do not mistake that initial snapshot for the restored state.
  const credentialDeadline = Date.now() + 30000
  let credentialsRestored = false
  while (Date.now() < credentialDeadline) {
    const restored = await page.evaluate(() => window.nexusDesktop.requestApi({ url: '/api/project-overview' }))
    credentialsRestored = restored.status === 200 && Boolean(restored.body.account.login) && restored.body.providers.some((provider) => provider.configured)
    if (credentialsRestored) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const locale = JSON.parse(before.get('desktop-settings.json')).language || 'en-US'
  const labels = JSON.parse(await fs.readFile(path.join(root, `src/locales/${locale}/workstation.json`), 'utf8')).overview
  await page.getByRole('button', { name: labels.title, exact: true }).click()
  await page.locator('.nx-project-overview[data-live="true"]').waitFor()
  const response = await page.evaluate(() => window.nexusDesktop.requestApi({ url: '/api/project-overview' }))
  assert.equal(response.status, 200)
  const data = response.body
  credentialsRestored = credentialsRestored && Boolean(data.account.login) && data.providers.some((provider) => provider.configured)
  assert.equal(data.paused, true)
  assert.equal(data.repositories.length, state.projects.length)
  assert.equal(path.resolve((await page.evaluate(() => window.nexusDesktop.getInfo())).dataPath), path.resolve(temporary))
  const rendered = await page.locator('[data-node^="repository:"]').count()
  assert.equal(rendered, data.repositories.length)
  const result = { status: 'PASS', version: (await page.evaluate(() => window.nexusDesktop.getInfo())).version, actualInstalledProfile: false, isolatedRealProfileCopy: true, schedulerPaused: data.paused, integrationSchedulesDisabled: true, readOnlyPage: true, repositoryCount: data.repositories.length, renderedRepositoryCount: rendered, accountPresent: Boolean(data.account.login), configuredAIConnections: data.providers.filter((provider) => provider.configured).length, runningTasks: data.stats.running, activeFlows: await page.locator('.nx-map-flow.is-active').count(), at: new Date().toISOString() }
  result.credentialRestoration = credentialsRestored ? 'PASS' : 'BLOCKED'
  if (!credentialsRestored) {
    result.status = 'PARTIAL'
    const log = await fs.readFile(path.join(temporary, 'logs/workstation.log'), 'utf8')
    result.credentialDiagnostics = log.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => /credential|provider-keys/.test(event.event)).map(({ level, event, count, synced }) => ({ level, event, count, synced }))
    // Only return counts and success flags; plaintext credentials stay in the main process.
    const github = JSON.parse(before.get('github-credentials.json') || '{}').encrypted
    const keys = Object.values(JSON.parse(before.get('provider-keys.json') || '{}').keys || {})
    result.credentialDecryption = await app.evaluate(({ safeStorage }, records) => {
      const readable = (value, encoding) => {
        try { return Boolean(safeStorage.decryptString(Buffer.from(value || '', encoding))) }
        catch { return false }
      }
      return { encryptionAvailable: safeStorage.isEncryptionAvailable(), githubReadable: readable(records.github, 'base64'), providerEntries: records.keys.length, readableProviderEntries: records.keys.filter((key) => readable(key, 'latin1')).length }
    }, { github, keys })
  }
  if (data.stats.running === 0) assert.equal(result.activeFlows, 0)
  await fs.mkdir(path.join(root, 'docs/screenshots/project-overview'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'docs/screenshots/project-overview/installed-real-overview.png') })
  if (data.repositories.length) {
    await page.getByRole('combobox', { name: labels.locate, exact: true }).selectOption(data.repositories[0].id)
    await page.locator('.nx-map-inspector h2').filter({ hasText: data.repositories[0].fullName }).waitFor()
    await page.getByRole('button', { name: labels.fit, exact: true }).click()
    await page.screenshot({ path: path.join(root, 'docs/screenshots/project-overview/installed-real-inspector.png') })
  }
  await app.close(); app = null
  for (const [name, content] of before) assert.equal(digest(await fs.readFile(path.join(dataPath, name))), digest(content), `${name} must remain unchanged`)
  result.originalProfileFilesChecked = before.size
  result.originalProfileUnchanged = true
  await fs.writeFile(path.join(root, 'docs/evidence/project-overview-live.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  if (!credentialsRestored) process.exitCode = 2
} finally {
  await app?.close().catch(() => {})
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep))
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
