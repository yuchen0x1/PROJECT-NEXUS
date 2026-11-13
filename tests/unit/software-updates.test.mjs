import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { SoftwareUpdates, isNewerSoftwareVersion } from '../../server/services/software-updates.mjs'
const directories = []
async function setup(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-updates-')); directories.push(dataDir)
  const bytes = Buffer.from('fixture installer bytes, not an executable')
  const release = { tag_name: 'v0.8.0', html_url: 'https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.8.0', assets: [{ name: 'PROJECT-NEXUS-0.8.0-win-x64-setup.exe', size: bytes.length, digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, browser_download_url: 'https://github.com/yuchen0x1/PROJECT-NEXUS/releases/download/v0.8.0/PROJECT-NEXUS-0.8.0-win-x64-setup.exe' }] }
  const service = new SoftwareUpdates({ dataDir, version: '0.7.0', request: async () => release, fetchImpl: async () => new Response(bytes), verify: async () => ({ valid: false, status: 'NotSigned' }), ...options })
  return { service, bytes, release, dataDir }
}
afterEach(async () => { for (const dir of directories.splice(0)) { expect(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true); await fs.rm(dir, { recursive: true, force: true }) } })
it('compares complete versions and rejects downgrades, prereleases and missing digests', async () => {
  expect(isNewerSoftwareVersion('v0.10.0', '0.9.9')).toBe(true)
  expect(isNewerSoftwareVersion('0.7.0', '0.8.0')).toBe(false)
  const { service, release } = await setup()
  release.prerelease = true
  await expect(service.check()).rejects.toMatchObject({ code: 'UPDATE_RELEASE_INVALID' })
  release.prerelease = false; release.assets[0].digest = ''
  await expect(service.check()).rejects.toMatchObject({ code: 'UPDATE_ASSET_INVALID' })
})
it('verifies actual streamed bytes but never treats an unsigned package as installable', async () => {
  const { service } = await setup()
  const candidate = await service.check()
  const result = await service.download(candidate.id)
  expect(result.hashVerified).toBe(true)
  expect(result.status).toBe('Blocked')
  expect(result.signature.valid).toBe(false)
  expect(result.installationAuthorized).toBe(false)
  await expect(service.prepareInstall(candidate.id, { confirm: true, currentVersion: '0.7.0' })).rejects.toMatchObject({ code: 'UPDATE_NOT_VERIFIED' })
})
it('refuses an external redirect and deletes partial bytes on a hash mismatch', async () => {
  const { service, dataDir } = await setup({ fetchImpl: async () => new Response('bad', { status: 302, headers: { Location: 'http://127.0.0.1/private' } }) })
  const candidate = await service.check()
  await expect(service.download(candidate.id)).rejects.toMatchObject({ code: 'UPDATE_REDIRECT_INVALID' })
  service.fetch = async () => new Response(Buffer.alloc(candidate.asset.size, 1))
  await expect(service.download(candidate.id)).rejects.toMatchObject({ code: 'UPDATE_HASH_MISMATCH' })
  expect(await fs.stat(path.join(dataDir, 'evolution/update-cache', candidate.id, 'installer.part')).catch(() => null)).toBeNull()
})
it('binds the expected publisher and repeats both hash and signature checks before native handoff', async () => {
  // Signature verifier is a fixture in this unit test; no real signature acceptance is claimed.
  const { service, dataDir } = await setup({ publisher: 'CN=Fixture Publisher', verify: async () => ({ valid: true, status: 'Valid', publisher: 'CN=Fixture Publisher' }) })
  const candidate = await service.check()
  expect((await service.download(candidate.id)).status).toBe('Verified')
  await expect(service.prepareInstall(candidate.id, { currentVersion: '0.7.0' })).rejects.toMatchObject({ code: 'UPDATE_CONFIRM_REQUIRED' })
  const receipt = await service.prepareInstall(candidate.id, { confirm: true, currentVersion: '0.7.0' })
  expect(receipt.installationAuthorized).toBe(false)
  expect(receipt.requiresNativeConfirmation).toBe(true)
  await fs.writeFile(path.join(dataDir, 'evolution/update-cache', candidate.id, candidate.asset.name), 'tampered')
  await expect(service.prepareInstall(candidate.id, { confirm: true, currentVersion: '0.7.0' })).rejects.toMatchObject({ code: 'UPDATE_CHANGED' })
})
