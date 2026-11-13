import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { durableEffect, reconcileEffect } from '../../server/services/durable-effects.mjs'
import { acquireFileLease } from '../../server/services/file-lease.mjs'
import { cleanupTestEnvironment, tempDataDir } from './helpers/server-harness.mjs'

afterEach(cleanupTestEnvironment)
describe('durable effects and host ownership', () => {
  it('persists intent before sending and never repeats a lost response', async () => {
    let disk, writes = 0
    const job = {}
    const args = { job, endpoint: '/repos/a/b/pulls', options: { method: 'POST', body: JSON.stringify({ head: 'fix', base: 'main' }) }, save: async () => { disk = structuredClone(job) }, perform: async () => { expect(disk.operations[0].status).toBe('Prepared'); writes++; throw new Error('response lost') } }
    await expect(durableEffect(args)).rejects.toThrow('response lost')
    await expect(durableEffect({ ...args, job: structuredClone(disk) })).rejects.toThrow(/reconciliation/)
    expect(writes).toBe(1)
    const operation = disk.operations[0]
    expect(await reconcileEffect(operation, async () => [{ number: 7, head: { ref: 'fix' }, base: { ref: 'main' } }])).toBe(true)
    expect(await durableEffect({ ...args, job: disk })).toMatchObject({ number: 7 })
    expect(writes).toBe(1)
  })
  it('does not send if durability or permission checks fail', async () => {
    let sent = false
    await expect(durableEffect({ job: {}, endpoint: 'x', save: async () => { throw new Error('disk full') }, perform: async () => { sent = true } })).rejects.toThrow('disk full')
    expect(sent).toBe(false)
  })
  it('holds a file lease across independent callers and recovers a dead owner', async () => {
    const dir = await tempDataDir()
    const file = path.join(dir, 'repo.lock')
    const first = await acquireFileLease(file)
    await expect(acquireFileLease(file)).rejects.toMatchObject({ code: 'LEASE_HELD' })
    await first.release()
    await fs.writeFile(file, JSON.stringify({ pid: 2147483647, token: 'dead' }))
    const recovered = await acquireFileLease(file)
    await recovered.release()
  })
  it('requires an exact merged head and exact asset digest for reconciliation', async () => {
    expect(await reconcileEffect({ endpoint: '/repos/a/b/pulls/7/merge', body: '{"sha":"tested"}' }, async () => ({ merged: true, head: { sha: 'other' } }))).toBe(false)
    expect(await reconcileEffect({ endpoint: 'upload:1:x', repository: 'a/b', releaseId: 1, name: 'x', size: 1, sha256: 'good' }, async () => [{ name: 'x', size: 1, digest: 'sha256:bad' }])).toBe(false)
    expect(await reconcileEffect({ endpoint: '/repos/a/b/releases', body: '{"tag_name":"v1","target_commitish":"tested"}' }, async () => ({ tag_name: 'v1', target_commitish: 'other' }))).toBe(false)
  })
})
