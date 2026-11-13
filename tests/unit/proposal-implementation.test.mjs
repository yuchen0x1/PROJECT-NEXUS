import { expect, it } from 'vitest'
import { proposalLifecycle, startProposalImplementation } from '../../server/services/proposal-implementation.mjs'
import { commandPermission, getTool } from '../../server/services/agent/tools.mjs'
const sha = 'a'.repeat(40)
const fixture = () => {
  const source = { repository: 'peer/project', path: 'src/agent.ts', sha, license: 'MIT' }
  return { report: { id: 'report', candidates: [{ fullName: 'peer/project', sources: [{ path: source.path, sha }] }] }, proposal: { id: 'proposal', status: 'Approved', licenseReview: 'ReviewedByUser', title: 'Budgeted work', rationale: 'Bound work.', evidence: [source] }, project: { id: 'target' }, body: { requestId: 'request', confirm: true, sourceDisclosureConfirmed: true, executionConsent: true, spec: { plan: 'Implement bounded work.', targetModules: ['src/runtime.mjs'], testCriteria: ['Budget exhaustion stops further work.'] } } }
}
it('requires approved provenance and a concrete implementation spec before scheduling', async () => {
  const args = fixture(); let starts = 0
  const engine = { create: async (input) => { starts++; return { id: input.requestId } } }, scheduler = { enqueue: () => { starts++ } }
  args.proposal.licenseReview = 'Required'
  await expect(startProposalImplementation({ ...args, engine, scheduler })).rejects.toMatchObject({ code: 'PROPOSAL_NOT_APPROVED' })
  args.proposal.licenseReview = 'ReviewedByUser'; args.body.spec.testCriteria = []
  await expect(startProposalImplementation({ ...args, engine, scheduler })).rejects.toMatchObject({ code: 'PROPOSAL_SPEC_REQUIRED' })
  expect(starts).toBe(0)
})
it('durably links an isolated implementation before enqueueing and never marks it applied', async () => {
  const args = fixture(); const order = []
  await startProposalImplementation({ ...args, engine: { create: async (input) => { order.push('workflow-persisted'); expect(input.metadata.referencePolicy).toBe('design-only'); return { id: 'request' } } }, save: async () => { expect(args.proposal.implementation.workflowId).toBe('request'); order.push('proposal-persisted') }, scheduler: { enqueue: () => order.push('enqueued') } })
  expect(order).toEqual(['workflow-persisted', 'proposal-persisted', 'enqueued'])
  expect(args.proposal.applied).toBe(false)
  expect(proposalLifecycle(args.proposal, { status: 'Completed', nodes: [] })).toBe('Completed')
  expect(proposalLifecycle(args.proposal, { status: 'Running', nodes: [{ role: 'tester', status: 'Running' }] })).toBe('Testing')
})
it('escalates remote writes and installation commands in every explicit command wrapper', () => {
  expect(commandPermission('git push origin main')).toBe('high')
  expect(commandPermission('npm publish')).toBe('high')
  expect(commandPermission('npm install package')).toBe('high')
  expect(commandPermission('node verify.mjs')).toBe('medium')
  expect(getTool('run_tests').permissionFor({ command: 'git push origin main' })).toBe('high')
  expect(getTool('build_project').permissionFor({ command: 'npm publish' })).toBe('high')
})
