import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SelfMaintenance } from '../../server/services/self-maintenance.mjs'

const directories = []
afterEach(async () => { for (const directory of directories.splice(0)) { expect(directory.startsWith(os.tmpdir() + path.sep)).toBe(true); await fs.rm(directory, { recursive: true, force: true }) } })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-self-')); directories.push(root)
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'project-nexus', version: '0.8.0', scripts: { test: 'vitest', lint: 'eslint .', typecheck: 'tsc' } }))
  const calls = [], enqueued = [], workflows = []
  let dirty = '', head = 'a'.repeat(40)
  const execute = async ({ command }) => {
    calls.push(command)
    let stdout = command.includes('get-url') ? 'https://github.com/yuchen0x1/PROJECT-NEXUS.git' : command.includes('rev-parse') ? head : command.includes('status') ? dirty : command.includes('audit') ? JSON.stringify({ metadata: { vulnerabilities: { total: 0, critical: 0, high: 0, moderate: 0 } } }) : '{}'
    return { ok: true, exitCode: 0, stdout, stderr: '' }
  }
  const service = new SelfMaintenance({ dataDir: path.join(root, 'data'), engine: { create: async (value) => { const result = { ...value, id: value.requestId }; workflows.push(result); return result } }, scheduler: { enqueue: (id) => enqueued.push(id) }, project: async (id) => ({ id, path: root }), request: async () => ({ tag_name: 'v0.7.0', html_url: 'https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.7.0' }), execute })
  return { service, calls, enqueued, workflows, setDirty: (value) => { dirty = value }, setHead: (value) => { head = value } }
}
it('keeps independent policies, actual diagnostic receipts and candidate source confirmation', async () => {
  const f = await fixture()
  expect((await f.service.getPolicy()).enabled).toBe(false)
  await expect(f.service.setPolicy({ projectId: 'p', enabled: true })).rejects.toMatchObject({ code: 'SELF_POLICY_CONFIRM_REQUIRED' })
  const assessment = await f.service.assess('p')
  expect(assessment.status).toBe('Completed'); expect(assessment.quality.testsExecutedByAssessment).toBe(false)
  const body = { projectId: 'p', confirm: true, sourceDisclosureConfirmed: true, executionConsent: true, requestId: 'candidate-fixture' }
  await expect(f.service.candidate(assessment.id, body)).rejects.toMatchObject({ code: 'SELF_CANDIDATE_CONFIRM_REQUIRED' })
  await f.service.setPolicy({ confirm: true, projectId: 'p', enabled: false, allowCandidate: true })
  f.setDirty(' M app.mjs')
  await expect(f.service.candidate(assessment.id, body)).rejects.toMatchObject({ code: 'SELF_SOURCE_CHANGED' })
  f.setDirty('')
  await expect(f.service.candidate(assessment.id, { ...body, projectId: 'other' })).rejects.toMatchObject({ code: 'SELF_CANDIDATE_CONFIRM_REQUIRED' })
  const candidate = await f.service.candidate(assessment.id, body)
  expect(candidate.kind).toBe('self-maintenance'); expect(candidate.metadata.installationAuthorized).toBe(false)
  expect(f.enqueued).toEqual(['candidate-fixture'])
  expect(f.calls.some((command) => /install|push|publish|reset|clean/.test(command))).toBe(false)
})
it('reserves diagnostic admission before asynchronous validation to prevent double starts', async () => {
  const f = await fixture()
  const results = await Promise.allSettled([f.service.startAssessment('p'), f.service.startAssessment('p')])
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
  expect(results.find((item) => item.status === 'rejected').reason.code).toBe('SELF_MAINTENANCE_BUSY')
  while (f.service.controllers.size) await new Promise((resolve) => setTimeout(resolve, 20))
  expect((await f.service.assessments.list())).toHaveLength(1)
})
