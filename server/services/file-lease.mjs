import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

// Local filesystem only. An abandoned lease is reclaimed only after its owner has exited.
export async function acquireFileLease(file) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const token = crypto.randomUUID()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() })); await handle.sync() } finally { await handle.close() }
      return { token, async release() {
        const current = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'))
        if (current.token === token) await fs.unlink(file)
      } }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // Serialize reclamation so two starters cannot remove each other's new lease.
      const reclaimer = await fs.open(`${file}.reclaim`, 'wx', 0o600).catch(() => null)
      if (!reclaimer) throw Object.assign(new Error('Lease recovery is already in progress; retry after checking the host.'), { code: 'LEASE_HELD' })
      try {
        const current = JSON.parse(await fs.readFile(file, 'utf8').catch((cause) => { if (cause.code === 'ENOENT') return '{}'; throw cause }))
        if (current.pid && alive(current.pid)) throw Object.assign(new Error('Another host owns this data directory or repository.'), { code: 'LEASE_HELD' })
        await fs.unlink(file).catch((cause) => { if (cause.code !== 'ENOENT') throw cause })
      } finally { await reclaimer.close(); await fs.unlink(`${file}.reclaim`) }
    }
  }
  throw Object.assign(new Error('Lease changed while being acquired.'), { code: 'LEASE_HELD' })
}
