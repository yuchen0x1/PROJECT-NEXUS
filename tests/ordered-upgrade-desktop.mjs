import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright'
import { emptyState, saveStateFile } from '../server/services/state-store.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-ordered-ui-'))
const dataDir = path.join(temporary, 'data')
const labels = JSON.parse(await fs.readFile(path.join(root, 'src/locales/en-US/git.json'), 'utf8'))
const mock = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url.includes('/git/ref/')) return res.end(JSON.stringify({ object: { sha: 'a'.repeat(40) } }))
  if (req.url.includes('/issues')) return res.end('[]')
  if (req.url === '/user') return res.end('{"login":"fixture"}')
  return res.end(JSON.stringify({ id: 1, full_name: 'fixture/one', default_branch: 'main', open_issues_count: 0, archived: false, permissions: { push: true } }))
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
let app
try {
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(path.join(dataDir, 'desktop-settings.json'), JSON.stringify({ language: 'en-US', theme: 'light' }))
  const state = structuredClone(emptyState)
  state.projects = ['one', 'two'].map((id) => ({ id, fullName: `fixture/${id}`, name: id, owner: 'fixture', defaultBranch: 'main', group: 'fixture', stack: [], hosting: { strategy: 'observe', enabled: false } }))
  state.hostedJobs = [{ id: 'delivery-failed', projectId: 'one', repository: 'fixture/one', issueNumber: 7, priority: 'P2', status: 'Blocked', executionStatus: 'Succeeded', deliveryStatus: 'Incomplete', createdAt: new Date().toISOString(), error: 'Release test failed; local changes retained.', events: [] }]
  await saveStateFile(path.join(dataDir, 'state.json'), state)
  const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: dataDir, GITHUB_TOKEN: 'fixture-only', GITHUB_API_URL: `http://127.0.0.1:${mock.address().port}`, AI_API_KEY: 'fixture-only', AI_BASE_URL: 'http://127.0.0.1:1', AI_MODEL: 'fixture', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ executablePath: require('electron'), args: [root, '--nexus-smoke-test'], env, timeout: 45000 })
  const page = await app.firstWindow()
  await page.locator('.nx-setup-entry').waitFor()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.nx-setup-entry').click()
  await page.locator('.nx-setup nav button').nth(2).click()
  await page.locator('.nx-repo-option input[value="one"]').waitFor()
  await page.locator('.nx-repo-select-none').click()
  await page.locator('.nx-repo-option input[value="one"]').check()
  await page.locator('.nx-setup-body button').last().click()
  await page.locator('.nx-setup nav button').nth(3).click()
  await page.getByRole('button', { name: labels.setup.detect, exact: true }).click()
  await page.locator('.nx-setup-complete').waitFor({ timeout: 20000 })
  await page.locator('.nx-setup nav button').nth(4).click()
  assert.equal(await page.locator('.nx-setup-consent input').isChecked(), false)
  await page.locator('.nx-setup-body button').last().click()
  await page.locator('.nx-setup-complete').waitFor()
  await page.locator('.nx-setup nav button').nth(5).click()
  await page.locator('.nx-setup-body button').click()
  await page.locator('.nx-setup-complete').waitFor({ timeout: 20000 })
  await page.locator('.nx-setup nav button').nth(6).click()
  assert.equal(await page.getByRole('button', { name: labels.hosting.enable, exact: true }).isEnabled(), true)
  await page.locator('.nx-setup nav button').nth(2).click()
  await page.locator('.nx-repo-select-none').click()
  await page.locator('.nx-repo-option input[value="two"]').check()
  await page.locator('.nx-setup nav button').nth(6).click()
  assert.equal(await page.getByRole('button', { name: labels.hosting.enable, exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.nx-rail [data-management-page]').count(), 20)
  assert.equal(await page.locator('.nx-remote-navigation').count(), 0)
  await page.locator('[data-management-page="Task Center"]').click()
  await page.locator('.hosting-run-row summary').filter({ hasText: 'fixture/one' }).click()
  assert.match(await page.locator('.hosting-run-row').innerText(), /Execution[\s\S]*Succeeded[\s\S]*Delivery[\s\S]*Incomplete/)
  await page.getByRole('button', { name: labels.upgrade.reconcile, exact: true }).click()
  await page.getByText('Remote receipts confirmed', { exact: true }).waitFor()
  const evidenceDir = path.join(root, 'docs/screenshots/ordered-upgrade')
  await fs.mkdir(evidenceDir, { recursive: true })
  await page.screenshot({ path: path.join(evidenceDir, 'task-outcomes.png') })
  assert.deepEqual(errors, [])
  console.log('PASS: Real Electron window: setup repository changes invalidate readiness; 20 remote pages share the desktop rail; failed delivery is visible separately; receipt reconciliation works.')
} finally {
  await app?.close().catch(() => {})
  await new Promise((resolve) => mock.close(resolve))
  await fs.rm(temporary, { recursive: true, force: true })
}
