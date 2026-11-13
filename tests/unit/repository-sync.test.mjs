import { describe, it, expect } from 'vitest'
import { createSyncGate, reconcileRepositories, repositoryAvailable, retryDeadline } from '../../server/services/repository-sync.mjs'

const repo = (id, extra = {}) => ({ id: `repo_${id}`, githubId: id, fullName: `fixture/repo-${id}`, owner: 'fixture', archived: false, ...extra })
describe('authoritative repository synchronization', () => {
  it('reconciles 26 to 25 without deleting history, policies or workspaces, and restores reappearing records', () => {
    const projects = Array.from({ length: 26 }, (_, index) => repo(index + 1))
    const scanned = projects[0]
    scanned.stack = ['TypeScript', 'Electron']; scanned.latestRelease = { tag: 'v1.0.0' }; scanned.workflows = [{ id: 7 }]
    const original = projects[25]
    original.hosting = { enabled: true }; original.localWorkspace = { path: 'retained' }
    expect(reconcileRepositories(projects, projects.slice(0, 25).map((item) => ({ ...item, stack: ['JavaScript'], latestRelease: null, workflows: [] }))).unavailable).toBe(1)
    expect(scanned).toMatchObject({ stack: ['TypeScript', 'Electron'], latestRelease: { tag: 'v1.0.0' }, workflows: [{ id: 7 }] })
    expect(projects.filter(repositoryAvailable)).toHaveLength(25)
    expect(projects).toHaveLength(26)
    expect(original).toMatchObject({ repositoryAvailable: false, hosting: { enabled: true }, localWorkspace: { path: 'retained' } })
    reconcileRepositories(projects, [repo(26)], { complete: false })
    expect(projects.filter(repositoryAvailable)).toHaveLength(26)
    expect(projects[25]).toBe(original)
  })
  it('never removes missing entries from an incomplete snapshot or another installation scope', () => {
    const projects = [repo(1), repo(2, { installationId: 'app-a' }), repo(3, { installationId: 'app-b' })]
    reconcileRepositories(projects, [], { complete: false })
    expect(projects.every(repositoryAvailable)).toBe(true)
    reconcileRepositories(projects, [], { installationId: 'app-a' })
    expect(projects.filter(repositoryAvailable).map((item) => item.id)).toEqual(['repo_1', 'repo_3'])
  })
  it('uses stable identities for renames and keeps an old deleted identity when a name is reused', () => {
    const projects = [repo(1, { hosting: { enabled: true } })]
    const retained = projects[0]
    reconcileRepositories(projects, [repo(1, { fullName: 'fixture/renamed' })])
    expect(projects).toHaveLength(1); expect(projects[0]).toBe(retained)
    reconcileRepositories(projects, [repo(2, { fullName: 'fixture/renamed' })])
    expect(projects.filter(repositoryAvailable)).toHaveLength(1)
    expect(projects).toHaveLength(2)
  })
  it('keeps a repository available when another authoritative connection still lists it', () => {
    const projects = [repo(1, { installationId: 'app-a' })]
    reconcileRepositories(projects, [repo(1)])
    reconcileRepositories(projects, [], { installationId: 'app-a' })
    expect(repositoryAvailable(projects[0])).toBe(true)
    reconcileRepositories(projects, [])
    expect(repositoryAvailable(projects[0])).toBe(false)
  })
  it('deduplicates in-flight jobs and enforces 60 seconds for automatic requests while permitting manual refresh', () => {
    let time = 0, starts = 0
    const gate = createSyncGate({ clock: () => time })
    const start = () => ({ id: `task-${++starts}` })
    expect(gate.request(true, start).task.id).toBe('task-1')
    expect(gate.request(false, start)).toMatchObject({ reused: true, task: { id: 'task-1' } })
    gate.finish()
    time = 59_999
    expect(gate.request(true, start).skipped).toBe(true)
    time++
    expect(gate.request(true, start).task.id).toBe('task-2')
    gate.finish()
    expect(gate.request(false, start).task.id).toBe('task-3')
  })
  it('honors Retry-After, reset headers and persisted retry windows, without marking partial data successful', () => {
    const clock = () => 100_000
    expect(retryDeadline({ retryAfter: '120', rateRemaining: '0', rateReset: '300' }, 1, clock())).toBe(300_000)
    const gate = createSyncGate({ clock })
    gate.request(true, () => ({ id: 'one' })); gate.finish({ retryAfter: '120', code: 'GITHUB_RATE_LIMITED' })
    const restarted = createSyncGate({ clock, initial: gate.status() })
    expect(restarted.request(false, () => { throw Error('must not request') }).reason).toBe('backoff')
    expect(restarted.status().lastSuccessAt).toBeNull()
    const partial = createSyncGate({ clock })
    partial.request(true, () => ({ id: 'partial' })); partial.finish(null, true)
    expect(partial.status()).toMatchObject({ lastSuccessAt: null, lastErrorCode: 'GITHUB_SYNC_PARTIAL' })
  })
})
