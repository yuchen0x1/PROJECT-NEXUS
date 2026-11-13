import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildProjectOverview, OVERVIEW_EVENT_LIMIT } from '../../server/services/project-overview.mjs'
import { emptyState, saveStateFile } from '../../server/services/state-store.mjs'
import { cleanupTestEnvironment, startHttpServer, startNexusServer, tempDataDir, getJson } from './helpers/server-harness.mjs'

afterEach(cleanupTestEnvironment)
const project = (id) => ({ id, name: id, fullName: `owner/${id}`, owner: 'owner', hosting: { enabled: true, strategy: 'autonomous', intervalMinutes: 30 } })
const fixture = () => ({ projects: [project('one'), project('two')], hostedJobs: [], integrationJobs: [], hostingRuns: [], researchReports: [] })

describe('project overview projection', () => {
  it('joins hosted work to its runtime and preserves delivery failures', () => {
    const state = fixture()
    state.hostedJobs.push({ id: 'job', projectId: 'one', status: 'Running', createdAt: '2026-11-13T00:00:00Z', events: [{ type: 'task_created', at: '2026-11-13T00:00:00Z', metadata: { taskId: 'runtime' } }] })
    const local = { id: 'runtime', projectId: 'one', status: 'Running', phase: 'executing', providerId: 'provider', events: [{ at: '2026-11-13T00:00:01Z', type: 'tool_call', detail: 'run_tests → ok', metadata: { resultSummary: '2 tests passed' } }] }
    let result = buildProjectOverview({ state, localTasks: [local] })
    expect(result.tasks).toHaveLength(1)
    expect(result.stats.running).toBe(1)
    expect(result.repositories[0].status).toBe('running')
    expect(result.tasks[0].stage).toBe('execution')
    expect(result.events[0].detail).toContain('2 tests passed')
    state.hostedJobs[0].status = 'Succeeded'; state.hostedJobs[0].executionStatus = 'Succeeded'; state.hostedJobs[0].deliveryStatus = 'Incomplete'
    local.status = 'Succeeded'; local.phase = 'delivered'
    result = buildProjectOverview({ state, localTasks: [local] })
    expect(result.repositories[0].status).toBe('blocked')
    expect(result.stats.running).toBe(0)
    expect(result.tasks[0].deliveryStatus).toBe('Incomplete')
  })

  it('redacts known secrets, bounds outputs and never returns prompts or credential fields', () => {
    const secret = 'opaque-private-provider-credential'
    const state = fixture(), before = JSON.stringify(state)
    const result = buildProjectOverview({ state, secrets: [secret], providers: [{ id: 'p', name: 'Provider', model: 'm', configured: true, apiKey: secret }], localTasks: [{ id: 't', projectId: 'one', label: secret, prompt: 'DO NOT RETURN MY PROMPT', workspace: { path: 'C:/private/workspace' }, status: 'Running', error: secret, events: [{ detail: `${secret} ${'x'.repeat(4000)}` }] }] })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain('DO NOT RETURN MY PROMPT')
    expect(JSON.stringify(result)).not.toContain('C:/private/workspace')
    expect(result.events[0].detail.length).toBeLessThanOrEqual(1000)
    expect(JSON.stringify(state)).toBe(before)
  })

  it('scopes output without removing other repositories and caps event history', () => {
    const tasks = Array.from({ length: 30 }, (_, index) => ({ id: `t-${index}`, projectId: index % 2 ? 'one' : 'two', status: 'Succeeded', phase: 'delivered', events: Array.from({ length: 12 }, (_, e) => ({ at: new Date(Date.UTC(2026, 10, 13, 0, index, e)).toISOString(), detail: `Recorded ${index}/${e}` })) }))
    const result = buildProjectOverview({ state: fixture(), localTasks: tasks, projectId: 'one' })
    expect(result.events).toHaveLength(OVERVIEW_EVENT_LIMIT)
    expect(result.eventsTruncated).toBe(true)
    expect(result.events.every((event) => event.projectId === 'one')).toBe(true)
    expect(result.tasks.every((task) => task.projectId === 'one')).toBe(true)
    expect(result.repositories).toHaveLength(2)
    expect(result.eventsScope).toBe('one')
  })

  it('keeps paused, queued, unknown and unrelated local tasks distinct from running repository work', () => {
    const result = buildProjectOverview({ state: fixture(), paused: true, localTasks: [{ id: 'paused', projectId: 'one', status: 'Paused' }, { id: 'queue', projectId: 'two', status: 'Queued' }, { id: 'local', projectId: 'local-folder', projectName: 'one', status: 'Running' }, { id: 'unknown', projectId: 'one', status: 'Unknown' }] })
    expect(result.repositories.find((repo) => repo.id === 'one').status).toBe('blocked')
    expect(result.repositories.find((repo) => repo.id === 'two').status).toBe('queued')
    expect(result.tasks.find((task) => task.taskId === 'local').projectId).toBeNull()
    expect(result.tasks.find((task) => task.taskId === 'unknown').status).toBe('idle')
    expect(result.paused).toBe(true)
  })

  it('shows live research only while a real in-flight record exists and never invents an account', () => {
    const state = fixture()
    const live = buildProjectOverview({ state, activeResearch: [{ id: 'research-now', projectId: 'one', repository: 'owner/one' }] })
    expect(live.services.find((service) => service.id === 'research').running).toBe(1)
    expect(live.account.login).toBeNull()
    expect(buildProjectOverview({ state }).stats.running).toBe(0)
  })
})

describe('project overview API', () => {
  it('requires the desktop API credential and performs no GitHub or provider requests', async () => {
    const dataDir = await tempDataDir('nexus-overview-api-')
    const stateFile = path.join(dataDir, 'state.json'), token = 'overview-local-test-token'
    const state = structuredClone(emptyState)
    state.projects = [project('one'), project('two')].map((p) => ({ ...p, hosting: { enabled: false, strategy: 'observe' } }))
    await saveStateFile(stateFile, state)
    let externalRequests = 0
    const providerUrl = await startHttpServer((_req, res) => { externalRequests++; res.end('{}') })
    const { base } = await startNexusServer({ dataDir, stateFile, providerUrl, token })
    const before = await fs.readFile(stateFile, 'utf8')
    expect((await fetch(`${base}/api/project-overview`)).status).toBe(401)
    const response = await getJson(base, token, '/api/project-overview?projectId=one')
    expect(response.response.status).toBe(200)
    expect(response.body.repositories).toHaveLength(2)
    expect(response.body.eventsScope).toBe('one')
    expect(response.body.stats.running).toBe(0)
    expect(externalRequests).toBe(0)
    expect(await fs.readFile(stateFile, 'utf8')).toBe(before)
  })
})
