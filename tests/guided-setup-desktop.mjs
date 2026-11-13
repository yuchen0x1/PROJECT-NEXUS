import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createRequire } from 'node:module'
import { _electron } from 'playwright'
import { emptyState, saveStateFile } from '../server/services/state-store.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-guided-setup-'))
const locale = process.env.NEXUS_GUIDE_TEST_LOCALE || 'en-US'
const batchMode = process.env.NEXUS_GUIDE_BATCH === 'true'
const labels = JSON.parse(await fs.readFile(path.join(root, `src/locales/${locale}/git.json`), 'utf8'))
const navigation = JSON.parse(await fs.readFile(path.join(root, `src/locales/${locale}/navigation.json`), 'utf8'))
const modelLabels = JSON.parse(await fs.readFile(path.join(root, `src/locales/${locale}/agent.json`), 'utf8')).providers.discovery
const screenshots = path.join(root, `test-results/${batchMode ? 'batch-repositories' : 'guided-setup'}`)
await fs.mkdir(screenshots, { recursive: true })
let rejectProvider = true, rejectRepository = false, rejectModels = true
let modelRequests = 0
let issueRequests = 0
const mock = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/v1/models') {
    modelRequests++
    assert.equal(req.headers.authorization, 'Bearer fixture-ai-key')
    if (rejectModels) { res.statusCode = 401; return res.end('{"error":{"message":"DO NOT DISPLAY fixture-ai-key"}}') }
    return res.end('{"data":[{"id":"fixture-model"},{"id":"fixture-alternate"}]}')
  }
  if (req.url.endsWith('/chat/completions')) {
    if (rejectProvider) { res.statusCode = 503; return res.end('{"error":{"message":"Fixture provider unavailable"}}') }
    return res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  }
  if (req.url === '/user') return res.end('{"login":"fixture","avatar_url":""}')
  if (req.url.startsWith('/user/repos')) return res.end(JSON.stringify((batchMode ? ['one', 'two', 'three'] : ['one', 'two']).map((name, index) => ({ id: index + 1, name, full_name: `fixture/${name}`, owner: { login: 'fixture' }, default_branch: 'main', archived: false }))))
  if (req.url.includes('/git/ref/')) return res.end(JSON.stringify({ object: { sha: 'a'.repeat(40) } }))
  if (req.url.includes('/issues')) { issueRequests++; return res.end('[]') }
  if (req.url.startsWith('/repos/')) {
    if (rejectRepository && (!batchMode || req.url.startsWith('/repos/fixture/one'))) { res.statusCode = 403; return res.end('{"message":"Fixture repository permission denied"}') }
    return res.end('{"id":1,"full_name":"fixture/one","default_branch":"main","open_issues_count":0,"permissions":{"push":true}}')
  }
  return res.end('[]')
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
let app
try {
  await fs.writeFile(path.join(temporary, 'desktop-settings.json'), JSON.stringify({ language: locale, theme: 'light' }))
  const state = structuredClone(emptyState)
  state.settings.hostingPaused = true
  state.projects = (batchMode ? ['one', 'two', 'three'] : ['one', 'two']).map((id) => ({ id, fullName: `fixture/${id}`, name: id, owner: 'fixture', defaultBranch: 'main', group: 'fixture', stack: [], hosting: { strategy: 'observe', enabled: false } }))
  await saveStateFile(path.join(temporary, 'state.json'), state)
  const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: temporary, GITHUB_API_URL: `http://127.0.0.1:${mock.address().port}`, NEXUS_ENABLE_REMOTE_WRITES: 'false' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_OWNER', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'NEXUS_AI_PROVIDERS_JSON']) delete env[key]
  const installedExe = process.env.NEXUS_GUIDE_INSTALLED_EXE
  app = await _electron.launch({ executablePath: installedExe || require('electron'), args: installedExe ? ['--nexus-smoke-test'] : [root, '--nexus-smoke-test'], env, timeout: 45000 })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720))
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.locator('.nx-guide-entry').waitFor()
  await page.locator('.nx-first-use-notice').waitFor()
  assert.equal(await page.evaluate(async () => (await window.nexusDesktop.getSettings()).preferences.onboardingStage), 'setup')
  await page.locator('.nx-setup-later').click()
  await page.screenshot({ path: path.join(screenshots, `workbench-${locale}.png`) })
  assert.equal(await page.locator('.nx-rail [data-management-page]').count(), 20)
  assert.equal(await page.locator('.nx-remote-navigation').count(), 0)
  await page.locator('[data-management-page="Task Center"]').click()
  await page.locator('.hosted-timeline').waitFor()
  assert.equal(await page.locator('.nx-rail [aria-current="page"]').count(), 1)
  assert.ok((await page.locator('.nx-location').innerText()).includes(labels.shell.nav.taskCenter))
  await page.locator('.nx-rail .nx-nav-item').filter({ hasText: navigation.rail.workbench }).click()
  await page.locator('.nx-guide-entry').click()
  await page.screenshot({ path: path.join(screenshots, `start-${locale}.png`) })
  const currentStep = () => page.locator('.nx-setup nav button[aria-current="step"]').innerText()
  const next = () => page.locator('.nx-setup-next').click()
  assert.equal(await page.locator('.nx-setup-next').isDisabled(), true)
  await page.locator('#setup-github-token').fill('fixture-github-token')
  await page.getByRole('button', { name: labels.guide.viewLocation, exact: true }).click()
  await page.locator('.nx-product-tour').waitFor()
  assert.equal(await page.locator('.nx-product-tour').evaluate((element) => element === document.activeElement), true)
  await page.getByRole('button', { name: labels.guide.returnToSetup, exact: true }).click()
  assert.equal(await page.locator('#setup-github-token').inputValue(), 'fixture-github-token')
  await next()
  await page.locator('.nx-setup-body select').waitFor()
  assert.ok((await currentStep()).includes(labels.setup.steps[1]))
  assert.equal(await page.locator('.nx-shell').getAttribute('data-page'), 'agent')
  const inputs = page.locator('.nx-setup-body input')
  await inputs.nth(0).fill(`http://127.0.0.1:${mock.address().port}/v1`)
  await inputs.nth(1).fill('fixture-ai-key')
  await inputs.nth(2).fill('manual-model')
  await page.locator('.nx-model-fetch').click()
  await page.locator('.nx-model-error').filter({ hasText: modelLabels.errors.unauthorized }).waitFor()
  assert.equal(await inputs.nth(2).inputValue(), 'manual-model')
  assert.equal((await page.locator('.nx-model-status').innerText()).includes('fixture-ai-key'), false)
  rejectModels = false
  await page.locator('.nx-model-fetch').click()
  await page.locator('.nx-model-select').waitFor()
  assert.equal(await inputs.nth(2).inputValue(), 'manual-model')
  await page.locator('.nx-model-select').selectOption('fixture-model')
  assert.equal(await inputs.nth(2).inputValue(), 'fixture-model')
  await page.waitForFunction(() => document.querySelector('.nx-model-select').getBoundingClientRect().bottom <= document.querySelector('.nx-setup footer').getBoundingClientRect().top)
  const unsavedProviders = await page.evaluate(async () => (await window.nexusDesktop.requestApi({ url: '/api/local-agent/providers' })).body.providers)
  assert.equal(unsavedProviders.some((item) => item.source === 'stored'), false)
  await page.screenshot({ path: path.join(screenshots, `models-${locale}.png`) })
  await inputs.nth(1).fill('changed-key')
  await page.locator('.nx-model-select').waitFor({ state: 'detached' })
  assert.equal(await inputs.nth(2).inputValue(), 'fixture-model')
  await inputs.nth(1).fill('fixture-ai-key')
  await next()
  await page.locator('.nx-setup-body [role="alert"]').waitFor()
  assert.ok((await currentStep()).includes(labels.setup.steps[1]))
  rejectProvider = false
  await next()
  await page.locator('.nx-repo-option input[value="two"]').waitFor()
  assert.ok((await currentStep()).includes(labels.setup.steps[2]))
  await page.locator('.nx-repo-select-none').click()
  assert.equal(await page.locator('.nx-setup-next').isDisabled(), true)
  if (batchMode) {
    await new Promise((resolve) => setTimeout(resolve, 2200))
    assert.equal(await page.locator('.nx-repo-option input:checked').count(), 0)
    await page.locator('.nx-repo-select-all').click()
    assert.equal(await page.locator('.nx-repo-option input:checked').count(), 3)
    await page.locator('#setup-repository-search').fill('two')
    assert.equal(await page.locator('.nx-repo-option').count(), 1)
    await page.locator('.nx-repo-select-none').click()
    await page.locator('.nx-repo-select-all').click()
    assert.equal(await page.locator('.nx-repo-selection-count').innerText(), labels.batch.selected.replace('{{selected}}', '3').replace('{{total}}', '3'))
    await page.locator('#setup-repository-search').fill('')
    await page.locator('.nx-repo-checklist').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(screenshots, `select-all-${locale}.png`) })
    await page.locator('.nx-repo-option input[value="three"]').uncheck()
  } else await page.locator('.nx-repo-option input[value="two"]').check()
  await next()
  assert.ok((await currentStep()).includes(labels.setup.steps[3]))
  await next()
  await page.locator('.nx-setup-body input[type="checkbox"]').waitFor({ timeout: 20000 })
  assert.equal(await page.locator('.nx-setup-next').isDisabled(), true)
  assert.equal(await page.locator('.nx-setup-body input[type="checkbox"]').isChecked(), false)
  await page.screenshot({ path: path.join(screenshots, `policy-${locale}.png`) })
  await page.locator('.nx-setup-body input[type="checkbox"]').check()
  await next()
  await page.getByRole('button', { name: labels.hosting.inspectLight, exact: true }).waitFor()
  rejectRepository = true
  await next()
  await page.locator('.nx-setup-body [role="alert"]').waitFor()
  assert.ok((await currentStep()).includes(labels.setup.steps[5]))
  const afterFailedInspection = JSON.parse(await fs.readFile(path.join(temporary, 'state.json'), 'utf8'))
  if (batchMode) {
    assert.equal(await page.locator('.nx-setup-batch [data-project-id="one"]').getAttribute('data-status'), 'failed')
    assert.equal(await page.locator('.nx-setup-batch [data-project-id="two"]').getAttribute('data-status'), 'success')
    await page.screenshot({ path: path.join(screenshots, `partial-check-${locale}.png`) })
  }
  rejectRepository = false
  await next()
  await page.locator('.nx-setup-body .nx-setup-consent').waitFor({ timeout: 30000 })
  if (batchMode) {
    const afterRetry = JSON.parse(await fs.readFile(path.join(temporary, 'state.json'), 'utf8'))
    assert.equal(afterRetry.projects.find((item) => item.id === 'two').setupReadiness.id, afterFailedInspection.projects.find((item) => item.id === 'two').setupReadiness.id)
  }
  assert.ok((await currentStep()).includes(labels.setup.steps[6]))
  assert.equal(await page.locator('.nx-setup-next').isDisabled(), true)
  await page.locator('.nx-setup-body input[type="checkbox"]').check()
  assert.equal(await page.locator('.nx-setup-next').isDisabled(), true)
  await page.locator('.nx-setup-body').getByRole('button', { name: labels.hosting.resume, exact: true }).click()
  if (batchMode) {
    const renewed = await page.evaluate(() => window.nexusDesktop.requestApi({ url: '/api/projects/one/hosting/readiness', method: 'POST', body: '{}' }))
    assert.equal(renewed.status, 200)
  }
  await next()
  let partialEnable
  if (batchMode) {
    await page.locator('.nx-setup-body [role="alert"]').waitFor()
    partialEnable = JSON.parse(await fs.readFile(path.join(temporary, 'state.json'), 'utf8'))
    assert.equal(partialEnable.projects.find((item) => item.id === 'one').hosting.enabled, false)
    assert.equal(partialEnable.projects.find((item) => item.id === 'two').hosting.enabled, true)
    assert.equal(await page.locator('.nx-setup-completion').count(), 0)
    await page.locator('.nx-batch-retry').click()
  }
  await page.locator('.nx-setup-completion').waitFor()
  await page.screenshot({ path: path.join(screenshots, `enabled-${locale}.png`) })
  const enabledState = JSON.parse(await fs.readFile(path.join(temporary, 'state.json'), 'utf8'))
  assert.equal(enabledState.projects.find((item) => item.id === 'two').hosting.enabled, true)
  assert.equal(enabledState.projects.find((item) => item.id === 'one').hosting.enabled, batchMode)
  if (batchMode) {
    assert.equal(enabledState.projects.find((item) => item.id === 'three').hosting.enabled, false)
    assert.equal(enabledState.projects.find((item) => item.id === 'two').hosting.updatedAt, partialEnable.projects.find((item) => item.id === 'two').hosting.updatedAt)
    assert.equal(await page.locator('.nx-setup-enabled-repos li').count(), 2)
  }
  assert.equal(enabledState.settings.remoteWritesEnabled, true)
  assert.equal(enabledState.settings.hostingPaused, false)
  const beforeIssues = issueRequests
  await page.getByRole('button', { name: labels.guide.inspectNow, exact: true }).click()
  await page.locator('.success-text').filter({ hasText: labels.guide.inspected.replace('{{count}}', '0').replace('{{actionable}}', '0') }).waitFor()
  assert.equal(issueRequests - beforeIssues, batchMode ? 2 : 1)
  if (batchMode) {
    await page.getByRole('button', { name: labels.guide.inspectNow, exact: true }).click()
    for (let attempt = 0; attempt < 100 && issueRequests < beforeIssues + 4; attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(issueRequests - beforeIssues, 4)
    await page.locator('.success-text').filter({ hasText: labels.guide.inspected.replace('{{count}}', '0').replace('{{actionable}}', '0') }).waitFor()
  }
  await page.getByRole('button', { name: labels.guide.viewRunLocations, exact: true }).click()
  assert.equal(await page.evaluate(async () => (await window.nexusDesktop.getSettings()).preferences.onboardingStage), 'tour')
  await page.locator('.nx-product-tour h2').filter({ hasText: labels.guide.tourTitles[0] }).waitFor()
  assert.equal(await page.locator('.hosting-policy h2').innerText(), batchMode ? 'fixture/one' : 'fixture/two')
  assert.equal(await page.locator('.hosting-policy select').inputValue(), 'autonomous')
  assert.equal(await page.locator('.hosting-gates input').first().isChecked(), true)
  await page.screenshot({ path: path.join(screenshots, `hosting-tour-${locale}.png`) })
  for (let index = 1; index < 4; index++) {
    await page.locator('.nx-product-tour footer .nx-primary').click()
    await page.locator('.nx-product-tour h2').filter({ hasText: labels.guide.tourTitles[index] }).waitFor()
  }
  await page.locator('.nx-product-tour footer .nx-primary').click()
  await page.locator('.nx-product-tour').waitFor({ state: 'detached' })
  assert.equal(JSON.parse(await fs.readFile(path.join(temporary, 'desktop-settings.json'), 'utf8')).onboardingStage, 'complete')
  await page.locator('.hosting-policy').waitFor()
  const metadataUpdate = await page.evaluate(() => window.nexusDesktop.requestApi({ url: '/api/local-agent/providers/setup-provider', method: 'PATCH', body: JSON.stringify({ name: 'Keep provider name', priority: 7, capabilities: ['chat', 'json'] }) }))
  assert.equal(metadataUpdate.status, 200)
  await page.locator('.nx-guide-trigger').click()
  await page.locator('.nx-setup-reuse').waitFor()
  assert.equal(await page.locator('#setup-github-token').inputValue(), '')
  await next()
  await page.locator('.nx-setup-body input').first().waitFor()
  assert.equal(await page.locator('.nx-setup-body input[type="password"]').inputValue(), '')
  assert.equal(await page.locator('.nx-setup-next').isEnabled(), true)
  await page.locator('.nx-model-fetch').click()
  await page.locator('.nx-model-select').waitFor()
  assert.equal(await page.locator('.nx-setup-body input[type="password"]').inputValue(), '')
  assert.ok(modelRequests >= 3)
  await page.locator('.nx-setup-body').getByRole('button', { name: labels.setup.saveTest, exact: true }).click()
  await page.locator('.nx-setup-body .success-text').waitFor()
  const providerMetadata = await page.evaluate(async () => (await window.nexusDesktop.requestApi({ url: '/api/local-agent/providers' })).body.providers.find((item) => item.id === 'setup-provider'))
  assert.equal(providerMetadata.name, 'Keep provider name')
  assert.equal(providerMetadata.priority, 7)
  assert.deepEqual(providerMetadata.capabilities, ['chat', 'json'])
  await page.keyboard.press('Escape')
  await page.locator('.nx-rail .nx-nav-item').filter({ hasText: navigation.rail.workbench }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720))
  const bounds = await page.locator('.nx-rail-collapse').boundingBox()
  assert.ok(bounds.y + bounds.height <= await page.evaluate(() => innerHeight))
  await fs.mkdir(path.join(root, 'test-results/guided-setup'), { recursive: true })
  await page.screenshot({ path: path.join(root, `test-results/guided-setup/flat-navigation-${locale}.png`) })
  assert.deepEqual(pageErrors, [])
  await fs.writeFile(path.join(root, `test-results/${batchMode ? 'batch-repositories' : 'guided-setup'}-${process.env.NEXUS_GUIDE_INSTALLED_EXE ? 'installed-' : ''}${locale}.json`), JSON.stringify({ status: 'PASS', locale, batchMode, fixtureServices: true, installedPackage: Boolean(process.env.NEXUS_GUIDE_INSTALLED_EXE), checks: ['flat-navigation', 'next-saves-and-navigates', 'draft-model-discovery', 'model-failure-retry', 'model-selection-and-manual-entry', 'model-list-invalidation', 'saved-key-model-discovery', 'provider-failure-retry', 'repository-failure-retry', 'script-and-write-consent', 'selected-repository', 'actual-enable', 'feature-tour', 'saved-credential-reuse', 'provider-metadata-preserved', 'explicit-scheduler-resume', '720p-layout', ...(batchMode ? ['select-all-and-none', 'deselect-survives-polling', 'search-keeps-selection', 'batch-policy', 'partial-inspection-retry', 'partial-enable-retry-with-fresh-proof', 'successful-repository-not-repeated', 'unselected-repository-untouched', 'batch-issue-sync-and-repeat'] : [])], at: new Date().toISOString() }, null, 2))
  console.log('PASS: Flat navigation and complete guided setup, retries after real fixture failures, explicit consent, repository selection, feature tour, saved credential reuse and 720p sidebar layout.')
} finally {
  await app?.close().catch(() => {})
  await new Promise((resolve) => mock.close(resolve))
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
