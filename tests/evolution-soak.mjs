import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { performance } from 'node:perf_hooks'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { _electron } from 'playwright'
import { emptyState, saveStateFile } from '../server/services/state-store.mjs'
import { registerLocalProject } from '../server/services/local-projects.mjs'

const run = promisify(execFile), require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const hours = Number(process.env.NEXUS_SOAK_HOURS || 24)
assert.ok(Number.isFinite(hours) && hours > 0 && hours <= 48)
const jobIntervalMs = Number(process.env.NEXUS_SOAK_JOB_INTERVAL_SECONDS || 3600) * 1000
assert.ok(Number.isFinite(jobIntervalMs) && jobIntervalMs >= 30000 && jobIntervalMs <= 3600000)
const id = new Date().toISOString().replace(/[:.]/g, '-')
const output = path.join(root, 'test-results', 'soak', id), snapshot = path.join(output, 'source'), dataDir = path.join(output, 'fixture-profile'), projectDir = path.join(output, 'fixture-project')
assert.ok(output.startsWith(path.join(root, 'test-results', 'soak') + path.sep))
await fs.mkdir(snapshot, { recursive: true }); await fs.mkdir(dataDir); await fs.mkdir(projectDir)
const owned = ['desktop', 'server', 'dist', 'package.json', 'package-lock.json'], files = []
async function inventory(base, relative = '') {
  for (const entry of (await fs.readdir(path.join(base, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(relative, entry.name)
    assert.equal(entry.isSymbolicLink(), false, 'Application snapshots cannot contain links.')
    if (entry.isDirectory()) await inventory(base, file)
    else if (entry.isFile()) files.push({ path: file.replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(await fs.readFile(path.join(base, file))).digest('hex') })
  }
}
for (const name of owned) await fs.cp(path.join(root, name), path.join(snapshot, name), { recursive: true, errorOnExist: true, force: false, dereference: false })
await inventory(snapshot)
const sourceSha256 = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')
// Reuse the already-audited installed dependencies; no package lifecycle scripts
// or external repository code is downloaded or executed by this harness.
await fs.symlink(path.join(root, 'node_modules'), path.join(snapshot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
const electronPath = require('electron')
const manifest = { id, status: 'Prepared', sourceSha256, files, hoursRequested: hours, minimumAcceptanceHours: 24, fixtureModel: true, realExternalModelVerified: false, nativeElectron: true, isolatedProfile: true, dependencies: { linkedToExistingInstall: true, lockSha256: files.find((file) => file.path === 'package-lock.json').sha256, electronExecutableSha256: crypto.createHash('sha256').update(await fs.readFile(electronPath)).digest('hex') }, scope: 'One fixture collaboration workflow per hour, 60-second native/API resource samples; hidden native window between samples. No Windows reboot, signing, installation or production service acceptance.' }
manifest.harnessSha256 = crypto.createHash('sha256').update(await fs.readFile(import.meta.filename)).digest('hex')
manifest.jobIntervalSeconds = jobIntervalMs / 1000
manifest.scope = `Fixture collaboration every ${jobIntervalMs / 1000} seconds, 60-second native/API samples, hidden window. No reboot, production service, signing or installation acceptance.`
await fs.copyFile(import.meta.filename, path.join(output, 'harness-source.mjs'))
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
await fs.writeFile(path.join(projectDir, 'app.mjs'), 'export const answer = 41\n')
await fs.writeFile(path.join(projectDir, 'verify.mjs'), 'import { answer } from "./app.mjs"; if(answer !== 42) throw new Error("incorrect answer"); console.log("soak verified 42")\n')
await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'nexus-soak-fixture', type: 'module', scripts: { test: 'node verify.mjs' } }))
const { project } = await registerLocalProject({ dataDir, folderPath: projectDir })
await fs.writeFile(path.join(dataDir, 'desktop-settings.json'), JSON.stringify({ language: 'zh-CN', theme: 'dark', autoStart: false }))
const state = structuredClone(emptyState); state.settings.hostingPaused = true
await saveStateFile(path.join(dataDir, 'state.json'), state)
let requests = 0, app, page, stopped = false, apiConnection
const errors = [], jobs = [], measurements = []
const mock = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); res.end('{}'); return }
  let body = ''; req.on('data', (chunk) => { body += chunk }); req.on('end', () => {
    try {
      const input = JSON.parse(body), system = input.messages[0].content
      requests++
      const role = system.match(/^You are the (\w+) in a bounded/)?.[1]
      const answer = role ? { summary: `Soak fixture ${role}`, safe: true, verdict: 'approve', steps: ['Correct answer'], risks: [] } : system.includes('independent code reviewer') ? { findings: [], overall: 'Actual candidate diff checked.', verdict: 'approve' } : input.max_tokens === 2048 ? { plan: ['Correct source and verify'], first_tool: { name: 'write_file', args: { path: 'app.mjs', content: 'export const answer = 42\n' } } } : { final: 'Soak candidate verified.' }
      if (role === 'tester' && JSON.parse(input.messages[1].content).evidence?.task) answer.testFiles = [{ path: 'nexus-tests/answer.test.mjs', content: 'import {test} from "node:test"; import assert from "node:assert/strict"; import {answer} from "../app.mjs"; test("independent answer",()=>assert.equal(answer,42));\n' }]
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 30, completion_tokens: 20 } }))
    } catch { res.writeHead(500); res.end() }
  })
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function api(url, body) {
  // Background acceptance must not depend on a hidden renderer's message loop.
  // The fixture token stays in harness memory and is never written to evidence.
  const response = await fetch(`${apiConnection.origin}/api/evolution${url}`, { headers: { Authorization: `Bearer ${apiConnection.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) })
  const result = await response.json()
  assert.ok(response.ok, JSON.stringify(result))
  return result
}
async function nativeTree(mainPid) {
  if (process.platform !== 'win32') return { available: false }
  assert.ok(Number.isSafeInteger(mainPid) && mainPid > 0)
  const script = `$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,HandleCount,ReadTransferCount,WriteTransferCount); $ids = [Collections.Generic.HashSet[int]]::new(); $null=$ids.Add(${mainPid}); do { $added=$false; foreach($row in $rows) { if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $added=$true } } } while($added); @($rows | Where-Object { $ids.Contains([int]$_.ProcessId) }) | ConvertTo-Json -Compress`
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 })
  const parsed = JSON.parse(stdout), processes = Array.isArray(parsed) ? parsed : [parsed]
  return { available: true, processes, handles: processes.reduce((sum, item) => sum + Number(item.HandleCount || 0), 0), ioReadBytes: processes.reduce((sum, item) => sum + Number(item.ReadTransferCount || 0), 0), ioWriteBytes: processes.reduce((sum, item) => sum + Number(item.WriteTransferCount || 0), 0) }
}
async function task(number) {
  const began = performance.now()
  const created = await api('/workflows', { requestId: `soak_${number}`, projectId: project.id, prompt: 'Correct the fixture answer to 42 and run its actual self-test.', sourceDisclosureConfirmed: true, executionConsent: true, limits: { stepTimeoutMs: 120000, wallClockMs: 600000 } })
  for (let attempt = 0; attempt < 180; attempt++) {
    const { workflow } = await api(`/workflows/${created.workflow.id}`)
    if (['Completed', 'Blocked', 'Failed', 'TimedOut', 'Cancelled'].includes(workflow.status)) {
      assert.equal(workflow.status, 'Completed', JSON.stringify({ status: workflow.status, errorCode: workflow.errorCode, roles: workflow.nodes.filter((node) => node.status !== 'Completed').map(({ role, status, errorCode, errorSummary }) => ({ role, status, errorCode, errorSummary })) }))
      assert.equal(workflow.nodes.find((node) => node.role === 'tester').result.verified, true)
      assert.equal(await fs.readFile(path.join(projectDir, 'app.mjs'), 'utf8'), 'export const answer = 41\n')
      const receipt = { id: workflow.id, status: workflow.status, durationMs: performance.now() - began, tokens: workflow.usage, at: new Date().toISOString() }
      jobs.push(receipt); await fs.appendFile(path.join(output, 'jobs.jsonl'), JSON.stringify(receipt) + '\n')
      return
    }
    await delay(1000)
  }
  throw new Error('Soak workflow exceeded its bounded acceptance deadline.')
}
let started = 0, maxSampleGapMs = 0, previousSample = 0
async function writeStatus(status, extra = {}) {
  const value = { id, status, sourceSha256, startedAt: manifest.startedAt, updatedAt: new Date().toISOString(), elapsedSeconds: started ? (performance.now() - started) / 1000 : 0, requestedHours: hours, samples: measurements.length, completedWorkflows: jobs.length, modelRequests: requests, maxSampleGapMs, errors, ...extra }
  await saveStateFile(path.join(output, 'status.json'), value)
  console.log(JSON.stringify(value))
}
try {
  const env = { ...process.env, NEXUS_DESKTOP_DATA_DIR: dataDir, NEXUS_ENABLE_REMOTE_WRITES: 'false', GITHUB_TOKEN: 'soak-fixture-token', GITHUB_OWNER: 'soak-fixture', GITHUB_API_URL: `http://127.0.0.1:${mock.address().port}`, AI_PROVIDER_KIND: 'openai-compatible', AI_API_KEY: 'soak-fixture-key', AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, AI_MODEL: 'soak-fixture-model' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'GH_TOKEN', 'NEXUS_AI_PROVIDERS_JSON', 'NEXUS_UPDATE_PUBLISHER']) delete env[key]
  app = await _electron.launch({ executablePath: electronPath, args: [snapshot, '--nexus-smoke-test'], env, timeout: 45000 })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push({ kind: 'renderer', message: error.message, at: new Date().toISOString() }))
  const launcherPid = app.process().pid
  const mainPid = await app.evaluate(() => process.pid)
  await page.locator('.nx-rail').waitFor({ timeout: 30000 })
  apiConnection = await app.evaluate(({ BrowserWindow }) => ({ origin: new URL(BrowserWindow.getAllWindows()[0].webContents.getURL()).origin, token: process.env.NEXUS_LOCAL_API_TOKEN }))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  started = performance.now(); manifest.startedAt = new Date().toISOString(); manifest.status = 'Running'; manifest.harnessPid = process.pid; manifest.launcherPid = launcherPid; manifest.electronPid = mainPid
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2)); await writeStatus('Running')
  let nextTask = 0, nextSample = 0, activeJob = null
  while (!stopped && performance.now() - started < hours * 3600000) {
    const elapsed = performance.now() - started
    if (elapsed >= nextTask && !activeJob) {
      activeJob = task(jobs.length).catch((cause) => { errors.push({ kind: 'workflow', message: String(cause.message).slice(0, 1500), at: new Date().toISOString() }); stopped = true }).finally(() => { activeJob = null })
      nextTask += jobIntervalMs
    }
    if (elapsed >= nextSample) {
      const status = await api('/status')
      const desktop = await app.evaluate(({ app }) => ({ at: new Date().toISOString(), processes: app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type, cpuPercent: item.cpu.percentCPUUsage, workingSetBytes: item.memory.workingSetSize * 1024, peakWorkingSetBytes: item.memory.peakWorkingSetSize * 1024 })) }))
      const renderer = { heapBytes: null, visible: false, reason: 'Hidden renderer working set is measured through native Electron process metrics; no fabricated JS heap value.' }
      const tree = await nativeTree(mainPid)
      const measured = performance.now()
      if (previousSample) maxSampleGapMs = Math.max(maxSampleGapMs, measured - previousSample)
      previousSample = measured
      const sample = { at: new Date().toISOString(), elapsedSeconds: (measured - started) / 1000, resources: status.resources, queue: status.scheduler, desktop, renderer, tree }
      measurements.push(sample); await fs.appendFile(path.join(output, 'samples.jsonl'), JSON.stringify(sample) + '\n')
      assert.equal(errors.length, 0, JSON.stringify(errors)); await writeStatus('Running')
      nextSample += 60000
    }
    await delay(Math.min(1000, Math.max(1, hours * 3600000 - (performance.now() - started))))
  }
  if (activeJob) await activeJob
  const elapsedHours = (performance.now() - started) / 3600000
  const comparisons = measurements.length > 1 ? { nodeRssGrowthBytes: measurements.at(-1).resources.node.rssBytes - measurements[0].resources.node.rssBytes, handleGrowth: measurements.at(-1).tree.handles - measurements[0].tree.handles, processGrowth: measurements.at(-1).desktop.processes.length - measurements[0].desktop.processes.length } : null
  const sourceStillMatches = (await Promise.all(files.map(async (file) => crypto.createHash('sha256').update(await fs.readFile(path.join(root, file.path))).digest('hex') === file.sha256))).every(Boolean)
  const valid24h = elapsedHours >= 24 && maxSampleGapMs <= 150000 && errors.length === 0 && sourceStillMatches
  await writeStatus(errors.length ? 'FAIL' : valid24h ? 'PASS' : 'PARTIAL', { elapsedHours, sourceStillMatches, continuous24hVerified: valid24h, comparisons, reason: valid24h ? null : hours < 24 ? 'SHORT_HARNESS_CHECK_ONLY' : 'CONTINUITY_DURATION_OR_SOURCE_NOT_PROVEN' })
  if (errors.length) process.exitCode = 1
} catch (cause) {
  errors.push({ kind: 'harness', message: String(cause.message).slice(0, 1500), at: new Date().toISOString() })
  await writeStatus('FAIL', { continuous24hVerified: false }); process.exitCode = 1
} finally {
  stopped = true
  await app?.close().catch(() => {})
  await new Promise((resolve) => mock.close(resolve))
  // Keep the isolated profile, source inventory and raw measurements for review.
}
