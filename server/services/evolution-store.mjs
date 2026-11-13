import fs from 'node:fs/promises'
import path from 'node:path'
import { acquireFileLease } from './file-lease.mjs'
import { saveStateFile } from './state-store.mjs'

const queues = new Map()
export function safeRecordId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw Object.assign(new Error('Invalid record identifier.'), { code: 'EVOLUTION_INVALID_ID' })
  return value
}
export class EvolutionStore {
  constructor(dataDir, collection) {
    if (!path.isAbsolute(dataDir)) throw new Error('An absolute data directory is required.')
    this.root = path.join(dataDir, 'evolution', safeRecordId(collection))
  }
  file(id) { return path.join(this.root, `${safeRecordId(id)}.json`) }
  async get(id) {
    const file = this.file(id)
    const stat = await fs.lstat(file).catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
    if (!stat) return null
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Record must be a regular file.')
    if (stat.size > 4 * 1024 * 1024) throw new Error('Record exceeds its read budget; existing data was preserved.')
    const record = JSON.parse(await fs.readFile(file, 'utf8'))
    if (record.schemaVersion !== 1 || record.id !== id || !Number.isInteger(record.revision)) throw new Error('Invalid record format; existing data was preserved.')
    return record
  }
  async list({ map = (record) => record } = {}) {
    const names = await fs.readdir(this.root).catch((error) => { if (error.code !== 'ENOENT') throw error; return [] })
    if (names.length > 10000) throw new Error('Record directory exceeds its inspection limit.')
    const records = []
    // Projected listings never retain all full histories/contexts at once.
    for (const name of names.filter((item) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json$/.test(item))) records.push(map(await this.get(name.slice(0, -5))))
    return records
  }
  async count() {
    const names = await fs.readdir(this.root).catch((error) => { if (error.code !== 'ENOENT') throw error; return [] })
    return names.filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json$/.test(name)).length
  }
  async update(id, change, expectedRevision) {
    const file = this.file(id), previous = queues.get(file) || Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      const lease = await acquireFileLease(`${file}.lock`)
      try {
        const current = await this.get(id)
        if (expectedRevision !== undefined && (current?.revision || 0) !== expectedRevision) throw Object.assign(new Error('Record changed; reload before applying this operation.'), { code: 'EVOLUTION_REVISION_CONFLICT' })
        const next = await change(structuredClone(current))
        // Explicit no-op, used when a record was cleared before a background receipt.
        if (next === null) return null
        if (!next || next.id !== id) throw new Error('Record update must preserve its identity.')
        Object.assign(next, { schemaVersion: 1, revision: (current?.revision || 0) + 1, updatedAt: new Date().toISOString() })
        if (Buffer.byteLength(JSON.stringify(next)) > 4 * 1024 * 1024) throw new Error('Record exceeds its storage limit.')
        await saveStateFile(file, next)
        return structuredClone(next)
      } finally { await lease.release() }
    })
    queues.set(file, pending)
    try { return await pending } finally { if (queues.get(file) === pending) queues.delete(file) }
  }
}
