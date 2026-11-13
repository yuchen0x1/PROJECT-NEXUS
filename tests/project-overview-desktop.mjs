import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { _electron } from 'playwright'
import { emptyState, saveStateFile } from '../server/services/state-store.mjs'
import { createLocalAgentTask, updateLocalAgentTask } from '../server/services/local-agent-tasks.mjs'

const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-overview-ui-'))
const locale = process.env.NEXUS_OVERVIEW_LOCALE || 'zh-CN'
const labels = JSON.parse(await fs.readFile(path.join(root, `src/locales/${locale}/workstation.json`), 'utf8')).overview
const executablePath = process.env.NEXUS_OVERVIEW_INSTALLED_EXE
const screenshots = path.join(root, 'docs/screenshots/project-overview')
await fs.mkdir(screenshots, { recursive: true })
let remoteRequests = 0
const mock = http.createServer((_req, res) => { remoteRequests++; res.end('{}') })
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
let app
try {
  await fs.writeFile(path.join(temporary, 'desktop-settings.json'), JSON.stringify({ language: locale, theme: 'light' }))
  const state = structuredClone(emptyState)
  state.settings.hostingPaused = true
  state.projects = ['one', 'two', 'three'].map((id) => ({ id, name: id, fullName: `fixture/${id}`, owner: 'fixture', defaultBranch: 'main', hosting: { enabled: false, strategy: 'observe' } }))
  state.hostedJobs = [{ id: 'incomplete-delivery', projectId: 'three', repository: 'fixture/three', status: 'Blocked', executionStatus: 'Succeeded', deliveryStatus: 'Incomplete', createdAt: new Date().toISOString(), error: 'Fixture release requires approval', events: [] }]
  await saveStateFile(path.join(temporary, 'state.json'), state)
  const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: temporary, GITHUB_TOKEN: 'fixture-gh-token', GITHUB_OWNER: 'fixture-account', GITHUB_API_URL: `http://127.0.0.1:${mock.address().port}`, AI_API_KEY: 'fixture-provider-key', AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, AI_MODEL: 'fixture-model', NEXUS_ENABLE_REMOTE_WRITES: 'false' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NEXUS_AI_PROVIDERS_JSON
  app = await _electron.launch({ executablePath: executablePath || require('electron'), args: executablePath ? ['--nexus-smoke-test'] : [root, '--nexus-smoke-test'], env, timeout: 45000 })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.nx-setup-entry').waitFor()
  await createLocalAgentTask({ dataDir: temporary, task: { id: 'live-task', projectId: 'one', projectName: 'fixture/one', label: 'Fixture autonomous task', providerId: 'default' } })
  await updateLocalAgentTask({ dataDir: temporary, taskId: 'live-task', patch: { status: 'Running', phase: 'executing' }, event: { type: 'tool_call', detail: 'Fixture execution output', metadata: { resultSummary: 'stdout: fixture-provider-key must stay hidden' } } })
  await page.getByRole('button', { name: labels.title, exact: true }).click()
  await page.locator('[data-node="repository:one"][data-status="running"]').waitFor()
  await page.locator('[data-flow-project="one"].is-active').waitFor()
  assert.equal(await page.locator('.nx-map-ai-flow.is-active').count(), 1)
  assert.equal(await page.locator('.nx-activity-pane').count(), 0)
  assert.equal(await page.locator('[data-node="account"] .nx-map-account-name').textContent(), 'fixture-account')
  assert.equal(await page.locator('[data-node^="repository:"]').count(), 3)
  assert.equal(await page.locator('[data-node="repository:three"]').getAttribute('data-status'), 'blocked')
  await page.screenshot({ path: path.join(screenshots, `running-${locale}.png`) })
  const world = page.locator('.nx-overview-svg > g')
  const initial = await world.getAttribute('transform')
  await page.getByRole('button', { name: labels.zoomIn, exact: true }).click()
  assert.notEqual(await world.getAttribute('transform'), initial)
  await page.getByRole('button', { name: labels.fit, exact: true }).click()
  const bounds = await page.locator('.nx-overview-svg').boundingBox()
  const beforeDrag = await world.getAttribute('transform')
  await page.mouse.move(bounds.x + 25, bounds.y + 100)
  await page.mouse.down(); await page.mouse.move(bounds.x + 80, bounds.y + 135); await page.mouse.up()
  assert.notEqual(await world.getAttribute('transform'), beforeDrag)
  await page.getByRole('button', { name: labels.fit, exact: true }).click()
  await page.getByRole('searchbox', { name: labels.search, exact: true }).fill('two')
  assert.equal(await page.locator('[data-node^="repository:"]').count(), 1)
  await page.getByRole('searchbox', { name: labels.search, exact: true }).fill('')
  await page.getByRole('combobox', { name: labels.locate, exact: true }).selectOption('one')
  await page.locator('.nx-map-inspector .nx-map-events').filter({ hasText: 'Fixture execution output' }).waitFor()
  assert.equal((await page.locator('.nx-map-inspector').innerText()).includes('fixture-provider-key'), false)
  await page.screenshot({ path: path.join(screenshots, `selected-output-${locale}.png`) })
  await updateLocalAgentTask({ dataDir: temporary, taskId: 'live-task', patch: { phase: 'verifying' }, event: 'Fixture verification output' })
  await page.locator('[data-flow-project="one"][data-flow-stage="verification"]').waitFor({ timeout: 12000 })
  await page.locator('.nx-map-inspector .nx-map-events').filter({ hasText: 'Fixture verification output' }).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await page.locator('.nx-map-flow.is-active').first().evaluate((element) => getComputedStyle(element).animationName), 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await app.evaluate(() => { globalThis.__overviewOriginalFetch = globalThis.fetch; globalThis.fetch = (url, ...args) => String(url).includes('/api/project-overview') ? Promise.reject(new Error('Fixture connection interrupted')) : globalThis.__overviewOriginalFetch(url, ...args) })
  await page.locator('.nx-map-header > button').click()
  await page.locator('.nx-map-warning').waitFor()
  assert.equal(await page.locator('.nx-project-overview').getAttribute('data-live'), 'false')
  assert.equal(await page.locator('.nx-map-flow.is-active').count(), 0)
  assert.equal(await page.locator('.nx-map-ai-flow.is-active').count(), 0)
  assert.equal(await page.locator('[data-node^="repository:"]').count(), 3)
  await app.evaluate(() => { globalThis.fetch = globalThis.__overviewOriginalFetch })
  await page.locator('.nx-map-header > button').click()
  await page.locator('.nx-map-flow.is-active').waitFor()
  await updateLocalAgentTask({ dataDir: temporary, taskId: 'live-task', patch: { status: 'Paused' }, event: 'Fixture approval required' })
  await page.locator('[data-node="repository:one"][data-status="blocked"]').waitFor({ timeout: 12000 })
  assert.equal(await page.locator('[data-flow-project="one"]').count(), 0)
  await updateLocalAgentTask({ dataDir: temporary, taskId: 'live-task', patch: { status: 'Running' } })
  await updateLocalAgentTask({ dataDir: temporary, taskId: 'live-task', patch: { status: 'Succeeded', phase: 'delivered' }, event: 'Fixture final result' })
  await page.locator('[data-node="repository:one"][data-status="success"]').waitFor({ timeout: 12000 })
  await page.locator('.nx-map-inspector .nx-map-events').filter({ hasText: 'Fixture final result' }).waitFor()
  const eventIds = await page.locator('.nx-map-inspector [data-event-id]').evaluateAll((elements) => elements.map((element) => element.dataset.eventId))
  assert.equal(new Set(eventIds).size, eventIds.length)
  await page.keyboard.press('Escape')
  await page.locator('[data-node="service:ai"]').focus()
  await page.keyboard.press('Enter')
  await page.locator('.nx-map-providers').filter({ hasText: 'fixture-model' }).waitFor()
  await page.screenshot({ path: path.join(screenshots, `ai-${locale}.png`) })
  await page.getByRole('combobox', { name: labels.locate, exact: true }).selectOption('two')
  await page.getByRole('button', { name: labels.openHosting, exact: true }).click()
  await page.locator('.hosting-policy h2').filter({ hasText: 'fixture/two' }).waitFor()
  assert.equal(remoteRequests, 0)
  assert.deepEqual(errors, [])
  const result = { status: 'PASS', locale, installedPackage: Boolean(executablePath), fixtureServices: true, externalRequests: remoteRequests, checks: ['sidebar-entry', 'centered-account', 'repository-map', 'running-flow-from-records', 'phase-and-output-refresh', 'partial-delivery-not-success', 'zoom-pan-fit', 'search-and-locate', 'repository-inspector', 'secret-redaction', 'disconnect-stops-animation-retains-data', 'retry-reconnect', 'approval-stops-flow', 'completion-stops-flow', 'unique-events', 'keyboard-navigation', 'reduced-motion', 'selected-repository-navigation'], at: new Date().toISOString() }
  await fs.writeFile(path.join(root, `docs/evidence/project-overview-${executablePath ? 'installed-' : ''}${locale}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await app?.close().catch(() => {})
  await new Promise((resolve) => mock.close(resolve))
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep))
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
