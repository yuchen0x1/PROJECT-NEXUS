import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { _electron } from 'playwright'

const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-first-use-'))
const settingsFile = path.join(temporary, 'desktop-settings.json')
const executablePath = process.env.NEXUS_FIRST_USE_TEST_EXECUTABLE || require('electron')
const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: temporary, NEXUS_ENABLE_REMOTE_WRITES: 'false' }
for (const key of ['ELECTRON_RUN_AS_NODE', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_OWNER', 'AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL', 'NEXUS_AI_PROVIDERS_JSON']) delete env[key]
const errors = []
let app
const launch = async () => {
  app = await _electron.launch({ executablePath, args: process.env.NEXUS_FIRST_USE_TEST_EXECUTABLE ? ['--nexus-smoke-test'] : [root, '--nexus-smoke-test'], env, timeout: 45000 })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720))
  await page.locator('.nx-shell').waitFor()
  return page
}
const stage = (page) => page.evaluate(async () => (await window.nexusDesktop.getSettings()).preferences.onboardingStage)
try {
  let page = await launch()
  await page.locator('.nx-first-use-notice').waitFor()
  const locale = await page.locator('html').getAttribute('lang')
  const labels = JSON.parse(await fs.readFile(path.join(root, `src/locales/${locale}/git.json`), 'utf8'))
  assert.equal(await stage(page), 'setup')
  assert.equal(await page.locator('.nx-setup-guided').count(), 1)
  assert.equal(await page.locator('.nx-setup-next').isDisabled(), true)
  assert.equal(await page.locator('.nx-setup nav button').last().isDisabled(), true)
  assert.ok((await page.locator('.nx-first-use-notice').innerText()).includes(labels.guide.firstUse.detail))
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'test-results/first-use-auto-guide.png') })
  await page.locator('.nx-setup-later').click()
  await page.locator('.nx-setup').waitFor({ state: 'detached' })
  assert.equal(await stage(page), 'setup', 'Postponing must not complete the tutorial.')
  await page.evaluate(() => window.nexusDesktop.updateSettings({ theme: 'light' }))
  await app.close()

  page = await launch()
  await page.locator('.nx-first-use-notice').waitFor()
  assert.equal(await stage(page), 'setup', 'Incomplete setup must open again after restart.')
  // The full guided-setup test verifies the real successful setup transition.
  // Restore its durable handoff here to test restarting before the feature tour.
  await page.evaluate(() => window.nexusDesktop.updateSettings({ onboardingStage: 'tour' }))
  await app.close()

  page = await launch()
  await page.locator('.nx-product-tour').waitFor()
  assert.equal(await page.locator('.nx-setup').count(), 0)
  assert.equal(await stage(page), 'tour')
  await page.locator('.nx-product-tour .nx-icon-button').click()
  assert.equal(await stage(page), 'tour', 'Closing the tour must not mark it complete.')
  await page.locator('.nx-guide-trigger').click()
  for (let index = 0; index < 4; index++) {
    await page.locator('.nx-product-tour h2').filter({ hasText: labels.guide.tourTitles[index] }).waitFor()
    await page.locator('.nx-product-tour footer .nx-primary').click()
  }
  await page.locator('.nx-product-tour').waitFor({ state: 'detached' })
  assert.equal(await stage(page), 'complete')
  assert.equal(JSON.parse(await fs.readFile(settingsFile, 'utf8')).onboardingStage, 'complete')
  await page.evaluate(() => localStorage.clear())
  await app.close()

  page = await launch()
  assert.equal(await stage(page), 'complete')
  assert.equal(await page.locator('.nx-setup, .nx-product-tour').count(), 0, 'Completed tutorials must not reopen, even with browser storage cleared.')
  await page.locator('.nx-guide-entry').click()
  await page.locator('.nx-setup-guided').waitFor()
  assert.equal(await page.locator('.nx-first-use-notice').count(), 0)
  await page.keyboard.press('Escape')
  assert.equal(await stage(page), 'complete', 'Manually replaying the tutorial must preserve completion.')
  const invalid = await page.evaluate(() => window.nexusDesktop.updateSettings({ onboardingStage: 'invalid' }).then(() => 'accepted', (error) => error.message))
  assert.match(invalid, /Invalid onboarding stage/)
  assert.equal(await stage(page), 'complete')
  await app.close()

  const stored = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
  await fs.writeFile(settingsFile, JSON.stringify({ ...stored, onboardingStage: 'invalid' }))
  page = await launch()
  await page.locator('.nx-first-use-notice').waitFor()
  assert.equal(await stage(page), 'setup', 'Invalid saved progress must fall back to the tutorial.')
  assert.deepEqual(errors, [])
  console.log('PASS: A fresh profile opens guided setup automatically; postponing resumes after restart; the pending tour resumes; finishing persists across restart and browser storage clearing; manual replay and invalid-state recovery work. No real credentials or repository writes.')
} finally {
  await app?.close().catch(() => {})
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
