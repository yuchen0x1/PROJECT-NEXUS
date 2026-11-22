import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { applyCandidateFiles } from '../../server/services/candidate-apply.mjs'
const directories = []
afterEach(async () => { for (const directory of directories.splice(0)) { expect(directory.startsWith(os.tmpdir() + path.sep)).toBe(true); await fs.rm(directory, { recursive: true, force: true }) } })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-apply-')); directories.push(root)
  const originalRoot = path.join(root, 'original'), source = path.join(root, 'candidate'), backupRoot = path.join(root, 'backups', 'task')
  await fs.mkdir(originalRoot); await fs.mkdir(source)
  return { root, originalRoot, source, backupRoot, taskId: 'task' }
}
it('preserves exact binary bytes, backs up originals and reconciles a repeated application', async () => {
  const f = await fixture(), before = Buffer.from([0, 255, 127]), after = Buffer.from([255, 0, 128, 42])
  await fs.writeFile(path.join(f.originalRoot, 'icon.bin'), before); await fs.writeFile(path.join(f.source, 'icon.bin'), after)
  const input = { ...f, changes: [{ path: 'icon.bin', action: 'modified' }], expectedEntries: [{ path: 'icon.bin', sha256: crypto.createHash('sha256').update(after).digest('hex') }] }
  expect((await applyCandidateFiles(input)).appliedPaths).toEqual(['icon.bin'])
  expect(await fs.readFile(path.join(f.originalRoot, 'icon.bin'))).toEqual(after)
  expect(await fs.readFile(path.join(f.backupRoot, 'icon.bin'))).toEqual(before)
  expect((await applyCandidateFiles(input)).alreadyApplied).toBe(true)
  await fs.writeFile(path.join(f.originalRoot, 'icon.bin'), 'user changes')
  await expect(applyCandidateFiles(input)).rejects.toMatchObject({ code: 'AGENT_APPLY_RECOVERY_REQUIRED' })
  expect(await fs.readFile(path.join(f.originalRoot, 'icon.bin'), 'utf8')).toBe('user changes')
})
it('blocks path traversal and original-project junctions before mutating any file', async () => {
  const f = await fixture(), outside = path.join(f.root, 'outside')
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private.txt'), 'preserve')
  await expect(applyCandidateFiles({ ...f, changes: [{ path: '../outside/private.txt', action: 'deleted' }] })).rejects.toMatchObject({ code: 'AGENT_APPLY_PATH_INVALID' })
  await fs.symlink(outside, path.join(f.originalRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(applyCandidateFiles({ ...f, changes: [{ path: 'linked/private.txt', action: 'deleted' }] })).rejects.toMatchObject({ code: 'AGENT_APPLY_PATH_INVALID' })
  expect(await fs.readFile(path.join(outside, 'private.txt'), 'utf8')).toBe('preserve')
})
it('fails closed when a backup cannot be created or candidate bytes no longer match review', async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.originalRoot, 'app.mjs'), 'original'); await fs.writeFile(path.join(f.source, 'app.mjs'), 'candidate')
  await fs.mkdir(f.backupRoot, { recursive: true }); await fs.writeFile(path.join(f.backupRoot, 'app.mjs'), 'existing backup')
  const input = { ...f, changes: [{ path: 'app.mjs', action: 'modified' }] }
  await expect(applyCandidateFiles(input)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await fs.readFile(path.join(f.originalRoot, 'app.mjs'), 'utf8')).toBe('original')
  await expect(applyCandidateFiles({ ...input, expectedEntries: [{ path: 'app.mjs', sha256: '0'.repeat(64) }] })).rejects.toMatchObject({ code: 'AGENT_APPLY_ARTIFACT_CHANGED' })
})
