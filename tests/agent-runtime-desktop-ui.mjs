import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'
import { registerLocalProject } from '../server/services/local-projects.mjs'

// PHASE 6 desktop acceptance: drive the autonomous runtime through the real
// Electron window — plan, tool events, isolated worktree diff, verification,
// independent review and the provider/insights panels — against a scripted
// local provider. The original project must remain untouched until the user
// applies the changes.

const require = createRequire(import.meta.url)
const electronExecutable = require('electron')
const appRoot = path.resolve(import.meta.dirname, '..')
const screenshotPath = path.join(appRoot, 'docs', 'screenshots', 'phase6', 'agent-runtime-workbench.png')
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-phase6-desktop-ui-'))
const dataRoot = path.join(tempRoot, 'nexus user data')
const projectPath = path.join(tempRoot, 'runtime fixture project')
const profilePath = path.join(tempRoot, 'electron profile')
const originalSource = 'export const answer = 41\n'
const updatedSource = 'export const answer = 42\n'
const prompt = 'Fixture: change the exported answer constant to 42 and verify the self check passes.'
const outputLimit = 128 * 1024
const startupTimeoutMs = 45_000
const devToolsPattern = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/

let child
let browser
let providerServer
let providerRequests = 0
let output = ''
let devToolsEndpoint = null
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

// Deterministic scripted responses: plan (+first tool), edit, final; the
// review call arrives after the loop and gets the review verdict.
const scriptedResponses = [
  JSON.stringify({
    thought: 'Read the constant, update it, verify.',
    plan: ['Read src/main.js', 'Set answer to 42', 'Run the self check'],
    first_tool: { name: 'read_file', args: { path: 'src/main.js' } }
  }),
  JSON.stringify({ thought: 'Editing the constant.', tool: { name: 'edit_file', args: { path: 'src/main.js', oldText: 'answer = 41', newText: 'answer = 42' } } }),
  JSON.stringify({ thought: 'Done; verification runs automatically.', final: 'Updated the answer constant to 42 in the isolated worktree.' })
]

function scriptedReply() {
  const next = scriptedResponses.shift()
  if (next !== undefined) return next
  return JSON.stringify({ findings: [], overall: 'The diff is minimal and matches the request.', verdict: 'approve' })
}

try {
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.mkdir(profilePath, { recursive: true })
  await fs.mkdir(dataRoot, { recursive: true })
  await fs.writeFile(path.join(dataRoot, 'desktop-settings.json'), JSON.stringify({ onboardingStage: 'complete', language: 'en-US' }, null, 2), 'utf8')
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'runtime-fixture', type: 'module', scripts: { test: 'node src/selfcheck.js' } }, null, 2), 'utf8')
  await fs.writeFile(path.join(projectPath, 'src', 'main.js'), originalSource, 'utf8')
  await fs.writeFile(path.join(projectPath, 'src', 'selfcheck.js'), [
    "import fs from 'node:fs'",
    "const main = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8')",
    "process.exit(main.includes('answer = 42') ? 0 : 1)"
  ].join('\n'), 'utf8')
  // The runtime defaults to a git worktree workspace; make the fixture a real repo.
  const { runCommand } = await import('../server/services/agent/executor.mjs')
  await runCommand({ cwd: projectPath, command: 'git init -b main', timeoutMs: 20_000 })
  await runCommand({ cwd: projectPath, command: 'git add -A', timeoutMs: 20_000 })
  await runCommand({ cwd: projectPath, command: 'git -c user.name=nexus-fixture -c user.email=fixture@nexus.local commit -m "fixture init"', timeoutMs: 20_000 })
  const sourceHashBefore = crypto.createHash('sha256').update(await fs.readFile(path.join(projectPath, 'src', 'main.js'))).digest('hex')
  const { project } = await registerLocalProject({ dataDir: dataRoot, folderPath: projectPath })

  // Scripted runtime provider behind the env-configured legacy provider slot.
  providerServer = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      providerRequests += 1
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.headers.authorization, 'Bearer phase6-ui-fixture-key')
      const payload = JSON.parse(raw)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{ message: { content: scriptedReply() } }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }
      }))
    })
  })
  await new Promise((resolve, reject) => providerServer.once('error', reject).listen(0, '127.0.0.1', resolve))
  const providerUrl = `http://127.0.0.1:${providerServer.address().port}`

  const debuggingPort = await freePort()
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
      AI_PROVIDER_KIND: 'openai-compatible',
      AI_BASE_URL: providerUrl,
      AI_API_KEY: 'phase6-ui-fixture-key',
      AI_MODEL: 'phase6-fixture-model',
      AI_REQUEST_TIMEOUT_MS: '20000',
      AI_MAX_RETRIES: '0',
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
  await waitFor(() => output.includes('NEXUS_DESKTOP_TRACE:local-service-ready'), startupTimeoutMs, 'local service readiness')
  const devToolsUrl = `http://127.0.0.1:${debuggingPort}/json/version`
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const version = await fetch(devToolsUrl).then((response) => response.json())
      if (version.webSocketDebuggerUrl) { devToolsEndpoint = version.webSocketDebuggerUrl; break }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await waitFor(() => devToolsEndpoint, 10_000, 'Electron DevTools endpoint')
  browser = await chromium.connectOverCDP(devToolsEndpoint, { timeout: 15_000 })
  const context = browser.contexts()[0]
  assert.ok(context, 'The launched Electron app should expose a Chromium context.')
  const page = context.pages()[0] || await context.waitForEvent('page', { timeout: 15_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 })
  await page.getByRole('heading', { name: 'Workbench', exact: true }).waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'AI Agent', exact: true }).click()
  await page.getByRole('heading', { name: 'Describe a code change', exact: true }).waitFor({ timeout: 10_000 })
  await page.getByText('Provider ready', { exact: true }).waitFor({ timeout: 10_000 })

  // Provider manager panel renders the env default with a key state.
  await page.getByRole('heading', { name: 'AI providers & keys', exact: true }).waitFor({ timeout: 10_000 })

  // Project insights panel against the registered fixture project.
  await page.getByRole('button', { name: 'Analyze project', exact: true }).click()
  await page.getByText(/files · .* languages/).waitFor({ timeout: 30_000 })

  // Compose the runtime task (default engine is the autonomous runtime).
  await page.getByLabel(/Request/).fill(prompt)
  await page.getByLabel(/Approval policy/).waitFor({ timeout: 5_000 })
  await page.getByLabel(/Workspace isolation/).selectOption('worktree')
  await page.getByLabel(/I reviewed this disclosure and authorize sending/).check()
  const startButton = page.getByRole('button', { name: 'Start agent task', exact: true })
  assert.equal(await startButton.isEnabled(), true)
  await startButton.click()

  // The runtime plan and tool activity surface in the detail panel.
  await page.getByText(/Plan \(\d+ steps\)/).waitFor({ timeout: 30_000 })
  await page.getByText(/Build & test verification/).waitFor({ timeout: 60_000 })
  await page.locator('.nx-agent-status.succeeded').first().waitFor({ timeout: 60_000 })
  await page.getByText('Updated the answer constant to 42 in the isolated worktree.', { exact: true }).waitFor({ timeout: 15_000 })
  await page.locator('.nx-agent-diff').first().getByText('src/main.js', { exact: true }).waitFor({ timeout: 15_000 })

  // The original project is untouched; the change lives in the isolated worktree.
  assert.equal(await fs.readFile(path.join(projectPath, 'src', 'main.js'), 'utf8'), originalSource, 'The original project must remain untouched before the user applies the change.')
  assert.equal(JSON.stringify(crypto.createHash('sha256').update(await fs.readFile(path.join(projectPath, 'src', 'main.js'))).digest('hex')), JSON.stringify(sourceHashBefore))

  // Roll back the isolated workspace through the UI.
  await page.getByRole('button', { name: 'Roll back workspace', exact: true }).click()
  await page.getByText('The workspace was rolled back to its original state.', { exact: true }).waitFor({ timeout: 30_000 })

  await fs.mkdir(path.dirname(screenshotPath), { recursive: true })
  await page.screenshot({ path: screenshotPath, fullPage: true })
  console.log('PASS: The autonomous runtime ran inside the real Electron window: plan, tool execution, verification and review all surfaced.')
  console.log('PASS: The original project remained byte-identical while the worktree workspace held the change.')
  console.log('PASS: Workspace rollback completed from the desktop UI.')
  console.log(`Provider requests: ${providerRequests}; fixture project id: ${project.id}`)
  console.log(`PASS: Runtime screenshot saved to ${screenshotPath}`)
} catch (error) {
  failed = true
  const diagnostics = path.join(tempRoot, 'diagnostics')
  await fs.mkdir(diagnostics, { recursive: true }).catch(() => {})
  await fs.writeFile(path.join(diagnostics, 'electron-output.log'), output, 'utf8').catch(() => {})
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(diagnostics, 'failure.png'), fullPage: true }).catch(() => {})
  console.error(`PHASE 6 desktop runtime test failed. Temporary data retained at: ${tempRoot}`)
  throw error
} finally {
  await browser?.close().catch(() => {})
  stopProcessTree()
  if (child && !childExit) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000))
    ])
  }
  if (!childExit) stopProcessTree()
  await new Promise((resolve) => providerServer?.close(resolve) || resolve())
  if (!failed) await fs.rm(tempRoot, { recursive: true, force: true })
}
