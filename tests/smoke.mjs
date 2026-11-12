import assert from 'node:assert/strict'

const base = process.env.NEXUS_URL || 'http://localhost:4317'

async function get(path) {
  const response = await fetch(`${base}${path}`)
  const body = await response.json()
  return { response, body }
}

const health = await get('/api/health')
assert.equal(health.response.status, 200)
assert.equal(health.body.ok, true)

const overview = await get('/api/overview')
assert.equal(overview.response.status, 200)
assert.ok('metrics' in overview.body)
assert.ok(Array.isArray(overview.body.projects))

const status = await get('/api/github/status')
assert.equal(status.response.status, 200)
assert.ok(typeof status.body.configured === 'boolean')

const appConfig = await get('/api/github/app/config')
assert.equal(appConfig.response.status, 200)
assert.ok(typeof appConfig.body.configured === 'boolean')

const updateState = await get('/api/auto-update')
assert.equal(updateState.response.status, 200)
assert.ok(Array.isArray(updateState.body.configs))

const authContext = await get('/api/auth/context')
assert.equal(authContext.response.status, 200)
assert.ok(['Viewer', 'Operator', 'Administrator'].includes(authContext.body.role))

if (!status.body.configured) {
  const sync = await fetch(`${base}/api/tasks/sync-repositories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(sync.status, 202)
  const taskEnvelope = await sync.json()
  assert.equal(taskEnvelope.task.status, 'Pending')
}

console.log('PROJECT NEXUS smoke checks passed')
