// Explicit read-only acceptance against the user's configured provider. Work
// from a disposable credential copy, never save or enable real project tasks.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const executablePath = process.env.NEXUS_MODEL_PICKER_EXE
if (!executablePath) throw new Error('Set NEXUS_MODEL_PICKER_EXE to the new desktop executable.')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-live-model-list-'))
const realData = path.join(process.env.LOCALAPPDATA, 'PROJECT NEXUS')
let app
try {
  for (const file of ['ai-providers.json', 'provider-keys.json']) await fs.copyFile(path.join(realData, file), path.join(temporary, file))
  // Chromium's encrypted safeStorage key lives in sessionData/Local State.
  // Copy it as well so this Windows user can decrypt the disposable vault.
  await fs.mkdir(path.join(temporary, 'cache'), { recursive: true })
  await fs.copyFile(path.join(realData, 'cache', 'Local State'), path.join(temporary, 'cache', 'Local State'))
  await fs.writeFile(path.join(temporary, 'desktop-settings.json'), JSON.stringify({ onboardingStage: 'complete', language: 'zh-CN', theme: 'light' }))
  const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: temporary, NEXUS_ENABLE_REMOTE_WRITES: 'false' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'GITHUB_TOKEN', 'GH_TOKEN', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'NEXUS_AI_PROVIDERS_JSON']) delete env[key]
  app = await _electron.launch({ executablePath, args: ['--nexus-smoke-test'], env, timeout: 45000 })
  const page = await app.firstWindow()
  await page.locator('.nx-setup-entry').waitFor()
  await page.locator('.nx-setup-entry').click()
  await page.locator('.nx-setup nav button').nth(1).click()
  await page.waitForFunction(() => document.querySelector('.nx-model-picker input')?.value)
  assert.equal(await page.locator('.nx-setup-body input[type="password"]').inputValue(), '')
  const selectedModel = await page.locator('.nx-model-picker input').inputValue()
  await page.locator('.nx-model-fetch').click()
  await page.waitForFunction(() => Boolean(document.querySelector('.nx-model-select, .nx-model-error')), null, { timeout: 25000 })
  const error = await page.locator('.nx-model-error').count() ? await page.locator('.nx-model-error').innerText() : null
  const models = await page.locator('.nx-model-select option').evaluateAll((items) => items.map((item) => item.value).filter(Boolean))
  const result = { status: models.length ? 'PASS' : 'BLOCKED', installedVersion: (await page.evaluate(() => window.nexusDesktop.getInfo())).version, realProvider: true, disposableCredentialCopy: true, modelCount: models.length, savedModelListed: models.includes(selectedModel), savedKeyStayedHidden: true, error, at: new Date().toISOString() }
  if (models.length) {
    assert.equal(models.includes(selectedModel), true)
    await page.locator('.nx-model-select').selectOption(selectedModel)
    await page.locator('.nx-model-select').evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await fs.mkdir(path.join(root, 'docs/screenshots/model-picker'), { recursive: true })
    await page.screenshot({ path: path.join(root, 'docs/screenshots/model-picker/live-provider.png') })
  }
  await fs.writeFile(path.join(root, 'docs/evidence/model-picker-live.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await app?.close().catch(() => {})
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep))
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
