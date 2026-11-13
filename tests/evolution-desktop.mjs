import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { _electron } from 'playwright'
import { emptyState, saveStateFile } from '../server/services/state-store.mjs'
import { registerLocalProject } from '../server/services/local-projects.mjs'

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-evolution-desktop-'))
const dataDir = path.join(temporary, 'profile'), projectDir = path.join(temporary, 'project')
const locale = process.env.NEXUS_EVOLUTION_LOCALE || 'zh-CN', theme = process.env.NEXUS_EVOLUTION_THEME || 'dark'
const packagedExecutable = process.env.NEXUS_EVOLUTION_EXECUTABLE ? path.resolve(process.env.NEXUS_EVOLUTION_EXECUTABLE) : null
const evidenceSuffix = packagedExecutable ? '-packaged' : ''
const labels = JSON.parse(await fs.readFile(path.join(root, `src/locales/${locale}/workstation.json`), 'utf8')).evolution
const common = JSON.parse(await fs.readFile(path.join(root, `src/locales/${locale}/common.json`), 'utf8'))
const screenshots = path.join(root, 'docs/screenshots/ultimate-evolution')
await fs.mkdir(dataDir, { recursive: true }); await fs.mkdir(projectDir)
await fs.mkdir(screenshots, { recursive: true })
await fs.writeFile(path.join(projectDir, 'app.mjs'), 'export const answer = 41\n')
await fs.writeFile(path.join(projectDir, 'verify.mjs'), 'import { answer } from "./app.mjs"; if (answer !== 42) throw new Error("not fixed"); console.log("verified answer 42")\n')
await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture-evolution-project', type: 'module', scripts: { test: 'node verify.mjs' } }))
const { project } = await registerLocalProject({ dataDir, folderPath: projectDir })
await fs.writeFile(path.join(dataDir, 'desktop-settings.json'), JSON.stringify({ language: locale, theme, autoStart: false }))
const state = structuredClone(emptyState); state.settings.hostingPaused = true
await saveStateFile(path.join(dataDir, 'state.json'), state)
let releasePlanner
const plannerGate = new Promise((resolve) => { releasePlanner = resolve })
const rolesSeen = [], modelRequests = []
const mock = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.endsWith('/releases/latest')) res.end(JSON.stringify({ tag_name: 'v0.8.0', html_url: 'https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.8.0', assets: [{ name: 'PROJECT-NEXUS-0.8.0-win-x64-setup.exe', size: 10, digest: `sha256:${crypto.createHash('sha256').update('fixture').digest('hex')}`, browser_download_url: 'https://github.com/yuchen0x1/PROJECT-NEXUS/releases/download/v0.8.0/PROJECT-NEXUS-0.8.0-win-x64-setup.exe' }] }))
    else res.end('{}')
    return
  }
  let body = ''; req.on('data', (chunk) => { body += chunk }); req.on('end', async () => {
    const request = JSON.parse(body), system = request.messages[0].content
    modelRequests.push(request)
    const role = system.match(/^You are the (\w+) in a bounded/)?.[1]
    let answer
    if (role) { rolesSeen.push(role); if (role === 'planner') await plannerGate; answer = { summary: `Fixture ${role} result`, safe: true, verdict: 'approve', steps: ['Correct answer'], recommendations: [], risks: [] } }
    else if (system.includes('independent code reviewer')) answer = { findings: [], verdict: 'approve', overall: 'Fixture diff reviewed.' }
    else if (request.max_tokens === 2048) answer = { thought: 'Correct the isolated answer', plan: ['Change answer to 42'], first_tool: { name: 'write_file', args: { path: 'app.mjs', content: 'export const answer = 42\n' } } }
    else answer = { thought: 'Complete', final: 'Isolated source fixed and verified.' }
    if (role === 'tester' && JSON.parse(request.messages[1].content).evidence?.task) answer.testFiles = [{ path: 'nexus-tests/answer.test.mjs', content: 'import {test} from "node:test"; import assert from "node:assert/strict"; import {answer} from "../app.mjs"; test("independent answer",()=>assert.equal(answer,42));\n' }]
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 30, completion_tokens: 20 } }))
  })
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
let app
try {
  const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: dataDir, NEXUS_ENABLE_REMOTE_WRITES: 'false', GITHUB_TOKEN: 'fixture-only-github-token', GITHUB_OWNER: 'fixture-owner', GITHUB_API_URL: `http://127.0.0.1:${mock.address().port}`, AI_PROVIDER_KIND: 'openai-compatible', AI_API_KEY: 'fixture-only-evolution-key', AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, AI_MODEL: 'fixture-evolution-model' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'GH_TOKEN', 'NEXUS_AI_PROVIDERS_JSON', 'NEXUS_UPDATE_PUBLISHER']) delete env[key]
  app = await _electron.launch({ executablePath: packagedExecutable || require('electron'), args: [...(packagedExecutable ? [] : [root]), '--nexus-smoke-test', ...(process.env.NEXUS_EVOLUTION_SCALE ? [`--force-device-scale-factor=${process.env.NEXUS_EVOLUTION_SCALE}`] : [])], env, timeout: 45000 })
  const page = await app.firstWindow(), errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720))
  await page.getByRole('button', { name: labels.title, exact: true }).click()
  await page.locator('.nx-evolution').waitFor()
  if (theme === 'system') await page.emulateMedia({ colorScheme: null })
  if (theme === 'system') for (const mode of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value }, mode)
    await page.waitForFunction((value) => document.documentElement.dataset.theme === value, mode)
  }
  if (process.env.NEXUS_EVOLUTION_VERIFY_ONLY === 'true') {
    for (const tab of ['agents', 'research', 'maintenance', 'memory', 'recovery', 'resources', 'updates']) {
      await page.getByRole('button', { name: labels.tabs[tab], exact: true }).click()
      await page.waitForTimeout(150)
      assert.equal((await page.locator('.nx-evolution').innerText()).includes('workstation:evolution.'), false)
      assert.equal(await page.locator('.nx-evolution').evaluate((element) => element.scrollWidth > element.clientWidth + 2), false)
    }
    assert.deepEqual(errors, [])
    assert.equal(modelRequests.length, 0)
    const result = { status: 'PASS', locale, theme, systemThemeFollowVerified: theme === 'system', nativeElectron: true, fixtureUIOnly: true, tabs: 7, modelRequests: 0, scale: process.env.NEXUS_EVOLUTION_SCALE || 'system', at: new Date().toISOString() }
    await fs.writeFile(path.join(root, `test-results/ultimate-locale-${locale}.json`), JSON.stringify(result, null, 2))
    await page.screenshot({ path: path.join(screenshots, `locale-${locale}-${theme}.png`) })
    console.log(JSON.stringify(result))
  } else {
  await page.getByRole('textbox', { name: labels.goal, exact: true }).fill('Fixture collaboration: correct answer to 42 and verify it.')
  const start = page.getByRole('button', { name: labels.start, exact: true })
  assert.equal(await start.isDisabled(), true)
  await page.getByRole('checkbox', { name: labels.disclosure, exact: true }).check()
  await page.getByRole('checkbox', { name: labels.trustedConsent, exact: true }).check()
  await start.click()
  await page.locator('[data-role="planner"][data-status="Running"]').waitFor({ timeout: 30000 })
  await page.locator('.nx-evolution-role-grid').getByText('fixture-evolution-model', { exact: true }).waitFor({ timeout: 12000 })
  await page.locator('.nx-evolution-detail').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(screenshots, `running-${locale}-${theme}.png`) })
  await page.getByRole('button', { name: labels.pauseSafely, exact: true }).click()
  await page.locator('.nx-evolution-detail > header .nx-evolution-badge.is-interrupted').waitFor({ timeout: 15000 })
  releasePlanner()
  await page.getByRole('button', { name: labels.tabs.recovery, exact: true }).click()
  await page.getByRole('button', { name: labels.resumeVerified, exact: true }).click()
  await page.locator('.nx-evolution-detail > header .nx-evolution-badge.is-completed').waitFor({ timeout: 90000 })
  await page.locator('[data-role="tester"]').click()
  await page.locator('.nx-evolution-role-inspector summary').filter({ hasText: /^test · PASS$/ }).click()
  await page.locator('.nx-evolution-role-inspector pre').filter({ hasText: 'verified answer 42' }).waitFor()
  await page.screenshot({ path: path.join(screenshots, `verified-${locale}-${theme}.png`) })
  assert.equal(await fs.readFile(path.join(projectDir, 'app.mjs'), 'utf8'), 'export const answer = 41\n')
  await page.getByRole('button', { name: labels.tabs.memory, exact: true }).click()
  await page.getByRole('button', { name: labels.refreshMemory, exact: true }).click()
  await page.locator('.nx-evolution-metrics').waitFor()
  await page.getByRole('textbox', { name: labels.addMemory, exact: true }).fill('Fixture inference: verify source evidence before adopting a design.')
  await page.getByRole('button', { name: labels.saveInference, exact: true }).click()
  await page.locator('.nx-evolution-memory-facts').getByText(labels.inference, { exact: true }).waitFor()
  const exportFile = path.join(temporary, 'exported-memory.json')
  await app.evaluate(({ session }, file) => { session.defaultSession.once('will-download', (_event, item) => { item.setSavePath(file) }) }, exportFile)
  await page.getByRole('button', { name: labels.exportMemory, exact: true }).click()
  for (let attempt = 0; attempt < 100 && !await fs.stat(exportFile).catch(() => null); attempt++) await page.waitForTimeout(100)
  const exported = JSON.parse(await fs.readFile(exportFile, 'utf8'))
  assert.equal(exported.id, project.id); assert.equal(exported.format, 'project-nexus-memory-v1')
  assert.equal(exported.facts.at(-1).classification, 'inference')
  await page.screenshot({ path: path.join(screenshots, `memory-${locale}-${theme}.png`) })
  await page.getByRole('button', { name: labels.clearMemory, exact: true }).click()
  await page.getByRole('dialog').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: labels.clearMemory, exact: true }).click()
  await page.getByRole('button', { name: labels.confirmClear, exact: true }).click()
  await page.getByText(labels.noMemory, { exact: true }).waitFor()
  await page.getByRole('button', { name: labels.tabs.recovery, exact: true }).click()
  await page.getByText(labels.noRecovery, { exact: true }).waitFor()
  await page.getByRole('button', { name: labels.tabs.resources, exact: true }).click()
  await page.locator('.nx-evolution-resource-chart').waitFor()
  const metrics = await page.evaluate(() => window.nexusDesktop.getMetrics())
  assert.ok(metrics.processes.some((item) => item.type === 'Browser' && item.workingSetBytes > 0))
  assert.ok(metrics.processes.some((item) => item.type === 'Tab' && item.workingSetBytes > 0))
  await page.screenshot({ path: path.join(screenshots, `resources-${locale}-${theme}.png`) })
  await page.getByRole('button', { name: labels.tabs.maintenance, exact: true }).click()
  assert.equal(await page.getByRole('checkbox', { name: labels.selfPolicyConsent, exact: true }).isChecked(), false)
  await page.getByRole('button', { name: labels.runDiagnostics, exact: true }).click()
  await page.getByText('SELF_PROJECT_MISMATCH', { exact: true }).waitFor({ timeout: 12000 })
  await page.getByRole('button', { name: labels.tabs.updates, exact: true }).click()
  await page.getByText(labels.publisherMissing, { exact: true }).waitFor()
  await page.getByRole('button', { name: labels.checkUpdates, exact: true }).click()
  await page.locator('.nx-evolution-assessment h3').getByText('0.8.0', { exact: true }).waitFor()
  await page.getByText(labels.installationGate, { exact: true }).waitFor()
  await page.screenshot({ path: path.join(screenshots, `updates-${locale}-${theme}.png`) })
  assert.equal(await page.locator('.nx-evolution').evaluate((element) => element.scrollWidth > element.clientWidth + 2), false)
  assert.equal((await page.locator('.nx-evolution').innerText()).includes('workstation:evolution.'), false)
  assert.deepEqual(errors, [])
  assert.deepEqual([...new Set(rolesSeen)].sort(), ['planner', 'researcher', 'tester', 'security', 'reviewer'].sort())
  const servicePid = metrics.servicePid
  assert.ok(Number.isSafeInteger(servicePid) && servicePid > 0)
  // Playwright's launcher PID differs from Electron's actual main PID on this
  // Windows build. Killing only the launcher does not simulate an app crash.
  const actualMainPid = await app.evaluate(() => process.pid)
  const mainExited = new Promise((resolve) => app.process().once('exit', resolve))
  process.kill(actualMainPid, 'SIGKILL')
  await Promise.race([mainExited, new Promise((resolve) => setTimeout(resolve, 2000))])
  const processAlive = (pid) => { try { process.kill(pid, 0); return true } catch (cause) { if (cause.code === 'ESRCH') return false; throw cause } }
  const ownerDeadline = Date.now() + 12000
  while (processAlive(servicePid) && Date.now() < ownerDeadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(processAlive(servicePid), false, 'The API child must stop after an actual Electron main-process kill.')
  // An abrupt process kill may leave a lease file. Recovery must prove its
  // owner exited and reclaim it, rather than requiring graceful crash cleanup.
  const remainingLease = await fs.readFile(path.join(dataDir, 'state.json.host.lock'), 'utf8').catch((cause) => { if (cause.code === 'ENOENT') return null; throw cause })
  if (remainingLease) assert.equal(JSON.parse(remainingLease).pid, servicePid)
  await app.close().catch(() => {})
  const completedRequests = modelRequests.length
  app = await _electron.launch({ executablePath: packagedExecutable || require('electron'), args: [...(packagedExecutable ? [] : [root]), '--nexus-smoke-test'], env, timeout: 45000 })
  const recoveredPage = await app.firstWindow()
  await recoveredPage.locator('.nx-rail').waitFor({ timeout: 20000 })
  const recovered = await recoveredPage.evaluate(() => window.nexusDesktop.requestApi({ url: '/api/evolution/workflows' }))
  assert.equal(recovered.status, 200)
  assert.equal(recovered.body.workflows.length, 1)
  assert.equal(recovered.body.workflows[0].status, 'Completed')
  assert.equal(modelRequests.length, completedRequests, 'Restarting must not repeat a completed collaboration.')
  const result = { status: 'PASS', locale, theme, nativeElectron: true, packagedExecutable: Boolean(packagedExecutable), cssWindow: '1280x720', fixtureModel: true, realExternalServicesVerified: false, originalProjectUnchanged: true, modelRequests: modelRequests.length, checks: ['explicit-consent', 'live-role-model', 'six-role-workflow', 'actual-test-output', 'original-project-unchanged', 'safe-pause-and-resume', 'memory-inference', 'memory-export-download', 'memory-clear-confirmation', 'keyboard-dismiss', 'recovery-empty', 'resource-telemetry', 'electron-main-renderer-metrics', 'self-project-identity', 'update-check', 'publisher-installation-gate', 'no-horizontal-overflow', 'no-raw-translation-keys', 'actual-electron-main-kill-api-owner-shutdown'], at: new Date().toISOString() }
  await fs.writeFile(path.join(root, `test-results/ultimate-desktop-${locale}-${theme}${evidenceSuffix}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  }
} finally {
  releasePlanner()
  await app?.close().catch(() => {})
  await new Promise((resolve) => mock.close(resolve))
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep))
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
}
