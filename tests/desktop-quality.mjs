import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

// PHASE 5.1 Windows desktop quality test: real Electron runs covering window
// resizing across common sizes, the theme system (including follow-Windows
// via emulated color scheme), command-palette keyboard interaction, the
// notification center, corrupted-settings recovery, invalid-language
// fallback and window-bounds memory across restarts.

const require = createRequire(import.meta.url)
const electronExecutable = require('electron')
const appRoot = path.resolve(import.meta.dirname, '..')
const screenshotDir = path.join(appRoot, 'docs', 'screenshots', 'phase5.1')
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-phase5-1-quality-'))
const dataRoot = path.join(tempRoot, 'nexus-data')
const profilePath = path.join(tempRoot, 'electron-profile')
const settingsFile = path.join(dataRoot, 'desktop-settings.json')
const windowStateFile = path.join(dataRoot, 'window-state.json')
const outputLimit = 128 * 1024
const devToolsPattern = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/

let child = null
let childExit = null
let output = ''
let failed = false

function appendOutput(chunk) {
  output = (output + chunk.toString()).slice(-outputLimit)
}

function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve()
      if (childExit) return reject(new Error(`Electron exited before ${label} (code ${childExit.code ?? 'unknown'}).`))
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error(`Timed out waiting for ${label}.`))
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

async function launch({ settings = null, extraArgs = [] } = {}) {
  const debuggingPort = await freePort()
  output = ''
  childExit = null
  child = spawn(electronExecutable, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profilePath}`,
    ...extraArgs,
    appRoot,
    '--nexus-smoke-test'
  ], {
    cwd: appRoot,
    env: { ...process.env, NEXUS_DESKTOP_DATA_DIR: dataRoot, ELECTRON_ENABLE_LOGGING: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', appendOutput)
  child.stderr.on('data', appendOutput)
  child.on('error', (error) => { childExit = { code: null, signal: null, error } })
  child.on('exit', (code, signal) => { childExit = { code, signal } })
  await waitFor(() => output.includes('NEXUS_DESKTOP_TRACE:app-ready'), 20_000, 'app readiness')
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
  await waitFor(() => endpoint, 10_000, 'DevTools endpoint')
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 })
  const context = browser.contexts()[0]
  const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 15_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 })
  await page.locator('.nx-rail').waitFor({ timeout: 20_000 })
  if (await page.locator('.nx-setup-later').count()) await page.locator('.nx-setup-later').click()
  return { browser, page }
}

async function stop(instance) {
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

/** Emulate a viewport size so layout checks run at common window sizes. */
async function setViewportSize(page, width, height) {
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await page.setViewportSize({ width, height })
  await page.waitForTimeout(350)
}


async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const workarea = document.querySelector('.nx-workarea')
    const shell = document.querySelector('.nx-shell')
    const paletteProbe = document.documentElement.scrollWidth - document.documentElement.clientWidth
    return {
      workareaOverflow: workarea ? workarea.scrollWidth - workarea.clientWidth : -1,
      documentOverflow: paletteProbe,
      shellMin: shell ? getComputedStyle(shell).minWidth : ''
    }
  })
  assert.ok(overflow.workareaOverflow <= 2, `${label}: work area scrolls horizontally by ${overflow.workareaOverflow}px`)
  assert.ok(overflow.documentOverflow <= 2, `${label}: document scrolls horizontally by ${overflow.documentOverflow}px`)
}

try {
  await fs.mkdir(dataRoot, { recursive: true })
  await fs.mkdir(profilePath, { recursive: true })
  await fs.mkdir(screenshotDir, { recursive: true }).catch(() => {})
  await fs.writeFile(settingsFile, JSON.stringify({ onboardingStage: 'complete', language: 'en-US', theme: 'dark' }, null, 2), 'utf8')

  // ---- Launch 1: window sizes, theme system, palette, notifications ----
  let instance = await launch()
  let page = instance.page

  for (const [width, height] of [[1280, 720], [1366, 768], [1600, 900]]) {
    await setViewportSize(page, width, height)
    await assertNoHorizontalOverflow(page, `${width}x${height}`)
    if (width === 1280) await page.screenshot({ path: path.join(screenshotDir, 'window-1280x720.png') })
    console.log(`PASS: ${width}x${height} renders without horizontal overflow.`)
  }

  // Restore a comfortable size for the interaction checks.
  await setViewportSize(page, 1600, 900)

  // Theme: explicit light via the top-bar toggle.
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', null, { timeout: 5_000 })
  await page.screenshot({ path: path.join(screenshotDir, 'workbench-en-US-light.png') })
  console.log('PASS: top-bar toggle switches to light theme instantly.')

  // Follow-Windows: emulate the OS color scheme while theme=system.
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('radio', { name: 'Match Windows' }).click()
  await page.waitForFunction(() => document.documentElement.dataset.themePreference === 'system', null, { timeout: 5_000 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', null, { timeout: 5_000 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 5_000 })
  console.log('PASS: theme=system follows the emulated Windows color scheme in real time.')
  await page.emulateMedia({ colorScheme: null })

  // Command palette: keyboard navigation and empty state.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+k')
  await page.locator('.nx-palette').waitFor({ timeout: 5_000 })
  await page.locator('.nx-palette input').fill('zzzz-no-match')
  await page.locator('.nx-palette-empty').waitFor({ timeout: 3_000 })
  await page.screenshot({ path: path.join(screenshotDir, 'command-palette-empty.png') })
  await page.locator('.nx-palette input').fill('projects')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor({ timeout: 10_000 })
  await page.screenshot({ path: path.join(screenshotDir, 'projects-en-US.png') })
  console.log('PASS: command palette empty state, keyboard navigation and Enter work.')

  // Notification center: badge increments after new activity, mark-all-read clears it.
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Workbench' }).first().click()
  await page.getByRole('heading', { name: 'Workbench', exact: true }).waitFor({ timeout: 10_000 })
  const badgeBefore = await page.locator('.nx-bell-badge').count()
  await page.getByRole('button', { name: 'Recheck development tools' }).first().click()
  await page.waitForFunction((prev) => {
    const badge = document.querySelector('.nx-bell-badge')
    return Boolean(badge && (!prev || badge.textContent !== prev))
  }, badgeBefore ? String(await page.locator('.nx-bell-badge').textContent()) : '', { timeout: 20_000 })
  await page.getByRole('button', { name: 'Notification center' }).click()
  await page.locator('.nx-notification-panel').waitFor({ timeout: 5_000 })
  await page.screenshot({ path: path.join(screenshotDir, 'notification-center.png') })
  await page.getByRole('button', { name: 'Mark all as read' }).click()
  assert.equal(await page.locator('.nx-bell-badge').count(), 0, 'Badge must clear after marking all read.')
  await page.keyboard.press('Escape')
  console.log('PASS: notification badge tracks new activity and mark-all-read clears it.')

  // Environment page screenshot (deep-checks page in English).
  await page.getByRole('button', { name: 'Environment' }).first().click()
  await page.getByRole('heading', { name: 'Development environment', exact: true }).waitFor({ timeout: 10_000 })
  await page.screenshot({ path: path.join(screenshotDir, 'environment-en-US.png') })
  console.log('PASS: environment page renders in English.')

  // Window-bounds memory: seed the real window-state.json the way the app
  // itself writes it, then relaunch and confirm the bounds are restored.
  await stop(instance)
  await fs.writeFile(windowStateFile, JSON.stringify({ width: 1400, height: 860, x: 60, y: 60, maximized: false }), 'utf8')

  // ---- Launch 2: window-bounds memory + settings persistence ----
  instance = await launch()
  page = instance.page
  const bounds = await page.evaluate(() => ({ w: window.outerWidth, h: window.outerHeight }))
  assert.ok(Math.abs(bounds.w - 1400) <= 40 && Math.abs(bounds.h - 860) <= 60,
    `Window should restore approximately 1400x860, got ${bounds.w}x${bounds.h}.`)
  const savedSettings = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
  assert.equal(savedSettings.theme, 'system', 'Theme preference must persist across restarts.')
  console.log(`PASS: window bounds (${bounds.w}x${bounds.h}) and theme preference persisted across restart.`)
  await stop(instance)

  // ---- Launch 3: corrupted settings file recovers safely ----
  await fs.writeFile(settingsFile, '{ this is not valid json !!!', 'utf8')
  instance = await launch()
  page = instance.page
  // With corrupted settings the language falls back to the system locale, so
  // assert language-agnostically: the shell rendered and the language is supported.
  await page.waitForFunction(() => ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'pt-BR', 'ru-RU'].includes(document.documentElement.lang), null, { timeout: 15_000 })
  await page.locator('.nx-page-heading h1').first().waitFor({ timeout: 10_000 })
  const recoveredLanguage = await page.evaluate(() => document.documentElement.lang)
  console.log(`PASS: corrupted desktop-settings.json recovered (language=${recoveredLanguage}) without blocking startup.`)
  await stop(instance)

  // ---- Launch 4: invalid language code falls back safely ----
  await fs.writeFile(settingsFile, JSON.stringify({ onboardingStage: 'complete', language: 'xx-XX', theme: 'dark' }, null, 2), 'utf8')
  instance = await launch()
  page = instance.page
  await page.waitForFunction(() => ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'pt-BR', 'ru-RU'].includes(document.documentElement.lang), null, { timeout: 15_000 })
  console.log(`PASS: invalid language code "xx-XX" falls back safely to ${await page.evaluate(() => document.documentElement.lang)}.`)
  await stop(instance)

  // ---- Launch 5: 150% device scale factor rendering ----
  instance = await launch({ extraArgs: ['--force-device-scale-factor=1.5'] })
  page = instance.page
  const dpr = await page.evaluate(() => window.devicePixelRatio)
  assert.equal(dpr, 1.5, `Forced device scale factor should report 1.5, got ${dpr}.`)
  await assertNoHorizontalOverflow(page, '150% scale')
  await page.screenshot({ path: path.join(screenshotDir, 'workbench-150pct-scale.png') })
  console.log('PASS: 150% device scale factor renders without layout breakage.')
  await stop(instance)

  console.log('PHASE 5.1 Windows desktop quality test: ALL PASS.')
} catch (error) {
  failed = true
  await fs.mkdir(path.join(tempRoot, 'diagnostics'), { recursive: true }).catch(() => {})
  await fs.writeFile(path.join(tempRoot, 'diagnostics', 'electron-output.log'), output, 'utf8').catch(() => {})
  console.error(`Desktop quality test failed. Diagnostics retained at: ${tempRoot}`)
  throw error
} finally {
  stopProcessTree()
  if (!failed) await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}
