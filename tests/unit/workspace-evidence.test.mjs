import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { captureWorkspaceEvidence } from '../../server/services/workspace-evidence.mjs'

const directories = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) { expect(directory.startsWith(os.tmpdir() + path.sep)).toBe(true); await fs.rm(directory, { recursive: true, force: true }) }
})
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-evidence-')); directories.push(root)
  const source = path.join(root, 'source'); await fs.mkdir(source)
  const bytes = Buffer.from([0, 255, 128, 42]); await fs.writeFile(path.join(source, 'app.bin'), bytes)
  return { root, bytes, adapter: { source, workspaceRoot: root, diff: async () => ({ diff: 'binary fixture', changes: [{ path: 'app.bin', action: 'added' }] }) } }
}
it('retries a Windows lock-sharing error without bypassing mutual exclusion or changing binary evidence', async () => {
  const f = await fixture(), open = fs.open.bind(fs)
  let first = true, active = 0, maximum = 0
  vi.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
    if (String(file).endsWith('.lock') && first) { first = false; throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }) }
    return open(file, ...args)
  })
  const diff = f.adapter.diff
  f.adapter.diff = async () => { active++; maximum = Math.max(maximum, active); try { await new Promise((resolve) => setTimeout(resolve, 30)); return await diff() } finally { active-- } }
  const [one, two] = await Promise.all([captureWorkspaceEvidence(f.adapter), captureWorkspaceEvidence(f.adapter)])
  expect(maximum).toBe(1)
  expect(one.artifactSha256).toBe(two.artifactSha256)
  expect(one.entries[0].sha256).toBe(crypto.createHash('sha256').update(f.bytes).digest('hex'))
})
it('does not return evidence if lock access remains denied and cancellation arrives', async () => {
  const f = await fixture(), open = fs.open.bind(fs)
  vi.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
    if (String(file).endsWith('.lock')) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    return open(file, ...args)
  })
  const diff = vi.spyOn(f.adapter, 'diff')
  await expect(captureWorkspaceEvidence(f.adapter, { signal: AbortSignal.timeout(80) })).rejects.toMatchObject({ name: 'TimeoutError' })
  expect(diff).not.toHaveBeenCalled()
})
