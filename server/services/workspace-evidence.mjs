import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { acquireFileLease } from './file-lease.mjs'

/** Includes actual file bytes: a textual binary-diff marker is not a content digest. */
export async function captureWorkspaceEvidence(adapter, { signal } = {}) {
  const lockKey = crypto.createHash('sha256').update(path.resolve(adapter.source)).digest('hex')
  const lockFile = path.join(adapter.workspaceRoot || path.dirname(adapter.root), '.evidence', `${lockKey}.lock`)
  let lease
  const deadline = Date.now() + 10000
  while (!lease) {
    signal?.throwIfAborted()
    try { lease = await acquireFileLease(lockFile) }
    catch (cause) {
      if (cause.code !== 'LEASE_HELD' || Date.now() >= deadline) throw cause
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    const root = await fs.realpath(adapter.source), diff = await adapter.diff(), entries = []
    let total = 0
    for (const change of [...diff.changes].sort((a, b) => a.path.localeCompare(b.path))) {
      signal?.throwIfAborted()
      if (change.action === 'deleted') { entries.push({ path: change.path, action: 'deleted' }); continue }
      const target = path.resolve(root, change.path), relative = path.relative(root, target)
      if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Candidate file escaped its workspace.')
      let cursor = root
      for (const segment of relative.split(path.sep)) {
        cursor = path.join(cursor, segment)
        if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Candidate evidence cannot follow links.')
      }
      const stat = await fs.stat(target)
      total += stat.size
      if (!stat.isFile() || stat.size > 64 * 1024 ** 2 || total > 256 * 1024 ** 2) throw new Error('Candidate evidence exceeds its bounded file budget.')
      const bytes = await fs.readFile(target)
      entries.push({ path: change.path, action: change.action, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
    }
    return { ...diff, artifactSha256: crypto.createHash('sha256').update(JSON.stringify({ base: adapter.baseCommit || null, entries })).digest('hex'), entries }
  } finally { await lease.release() }
}
