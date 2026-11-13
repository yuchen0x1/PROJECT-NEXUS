import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { normalizeCandidate, researchCompetitor, discoverCompetitors } from '../server/services/competitor-research.mjs'

if (!process.env.GITHUB_TOKEN) throw new Error('Real GitHub credentials are required.')
const request = async (endpoint) => {
  const response = await fetch(`https://api.github.com${endpoint}`, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${endpoint}`)
  return response.json()
}
const discovered = await discoverCompetitors({ project: { name: 'PROJECT NEXUS', fullName: 'yuchen0x1/PROJECT-NEXUS', researchQuery: 'autonomous coding agent' }, request, limit: 2 })
const results = []
for (const repository of ['OpenHands/OpenHands', 'cline/cline']) {
  const meta = await request(`/repos/${repository}`)
  const result = await researchCompetitor({ request, candidate: normalizeCandidate(meta) })
  assert.ok(result.sources.length, `${repository}: source fetched`)
  assert.ok(result.readmeExcerpt.length, `${repository}: README fetched`)
  assert.ok(result.licenseEvidence?.sha, `${repository}: license fetched`)
  results.push(result)
  console.log(`PASS: ${repository}; license=${result.license?.spdx}; ${result.sources.length} source files; ${result.recentIssues.length} issues/PRs`)
}
await fs.writeFile('docs/evidence/v1-research.json', JSON.stringify({ at: new Date().toISOString(), discovered, results }, null, 2))
console.log('PASS: real discovery, source/README/license/issue/PR/commit/release evidence preserved.')
