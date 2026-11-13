import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createReleasePlan } from '../../server/services/release-plan.mjs'
import { buildUpgradeProposals, reviewUpgradeProposal } from '../../server/services/upgrade-proposals.mjs'
import { cleanupTestEnvironment, tempDataDir } from './helpers/server-harness.mjs'
afterEach(cleanupTestEnvironment)

describe('release planning and controlled research proposals', () => {
  it('binds a Node release to a version, tested commit and actual scripts', async () => {
    const root = await tempDataDir()
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.1', scripts: { test: 'node --test', build: 'node build.mjs' } }))
    const args = { root, repository: 'a/b', commitSha: 'tested', version: '1.0.1', tag: 'v1.0.1', policy: {} }
    const plan = await createReleasePlan(args)
    expect(plan).toMatchObject({ status: 'Prepared', adapter: 'node', commitSha: 'tested', testCommand: 'npm test' })
    expect((await createReleasePlan({ ...args, version: '1.0.2' })).status).toBe('Blocked')
    await fs.rm(path.join(root, 'package.json'))
    await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nversion="1.0.1"')
    expect((await createReleasePlan(args))).toMatchObject({ status: 'Blocked', adapter: 'python' })
  })
  it('blocks invented source references and requires license review for adoption', () => {
    const source = { repository: 'peer/repo', path: 'src/index.js', sha: 'a'.repeat(40) }
    const report = { candidates: [{ fullName: 'peer/repo', sources: [source], license: { spdx: 'MIT' } }], analysis: { upgradeProposals: [{ title: 'Improve retry', evidence: [source] }, { title: 'Invented', evidence: [{ ...source, sha: 'b'.repeat(40) }] }] } }
    const proposals = buildUpgradeProposals(report)
    expect(proposals.map((proposal) => proposal.status)).toEqual(['Draft', 'Blocked'])
    expect(() => reviewUpgradeProposal(proposals[0], { decision: 'approve', confirm: true })).toThrow(/licenses/)
    expect(reviewUpgradeProposal(proposals[0], { decision: 'approve', confirm: true, licenseReviewed: true, actor: 'Operator' })).toMatchObject({ status: 'Approved', applied: false })
    expect(buildUpgradeProposals({ ...report, analysis: { ...report.analysis, noActionRequired: true } })).toEqual([])
  })
})
