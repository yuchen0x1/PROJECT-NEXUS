import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'

const executablePath = process.env.NEXUS_INSTALLED_EXE?.trim()
if (!executablePath) throw new Error('Set NEXUS_INSTALLED_EXE to the full path of the freshly installed PROJECT NEXUS.exe.')

const installedExe = path.resolve(executablePath)
const executableInfo = await fs.stat(installedExe).catch(() => null)
if (!executableInfo?.isFile()) throw new Error(`NEXUS_INSTALLED_EXE is not a file: ${installedExe}`)

const tempLocalAppData = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-installed-package-smoke-'))
const expectedDataPath = path.join(tempLocalAppData, 'PROJECT NEXUS')
// Pin the UI language so the assertions below stay deterministic regardless
// of the Windows display language of the machine running the test.
await fs.mkdir(expectedDataPath, { recursive: true })
await fs.writeFile(path.join(expectedDataPath, 'desktop-settings.json'), JSON.stringify({ language: 'en-US' }, null, 2), 'utf8')
const keepTempDataForUninstallCheck = process.env.NEXUS_KEEP_INSTALLED_SMOKE_DATA === 'true'
const outputLimit = 128 * 1024
const startupTimeoutMs = 45_000
let child
let browser
let output = ''
let childExit = null
let failed = false

function appendOutput(chunk) {
  output = (output + chunk.toString()).slice(-outputLimit)
}

function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve()
      if (childExit) return reject(new Error(`Installed application exited before ${label} (code ${childExit.code ?? 'unknown'}, signal ${childExit.signal ?? 'none'}).`))
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

function stopTestProcessTree() {
  if (!child?.pid || childExit) return
  if (process.platform === 'win32') {
    // This is the PID created by this test; /T cleans up only its Electron and local-service descendants.
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

try {
  const debuggingPort = await freePort()
  const childEnv = { ...process.env, LOCALAPPDATA: tempLocalAppData, ELECTRON_ENABLE_LOGGING: '1' }
  // Avoid accidentally inheriting a development smoke override from the invoking shell.
  delete childEnv.NEXUS_DESKTOP_DATA_DIR
  delete childEnv.NEXUS_LOCAL_API_TOKEN

  child = spawn(installedExe, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debuggingPort}`
  ], {
    cwd: path.dirname(installedExe),
    env: childEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', appendOutput)
  child.stderr.on('data', appendOutput)
  child.on('error', (error) => { childExit = { code: null, signal: null, error } })
  child.on('exit', (code, signal) => { childExit = { code, signal } })

  const devToolsUrl = `http://127.0.0.1:${debuggingPort}/json/version`
  let devToolsEndpoint = null
  const startedAt = Date.now()
  while (!devToolsEndpoint && Date.now() - startedAt < startupTimeoutMs) {
    if (childExit) throw new Error(`Installed application exited during startup (code ${childExit.code ?? 'unknown'}, signal ${childExit.signal ?? 'none'}).`)
    try {
      const response = await fetch(devToolsUrl)
      if (response.ok) devToolsEndpoint = (await response.json()).webSocketDebuggerUrl || null
    } catch {}
    if (!devToolsEndpoint) await new Promise((resolve) => setTimeout(resolve, 150))
  }
  await waitFor(() => Boolean(devToolsEndpoint), startupTimeoutMs, 'loopback DevTools endpoint')

  browser = await chromium.connectOverCDP(devToolsEndpoint, { timeout: 15_000 })
  const contexts = browser.contexts()
  assert.equal(contexts.length, 1, 'The installed Electron app should expose one Chromium context.')
  const context = contexts[0]
  const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 15_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 })
  await page.waitForFunction(() => document.title.includes('PROJECT NEXUS'), null, { timeout: 30_000 })
  assert.equal(await page.title(), 'PROJECT NEXUS — Windows Workstation')
  await page.getByRole('heading', { name: 'Workbench', exact: true }).waitFor({ timeout: 20_000 })
  await page.getByText('Online', { exact: true }).waitFor({ timeout: 20_000 })

  const bridgeInfo = await page.evaluate(async () => {
    if (!window.nexusDesktop) throw new Error('The installed renderer has no desktop preload bridge.')
    return await window.nexusDesktop.getInfo()
  })
  const normalizedExpected = path.resolve(expectedDataPath).toLowerCase()
  const normalizedActual = path.resolve(bridgeInfo.dataPath).toLowerCase()
  assert.equal(normalizedActual, normalizedExpected, 'The installed app must store data under the temporary LOCALAPPDATA profile.')

  const bridgeHealth = await page.evaluate(async () => await window.nexusDesktop.requestApi({ url: '/api/health' }))
  assert.equal(bridgeHealth.status, 200, 'The authenticated desktop bridge should reach the packaged local API.')
  assert.equal(bridgeHealth.body.ok, true)
  assert.equal(bridgeHealth.body.service, 'project-nexus')

  const directHealthStatus = await page.evaluate(async () => {
    const response = await fetch('/api/health')
    return response.status
  })
  assert.equal(directHealthStatus, 401, 'Direct renderer API calls must remain unauthenticated and rejected.')

  const statePath = path.join(expectedDataPath, 'state.json')
  const logPath = path.join(expectedDataPath, 'logs', 'workstation.log')
  const persistedState = JSON.parse(await fs.readFile(statePath, 'utf8'))
  assert.equal(typeof persistedState.schemaVersion, 'number', 'The app should initialize its per-user persisted state.')
  const logStat = await fs.stat(logPath)
  assert.ok(logStat.isFile() && logStat.size > 0, 'The desktop should write its startup log under the temporary profile.')

  const screenshotDir = path.resolve(import.meta.dirname, '../docs/screenshots/v1')
  await fs.mkdir(screenshotDir, { recursive: true })
  await page.screenshot({ path: path.join(screenshotDir, 'installed-workbench.png') })
  await page.locator('.nx-setup-entry').click()
  await page.locator('.nx-setup').waitFor()
  assert.equal(await page.locator('.nx-setup nav button').count(), 7)
  await page.locator('.nx-setup nav button').nth(6).click()
  assert.equal(await page.getByRole('button', { name: 'Enable hosting', exact: true }).isDisabled(), true, 'Hosting must wait for actual prerequisites.')
  assert.equal(await page.locator('.nx-setup-consent input').isChecked(), false, 'Remote delivery must require an explicit selection.')
  await page.screenshot({ path: path.join(screenshotDir, 'installed-setup.png') })
  await page.keyboard.press('Escape')
  await page.locator('.nx-setup').waitFor({ state: 'detached' })
  console.log('PASS: Seven-step setup renders; prerequisites and remote-delivery default stay guarded; Escape closes the dialog.')

  // PowerShell cannot read scripts inside ASAR: verify the physical unpacked runner and execute it.
  const resources = path.join(path.dirname(installedExe), 'resources')
  assert.ok((await fs.stat(path.join(resources, 'app.asar.unpacked/server/services/agent/windows-job-runner.ps1'))).isFile())
  const executorUrl = pathToFileURL(path.join(resources, 'app.asar/server/services/agent/executor.mjs')).href
  const probeCode = `import(${JSON.stringify(executorUrl)}).then(async ({runCommand}) => { const result = await runCommand({cwd:${JSON.stringify(expectedDataPath)},command:'node -v'}); console.log(JSON.stringify({ok:result.ok,exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr})); process.exitCode = result.ok ? 0 : 1 }).catch(() => {process.exitCode=1})`
  const probe = await new Promise((resolve, reject) => {
    const runner = spawn(installedExe, ['-e', probeCode], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    runner.stdout.on('data', (chunk) => { output += chunk })
    runner.on('error', reject)
    runner.on('exit', (code) => resolve({ code, output }))
  })
  assert.equal(probe.code, 0, `Installed command runner failed: ${probe.output}`)
  assert.equal(JSON.parse(probe.output.trim()).ok, true)
  console.log('PASS: Installed ASAR invokes the unpacked Windows Job Object command runner successfully.')

  console.log('PASS: Freshly installed executable rendered the Windows workstation.')
  console.log('PASS: Desktop preload bridge reports dataPath under the disposable LOCALAPPDATA profile.')
  console.log('PASS: Authenticated bridge API health returned 200; direct renderer API health returned 401.')
  console.log('PASS: Packaged app state and startup log were written under the disposable profile.')
  console.log(`Installed executable: ${installedExe}`)
  console.log(`Temporary app data: ${expectedDataPath}`)
  if (keepTempDataForUninstallCheck) console.log(`Temporary profile retained for the uninstall data-retention check: ${tempLocalAppData}`)
} catch (error) {
  failed = true
  await fs.writeFile(path.join(tempLocalAppData, 'installed-package-smoke.log'), output, 'utf8').catch(() => {})
  console.error(`Installed-package smoke failed. Temporary profile and diagnostic log retained at: ${tempLocalAppData}`)
  if (childExit?.error) console.error(childExit.error)
  throw error
} finally {
  await browser?.close().catch(() => {})
  stopTestProcessTree()
  if (child && !childExit) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000))
    ])
  }
  if (!childExit) stopTestProcessTree()
  if (!failed && !keepTempDataForUninstallCheck) await fs.rm(tempLocalAppData, { recursive: true, force: true })
}
