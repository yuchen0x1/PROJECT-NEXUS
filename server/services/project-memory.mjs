import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EvolutionStore, safeRecordId } from './evolution-store.mjs'
import { acquireFileLease } from './file-lease.mjs'
import { buildProjectIndex } from './agent/indexer.mjs'
import { redactSecrets } from './ai-provider.mjs'

export class ProjectMemory {
  constructor(dataDir) { this.store = new EvolutionStore(dataDir, 'project-memory'); this.indexRoot = path.join(dataDir, 'evolution', 'memory-index') }
  async refresh(project) {
    safeRecordId(project.id)
    const root = await fs.realpath(project.path)
    const identity = crypto.createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex')
    const lease = await acquireFileLease(path.join(this.indexRoot, `${project.id}.scan.lock`))
    try {
      const previous = await this.store.get(project.id)
      if (previous && previous.rootIdentity !== identity) throw Object.assign(new Error('Project registration points to a different root; clear its memory explicitly before re-indexing.'), { code: 'MEMORY_PROJECT_CHANGED' })
      const built = await buildProjectIndex({ root, cacheFile: path.join(this.indexRoot, `${project.id}.json`) })
      return await this.store.update(project.id, (record) => ({ id: project.id, rootIdentity: identity, projectName: String(project.name).slice(0, 160), indexedAt: new Date().toISOString(), indexStats: built.index.stats, reindexed: built.reindexed, files: built.index.files, manifests: JSON.parse(redactSecrets(JSON.stringify((built.index.manifests || []).map(({ path: file, kind, scripts }) => ({ path: file, kind, scripts }))))), facts: record?.facts || [], experiences: record?.experiences || [] }))
    } finally { await lease.release() }
  }
  async remember(projectId, { text, category = 'experience', verified = false, source = null, workflowId = null }) {
    safeRecordId(projectId)
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Memory entry must contain 1–2,000 characters.')
    return this.store.update(projectId, (record) => {
      if (!record) throw new Error('Index the project before adding memory.')
      if (verified && (!source || !record.files?.some((file) => file.path === source.path && file.sha256 && file.sha256 === source.sha256))) throw Object.assign(new Error('A verified fact requires a matching indexed file hash.'), { code: 'MEMORY_SOURCE_UNVERIFIED' })
      record.facts = [...record.facts, { id: crypto.randomUUID(), text: redactSecrets(text), category: String(category).slice(0, 80), classification: verified ? 'verified' : 'inference', source: source ? { path: String(source.path).slice(0, 300), sha256: source.sha256 } : null, workflowId, at: new Date().toISOString() }].slice(-500)
      return record
    })
  }
  async export(projectId) {
    const record = await this.store.get(projectId)
    if (!record) return null
    return { ...record, exportedAt: new Date().toISOString(), format: 'project-nexus-memory-v1' }
  }
  async recordExperience(workflow) {
    safeRecordId(workflow.projectId)
    // Clearing memory stays effective: background receipts never recreate it.
    if (!await this.store.get(workflow.projectId)) return null
    return this.store.update(workflow.projectId, (record) => {
      if (!record) return null
      const experience = { id: workflow.id, status: workflow.status, at: new Date().toISOString(), source: { kind: 'workflow-receipt', workflowId: workflow.id, revision: workflow.revision }, classification: 'observed-execution', applied: false, roles: workflow.nodes.map((node) => ({ role: node.role, status: node.status, artifactSha256: node.result?.artifactSha256 || null, verified: node.result?.verified === true, safe: node.result?.safe === true, verdict: node.result?.verdict || null })), modelNarratives: workflow.nodes.filter((node) => node.result?.summary).map((node) => ({ role: node.role, classification: 'model-assessment', text: redactSecrets(node.result.summary).slice(0, 1000) })) }
      record.experiences = [...(record.experiences || []).filter((item) => item.id !== workflow.id), experience].slice(-100)
      return record
    })
  }
  async clear(projectId, { confirm } = {}) {
    if (confirm !== true) throw new Error('Explicit confirmation is required to clear project memory.')
    const scanLease = await acquireFileLease(path.join(this.indexRoot, `${safeRecordId(projectId)}.scan.lock`))
    const file = this.store.file(projectId)
    let recordLease
    try {
      recordLease = await acquireFileLease(`${file}.lock`)
      for (const target of [file, `${file}.bak`, path.join(this.indexRoot, `${projectId}.json`), path.join(this.indexRoot, `${projectId}.json.bak`)]) {
        const base = path.resolve(path.dirname(this.store.root))
        if (!path.resolve(target).startsWith(base + path.sep)) throw new Error('Memory cleanup escaped its data root.')
        await fs.rm(target, { force: true })
      }
      return { cleared: true, projectId }
    } finally { await recordLease?.release(); await scanLease.release() }
  }
}
