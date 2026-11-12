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
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-nexus-desktop-smoke-'))
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
    // This PID is the Electron process spawned by this test; /T also reaps its local API child.
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

try {
  await fs.mkdir(dataRoot, { recursive: true })
  await fs.mkdir(chromiumProfile, { recursive: true })
  // Pin the UI language so the assertions below are deterministic regardless
  // of the Windows display language of the machine running the test.
  await fs.writeFile(path.join(dataRoot, 'desktop-settings.json'), JSON.stringify({ language: 'en-US' }, null, 2), 'utf8')

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
  const contexts = browser.contexts()
  assert.equal(contexts.length, 1, 'The running Electron app should expose one Chromium context.')

  const context = contexts[0]
  let page = context.pages()[0]
  if (!page) page = await context.waitForEvent('page', { timeout: 15_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 })
  await page.waitForFunction(() => document.title.includes('PROJECT NEXUS'), null, { timeout: 20_000 })
  assert.equal(await page.title(), 'PROJECT NEXUS — Windows Workstation')
  await page.getByRole('heading', { name: 'Workbench', exact: true }).waitFor({ timeout: 15_000 })
  await page.getByText('Online', { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(await page.evaluate(() => typeof window.nexusDesktop), 'object', 'The isolated preload bridge should be available.')

  const unauthorizedHealth = await page.evaluate(async () => {
    const response = await fetch('/api/health')
    return response.status
  })
  assert.equal(unauthorizedHealth, 401, 'The local API must reject renderer requests that do not pass through the authenticated desktop bridge.')

  const pageText = await page.locator('body').innerText()
  assert.match(pageText, /This machine is ready for local project setup/)
  assert.match(pageText, /READ-ONLY MODE/)

  console.log('PASS: Electron launched a native BrowserWindow and rendered the Windows workstation.')
  console.log('PASS: The renderer has the narrow preload bridge; direct unauthenticated local API access is rejected.')
} catch (error) {
  failed = true
  const trace = output.split(/\r?\n/).filter((line) => line.includes('NEXUS_DESKTOP_TRACE:')).join('\n')
  await fs.writeFile(path.join(tempRoot, 'electron-output.log'), output, 'utf8').catch(() => {})
  console.error(`Desktop smoke failed. Diagnostic files retained at: ${tempRoot}`)
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
