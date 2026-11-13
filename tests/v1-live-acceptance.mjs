import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { emptyState, saveStateFile } from '../server/services/state-store.mjs'

// Explicitly opt in: this fixture writes ONLY to the named temporary repository.
// The caller creates/deletes that repository. Keys are environment-only.
const repository = process.env.NEXUS_ACCEPTANCE_REPOSITORY
if (!/^yuchen0x1\/nexus-acceptance-\d{8}-\d{4}$/.test(repository || '')) throw new Error('Select the dedicated temporary acceptance repository.')
if (!process.env.GITHUB_TOKEN || !process.env.NEXUS_ACCEPTANCE_API_KEY) throw new Error('Real GitHub and AI credentials are required.')
const root = path.resolve(import.meta.dirname, '..')
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-v1-live-'))
const fixture = path.join(temp, 'original')
const dataDir = path.join(temp, 'data')
const evidence = { repository, startedAt: new Date().toISOString(), temporaryWorkspace: temp, checks: [] }
const record = (name, status, detail) => { evidence.checks.push({ name, status, detail, at: new Date().toISOString() }); console.log(`${status}: ${name}${detail ? ` — ${detail}` : ''}`) }
const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }
async function github(endpoint, options = {}) {
  const response = await fetch(`https://api.github.com${endpoint}`, { ...options, headers, signal: AbortSignal.timeout(30_000) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(`GitHub ${response.status}: ${body.message || endpoint}`), { status: response.status })
  return body
}
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64')}` }
const proxy = execFileSync('git', ['config', '--get-urlmatch', 'http.proxy', 'https://github.com/'], { windowsHide: true, encoding: 'utf8' }).trim()
if (proxy) Object.assign(gitEnv, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'http.proxy', GIT_CONFIG_VALUE_1: proxy })
const git = (...args) => execFileSync('git', args, { cwd: fixture, env: gitEnv, windowsHide: true, timeout: 90_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let server
try {
  const account = await github('/user')
  const repo = await github(`/repos/${repository}`)
  assert.equal(repo.private, true)
  assert.equal(repo.owner.login, account.login)
  record('A: real GitHub identity and repository permissions', 'PASS', `${account.login}; push=${repo.permissions.push}`)
  await fs.mkdir(path.join(fixture, 'src'), { recursive: true })
  await fs.mkdir(path.join(fixture, 'test'), { recursive: true })
  await fs.mkdir(path.join(fixture, '.github', 'workflows'), { recursive: true })
  const files = {
    '.github/workflows/test.yml': 'name: Acceptance CI\non: [push, pull_request]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: node --test\n',
    'package.json': JSON.stringify({ name: 'nexus-acceptance-fixture', version: '0.1.0', private: true, type: 'module', scripts: { test: 'node --test', build: 'node build.mjs' } }, null, 2),
    'README.md': '# NEXUS acceptance fixture\nA small calculator. Run npm test and npm run build. No dependencies.\n',
    'LICENSE': 'MIT License\nCopyright (c) 2026 PROJECT NEXUS acceptance fixture\n',
    'src/calc.mjs': 'export function add(a, b) { return a - b }\n',
    'test/calc.test.mjs': "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/calc.mjs'\ntest('addition of positive numbers', () => assert.equal(add(2, 3), 5))\n",
    'build.mjs': "import fs from 'node:fs/promises'\nawait fs.mkdir('dist', {recursive:true})\nawait fs.copyFile('src/calc.mjs','dist/calc.mjs')\nawait fs.writeFile('dist/acceptance.txt', 'Verified PROJECT NEXUS acceptance artifact\\n')\n"
  }
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(fixture, name), content)
  git('init', '-b', 'main'); git('remote', 'add', 'origin', `https://github.com/${repository}.git`)
  const existingHead = await github(`/repos/${repository}/git/ref/heads/main`).catch((error) => { if (error.status !== 404 && error.status !== 409) throw error; return null })
  if (existingHead) { git('fetch', 'origin', 'main'); git('reset', '--hard', 'origin/main') }
  else { git('add', '.'); git('-c', 'user.name=NEXUS acceptance', '-c', 'user.email=nexus@example.invalid', 'commit', '-m', 'test: reproducible addition bug'); git('push', '-u', 'origin', 'main') }
  const initialSha = git('rev-parse', 'HEAD')
  const releases = await github(`/repos/${repository}/releases`)
  if (!releases.some((release) => release.tag_name === 'v0.1.0')) await github(`/repos/${repository}/releases`, { method: 'POST', body: JSON.stringify({ tag_name: 'v0.1.0', target_commitish: initialSha, name: 'Fixture baseline', body: 'Intentional acceptance bug baseline.' }) })
  try { execFileSync(process.execPath, ['--test'], { cwd: fixture, windowsHide: true, stdio: 'pipe' }); throw new Error('Bug did not reproduce') }
  catch (error) { assert.equal(error.status, 1); record('C: original bug reproduced by real test', 'PASS', 'add(2, 3) returned -1 instead of 5') }
  const existingIssues = await github(`/repos/${repository}/issues`)
  const issue = existingIssues.find((issue) => issue.title === 'Bug: add(2, 3) returns -1 instead of 5') || await github(`/repos/${repository}/issues`, { method: 'POST', body: JSON.stringify({ title: 'Bug: add(2, 3) returns -1 instead of 5', body: 'The calculator subtracts instead of adding. Reproduce with npm test. Expected add(2, 3) === 5, actual -1. Fix src/calc.mjs and add regression coverage for negative numbers and zero. Preserve the existing test. Run npm test and npm run build.' }) })
  const state = structuredClone(emptyState)
  state.projects = [{ id: `gh_${repo.id}`, name: repo.name, owner: account.login, fullName: repository, defaultBranch: 'main', stack: ['Node.js'], hosting: { enabled: false, strategy: 'observe' } }]
  const stateFile = path.join(dataDir, 'state.json')
  await saveStateFile(stateFile, state)
  const localToken = crypto.randomBytes(32).toString('hex')
  let output = ''
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: '0', NEXUS_HOST: '127.0.0.1', NEXUS_DATA_DIR: dataDir, NEXUS_STATE_FILE: stateFile,
    NEXUS_DESKTOP_MODE: 'true', NEXUS_LOCAL_API_TOKEN: localToken, NEXUS_REPO_WORKSPACE_ROOT: path.join(dataDir, 'repositories'),
    NEXUS_ENABLE_REMOTE_WRITES: 'true', AI_PROVIDER_KIND: 'openai-compatible', AI_BASE_URL: process.env.NEXUS_ACCEPTANCE_BASE_URL || 'https://sub.pikaqiu.shop/v1', AI_API_KEY: process.env.NEXUS_ACCEPTANCE_API_KEY, AI_MODEL: process.env.NEXUS_ACCEPTANCE_MODEL || 'gpt-6-luna', AI_REQUEST_TIMEOUT_MS: '120000'
  } })
  server.stdout.on('data', (x) => { output = (output + x).slice(-10000) }); server.stderr.on('data', (x) => { output = (output + x).slice(-10000) })
  for (let i = 0; i < 200 && !output.includes('NEXUS_DESKTOP_READY:'); i++) await new Promise((r) => setTimeout(r, 100))
  const port = output.match(/NEXUS_DESKTOP_READY:(\d+)/)?.[1]
  assert.ok(port, 'Server became ready')
  const base = `http://127.0.0.1:${port}`
  async function api(method, endpoint, body = {}) {
    const response = await fetch(base + endpoint, { method, headers: { Authorization: `Bearer ${localToken}`, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(240_000) })
    const result = await response.json()
    if (!response.ok) throw new Error(`${endpoint} ${response.status}: ${result.message || result.code}`)
    return result
  }
  const projectId = state.projects[0].id
  await api('POST', `/api/projects/${projectId}/hosting/inspect`, { depth: 'light' })
  assert.equal(await fs.stat(path.join(dataDir, 'repositories')).then(() => true).catch(() => false), false)
  record('B: live monitoring performs no clone', 'PASS')
  await api('PUT', `/api/projects/${projectId}/hosting`, { strategy: 'autonomous', enabled: false, intervalMinutes: 120, executionMode: 'trusted-local', requiredChecks: ['test'] })
  const ready = await api('POST', `/api/projects/${projectId}/hosting/readiness`)
  await api('POST', `/api/projects/${projectId}/hosting/enable`, ready)
  await api('POST', `/api/projects/${projectId}/issues/sync`)
  // Explicit test-run authorization also covers high-risk triage of this disposable fixture.
  await api('POST', `/api/projects/${projectId}/issues/${issue.number}/fix`)
  let activity
  let last = ''
  for (let attempt = 0; attempt < 240; attempt++) {
    if (attempt % 6 === 0 && !activity?.fixState) await api('POST', `/api/projects/${projectId}/issues/sync`)
    const response = await api('GET', `/api/projects/${projectId}/issues`)
    activity = response.issues.find((item) => item.number === issue.number)
    if (activity?.fixState !== last) { last = activity?.fixState; console.log(`Issue fix state: ${last || 'pending'}`) }
    if (['succeeded', 'failed', 'blocked', 'interrupted'].includes(last)) break
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  evidence.activity = activity
  assert.equal(activity?.fixState, 'succeeded', JSON.stringify(activity?.fixSummary))
  assert.ok(activity.fixSummary.pullRequest?.number, 'Real PR created')
  const pull = await github(`/repos/${repository}/pulls/${activity.fixSummary.pullRequest.number}`)
  assert.equal(pull.merged, true, 'Real PR merged')
  const hosted = await api('GET', '/api/hosting/jobs')
  const job = hosted.jobs.find((item) => item.issueNumber === issue.number)
  evidence.job = job
  assert.equal(job.executionStatus, 'Succeeded'); assert.equal(job.deliveryStatus, 'Succeeded')
  assert.ok(job.outcome.merged.ci.passed)
  assert.ok(job.operations.every((operation) => operation.status === 'Confirmed'))
  record('Ordered upgrade: remote Actions CI, dual status and durable receipts', 'PASS', `${job.operations.length} confirmed operations`)
  record('C: AI fix, regression test, build, review, push and PR', 'PASS', `PR #${pull.number}`)
  assert.equal(git('rev-parse', 'HEAD'), initialSha)
  assert.equal(await fs.readFile(path.join(fixture, 'src/calc.mjs'), 'utf8'), files['src/calc.mjs'])
  record('B/G: original project preserved and task worktree isolated', 'PASS')
  assert.equal(activity.fixSummary.released?.published, true, activity.fixSummary.released?.reason)
  const release = await github(`/repos/${repository}/releases/tags/v0.1.1`)
  assert.equal(release.draft, false); assert.ok(release.assets.length)
  const closed = await github(`/repos/${repository}/issues/${issue.number}`)
  assert.equal(closed.state, 'closed')
  record('D: release assets and verified issue closure', 'PASS', `v0.1.1; ${release.assets.length} asset(s)`)
  evidence.release = { tag: release.tag_name, assets: release.assets.map((asset) => ({ name: asset.name, size: asset.size, digest: asset.digest })) }
} catch (error) {
  record('Live acceptance', 'FAIL', String(error.message).replace(/(?:sk-|github_pat_|ghp_)[A-Za-z0-9_-]+/g, '[REDACTED]'))
  process.exitCode = 1
} finally {
  if (server) { server.kill(); await new Promise((resolve) => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve) }) }
  evidence.finishedAt = new Date().toISOString()
  await fs.mkdir(path.join(root, 'docs', 'evidence'), { recursive: true })
  await fs.writeFile(path.join(root, 'docs', 'evidence', 'v1-ordered-live-acceptance.json'), JSON.stringify(evidence, null, 2))
  console.log(`Evidence saved; local fixture retained at ${temp}`)
}
