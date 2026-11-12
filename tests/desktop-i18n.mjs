import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

// Phase 5 desktop acceptance: real Electron run covering first-launch language
// detection, in-app language switching, persistence across restart, the theme
// system and the command palette. Mirrors the harness used by desktop.smoke.mjs.
// The test is language-agnostic: selectors are resolved from the locale files
// of whichever language the app is currently displaying.

const require = createRequire(import.meta.url)
const electronExecutable = require('electron')
const appRoot = path.resolve(import.meta.dirname, '..')
const screenshotDir = path.join(appRoot, 'docs', 'screenshots', 'phase5')
const localesDir = path.join(appRoot, 'src', 'locales')
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-phase5-i18n-'))
const dataRoot = path.join(tempRoot, 'nexus-data')
const profilePath = path.join(tempRoot, 'electron-profile')
const outputLimit = 128 * 1024
const devToolsPattern = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/

let child = null
let browser = null
let output = ''
let childExit = null
let failed = false

const labels = {}

/** Load the UI strings of a language for selector resolution. */
async function useLabels(language) {
  const load = async (namespace) => JSON.parse(await fs.readFile(path.join(localesDir, language, `${namespace}.json`), 'utf8'))
  const [navigation, settings, agent, environment, common] = await Promise.all([
    load('navigation'), load('settings'), load('agent'), load('environment'), load('common')
  ])
  labels.railWorkbench = navigation.rail.workbench
  labels.railEnvironment = navigation.rail.environment
  labels.openSettings = navigation.topbar.settings
  labels.settingsTitle = settings.page.title
  labels.agentTitle = agent.page.title
  labels.environmentTitle = environment.page.title
  labels.themeToggle = common.theme.toggle
  labels.commandPaletteTitle = navigation.commandPalette.title
  labels.agentNav = navigation.rail.agent
}

function appendOutput(chunk) {
  output = (output + chunk.toString()).slice(-outputLimit)
}

function resetOutput() {
  output = ''
}

function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve()
      if (childExit) return reject(new Error(`Electron exited before ${label} (code ${childExit.code ?? 'unknown'}).`))
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error(`Timed out waiting for ${label} after ${timeoutMs} ms.`))
      setTimeout(poll, 100)
    }
    poll()
  })
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function stopProcessTree() {
  if (!child?.pid || childExit) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

async function launchWorkstation() {
  const debuggingPort = await freePort()
  resetOutput()
  childExit = null
  child = spawn(electronExecutable, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profilePath}`,
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
  await waitFor(() => output.includes('NEXUS_DESKTOP_TRACE:local-service-ready'), 45_000, 'local service readiness')
  const devToolsUrl = `http://127.0.0.1:${debuggingPort}/json/version`
  let endpoint = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const version = await fetch(devToolsUrl).then((response) => response.json())
      if (version.webSocketDebuggerUrl) { endpoint = version.webSocketDebuggerUrl; break }
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await waitFor(() => endpoint, 10_000, 'Electron DevTools endpoint')
  const instanceBrowser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 })
  const context = instanceBrowser.contexts()[0]
  assert.ok(context, 'The launched Electron app should expose a Chromium context.')
  const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 15_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 })
  return { browser: instanceBrowser, page }
}

async function stopWorkstation(instance) {
  await instance?.browser?.close().catch(() => {})
  stopProcessTree()
  if (child && !childExit) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000))
    ])
  }
  if (!childExit) stopProcessTree()
  await new Promise((resolve) => setTimeout(resolve, 400))
  child = null
}

async function activeLanguage(page) {
  return page.evaluate(() => document.documentElement.lang)
}

async function selectLanguage(page, code) {
  await page.getByRole('button', { name: labels.openSettings }).click()
  await page.locator('.nx-language-select select').waitFor({ timeout: 10_000 })
  await page.locator('.nx-language-select select').selectOption(code)
  // The switch is async: resources load, i18next changes language, React re-renders.
  await page.waitForFunction((lang) => document.documentElement.lang === lang, code, { timeout: 15_000 })
  await useLabels(code)
}

async function openRailPage(page, railLabel) {
  await page.getByRole('button', { name: railLabel }).first().click()
}

try {
  await fs.mkdir(dataRoot, { recursive: true })
  await fs.mkdir(profilePath, { recursive: true })
  await fs.mkdir(screenshotDir, { recursive: true }).catch(() => {})

  // ---- Launch 1: first start with no saved language (system detection) ----
  let instance = await launchWorkstation()
  let page = instance.page
  await page.locator('.nx-rail').waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'pt-BR', 'ru-RU'].includes(document.documentElement.lang), null, { timeout: 15_000 })
  const detected = await activeLanguage(page)
  await useLabels(detected)
  console.log(`PASS: first launch resolved the system locale to "${detected}" and rendered the workstation.`)

  // ---- Switch to Simplified Chinese through Settings ----
  await selectLanguage(page, 'zh-CN')
  await page.getByRole('heading', { name: labels.settingsTitle, exact: true }).waitFor({ timeout: 10_000 })
  assert.equal(await activeLanguage(page), 'zh-CN')
  const savedAfterSwitch = JSON.parse(await fs.readFile(path.join(dataRoot, 'desktop-settings.json'), 'utf8'))
  assert.equal(savedAfterSwitch.language, 'zh-CN', 'The language choice must be persisted immediately.')
  await page.screenshot({ path: path.join(screenshotDir, 'settings-zh-CN.png') })
  console.log('PASS: switching to Simplified Chinese updates the UI instantly and persists desktop-settings.json.')

  // ---- Workbench page in Chinese ----
  await openRailPage(page, labels.railWorkbench)
  await page.getByRole('heading', { name: labels.railWorkbench, exact: true }).waitFor({ timeout: 10_000 })
  await page.screenshot({ path: path.join(screenshotDir, 'workbench-zh-CN.png') })
  console.log('PASS: the workbench page renders fully translated in Simplified Chinese.')

  // ---- Switch to Japanese, then English ----
  await selectLanguage(page, 'ja-JP')
  await page.getByRole('heading', { name: labels.settingsTitle, exact: true }).waitFor({ timeout: 10_000 })
  assert.equal(await activeLanguage(page), 'ja-JP')
  await selectLanguage(page, 'en-US')
  await page.getByRole('heading', { name: labels.settingsTitle, exact: true }).waitFor({ timeout: 10_000 })
  assert.equal(await activeLanguage(page), 'en-US')
  console.log('PASS: switching to Japanese and back to English works without restart.')

  // ---- Theme toggle flips the resolved theme on <html> ----
  const before = await page.locator('html').getAttribute('data-theme')
  await page.getByRole('button', { name: labels.themeToggle }).click()
  await page.waitForFunction((previous) => document.documentElement.getAttribute('data-theme') !== previous, before, { timeout: 5_000 })
  const after = await page.locator('html').getAttribute('data-theme')
  assert.ok(['dark', 'light'].includes(after), `data-theme should be dark or light, got "${after}".`)
  await page.screenshot({ path: path.join(screenshotDir, `settings-${after}-theme.png`) })
  await page.getByRole('button', { name: labels.themeToggle }).click()
  console.log(`PASS: theme toggle flips the document theme (${before} → ${after}).`)

  // ---- Command palette navigation (works in every language: Ctrl+K) ----
  await page.keyboard.press('Control+k')
  await page.locator('.nx-palette').waitFor({ timeout: 5_000 })
  await page.locator('.nx-palette input').fill(labels.agentNav)
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: labels.agentTitle, exact: true }).waitFor({ timeout: 10_000 })
  await page.screenshot({ path: path.join(screenshotDir, 'agent-page.png') })
  console.log('PASS: the command palette opens with Ctrl+K and navigates to the AI Agent page.')

  // ---- Leave the app in Japanese and close it ----
  await selectLanguage(page, 'ja-JP')
  await page.getByRole('heading', { name: labels.settingsTitle, exact: true }).waitFor({ timeout: 10_000 })
  await page.screenshot({ path: path.join(screenshotDir, 'settings-ja-JP.png') })
  await stopWorkstation(instance)
  console.log('PASS: the application closed cleanly with Japanese selected.')

  // ---- Launch 2: the saved language must survive the restart ----
  instance = await launchWorkstation()
  page = instance.page
  await page.locator('.nx-rail').waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => document.documentElement.lang === 'ja-JP', null, { timeout: 15_000 })
  await useLabels('ja-JP')
  await openRailPage(page, labels.railWorkbench)
  await page.getByRole('heading', { name: labels.railWorkbench, exact: true }).waitFor({ timeout: 10_000 })
  await page.screenshot({ path: path.join(screenshotDir, 'workbench-ja-JP.png') })
  console.log('PASS: after a full restart the workstation restored Japanese without overriding the user choice.')

  // ---- Environment page renders in Japanese after restart ----
  await openRailPage(page, labels.railEnvironment)
  await page.getByRole('heading', { name: labels.environmentTitle, exact: true }).waitFor({ timeout: 10_000 })
  const envText = await page.locator('body').innerText()
  assert.ok(!envText.includes('undefined'), 'No undefined placeholders may leak into the rendered page.')
  await stopWorkstation(instance)
  console.log('PASS: the environment page renders translated after restart; the acceptance flow completed.')
} catch (error) {
  failed = true
  await fs.mkdir(path.join(tempRoot, 'diagnostics'), { recursive: true }).catch(() => {})
  await fs.writeFile(path.join(tempRoot, 'diagnostics', 'electron-output.log'), output, 'utf8').catch(() => {})
  console.error(`Desktop i18n acceptance failed. Temporary data and logs retained at: ${tempRoot}`)
  if (childExit?.error) console.error(childExit.error)
  throw error
} finally {
  await browser?.close().catch(() => {})
  stopProcessTree()
  if (!failed) await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}
