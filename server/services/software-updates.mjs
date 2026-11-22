import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { EvolutionStore } from './evolution-store.mjs'
import { verifyArtifactSignature } from './artifact-signature.mjs'
import { acquireFileLease } from './file-lease.mjs'

const fail = (code, message) => Object.assign(new Error(message), { code })
const versionOf = (tag) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag))?.slice(1).map(Number)
const isNewer = (next, current) => {
  const a = versionOf(next), b = versionOf(current)
  if (!a || !b) return false
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index]
  return false
}
const downloadHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
export class SoftwareUpdates {
  constructor({ dataDir, version, request, publisher = '', fetchImpl = fetch, verify = verifyArtifactSignature }) {
    this.store = new EvolutionStore(dataDir, 'updates'); this.cache = path.join(dataDir, 'evolution', 'update-cache')
    this.version = version; this.request = request; this.publisher = publisher; this.fetch = fetchImpl; this.verify = verify
  }
  async recover() {
    for (const record of await this.store.list()) if (record.status === 'Downloading') await this.store.update(record.id, (current) => ({ ...current, status: 'Blocked', blockedReason: 'HOST_RESTARTED', installationAuthorized: false }))
  }
  async check() {
    const release = await this.request('/repos/yuchen0x1/PROJECT-NEXUS/releases/latest')
    if (release.draft || release.prerelease || !versionOf(release.tag_name)) throw fail('UPDATE_RELEASE_INVALID', 'No supported published full release was returned.')
    const asset = release.assets?.find((item) => item.name === `PROJECT-NEXUS-${release.tag_name.replace(/^v/, '')}-win-x64-setup.exe`)
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 512 * 1024 ** 2) throw fail('UPDATE_ASSET_INVALID', 'The release has no bounded Windows installer with a SHA256 digest.')
    const url = new URL(asset.browser_download_url)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || !url.pathname.startsWith('/yuchen0x1/PROJECT-NEXUS/releases/download/')) throw fail('UPDATE_URL_INVALID', 'Installer URL does not belong to the expected GitHub repository.')
    const id = crypto.createHash('sha256').update(JSON.stringify([release.tag_name, asset.digest, asset.size])).digest('hex')
    return this.store.update(id, (current) => current || ({ id, status: 'Discovered', version: release.tag_name.replace(/^v/, ''), currentVersion: this.version, newer: isNewer(release.tag_name, this.version), checkedAt: new Date().toISOString(), releaseUrl: release.html_url, asset: { name: asset.name, size: asset.size, sha256: asset.digest.slice(7), url: asset.browser_download_url }, publisherConfigured: Boolean(this.publisher), installationAuthorized: false }))
  }
  async download(id, { signal } = {}) {
    const lease = await acquireFileLease(`${this.store.file(id)}.download.lock`)
    let temporary
    try {
      const candidate = await this.store.get(id)
      if (!candidate || !candidate.newer) throw fail('UPDATE_NOT_NEWER', 'Only a newer discovered candidate can be downloaded.')
      if (!['Discovered', 'Blocked', 'Downloaded', 'Verified'].includes(candidate.status)) throw fail('UPDATE_NOT_DOWNLOADABLE', 'This update is not awaiting download.')
      await this.store.update(id, (record) => ({ ...record, status: 'Downloading', downloadedBytes: 0 }))
      const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(300000)])
      let url = candidate.asset.url, response
      for (let redirect = 0; redirect <= 5; redirect++) {
        const target = new URL(url)
        if (target.protocol !== 'https:' || !downloadHosts.has(target.hostname) || target.username || target.password) throw fail('UPDATE_REDIRECT_INVALID', 'Download redirect left the trusted HTTPS hosts.')
        response = await this.fetch(url, { redirect: 'manual', signal: combined })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location'); await response.body?.cancel()
          if (!location || redirect === 5) throw fail('UPDATE_REDIRECT_INVALID', 'Download exceeded its redirect limit.')
          url = new URL(location, url).href; continue
        }
        break
      }
      if (response.status !== 200 || !response.body) throw fail('UPDATE_DOWNLOAD_FAILED', 'The update download did not return a full installer.')
      const advertised = response.headers.get('content-length')
      if (advertised && Number(advertised) !== candidate.asset.size) throw fail('UPDATE_SIZE_MISMATCH', 'Installer size does not match the release asset.')
      const directory = path.join(this.cache, id)
      await fs.mkdir(directory, { recursive: true })
      temporary = path.join(directory, 'installer.part')
      await fs.rm(temporary, { force: true })
      const handle = await fs.open(temporary, 'wx', 0o600), digest = crypto.createHash('sha256')
      let bytes = 0, lastProgress = 0
      try {
        for await (const chunk of response.body) {
          combined.throwIfAborted(); bytes += chunk.length
          if (bytes > candidate.asset.size) throw fail('UPDATE_SIZE_MISMATCH', 'Download exceeded its declared size.')
          digest.update(chunk); await handle.writeFile(chunk)
          if (bytes - lastProgress >= 4 * 1024 ** 2) { lastProgress = bytes; await this.store.update(id, (record) => ({ ...record, downloadedBytes: bytes })) }
        }
        await handle.sync()
      } finally { await handle.close() }
      if (bytes !== candidate.asset.size || digest.digest('hex') !== candidate.asset.sha256) throw fail('UPDATE_HASH_MISMATCH', 'Downloaded installer failed its SHA256 or size check.')
      const file = path.join(directory, candidate.asset.name)
      await fs.rename(temporary, file); temporary = null
      const signature = await this.verify(file)
      // A valid certificate belonging to any publisher is insufficient: bind the expected publisher.
      const publisherMatches = Boolean(this.publisher) && signature.publisher === this.publisher
      const verified = signature.valid === true && publisherMatches
      return await this.store.update(id, (record) => ({ ...record, status: verified ? 'Verified' : 'Blocked', downloadedBytes: bytes, downloadedAt: new Date().toISOString(), hashVerified: true, signature: { status: signature.status, publisher: signature.publisher || null, valid: signature.valid === true, publisherMatches }, blockedReason: !this.publisher ? 'PUBLISHER_NOT_CONFIGURED' : !signature.valid ? 'SIGNATURE_INVALID' : !publisherMatches ? 'PUBLISHER_MISMATCH' : null, installationAuthorized: false }))
    } catch (cause) {
      const record = await this.store.get(id)
      if (record) await this.store.update(id, (current) => ({ ...current, status: 'Blocked', blockedReason: cause.code || cause.name, installationAuthorized: false }))
      throw cause
    } finally { if (temporary) await fs.rm(temporary, { force: true }); await lease.release() }
  }
  async prepareInstall(id, { confirm, currentVersion } = {}) {
    const candidate = await this.store.get(id)
    if (confirm !== true) throw fail('UPDATE_CONFIRM_REQUIRED', 'Explicit installation confirmation is required.')
    if (!candidate || candidate.status !== 'Verified' || currentVersion !== this.version || !candidate.signature?.publisherMatches || !this.publisher) throw fail('UPDATE_NOT_VERIFIED', 'The update is not bound to the current version and trusted publisher.')
    const file = path.join(this.cache, id, candidate.asset.name)
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('UPDATE_FILE_INVALID', 'Installer must be a regular verified file.')
    if (stat.size !== candidate.asset.size) throw fail('UPDATE_CHANGED', 'Installer size changed after verification.')
    const hash = crypto.createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    const digest = hash.digest('hex')
    const signature = await this.verify(file)
    if (digest !== candidate.asset.sha256 || !signature.valid || signature.publisher !== this.publisher) throw fail('UPDATE_CHANGED', 'Installer content or signature changed after verification.')
    // The native host must separately back up, confirm, install and validate startup.
    // This receipt deliberately does not launch a process or mark installation successful.
    return { candidateId: id, version: candidate.version, file, sha256: digest, publisher: this.publisher, requiresNativeConfirmation: true, installationAuthorized: false }
  }
}
export { isNewer as isNewerSoftwareVersion }
