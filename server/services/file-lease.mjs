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
        const contents = await fs.readFile(file, 'utf8').catch((cause) => { if (cause.code === 'ENOENT') return null; throw cause })
        // The owner may have just released the lease. Retry exclusive creation,
        // not unlink: a new owner could create the file after the missing read.
        if (contents === null) continue
        let current
        try { current = JSON.parse(contents) } catch { /* incomplete metadata is not proof of a dead owner */ }
        if (!Number.isInteger(current?.pid) || current.pid <= 0 || typeof current.token !== 'string' || !current.token.trim()) {
          throw Object.assign(new Error('Lease metadata is incomplete or unreadable; refusing to reclaim it.'), { code: 'LEASE_HELD' })
        }
        if (alive(current.pid)) throw Object.assign(new Error('Another host owns this data directory or repository.'), { code: 'LEASE_HELD' })
        await fs.unlink(file).catch((cause) => { if (cause.code !== 'ENOENT') throw cause })
      } finally { await reclaimer.close(); await fs.unlink(`${file}.reclaim`) }
    }
  }
  throw Object.assign(new Error('Lease changed while being acquired.'), { code: 'LEASE_HELD' })
}

// The default state lease is also the data-directory lease. A state override
// must not bypass it, and still needs its own lease if shared across data dirs.
export async function acquireHostLease({ dataDir, stateFile }) {
  const dataLock = path.resolve(dataDir, 'state.json.host.lock')
  const stateLock = `${path.resolve(stateFile)}.host.lock`
  const key = (file) => process.platform === 'win32' ? file.toLowerCase() : file
  const owner = await acquireFileLease(dataLock)
  let stateOwner
  try {
    if (key(dataLock) !== key(stateLock)) {
      // Avoid trying to acquire the same lock again through a directory alias.
      const stateDir = path.dirname(stateLock)
      await fs.mkdir(stateDir, { recursive: true })
      const [dataRoot, stateRoot] = await Promise.all([fs.realpath(path.dirname(dataLock)), fs.realpath(stateDir)])
      if (key(path.join(dataRoot, path.basename(dataLock))) !== key(path.join(stateRoot, path.basename(stateLock)))) {
        stateOwner = await acquireFileLease(stateLock)
      }
    }
  } catch (error) {
    await owner.release()
    throw error
  }
  return { async release() {
    try { await stateOwner?.release() } finally { await owner.release() }
  } }
}
