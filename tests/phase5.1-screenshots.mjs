import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

// PHASE 5.1 documentation screenshots (real Electron runs). Complements the
// captures taken inside tests/desktop-quality.mjs.

const require = createRequire(import.meta.url)
const electronExecutable = require('electron')
const appRoot = path.resolve(import.meta.dirname, '..')
const screenshotDir = path.join(appRoot, 'docs', 'screenshots', 'phase5.1')
const outputLimit = 128 * 1024
const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-phase5-1-shots-'))

let child = null
let childExit = null
let output = ''

const labels = {}
async function useLabels(language) {
  const load = async (namespace) => JSON.parse(await fs.readFile(path.join(appRoot, 'src', 'locales', language, `${namespace}.json`), 'utf8'))
  const [navigation, agent, settings, environment] = await Promise.all([
    load('navigation'), load('agent'), load('settings'), load('environment')
  ])
  labels.railWorkbench = navigation.rail.workbench
  labels.railAgent = navigation.rail.agent
  labels.railEnvironment = navigation.rail.environment
  labels.openSettings = navigation.topbar.settings
  labels.agentTitle = agent.page.title
  labels.settingsTitle = settings.page.title
  labels.environmentTitle = environment.page.title
  labels.agentNav = navigation.rail.agent
}

function appendOutput(chunk) {
  output = (output + chunk.toString()).slice(-outputLimit)
}

function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve()
      if (childExit) return reject(new Error(`Electron exited before ${label}.`))
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

async function launch(language, theme) {
  const dataRoot = path.join(workspaceRoot, `data-${language}-${theme}`)
  const profilePath = path.join(workspaceRoot, `profile-${language}-${theme}`)
  await fs.mkdir(dataRoot, { recursive: true })
  await fs.mkdir(profilePath, { recursive: true })
  await fs.writeFile(path.join(dataRoot, 'desktop-settings.json'), JSON.stringify({ language, theme }, null, 2), 'utf8')
  const debuggingPort = await freePort()
  output = ''
  childExit = null
  child = spawn(electronExecutable, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profilePath}`,
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
  await page.waitForFunction((lang) => document.documentElement.lang === lang, language, { timeout: 15_000 })
  await useLabels(language)
  await page.waitForTimeout(2500)
  return { browser, page }
}

async function stop(browser) {
  await browser?.close().catch(() => {})
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

async function capture(language, theme, shots) {
  const { browser, page } = await launch(language, theme)
  try {
    for (const shot of shots) {
      if (shot.page === 'workbench') await page.getByRole('button', { name: labels.railWorkbench }).first().click()
      if (shot.page === 'agent') await page.getByRole('button', { name: labels.railAgent }).first().click()
      if (shot.page === 'environment') await page.getByRole('button', { name: labels.railEnvironment }).first().click()
      if (shot.page === 'settings') await page.getByRole('button', { name: labels.openSettings }).click()
      if (shot.page === 'palette') {
        await page.keyboard.press('Control+k')
        await page.locator('.nx-palette').waitFor({ timeout: 5_000 })
        await page.locator('.nx-palette input').fill(labels.agentNav.slice(0, 3))
      }
      await page.waitForTimeout(700)
      await page.screenshot({ path: path.join(screenshotDir, shot.file) })
      console.log(`captured ${shot.file}`)
    }
  } finally {
    await stop(browser)
  }
}

try {
  await fs.mkdir(screenshotDir, { recursive: true })
  await capture('zh-CN', 'dark', [
    { page: 'workbench', file: 'workbench-zh-CN-dark.png' },
    { page: 'settings', file: 'settings-language-zh-CN.png' },
    { page: 'palette', file: 'command-palette-zh-CN.png' }
  ])
  await capture('ja-JP', 'dark', [
    { page: 'workbench', file: 'workbench-ja-JP-dark.png' },
    { page: 'agent', file: 'agent-ja-JP.png' }
  ])
  await capture('en-US', 'dark', [
    { page: 'workbench', file: 'workbench-en-US-dark.png' }
  ])
  await capture('de-DE', 'dark', [
    { page: 'workbench', file: 'workbench-de-DE-dark.png' },
    { page: 'environment', file: 'environment-de-DE.png' }
  ])
  console.log('PASS: Phase 5.1 screenshots captured from the running Windows desktop application.')
} catch (error) {
  await fs.mkdir(path.join(workspaceRoot, 'diagnostics'), { recursive: true }).catch(() => {})
  await fs.writeFile(path.join(workspaceRoot, 'diagnostics', 'electron-output.log'), output, 'utf8').catch(() => {})
  console.error(`Screenshot capture failed. Diagnostics retained at: ${workspaceRoot}`)
  throw error
}
