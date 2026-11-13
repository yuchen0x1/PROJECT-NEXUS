// Read-only primary-source collection. Never executes or imports external code.
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const targets = [
  ['OpenHands/OpenHands', ['src/api/launch-child-conversation-client-tool.ts', 'src/api/conversation-service/agent-server-conversation-service.api.ts', 'src/api/runtime-service/agent-server-runtime-service.ts']],
  ['cline/cline', ['sdk/packages/core/src/extensions/tools/team/multi-agent.ts', 'sdk/packages/core/src/extensions/tools/team/delegated-agent.ts', 'apps/cli/src/runtime/tool-policies.ts']],
  ['RooCodeInc/Roo-Code', ['src/core/task/Task.ts', 'src/core/webview/ClineProvider.ts']],
  ['continuedev/continue', ['core/core.ts', 'core/llm/index.ts']],
  ['Aider-AI/aider', ['aider/coders/base_coder.py', 'aider/repomap.py']],
  ['SWE-agent/SWE-agent', ['sweagent/agent/agents.py', 'sweagent/environment/swe_env.py']],
  ['OpenInterpreter/open-interpreter', ['codex-rs/core/src/agent/control/budget.rs', 'codex-rs/core/src/agent/control/spawn.rs', 'codex-rs/core/src/agent/control/user_authorization.rs']],
  ['google-gemini/gemini-cli', ['packages/core/src/core/client.ts', 'packages/core/src/tools/tool-registry.ts']]
]
const output = path.resolve('test-results/ultimate-research')
await fs.mkdir(output, { recursive: true })
async function api(endpoint) {
  const { stdout } = await exec('gh', ['api', endpoint], { windowsHide: true, timeout: 60000, maxBuffer: 24 * 1024 * 1024 })
  return JSON.parse(stdout)
}
async function collect([repository, preferred]) {
  const destination = path.join(output, repository.replace('/', '--'))
  await fs.mkdir(destination, { recursive: true })
  const metadata = await api(`repos/${repository}`)
  const recent = await api(`repos/${repository}/commits?per_page=3`)
  const commit = recent[0].sha
  const tree = await api(`repos/${repository}/git/trees/${commit}?recursive=1`)
  const blobs = tree.tree.filter((entry) => entry.type === 'blob')
  const files = [...preferred.filter((file) => blobs.some((entry) => entry.path === file))]
  if (files.length < 2) for (const entry of blobs.filter((item) => /(?:agent|runtime|tool|task|context).*(?:\.py|\.ts)$/.test(item.path) && !/test|fixture|example|migration/i.test(item.path))) {
    if (!files.includes(entry.path)) files.push(entry.path)
    if (files.length >= 3) break
  }
  const source = []
  for (const file of files) {
    const entry = await api(`repos/${repository}/contents/${file}?ref=${commit}`)
    if (entry.encoding !== 'base64') throw new Error(`Unsupported source encoding: ${repository}/${file}`)
    const text = Buffer.from(entry.content, 'base64').toString('utf8')
    const localFile = file.replace(/[\\/]/g, '__')
    await fs.writeFile(path.join(destination, localFile), text)
    source.push({ path: file, blobSha: entry.sha, commit, bytes: Buffer.byteLength(text), localFile, url: `https://github.com/${repository}/blob/${commit}/${file}` })
  }
  const license = await api(`repos/${repository}/license?ref=${commit}`)
  await fs.writeFile(path.join(destination, 'LICENSE.evidence.txt'), Buffer.from(license.content || '', 'base64'))
  const [issues, releases] = await Promise.all([api(`repos/${repository}/issues?state=all&per_page=4`), api(`repos/${repository}/releases?per_page=2`)])
  const evidence = { repository, checkedAt: new Date().toISOString(), commit, archived: metadata.archived, defaultBranch: metadata.default_branch, treeTruncated: tree.truncated, license: { spdx: license.license?.spdx_id, path: license.path, blobSha: license.sha, url: license.html_url }, source, recentCommits: recent.map((item) => ({ sha: item.sha, at: item.commit.committer.date, message: item.commit.message.split('\n')[0], url: item.html_url })), issues: issues.map((item) => ({ number: item.number, title: item.title, state: item.state, pullRequest: Boolean(item.pull_request), updatedAt: item.updated_at, url: item.html_url })), releases: releases.map((item) => ({ tag: item.tag_name, publishedAt: item.published_at, prerelease: item.prerelease, url: item.html_url })) }
  await fs.writeFile(path.join(destination, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ repository, commit, files: source.map((item) => item.path), license: evidence.license.spdx, status: 'PASS' }))
  return evidence
}
const results = []
for (let index = 0; index < targets.length; index += 2) {
  const batch = await Promise.allSettled(targets.slice(index, index + 2).map(collect))
  batch.forEach((result, offset) => {
    if (result.status === 'fulfilled') results.push(result.value)
    else { const repository = targets[index + offset][0]; results.push({ repository, status: 'BLOCKED', error: 'Primary-source collection failed; inspect authenticated GitHub access or source paths.' }); console.error(JSON.stringify({ repository, status: 'BLOCKED', code: result.reason.code || 'COLLECTION_FAILED' })) }
  })
}
await fs.writeFile(path.join(output, 'index.json'), JSON.stringify(results, null, 2))
if (results.some((result) => result.status === 'BLOCKED')) process.exitCode = 1
