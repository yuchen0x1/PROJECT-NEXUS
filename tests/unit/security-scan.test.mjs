import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runSecurityScan, scanSecrets, scanFrameworkRisks, scanDependencyVulnerabilities, summarizeFindingsByPriority } from '../../server/services/security-scan.mjs'

const cleanup = []

afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

// Files are created inline in each test (a shared helper silently lost its
// argument under vitest on this machine; inline creation is deterministic).
async function writeTree(directory, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
  return directory
}

describe('secret scanning', () => {
  it('detects committed credentials in text files', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-scan-'))
    cleanup.push(directory)
    await writeTree(directory, {
      'src/index.js': 'const x = 1\n',
      'server/key.txt': '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----',
      'config/settings.js': "const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234';\nconst aws = 'AKIAABCDEFGHIJKLMNOP';\n"
    })
    const findings = await scanSecrets({ root: directory })
    const keys = findings.map((finding) => finding.key)
    expect(keys).toContain('private_key')
    expect(keys).toContain('github_token')
    expect(keys).toContain('aws_key')
    expect(findings.find((finding) => finding.key === 'private_key').priority).toBe('P0')
    expect(findings.find((finding) => finding.key === 'private_key').path.replace(/\\/g, '/')).toBe('server/key.txt')
  })

  it('skips node_modules, .git, and oversized files', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-scan-'))
    cleanup.push(directory)
    await writeTree(directory, {
      'node_modules/pkg/index.js': "const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234';\n",
      '.git/hooks/pre-commit': 'AKIAABCDEFGHIJKLMNOP',
      'vendor/huge.js': 'const a = "AKIAABCDEFGHIJKLMNOP";\n'
    })
    await fs.writeFile(path.join(directory, 'vendor', 'huge.js'), 'x'.repeat(250_000), 'utf8')
    const findings = await scanSecrets({ root: directory })
    expect(findings).toEqual([])
  })
})

describe('framework risk scanning', () => {
  it('flags insecure Electron webPreferences and broad workflow permissions', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-scan-'))
    cleanup.push(directory)
    await writeTree(directory, {
      'electron/main.js': 'new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false } })\n',
      '.github/workflows/release.yml': 'on: push\npermissions: write-all\njobs: {}\n'
    })
    const findings = await scanFrameworkRisks({ root: directory })
    const keys = findings.map((finding) => finding.key)
    expect(keys).toContain('electron_nodeintegration')
    expect(keys).toContain('electron_contextisolation_off')
    expect(keys).toContain('workflow_write_all')
  })
})

describe('dependency vulnerability audit', () => {
  it('returns null without an npm lockfile and never installs anything', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-scan-'))
    cleanup.push(directory)
    await writeTree(directory, { 'package.json': '{"name":"x","version":"1.0.0"}' })
    expect(await scanDependencyVulnerabilities({ root: directory })).toBeNull()
  })
})

describe('runSecurityScan', () => {
  it('aggregates findings with counts and a status verdict', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-scan-'))
    cleanup.push(directory)
    await writeTree(directory, {
      'app.js': "const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234';\n"
    })
    const scan = await runSecurityScan({ root: directory })
    expect(scan.dependencyAuditRan).toBe(false)
    expect(scan.status).toBe('CRITICAL')
    expect(scan.counts.P0).toBeGreaterThanOrEqual(1)
    expect(summarizeFindingsByPriority(scan.findings)).toEqual(scan.counts)
    expect(scan.findings[0].priority <= scan.findings[scan.findings.length - 1].priority).toBe(true)
  })

  it('reports CLEAN when nothing matches', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-scan-'))
    cleanup.push(directory)
    await writeTree(directory, { 'src/app.js': 'export function add(a, b) { return a + b }\n' })
    const scan = await runSecurityScan({ root: directory })
    expect(scan.status).toBe('CLEAN')
    expect(scan.counts.P0).toBe(0)
  })
})
