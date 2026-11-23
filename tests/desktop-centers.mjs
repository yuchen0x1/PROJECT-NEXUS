// PROJECT NEXUS 2.0 desktop acceptance: verifies the nine-center ActivityBar,
// per-center leaf sets and command-palette navigation inside the real Electron
// shell. Mirrors tests/desktop.smoke.mjs launch protocol (isolated data dir,
// pinned en-US language, CDP attach) so assertions stay deterministic.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)
const electronExecutable = require('electron')
const appRoot = path.resolve(import.meta.dirname, '..')
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-nexus-desktop-centers-'))
const dataRoot = path.join(tempRoot, 'nexus-data')
const chromiumProfile = path.join(tempRoot, 'electron-profile')
const outputLimit = 128 * 1024
const startupTimeoutMs = 45_000
const devToolsPattern = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/

let child
let browser
let output = ''
let devToolsEndpoint = null
let cleanupTimer
let childExit = null
let failed = false

function appendOutput(chunk) {
  output = (output + chunk.toString()).slice(-outputLimit)
  devToolsEndpoint ||= output.match(devToolsPattern)?.[1] || null
}

function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve()
      if (childExit) return reject(new Error(`Electron exited before ${label} (code ${childExit.code ?? 'unknown'}, signal ${childExit.signal ?? 'none'}).`))
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error(`Timed out waiting for ${label} after ${timeoutMs} ms.`))
      setTimeout(poll, 100)
    }
    poll()
  })
}

function stopProcessTree() {
  if (!child?.pid || childExit) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

try {
  await fs.mkdir(dataRoot, { recursive: true })
  await fs.mkdir(chromiumProfile, { recursive: true })
  await fs.writeFile(path.join(dataRoot, 'desktop-settings.json'), JSON.stringify({ onboardingStage: 'complete', language: 'en-US' }, null, 2), 'utf8')

  child = spawn(electronExecutable, [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${chromiumProfile}`,
    appRoot,
    '--nexus-smoke-test'
  ], {
    cwd: appRoot,
    env: {
      ...process.env,
      NEXUS_DESKTOP_DATA_DIR: dataRoot,
      ELECTRON_ENABLE_LOGGING: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', appendOutput)
  child.stderr.on('data', appendOutput)
  child.on('error', (error) => { childExit = { code: null, signal: null, error } })
  child.on('exit', (code, signal) => { childExit = { code, signal } })

  await waitFor(() => output.includes('NEXUS_DESKTOP_TRACE:app-ready'), 20_000, 'Electron app readiness')
  await waitFor(() => devToolsEndpoint, startupTimeoutMs, 'Electron DevTools endpoint')
  browser = await chromium.connectOverCDP(devToolsEndpoint, { timeout: 15_000 })
  const context = browser.contexts()[0]
  let page = context.pages()[0]
  if (!page) page = await context.waitForEvent('page', { timeout: 15_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 })
  await page.waitForFunction(() => document.title === 'PROJECT NEXUS — Windows Workstation', null, { timeout: 20_000 })
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor({ timeout: 20_000 })

  // 1. The rail renders exactly the nine 2.0 centers, in registry order.
  const expectedCenters = ['dashboard', 'repositories', 'autopilot', 'development', 'security', 'research', 'release', 'task', 'settings']
  const renderedCenters = await page.evaluate(() => Array.from(document.querySelectorAll('[data-management-center]')).map((el) => el.getAttribute('data-management-center')))
  assert.deepEqual(renderedCenters, expectedCenters, 'ActivityBar must render the nine centers in registry order.')

  // 2. Every center exposes its full leaf set; the default leaf is current.
  const expectedLeaves = {
    dashboard: ['Overview', 'Monitoring'],
    repositories: ['Projects', 'Repository Scanner', 'Issues'],
    autopilot: ['Autonomy', 'AI Operations', 'Hosting'],
    development: ['Build Center', 'AI Pipeline'],
    security: ['Security Center', 'Security Findings', 'Update Security'],
    research: ['Research'],
    release: ['Release Center', 'Auto Update'],
    task: ['Task Center', 'Integration History'],
    settings: ['Settings', 'GitHub Connections', 'Adapter Center']
  }
  for (const centerId of expectedCenters) {
    await page.locator(`[data-management-center="${centerId}"]`).click()
    const state = await page.evaluate((id) => {
      const button = document.querySelector(`[data-management-center="${id}"]`)
      const group = button?.closest('.nx-remote-center')
      const leaves = Array.from(group?.querySelectorAll('[data-management-page]') ?? []).map((leaf) => ({
        page: leaf.getAttribute('data-management-page'),
        current: leaf.getAttribute('aria-current') === 'page'
      }))
      return { expanded: button?.getAttribute('aria-expanded'), leaves }
    }, centerId)
    assert.equal(state.expanded, 'true', `Center ${centerId} must expand on click.`)
    assert.deepEqual(state.leaves.map((leaf) => leaf.page), expectedLeaves[centerId], `Center ${centerId} must keep its full legacy leaf set.`)
    const defaults = { dashboard: 'Overview', repositories: 'Projects', autopilot: 'Autonomy', development: 'Build Center', security: 'Security Center', research: 'Research', release: 'Release Center', task: 'Task Center', settings: 'Settings' }
    assert.equal(state.leaves.find((leaf) => leaf.page === defaults[centerId])?.current, true, `Center ${centerId} must open on its default leaf.`)
  }

  // 3. Visit all 21 original page identifiers through their center/leaf controls.
  // The rail shows its own localized labels (e.g. Overview → "Repository
  // overview"), so we verify reachability + aria-current rather than a
  // hardcoded label map.
  for (const [centerId, leaves] of Object.entries(expectedLeaves)) {
    // Clicking a center navigates to its default leaf and keeps it expanded,
    // so this is idempotent and guarantees the leaf list is in the DOM.
    await page.locator(`[data-management-center="${centerId}"]`).click()
    for (const leaf of leaves) {
      await page.locator(`[data-management-page="${leaf}"]`).click()
      await page.waitForFunction((pageId) => document.querySelector(`[data-management-page="${pageId}"]`)?.getAttribute('aria-current') === 'page', leaf)
      const pageLabel = (await page.locator(`[data-management-page="${leaf}"]`).innerText()).trim()
      assert.ok(pageLabel.length > 0, `Leaf ${leaf} must be reachable and display a localized label.`)
    }
  }

  // 4. Verify rail collapse/expand, without losing the active management page.
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  assert.equal(await page.locator('nav.nx-rail').getAttribute('class').then((value) => value.includes('collapsed')), true)
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  assert.equal(await page.locator('nav.nx-rail').getAttribute('class').then((value) => value.includes('collapsed')), false)

  // 5. Command palette searches and navigates directly to a legacy leaf.
  await page.keyboard.press('Control+KeyK')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.waitFor({ timeout: 10_000 })
  await palette.getByRole('textbox').fill('Update Security')
  const leafOption = palette.getByRole('option', { name: /Update Security/ }).first()
  await leafOption.waitFor({ timeout: 10_000 })
  await leafOption.click()
  await page.waitForFunction(() => document.querySelector('[data-management-page="Update Security"]')?.getAttribute('aria-current') === 'page')

  // 6. Open desktop-local settings, verify its real controls and theme/language.
  await page.getByRole('button', { name: 'App settings', exact: true }).click()
  const language = page.getByRole('combobox', { name: 'Interface language', exact: true })
  await language.waitFor({ timeout: 10_000 })
  await language.selectOption('zh-CN')
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN')
  await page.getByRole('radio', { name: '浅色', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.getByRole('radio', { name: '深色', exact: true }).click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await page.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('en-US')
  await page.waitForFunction(() => document.documentElement.lang === 'en-US')

  // 7. Settings center reads the real local API status (not placeholder UI).
  await page.locator('[data-management-center="settings"]').click()
  await page.locator('[data-management-page="Settings"]').click()
  await page.getByRole('heading', { name: 'AI provider & execution', exact: true }).waitFor({ timeout: 15_000 })
  await page.getByText('Concurrent task limit', { exact: true }).waitFor()
  await page.getByText('Desktop notifications', { exact: true }).waitFor()
  const settingsPanel = await page.locator('.settings-panel').filter({ has: page.getByRole('heading', { name: 'AI provider & execution', exact: true }) }).innerText()
  assert.match(settingsPanel, /Provider status/)
  assert.match(settingsPanel, /Concurrent task limit/)
  assert.match(settingsPanel, /Desktop notifications/)

  await fs.mkdir(path.join(appRoot, 'test-results'), { recursive: true })
  await page.screenshot({ path: path.join(appRoot, 'test-results/desktop-centers-settings.png') })

  console.log('PASS: The Electron ActivityBar renders exactly the nine 2.0 centers in registry order.')
  console.log('PASS: Every center expands to its complete legacy leaf set and opens on its default leaf.')
  console.log('PASS: All 21 legacy page identifiers are reachable through their correct center/leaf controls.')
  console.log('PASS: Center leaf switching and sidebar collapse/expand work.')
  console.log('PASS: Ctrl+K searches for and navigates directly to a legacy leaf.')
  console.log('PASS: Desktop settings language and dark/light theme controls update the document.')
  console.log('PASS: Settings center loads real AI/task runtime status from the local API.')
} catch (error) {
  failed = true
  const trace = output.split(/\r?\n/).filter((line) => line.includes('NEXUS_DESKTOP_TRACE:')).join('\n')
  await fs.writeFile(path.join(tempRoot, 'electron-output.log'), output, 'utf8').catch(() => {})
  console.error(`Desktop centers test failed. Diagnostic files retained at: ${tempRoot}`)
  if (trace) console.error(`Electron startup trace:\n${trace}`)
  if (childExit?.error) console.error(childExit.error)
  throw error
} finally {
  clearTimeout(cleanupTimer)
  await browser?.close().catch(() => {})
  stopProcessTree()
  if (child && !childExit) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => { cleanupTimer = setTimeout(resolve, 3_000) })
    ])
  }
  if (!childExit) stopProcessTree()
  if (!failed) await fs.rm(tempRoot, { recursive: true, force: true })
}
