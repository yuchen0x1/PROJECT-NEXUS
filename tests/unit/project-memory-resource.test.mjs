import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ProjectMemory } from '../../server/services/project-memory.mjs'
import { ResourceGovernor } from '../../server/services/resource-governor.mjs'
const dirs = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    expect(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  }
})
it('reuses unchanged file analysis, keeps source hashes and isolates knowledge between projects', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-memory-')); dirs.push(dir)
  const first = path.join(dir, 'one'), second = path.join(dir, 'two')
  await fs.mkdir(first); await fs.mkdir(second)
  await fs.writeFile(path.join(first, 'app.mjs'), 'export const name = "one"\n')
  await fs.writeFile(path.join(second, 'app.mjs'), 'export const name = "two"\n')
  const memory = new ProjectMemory(path.join(dir, 'data'))
  const initial = await memory.refresh({ id: 'one', name: 'One', path: first })
  expect(initial.indexStats.analyzedFiles).toBe(1)
  const again = await memory.refresh({ id: 'one', name: 'One', path: first })
  expect(again.indexStats.analyzedFiles).toBe(0)
  expect(again.indexStats.reusedFiles).toBe(1)
  await expect(memory.remember('one', { text: 'Unsupported assertion', verified: true })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_UNVERIFIED' })
  await memory.remember('one', { text: 'Operator checked the name export.', verified: true, source: { path: 'app.mjs', sha256: initial.files[0].sha256 } })
  await memory.remember('one', { text: 'Potential future refactor.' })
  const exported = await memory.export('one')
  expect(exported.facts.map((fact) => fact.classification)).toEqual(['verified', 'inference'])
  await memory.recordExperience({ id: 'workflow-one', projectId: 'one', status: 'Completed', revision: 10, nodes: [{ role: 'reviewer', status: 'Completed', result: { verdict: 'approve', summary: 'Model assessment only.' } }] })
  const experience = (await memory.export('one')).experiences[0]
  expect(experience.classification).toBe('observed-execution')
  expect(experience.modelNarratives[0].classification).toBe('model-assessment')
  await memory.refresh({ id: 'two', name: 'Two', path: second })
  expect((await memory.export('two')).facts).toEqual([])
  await expect(memory.refresh({ id: 'one', name: 'Wrong', path: second })).rejects.toMatchObject({ code: 'MEMORY_PROJECT_CHANGED' })
  await expect(memory.clear('one')).rejects.toThrow(/confirmation/)
  await memory.clear('one', { confirm: true })
  expect(await memory.export('one')).toBeNull()
  expect(await memory.recordExperience({ id: 'late-receipt', projectId: 'one' })).toBeNull()
  expect(await memory.export('one')).toBeNull()
  expect(await memory.export('two')).not.toBeNull()
  expect(await fs.readFile(path.join(first, 'app.mjs'), 'utf8')).toContain('one')
})
it('blocks low-disk work and reduces concurrency under measured memory pressure', async () => {
  let free = 8 * 1024 ** 3, disk = 10 * 1024 ** 3
  const system = { totalmem: () => 16 * 1024 ** 3, freemem: () => free, availableParallelism: () => 12, cpus: () => [{ times: { idle: 100, user: 20 } }] }
  const governor = new ResourceGovernor({ dataDir: process.cwd(), system, disk: async () => ({ bavail: disk, bsize: 1 }) })
  expect((await governor.sample({ force: true })).concurrency).toBe(4)
  free = 400 * 1024 ** 2
  const pressured = await governor.sample({ force: true })
  expect(pressured.concurrency).toBe(1)
  expect(pressured.pressure).toBe(true)
  disk = 100 * 1024 ** 2
  expect((await governor.sample({ force: true })).allowed).toBe(false)
})
it('does not invent disk or network measurements when telemetry is unavailable', async () => {
  const governor = new ResourceGovernor({ dataDir: process.cwd(), disk: async () => { throw new Error('unavailable') } })
  const sample = await governor.sample()
  expect(sample.diskFreeBytes).toBeNull()
  expect(sample.allowed).toBe(false)
  expect(sample.network).toBe('not-probed')
})
