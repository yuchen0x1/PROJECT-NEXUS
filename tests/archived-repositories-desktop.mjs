import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { _electron } from 'playwright'
import { emptyState, saveStateFile } from '../server/services/state-store.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-archive-selection-'))
const labels = JSON.parse(await fs.readFile(path.join(root, 'src/locales/zh-CN/git.json'), 'utf8'))
const repositories = [
  { id: 1, name: 'archived-project', archived: true }, { id: 2, name: 'active-project', archived: false },
  { id: 3, name: 'second-project', archived: false }, { id: 4, name: 'legacy-archive', archived: true }
].map((repo) => ({ ...repo, full_name: `fixture/${repo.name}`, owner: { login: 'fixture' }, default_branch: 'main' }))
const mock = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/user') return res.end('{"login":"fixture","avatar_url":""}')
  if (req.url.startsWith('/user/repos')) return res.end(JSON.stringify(repositories))
  res.statusCode = 404; res.end('{}')
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
let app
try {
  const state = structuredClone(emptyState)
  state.settings.hostingPaused = true
  state.projects = repositories.map((repo) => ({ id: `repo_${repo.id}`, name: repo.name, fullName: repo.full_name, owner: 'fixture', defaultBranch: 'main', stack: [], ...(repo.id === 4 ? { repoMeta: { archived: true } } : { archived: repo.archived }), hosting: { enabled: false, strategy: 'observe' } }))
  await saveStateFile(path.join(temporary, 'state.json'), state)
  await fs.writeFile(path.join(temporary, 'desktop-settings.json'), JSON.stringify({ language: 'zh-CN', theme: 'light' }))
  const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: temporary, GITHUB_API_URL: `http://127.0.0.1:${mock.address().port}`, NEXUS_ENABLE_REMOTE_WRITES: 'false' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_OWNER', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'NEXUS_AI_PROVIDERS_JSON']) delete env[key]
  const executablePath = process.env.NEXUS_ARCHIVE_TEST_EXECUTABLE || require('electron')
  app = await _electron.launch({ executablePath, args: process.env.NEXUS_ARCHIVE_TEST_EXECUTABLE ? ['--nexus-smoke-test'] : [root, '--nexus-smoke-test'], env, timeout: 45000 })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.nx-setup-entry').waitFor()
  await page.evaluate(() => window.nexusDesktop.connectGitHub('archive-fixture-token'))
  await page.locator('.nx-setup-entry').click()
  await page.locator('.nx-setup nav button').nth(2).click()
  await page.locator('.nx-repo-option input[value="repo_2"]').waitFor()
  assert.equal(await page.locator('.nx-repo-option').count(), 2)
  assert.equal(await page.locator('.nx-repo-option input:checked').getAttribute('value'), 'repo_2', 'Default selection must skip an archived first repository.')
  assert.equal(await page.locator('.nx-repo-status.active').count(), 2)
  await page.locator('#setup-show-archived').check()
  assert.equal(await page.locator('.nx-repo-status.archived').count(), 2)
  for (const id of ['repo_1', 'repo_4']) assert.equal(await page.locator(`.nx-repo-option input[value="${id}"]`).isDisabled(), true)
  await page.locator('.nx-repo-select-all').click()
  assert.equal(await page.locator('.nx-repo-option input:checked').count(), 2)
  assert.equal(await page.locator('.nx-repo-selection-count').innerText(), labels.batch.selected.replace('{{selected}}', '2').replace('{{total}}', '2'))
  await page.locator('#setup-repository-search').fill('archived-project')
  assert.equal(await page.locator('.nx-repo-option').count(), 1)
  await page.locator('.nx-repo-select-none').click()
  await page.locator('.nx-repo-select-all').click()
  await page.locator('#setup-repository-search').fill('')
  await page.locator('.nx-repo-option input[value="repo_3"]').uncheck()
  await page.waitForTimeout(2200)
  assert.equal(await page.locator('.nx-repo-option input:checked').count(), 1, 'Polling must preserve manual deselection.')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 720))
  const rowsFit = await page.locator('.nx-repo-option').evaluateAll((rows) => rows.every((row) => {
    const name = row.querySelector('.nx-repo-name').getBoundingClientRect()
    const status = row.querySelector('.nx-repo-status').getBoundingClientRect()
    return name.right <= status.left + 1 && status.right <= row.getBoundingClientRect().right + 1
  }))
  assert.equal(rowsFit, true, 'Repository names and archive badges must remain separate in a narrow window.')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'test-results/archived-repositories-visible.png') })
  await page.locator('#setup-show-archived').uncheck()
  await page.screenshot({ path: path.join(root, 'test-results/archived-repositories-default.png') })
  const sync = async () => {
    const response = await page.evaluate(() => window.nexusDesktop.requestApi({ url: '/api/tasks/sync-repositories', method: 'POST', body: '{}' }))
    assert.equal(response.status, 202)
    const taskId = response.body.task.id
    await page.waitForFunction(async (id) => {
      const result = await window.nexusDesktop.requestApi({ url: '/api/tasks' })
      return result.body.tasks.find((task) => task.id === id)?.status === 'Success'
    }, taskId)
  }
  repositories[1].archived = true
  await sync()
  await page.waitForFunction(() => document.querySelectorAll('.nx-repo-option').length === 1 && document.querySelectorAll('.nx-repo-option input:checked').length === 0)
  assert.equal(await page.locator('.nx-setup-next').isDisabled(), true)
  repositories[2].archived = true
  await sync()
  await page.getByText(labels.batch.noActive, { exact: true }).waitFor()
  assert.equal(await page.locator('.nx-repo-select-all').isDisabled(), true)
  repositories[3].archived = false
  await sync()
  await page.locator('.nx-repo-option input[value="repo_4"]').waitFor()
  assert.equal(await page.locator('.nx-repo-option input[value="repo_4"]').isDisabled(), false, 'Unarchive sync must override stale legacy archive metadata.')
  await page.locator('.nx-repo-select-all').click()
  await page.locator('.nx-setup-body').getByRole('button', { name: '确认', exact: true }).click()
  await page.locator('.nx-setup nav button').nth(2).locator('svg').waitFor()
  assert.equal(await page.locator('.nx-repo-option input:checked').count(), 1)
  assert.deepEqual(errors, [])
  const persisted = JSON.parse(await fs.readFile(path.join(temporary, 'state.json'), 'utf8'))
  assert.equal(persisted.projects.length, 4)
  assert.equal(persisted.projects.some((project) => project.hosting.enabled), false)
  console.log('PASS: Native repository status badges, default hiding, archived-row exclusion, selection counts, search/select-all, polling, newly archived deselection, all-archived state and unarchive sync. No real repository writes.')
} finally {
  await app?.close().catch(() => {})
  await new Promise((resolve) => mock.close(resolve))
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
