import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { defaultAutonomyDbFile, openAutonomyStore } from '../server/autonomy/db.mjs'
import { cleanupTestEnvironment, startNexusServer, tempDataDir } from './unit/helpers/server-harness.mjs'

const dataDir = await tempDataDir('nexus-autonomy-browser-')
const screenshots = path.resolve('test-results/autonomy-browser')
let browser
try {
  await fs.mkdir(screenshots, { recursive: true })
  const store = openAutonomyStore({ file: defaultAutonomyDbFile(dataDir) })
  try {
    store.setSetting('autonomySettings', { enabled: false, paused: true, automationMode: 'observe', researchEnabled: false })
    store.put('repositories', 'repo_fixture', { id: 'repo_fixture', fullName: 'fixture/visible', enabled: false, monitorItems: [], defaultBranch: 'main', pollIntervalMs: 1800000, automationMode: 'observe' })
    store.put('tasks', 'task_fixture', { id: 'task_fixture', repoId: 'repo_fixture', repository: 'fixture/visible', status: 'ACCEPTED', priority: 'P1', attempts: 1, verification: { verdict: 'PASS' }, workspace: { path: dataDir, isolated: true } })
  } finally {
    store.close()
  }

  const { base } = await startNexusServer({
    dataDir, stateFile: path.join(dataDir, 'state.json'), token: '', providerUrl: '', ipc: true,
    extraEnv: {
      NEXUS_DESKTOP_MODE: 'false', NEXUS_ROLE: 'Viewer', NEXUS_ENABLE_REMOTE_WRITES: 'false',
      GITHUB_API_URL: 'http://127.0.0.1:1', GITHUB_UPLOADS_URL: 'http://127.0.0.1:1',
      GITHUB_OWNER: '', GITHUB_TOKEN: '', GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '',
      GITHUB_APP_CLIENT_ID: '', GITHUB_APP_CLIENT_SECRET: '', AI_API_KEY: '', AI_MODEL: '',
      NEXUS_AI_PROVIDERS_JSON: '', NEXUS_AI_ROUTING_JSON: ''
    }
  })
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  const mutations = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (request.url().startsWith(`${base}/api/autonomy/`) && !['GET', 'HEAD'].includes(request.method())) mutations.push(request.method())
  })
  // Keep this test offline even if a dependency or default changes.
  await page.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
  await page.addInitScript(() => window.localStorage.setItem('nexus.user-preferences', JSON.stringify({ language: 'en-US' })))
  await page.goto(base)
  await page.getByRole('button', { name: 'AI Autonomy', exact: true }).click()
  const panel = page.locator('.ax-root')
  await panel.getByRole('heading', { name: 'Autonomous Operations Command Center' }).waitFor()
  await panel.getByRole('status').filter({ hasText: 'Read-only mode:' }).waitFor()
  await panel.getByRole('heading', { name: 'Execution readiness' }).waitFor()
  assert.equal(await panel.getByRole('button', { name: 'Start autonomy' }).count(), 0)
  await page.screenshot({ path: path.join(screenshots, 'overview.png') })

  const overviewRefresh = page.waitForResponse((response) => response.url() === `${base}/api/autonomy/overview`)
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
  const refreshed = await overviewRefresh
  assert.equal(refreshed.status(), 200)
  assert.equal((await refreshed.json()).apiAccess, 'read-only')
  await page.getByText('Refreshed', { exact: true }).waitFor()

  await panel.getByRole('button', { name: 'Monitoring', exact: true }).click()
  await panel.getByText('fixture/visible', { exact: true }).waitFor()
  assert.equal(await panel.getByRole('heading', { name: 'Add repository' }).count(), 0)
  assert.equal(await panel.getByRole('button', { name: 'Sync now' }).count(), 0)
  await page.screenshot({ path: path.join(screenshots, 'monitoring.png') })

  await panel.getByRole('button', { name: 'Desktop clients', exact: true }).click()
  await panel.getByRole('heading', { name: 'Capability matrix' }).waitFor()
  assert.equal(await panel.getByRole('button', { name: 'Probe clients' }).count(), 0)

  await panel.getByRole('button', { name: 'Tasks & runs', exact: true }).click()
  await panel.getByText('ACCEPTED', { exact: true }).waitFor()
  assert.equal(await panel.getByRole('button', { name: 'Open draft PR' }).count(), 0)
  assert.equal(await panel.getByRole('button', { name: 'Cancel', exact: true }).count(), 0)
  assert.deepEqual(mutations, [])
  assert.deepEqual(errors, [])
  console.log('Autonomy browser regression passed: navigation, persisted records, refresh, read-only actions and no mutation requests.')
} finally {
  try { await browser?.close() } finally { await cleanupTestEnvironment() }
}
