import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const hours = Number(process.env.NEXUS_SOAK_HOURS || 24)
const sampleSeconds = Math.max(5, Number(process.env.NEXUS_SOAK_SAMPLE_SECONDS || 60))
const restartAfterSeconds = Math.max(0, Number(process.env.NEXUS_SOAK_RESTART_AFTER_SECONDS || Math.min(300, hours * 3600 / 2)))
assert.ok(Number.isFinite(hours) && hours > 0 && hours <= 48)
const id = new Date().toISOString().replace(/[:.]/g, '-')
const outputDir = path.join(root, 'test-results', 'soak-runtime', id)
const dataDir = path.join(outputDir, 'data')
await fs.mkdir(dataDir, { recursive: true })

let outage = false
const proxy = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (outage) { res.writeHead(503); res.end(JSON.stringify({ message: 'soak network outage' })); return }
  if (/\/repos\/[^/]+\/[^/]+$/.test(req.url || '')) {
    res.end(JSON.stringify({ full_name: 'soak/example', default_branch: 'main', language: 'JavaScript', archived: false, pushed_at: new Date().toISOString(), open_issues_count: 0 }))
    return
  }
  res.end(JSON.stringify([]))
})
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
const apiBase = `http://127.0.0.1:${proxy.address().port}`
const envBase = { ...process.env, PORT: '0', NEXUS_HOST: '127.0.0.1', NEXUS_DATA_DIR: dataDir, NEXUS_STATE_FILE: path.join(dataDir, 'state.json'), GITHUB_TOKEN: 'soak-token', GITHUB_API_URL: apiBase, NEXUS_ENABLE_REMOTE_WRITES: 'false' }
for (const key of ['ELECTRON_RUN_AS_NODE', 'GH_TOKEN', 'NEXUS_AI_PROVIDERS_JSON', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL']) delete envBase[key]

const errors = [], samples = [], lifecycle = [], startedAt = new Date().toISOString()
let service = null
let servicePort = null

function startService() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'server', 'index.mjs')], { cwd: root, env: envBase, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    const timer = setTimeout(() => reject(new Error('service startup timed out')), 30_000)
    const onData = (chunk) => {
      output += String(chunk)
      const match = output.match(/PROJECT NEXUS API listening on http:\/\/localhost:(\d+)/)
      if (match) { clearTimeout(timer); service = child; servicePort = Number(match[1]); lifecycle.push({ event: 'service-started', pid: child.pid, port: servicePort, at: new Date().toISOString() }); resolve(child) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (chunk) => { const text = String(chunk); if (text.trim()) errors.push({ kind: 'service-stderr', detail: text.slice(-1000), at: new Date().toISOString() }) })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code, signal) => { if (!service || service === child) lifecycle.push({ event: 'service-exit', code, signal, at: new Date().toISOString() }) })
  })
}

async function stopService() {
  if (!service) return
  const child = service
  service = null
  try { child.kill('SIGTERM') } catch {}
  await new Promise((resolve) => { const timer = setTimeout(resolve, 10_000); child.once('exit', () => { clearTimeout(timer); resolve() }) })
}

async function api(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${servicePort}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, signal: AbortSignal.timeout(20_000) })
  const body = await response.json().catch(() => ({}))
  return { response, body }
}

async function processSample() {
  if (!service?.pid) return null
  if (process.platform !== 'win32') return { pid: service.pid, rssBytes: null, handles: null }
  const script = `$p=Get-Process -Id ${Number(service.pid)} -ErrorAction SilentlyContinue; if($p){ @{pid=$p.Id;rssBytes=$p.WorkingSet64;handles=$p.Handles;cpuSeconds=$p.CPU} | ConvertTo-Json -Compress }`
  try { const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 }); return stdout.trim() ? JSON.parse(stdout) : null } catch { return null }
}

try {
  await startService()
  let repository
  let taskId
  {
    const added = await api('/api/autonomy/repositories', { method: 'POST', body: JSON.stringify({ fullName: 'soak/example', localPath: root, monitorItems: ['repository'], pollIntervalMs: 30_000, agentProjectRef: 'soak', enabled: true }) })
    assert.equal(added.response.status, 201, JSON.stringify(added.body)); repository = added.body
    const settings = await api('/api/autonomy/control/pause', { method: 'POST', body: JSON.stringify({}) }); assert.equal(settings.response.ok, true, JSON.stringify(settings.body))
  }
  outage = true
  const failedSync = await api(`/api/autonomy/repositories/${repository.id}/sync`, { method: 'POST', body: JSON.stringify({ force: true }) })
  assert.equal(failedSync.response.ok, true, JSON.stringify(failedSync.body))
  outage = false
  const recoveredSync = await api(`/api/autonomy/repositories/${repository.id}/sync`, { method: 'POST', body: JSON.stringify({ force: true }) })
  assert.equal(recoveredSync.response.ok, true, JSON.stringify(recoveredSync.body))
  lifecycle.push({ event: 'network-recovery', failedVerdict: failedSync.body.verdict || null, recoveredVerdict: recoveredSync.body.verdict || null, at: new Date().toISOString() })

  const firstTask = await api('/api/autonomy/tasks', { method: 'POST', body: JSON.stringify({ repoId: repository.id, kind: 'soak-check', priority: 'P4', source: 'autonomy-soak', writeTask: false }) })
  const secondTask = await api('/api/autonomy/tasks', { method: 'POST', body: JSON.stringify({ repoId: repository.id, kind: 'soak-check', priority: 'P4', source: 'autonomy-soak', writeTask: false }) })
  assert.equal(firstTask.response.status, 201); assert.equal(secondTask.response.status, 201)
  taskId = firstTask.body.task.id; assert.equal(secondTask.body.task.id, taskId)
  lifecycle.push({ event: 'idempotency-verified', taskId, at: new Date().toISOString() })

  const began = Date.now()
  let restarted = false
  while (Date.now() - began < hours * 3_600_000) {
    const health = await api('/api/autonomy/health')
    assert.equal(health.response.ok, true, JSON.stringify(health.body))
    const status = await api('/api/autonomy/control/status')
    const measurement = await processSample()
    samples.push({ at: new Date().toISOString(), status: status.body, process: measurement })
    if (!restarted && restartAfterSeconds > 0 && Date.now() - began >= restartAfterSeconds * 1000) {
      await stopService(); await startService()
      const after = await api(`/api/autonomy/tasks/${taskId}`)
      assert.equal(after.response.ok, true, JSON.stringify(after.body)); assert.equal(after.body.task.id, taskId)
      restarted = true; lifecycle.push({ event: 'restart-recovery', taskId, at: new Date().toISOString() })
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(sampleSeconds * 1000, Math.max(50, hours * 3_600_000 - (Date.now() - began)))))
  }
  const first = samples.find((item) => item.process?.rssBytes)
  const last = [...samples].reverse().find((item) => item.process?.rssBytes)
  const elapsedHours = (Date.now() - began) / 3_600_000
  const comparisons = first && last ? { rssGrowthBytes: last.process.rssBytes - first.process.rssBytes, handleGrowth: last.process.handles - first.process.handles } : null
  const report = { id, status: errors.length ? 'FAIL' : elapsedHours >= 24 && restarted ? 'PASS' : 'PARTIAL', startedAt, endedAt: new Date().toISOString(), requestedHours: hours, elapsedHours, minimumAcceptanceHours: 24, continuous24hVerified: elapsedHours >= 24 && errors.length === 0 && restarted, restartRecoveryVerified: restarted, networkRecoveryVerified: lifecycle.some((item) => item.event === 'network-recovery'), duplicateTaskPrevented: lifecycle.some((item) => item.event === 'idempotency-verified'), samples, comparisons, lifecycle, errors }
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({ status: report.status, report: path.join(outputDir, 'report.json'), elapsedHours: report.elapsedHours, continuous24hVerified: report.continuous24hVerified }, null, 2))
  if (errors.length) process.exitCode = 1
} catch (error) {
  errors.push({ kind: 'harness', detail: String(error.message || error), at: new Date().toISOString() })
  const report = { id, status: 'FAIL', startedAt, endedAt: new Date().toISOString(), requestedHours: hours, continuous24hVerified: false, errors, lifecycle, samples }
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.error(JSON.stringify({ status: report.status, report: path.join(outputDir, 'report.json'), error: error.message }, null, 2))
  process.exitCode = 1
} finally {
  await stopService()
  await new Promise((resolve) => proxy.close(resolve))
}
