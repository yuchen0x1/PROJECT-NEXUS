import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { providerCredentialBinding } from '../server/services/provider-store.mjs'

function providerKeyId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(value)) throw new Error('Provider id is invalid.')
  return value.toLowerCase()
}

// All reads/mutations/syncs share one queue: a delayed startup or concurrent
// save must never replay an old snapshot after a completed key deletion.
export function createProviderKeyVault({ file, safeStorage, listProviders, syncKeys, fileOperations = fs }) {
  let pending = Promise.resolve()
  function enqueue(operation) {
    const result = pending.then(operation)
    pending = result.catch(() => {})
    return result
  }

  async function read() {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      if (parsed && [1, 2].includes(parsed.schemaVersion) && parsed.keys && typeof parsed.keys === 'object' && !Array.isArray(parsed.keys)) return parsed
      throw new Error('Credential vault format is invalid; existing credentials were preserved.')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    return { schemaVersion: 2, keys: {} }
  }

  async function write(vault) {
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.mkdir(path.dirname(file), { recursive: true })
    try {
      await fileOperations.writeFile(temporary, JSON.stringify({ ...vault, schemaVersion: 2 }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await fileOperations.rename(temporary, file)
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  }

  async function decrypt(vault) {
    const records = await listProviders()
    const keys = {}
    for (const provider of records) {
      const entry = Object.hasOwn(vault.keys, provider.id) ? vault.keys[provider.id] : null
      // v1 ciphertext has no trusted destination. Preserve it on disk, but do
      // not auto-bind it to possibly edited metadata; require explicit re-entry.
      if (!entry || typeof entry !== 'object' || typeof entry.encrypted !== 'string' || entry.binding !== providerCredentialBinding(provider)) continue
      try {
        const apiKey = safeStorage.decryptString(Buffer.from(entry.encrypted, 'latin1'))
        if (apiKey) keys[provider.id] = { apiKey, binding: entry.binding }
      } catch { /* an unavailable OS key must also disappear from the snapshot */ }
    }
    return keys
  }

  async function sync(vault) {
    const keys = await decrypt(vault)
    const result = await syncKeys(keys) // send even when the vault is empty
    if (!result?.synced) throw new Error('Provider key synchronization failed. The disk change may be saved, but service revocation is not confirmed; retry before using AI.')
    return result
  }

  return {
    sync: () => enqueue(async () => sync(await read())),
    getKey: (provider) => enqueue(async () => {
      const entry = (await decrypt(await read()))[provider.id]
      return entry?.binding === providerCredentialBinding(provider) ? entry.apiKey : ''
    }),
    status: () => enqueue(async () => ({ providerIds: Object.keys(await decrypt(await read())), encryptionAvailable: safeStorage.isEncryptionAvailable() })),
    set: (providerId, apiKey) => enqueue(async () => {
      const id = providerKeyId(providerId)
      if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new Error('The API key must be a non-empty string without newlines.')
      if (!safeStorage.isEncryptionAvailable()) throw new Error('The operating system refused secure credential encryption; the key was NOT saved.')
      const provider = (await listProviders()).find((item) => item.id === id)
      if (!provider) throw new Error('Provider was not found; save its configuration before saving a key.')
      const vault = await read()
      vault.keys[id] = { encrypted: safeStorage.encryptString(apiKey.trim()).toString('latin1'), binding: providerCredentialBinding(provider) }
      await write(vault)
      return { providerId: id, saved: true, sync: await sync(vault) }
    }),
    delete: (providerId) => enqueue(async () => {
      const id = providerKeyId(providerId)
      const vault = await read()
      delete vault.keys[id]
      await write(vault)
      return { providerId: id, deleted: true, sync: await sync(vault) }
    })
  }
}
