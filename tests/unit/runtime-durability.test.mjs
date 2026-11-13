import { expect, it } from 'vitest'
import { runAgentTask } from '../../server/services/agent/runtime.mjs'

it('stops before invoking the model or tools when the initial durability barrier fails', async () => {
  let writes = 0
  const failedStore = { update: async () => { writes++; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } }
  await expect(runAgentTask({
    task: { id: 'disk-full', prompt: 'Modify a file.' },
    project: { path: process.cwd() },
    adapter: { kind: 'copy' },
    provider: null,
    taskStore: failedStore
  })).rejects.toMatchObject({ code: 'AGENT_PERSISTENCE_FAILED', cause: { code: 'ENOSPC' } })
  expect(writes).toBe(1)
})
