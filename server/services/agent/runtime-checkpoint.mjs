import crypto from 'node:crypto'
import path from 'node:path'
import { captureWorkspaceEvidence } from '../workspace-evidence.mjs'
import { redactSecrets } from '../ai-provider.mjs'

const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code, message) => Object.assign(new Error(message), { code })

// Only a complete conversation boundary is resumable. A tool intent without a
// committed continuation is deliberately never replayed, even for a failed tool.
export class RuntimeCheckpoint {
  constructor({ task, provider, adapter, persist, signal }) {
    this.task = task; this.provider = provider; this.adapter = adapter; this.persist = persist; this.signal = signal
    this.current = null
  }
  identity() {
    return digest({ taskId: this.task.id, prompt: this.task.prompt, providerId: this.provider?.id, model: this.provider?.model, endpoint: this.provider?.baseUrl, root: path.resolve(this.adapter.source), base: this.adapter.baseCommit || null })
  }
  async beforeModel(messages, state, reservation) {
    if (state.phase !== 'executing') {
      await this.write({ version: 1, status: 'non_resumable_phase', phase: state.phase })
      return
    }
    const evidence = await captureWorkspaceEvidence(this.adapter, { signal: this.signal })
    const snapshot = JSON.parse(redactSecrets(JSON.stringify({ identity: this.identity(), artifactSha256: evidence.artifactSha256, messages, state: { ...state, startedAt: undefined, elapsedMs: Date.now() - state.startedAt } })))
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 800000) throw fail('AGENT_CHECKPOINT_TOO_LARGE', 'Conversation exceeded the bounded recovery checkpoint size.')
    await this.write({ version: 1, status: 'model_pending', snapshot, snapshotSha256: digest(snapshot), reservation })
  }
  async responseReceived() {
    if (this.current?.status === 'model_pending') await this.write({ ...this.current, status: 'response_received' })
  }
  async intent(kind, args) {
    await this.write({ ...this.current, version: 1, status: 'operation_pending', operation: { id: crypto.randomUUID(), kind, argsSha256: digest(args), intendedAt: new Date().toISOString() } })
  }
  async receipt(result) {
    await this.write({ ...this.current, status: 'operation_receipted', operation: { ...this.current.operation, resultSha256: digest(result), receiptedAt: new Date().toISOString() } })
  }
  async write(value) {
    this.current = { ...value, recordedAt: new Date().toISOString() }
    await this.persist({ runtimeCheckpoint: this.current })
  }
  async restore(checkpoint) {
    if (checkpoint?.version !== 1 || checkpoint.status !== 'model_pending' || !checkpoint.snapshot || digest(checkpoint.snapshot) !== checkpoint.snapshotSha256) throw fail('AGENT_CHECKPOINT_UNSAFE', 'The last durable boundary is incomplete or contains an uncertain operation; it cannot be replayed.')
    const snapshot = checkpoint.snapshot
    if (snapshot.identity !== this.identity()) throw fail('AGENT_CHECKPOINT_IDENTITY_CHANGED', 'Task, provider, model, workspace or baseline changed after the checkpoint.')
    const evidence = await captureWorkspaceEvidence(this.adapter, { signal: this.signal })
    if (evidence.artifactSha256 !== snapshot.artifactSha256) throw fail('AGENT_CHECKPOINT_ARTIFACT_CHANGED', 'Workspace bytes changed after the last safe checkpoint.')
    if (!Number.isSafeInteger(checkpoint.reservation) || checkpoint.reservation < 0 || snapshot.state?.phase !== 'executing' || !Array.isArray(snapshot.messages)) throw fail('AGENT_CHECKPOINT_INVALID', 'Checkpoint accounting or conversation is invalid.')
    const state = structuredClone(snapshot.state)
    state.totalUsage.uncertainTokens = (state.totalUsage.uncertainTokens || 0) + checkpoint.reservation
    state.providerCalls += 1
    state.startedAt = Date.now() - state.elapsedMs - Math.max(0, Date.now() - Date.parse(checkpoint.recordedAt))
    delete state.elapsedMs
    return { state, messages: structuredClone(snapshot.messages) }
  }
}
