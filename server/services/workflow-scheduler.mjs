/** Durable records are the source of truth; this queue only controls local admission. */
export class WorkflowScheduler {
  constructor({ engine, governor, validateOwner = async () => true, onFinished = async () => {} }) { this.engine = engine; this.governor = governor; this.validateOwner = validateOwner; this.onFinished = onFinished; this.pending = new Set(); this.active = new Map(); this.pumping = false; this.timer = null; this.stopped = false; this.lastError = null }
  enqueue(id) { if (!this.stopped && !this.active.has(id)) { this.pending.add(id); void this.pump().catch((cause) => { this.lastError = { code: cause.code || cause.name, at: new Date().toISOString() } }) } }
  async pump() {
    if (this.pumping || this.stopped) return
    this.pumping = true
    try {
      const admission = await this.governor.sample()
      if (!admission.allowed) return
      const maximum = Math.min(2, admission.concurrency)
      for (const id of this.pending) {
        if (this.active.size >= maximum || this.stopped) break
        this.pending.delete(id)
        const record = await this.engine.store.get(id)
        if (record?.status !== 'Queued') continue
        if (!await this.validateOwner(record)) {
          await this.engine.store.update(id, (current) => ({ ...current, status: 'Blocked', errorCode: 'WORKFLOW_PARENT_INTENT_UNCONFIRMED' }))
          continue
        }
        const running = this.engine.run(id).catch((cause) => { this.lastError = { code: cause.code || cause.name, at: new Date().toISOString() } }).then(async () => { const completed = await this.engine.store.get(id); if (completed) await this.onFinished(completed) }).catch((cause) => { this.lastError = { code: cause.code || cause.name, at: new Date().toISOString() } }).finally(() => { this.active.delete(id); void this.pump().catch((cause) => { this.lastError = { code: cause.code || cause.name, at: new Date().toISOString() } }) })
        this.active.set(id, running)
      }
    } finally {
      this.pumping = false
      clearTimeout(this.timer)
      if (!this.stopped && this.pending.size) { this.timer = setTimeout(() => void this.pump().catch((cause) => { this.lastError = { code: cause.code || cause.name, at: new Date().toISOString() } }), 3000); this.timer.unref?.() }
    }
  }
  status() { return { active: this.active.size, queued: this.pending.size, stopped: this.stopped, lastError: this.lastError } }
  async recover() { await this.engine.recover(); for (const record of await this.engine.store.list({ map: ({ id, status }) => ({ id, status }) })) if (record.status === 'Queued') this.enqueue(record.id) }
  async stop() { this.stopped = true; clearTimeout(this.timer); this.pending.clear(); for (const controller of this.engine.controllers.values()) controller.abort(Object.assign(new Error('Host shutdown.'), { code: 'HOST_SHUTDOWN' })); await Promise.allSettled(this.active.values()) }
}
