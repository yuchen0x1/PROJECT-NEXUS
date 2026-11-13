import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createRequire } from 'node:module'
import { _electron } from 'playwright'
import { emptyState, saveStateFile } from '../server/services/state-store.mjs'

const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-sync-desktop-'))
const labels = JSON.parse(await fs.readFile(path.join(root, 'src/locales/zh-CN/git.json'), 'utf8'))
let remoteCount = 25, requests = 0
const repos = (count) => Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `repo-${index + 1}`, full_name: `fixture/repo-${index + 1}`, owner: { login: 'fixture' }, archived: false, default_branch: 'main' }))
const mock = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url === '/user') return res.end('{"login":"fixture","avatar_url":""}')
  if (req.url.startsWith('/user/repos')) {
    requests++
    return setTimeout(() => { res.setHeader('etag', `"repos-${remoteCount}"`); res.end(JSON.stringify(repos(remoteCount))) }, 400)
  }
  res.statusCode = 404; res.end('{}')
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
let app
try {
  const state = structuredClone(emptyState)
  state.settings.hostingPaused = true
  state.repositorySync = { nextSyncAt: new Date(Date.now() + 60_000).toISOString() }
  state.projects = repos(26).map((repo) => ({ ...repo, id: `repo_${repo.id}`, githubId: repo.id, owner: 'fixture', fullName: repo.full_name, stack: [], hosting: { enabled: false } }))
  await saveStateFile(path.join(temporary, 'state.json'), state)
  await fs.writeFile(path.join(temporary, 'desktop-settings.json'), JSON.stringify({ language: 'zh-CN', theme: 'light' }))
  const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: temporary, GITHUB_API_URL: `http://127.0.0.1:${mock.address().port}`, NEXUS_ENABLE_REMOTE_WRITES: 'false' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_OWNER', 'AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL', 'NEXUS_AI_PROVIDERS_JSON']) delete env[key]
  const executablePath = process.env.NEXUS_SYNC_TEST_EXECUTABLE || require('electron')
  app = await _electron.launch({ executablePath, args: process.env.NEXUS_SYNC_TEST_EXECUTABLE ? ['--nexus-smoke-test'] : [root, '--nexus-smoke-test'], env, timeout: 45000 })
  const page = await app.firstWindow()
  const errors = []; page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.nx-setup-entry').waitFor()
  await page.evaluate(() => window.nexusDesktop.connectGitHub('sync-fixture-token'))
  await page.locator('[data-management-page="Overview"]').click()
  await page.waitForFunction(() => document.querySelector('.metric-value')?.textContent === '26')
  await page.getByRole('button', { name: labels.overview.syncGithub, exact: true }).dblclick()
  await page.getByText(labels.syncStatus.running, { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.metric-value')?.textContent === '25')
  assert.equal(requests, 1, 'Repeated manual clicks must share one GitHub request.')
  await page.getByText(labels.syncStatus.completed, { exact: true }).waitFor()
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'test-results/repository-sync-after-manual.png') })
  await page.locator('[data-management-page="Projects"]').click()
  await page.waitForFunction(() => document.querySelector('.data-count')?.textContent === '25')
  await page.locator('[data-management-page="Overview"]').click()
  await page.waitForTimeout(6000)
  assert.equal(requests, 1, 'Fast local status refresh must not poll GitHub.')
  remoteCount = 24
  await page.waitForFunction(() => document.querySelector('.metric-value')?.textContent === '24', null, { timeout: 75_000 })
  assert.equal(requests, 2, 'A single automatic sync must run after the 60-second interval.')
  await page.waitForFunction(async () => !(await window.nexusDesktop.requestApi({ url: '/api/repository-sync' })).body.running)
  const persisted = JSON.parse(await fs.readFile(path.join(temporary, 'state.json'), 'utf8'))
  assert.equal(persisted.projects.length, 26, 'Historical records must remain present.')
  assert.equal(persisted.projects.filter((project) => project.repositoryAvailable !== false).length, 24)
  assert.deepEqual(errors, [])
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'test-results/repository-sync-current-count.png') })
  console.log('PASS: Native manual sync 26→25, duplicate-click coalescing, consistent lists, local polling without GitHub calls, and one real 60-second automatic sync 25→24. Historical records retained; fixture GitHub only.')
} finally {
  await app?.close().catch(() => {})
  await new Promise((resolve) => mock.close(resolve))
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
