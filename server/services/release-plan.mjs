import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const read = async (root, file) => fs.readFile(path.join(root, file), 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error })

// Extend the existing delivery path. Unsupported packaging stays visibly blocked.
export async function createReleasePlan({ root, repository, commitSha, version, tag, policy }) {
  const packageText = await read(root, 'package.json')
  let adapter = 'unknown', testCommand = null, buildCommand = null, projectVersion = null, blockedReason = null
  if (packageText) {
    const manifest = JSON.parse(packageText)
    const tauri = await read(root, 'src-tauri/Cargo.toml')
    adapter = tauri ? 'tauri' : manifest.devDependencies?.electron || manifest.dependencies?.electron ? 'electron' : 'node'
    projectVersion = manifest.version
    testCommand = manifest.scripts?.test ? 'npm test' : null
    buildCommand = manifest.scripts?.build ? 'npm run build' : null
    if (tauri) blockedReason = 'Tauri packaging needs a validated platform adapter and signing configuration.'
  } else if (await read(root, 'Cargo.toml')) adapter = 'rust'
  else if (await read(root, 'pyproject.toml')) adapter = 'python'
  else if ((await fs.readdir(root)).some((file) => /\.(?:sln|csproj)$/.test(file))) adapter = 'dotnet'
  if (!['node', 'electron'].includes(adapter)) blockedReason ||= `Release packaging for ${adapter} has not passed real repository acceptance.`
  if (!testCommand) blockedReason ||= 'No regression test command is configured.'
  if (projectVersion !== version) blockedReason ||= `Tested project version must be ${version}.`
  const plan = { repository, commitSha, version, tag, adapter, testCommand, buildCommand, artifactDirectories: ['release', 'dist', 'build'], allowSourceOnly: policy.allowSourceOnlyRelease === true, status: blockedReason ? 'Blocked' : 'Prepared', blockedReason, requiresSigning: adapter === 'electron', signingStatus: adapter === 'electron' ? 'NotVerified' : 'NotApplicable' }
  return { ...plan, id: crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex'), createdAt: new Date().toISOString() }
}
