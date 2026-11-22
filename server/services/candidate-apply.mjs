import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { acquireFileLease } from './file-lease.mjs'
import { saveStateFile } from './state-store.mjs'

const hash = (bytes) => bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex')
const fail = (code, message) => Object.assign(new Error(message), { code })
async function guarded(root, relative) {
  if (typeof relative !== 'string' || !relative || /^(?:[A-Za-z]:|\/|\\)/.test(relative) || relative.includes('\0')) throw fail('AGENT_APPLY_PATH_INVALID', 'Candidate path is not project-relative.')
  const segments = relative.replace(/\\/g, '/').split('/')
  if (segments.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.includes(':') || /[. ]$/.test(part))) throw fail('AGENT_APPLY_PATH_INVALID', 'Candidate path contains an unsafe segment.')
  let cursor = root
  for (const [index, part] of segments.entries()) {
    cursor = path.join(cursor, part)
    const stat = await fs.lstat(cursor).catch((cause) => { if (cause.code === 'ENOENT') return null; throw cause })
    if (stat?.isSymbolicLink() || (stat && (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory()))) throw fail('AGENT_APPLY_PATH_INVALID', 'Application cannot follow links or replace special files.')
  }
  return cursor
}
async function readOrMissing(file) { try { return await fs.readFile(file) } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause } }
async function replaceFile(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${crypto.randomUUID()}.nexus-tmp`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}

// Explicit local application only. Backups and a durable intent precede every
// original-file mutation. Uncertain partial applications never replay themselves.
export async function applyCandidateFiles({ source, originalRoot, backupRoot, changes, taskId, expectedEntries }) {
  const root = await fs.realpath(originalRoot), candidate = await fs.realpath(source)
  const leaseKey = crypto.createHash('sha256').update(root.toLowerCase()).digest('hex')
  const lease = await acquireFileLease(path.join(path.dirname(backupRoot), `${leaseKey}.apply.lock`))
  const journalFile = `${backupRoot}.receipt.json`
  try {
    const previous = await readOrMissing(journalFile)
    if (previous) {
      const receipt = JSON.parse(previous)
      if (receipt.taskId === taskId && receipt.status === 'Confirmed' && (await Promise.all(receipt.entries.map(async (entry) => hash(await readOrMissing(await guarded(root, entry.path))) === entry.afterSha256))).every(Boolean)) return { appliedPaths: receipt.entries.map((entry) => entry.path), alreadyApplied: true }
      throw fail('AGENT_APPLY_RECOVERY_REQUIRED', 'An earlier application has an incomplete or changed receipt. Inspect its backup before continuing.')
    }
    const plan = []
    let bytes = 0
    for (const change of changes) {
      const target = await guarded(root, change.path), before = await readOrMissing(target)
      const after = change.action === 'deleted' ? null : await readOrMissing(await guarded(candidate, change.path))
      if (change.action !== 'deleted' && after === null) throw fail('AGENT_APPLY_READ_FAILED', 'A candidate file disappeared before application.')
      if (expectedEntries && !expectedEntries.some((entry) => entry.path === change.path && (change.action === 'deleted' ? entry.action === 'deleted' : entry.sha256 === hash(after)))) throw fail('AGENT_APPLY_ARTIFACT_CHANGED', 'Candidate bytes changed after the verified evidence was captured.')
      bytes += (before?.length || 0) + (after?.length || 0)
      if (bytes > 256 * 1024 ** 2) throw fail('AGENT_APPLY_TOO_LARGE', 'Application exceeded the bounded file budget.')
      plan.push({ path: change.path, target, before, after, beforeSha256: hash(before), afterSha256: hash(after) })
    }
    // Preserve all originals first; an unavailable backup blocks the entire apply.
    for (const entry of plan) if (entry.before !== null) {
      const backup = await guarded(backupRoot, entry.path)
      await fs.mkdir(path.dirname(backup), { recursive: true })
      const handle = await fs.open(backup, 'wx', 0o600)
      try { await handle.writeFile(entry.before); await handle.sync() } finally { await handle.close() }
    }
    const journal = { taskId, rootIdentity: hash(Buffer.from(root)), status: 'Intended', at: new Date().toISOString(), entries: plan.map(({ path: file, beforeSha256, afterSha256 }) => ({ path: file, beforeSha256, afterSha256 })), appliedPaths: [] }
    await saveStateFile(journalFile, journal)
    try {
      for (const entry of plan) {
        const target = await guarded(root, entry.path)
        if (hash(await readOrMissing(target)) !== entry.beforeSha256) throw fail('AGENT_APPLY_SOURCE_CHANGED', 'Original files changed while application was being prepared.')
        if (entry.after === null) await fs.rm(target, { force: true })
        else await replaceFile(target, entry.after)
        journal.appliedPaths.push(entry.path)
        await saveStateFile(journalFile, journal)
      }
      journal.status = 'Confirmed'; journal.finishedAt = new Date().toISOString()
      await saveStateFile(journalFile, journal)
      return { appliedPaths: journal.appliedPaths, alreadyApplied: false }
    } catch (cause) {
      // Restore only bytes written by this invocation, never a concurrent user edit.
      let restored = true
      for (const entry of [...plan].reverse().filter((item) => journal.appliedPaths.includes(item.path))) {
        try {
          const target = await guarded(root, entry.path)
          if (hash(await readOrMissing(target)) !== entry.afterSha256) { restored = false; continue }
          if (entry.before === null) await fs.rm(target, { force: true })
          else await replaceFile(target, entry.before)
        } catch { restored = false }
      }
      journal.status = restored ? 'RolledBack' : 'RecoveryRequired'; journal.errorCode = cause.code || cause.name
      await saveStateFile(journalFile, journal)
      throw cause
    }
  } finally { await lease.release() }
}
