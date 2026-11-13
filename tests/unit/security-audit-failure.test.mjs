import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
vi.mock('../../server/services/agent/executor.mjs', () => ({ runCommand: vi.fn(async () => ({ ok: false, stdout: '{"error":{"code":"ECONNRESET"}}' })) }))
import { scanDependencyVulnerabilities, runSecurityScan } from '../../server/services/security-scan.mjs'

describe('failed audit evidence', () => {
  it('never calls a failed dependency audit clean', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-audit-failure-'))
    try {
      await fs.writeFile(path.join(root, 'package.json'), '{}')
      await fs.writeFile(path.join(root, 'package-lock.json'), '{}')
      await expect(scanDependencyVulnerabilities({ root })).rejects.toMatchObject({ code: 'DEPENDENCY_AUDIT_FAILED' })
      await expect(runSecurityScan({ root })).rejects.toMatchObject({ code: 'DEPENDENCY_AUDIT_FAILED' })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})
