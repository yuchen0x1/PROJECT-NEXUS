import { describe, expect, it } from 'vitest'
import { beginAgentAttempt, canRetryAgentRun, createAgentRun, recordAgentEvent, transitionAgentRun } from '../../server/services/agent-runner.mjs'

describe('durable AgentRun phase and checkpoint state', () => {
  it('records bounded append-only events and checkpoints', () => {
    const run = createAgentRun({ id: 'run_1', taskId: 'task_1', projectId: 'repo_1', repository: 'acme/app' })
    transitionAgentRun(run, 'context', 'Read the saved repository report.')
    transitionAgentRun(run, 'plan', 'Prepared a bounded plan.', { reportId: 'report_1' })
    expect(beginAgentAttempt(run)).toBe(true)
    recordAgentEvent(run, 'plan', 'model_selected', 'Selected a configured provider.', { providerId: 'local' })
    expect(run.phase).toBe('plan')
    expect(run.checkpoint).toMatchObject({ phase: 'plan', reportId: 'report_1' })
    expect(run.events.length).toBe(5)
    expect(canRetryAgentRun(run)).toBe(true)
  })

  it('rejects backward phases and stops retrying at the attempt limit', () => {
    const run = createAgentRun({ maxAttempts: 1 })
    transitionAgentRun(run, 'context', 'context')
    expect(() => transitionAgentRun(run, 'queued', 'backward')).toThrow(/backwards/)
    expect(beginAgentAttempt(run)).toBe(true)
    expect(beginAgentAttempt(run)).toBe(false)
    transitionAgentRun(run, 'failed', 'terminal failure')
    expect(canRetryAgentRun(run)).toBe(false)
  })
})
