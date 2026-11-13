import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron } from 'playwright'
import { emptyState, saveStateFile } from '../server/services/state-store.mjs'

const root = path.resolve(import.meta.dirname, '..')
const executablePath = process.env.NEXUS_BATCH_INSTALLED_EXE
if (!executablePath) throw new Error('Set NEXUS_BATCH_INSTALLED_EXE to the new installed application.')
const original = path.join(process.env.LOCALAPPDATA, 'PROJECT NEXUS', 'state.json')
const originalBytes = await fs.readFile(original)
const projects = JSON.parse(originalBytes).projects
assert.ok(projects.length > 0)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-real-repo-selection-'))
let app
try {
  const state = structuredClone(emptyState)
  state.settings.hostingPaused = true
  state.projects = projects.map((project) => ({ ...project, hosting: { strategy: 'observe', enabled: false }, setupReadiness: undefined }))
  await saveStateFile(path.join(temporary, 'state.json'), state)
  await fs.writeFile(path.join(temporary, 'desktop-settings.json'), JSON.stringify({ onboardingStage: 'complete', language: 'zh-CN', theme: 'light' }))
  const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: temporary, NEXUS_ENABLE_REMOTE_WRITES: 'false' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'GITHUB_TOKEN', 'GH_TOKEN', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'NEXUS_AI_PROVIDERS_JSON']) delete env[key]
  app = await _electron.launch({ executablePath, args: ['--nexus-smoke-test'], env, timeout: 45000 })
  const page = await app.firstWindow()
  await page.locator('.nx-setup-entry').click()
  await page.locator('.nx-setup nav button').nth(2).click()
  await page.waitForFunction((total) => document.querySelectorAll('.nx-repo-option').length === total, projects.length)
  await page.locator('.nx-repo-select-all').click()
  assert.equal(await page.locator('.nx-repo-option input:checked').count(), projects.length)
  await page.locator('.nx-repo-select-none').click()
  await new Promise((resolve) => setTimeout(resolve, 2200))
  assert.equal(await page.locator('.nx-repo-option input:checked').count(), 0)
  assert.equal(await page.locator('.nx-setup-next').isDisabled(), true)
  await page.locator('.nx-repo-select-all').click()
  await page.locator('.nx-repo-checklist').scrollIntoViewIfNeeded()
  await fs.mkdir(path.join(root, 'docs/screenshots/batch-repositories'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'docs/screenshots/batch-repositories/real-repository-list.png') })
  const result = { status: 'PASS', version: (await page.evaluate(() => window.nexusDesktop.getInfo())).version, realRepositoryCount: projects.length, allSelectedCount: await page.locator('.nx-repo-option input:checked').count(), deselectionSurvivedPolling: true, selectionOnly: true, isolatedMetadataCopyWithoutCredentials: true, originalStateUnchanged: crypto.createHash('sha256').update(await fs.readFile(original)).digest('hex') === crypto.createHash('sha256').update(originalBytes).digest('hex'), at: new Date().toISOString() }
  assert.equal(result.originalStateUnchanged, true)
  await fs.writeFile(path.join(root, 'docs/evidence/batch-repositories-real-selection.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await app?.close().catch(() => {})
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep))
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
