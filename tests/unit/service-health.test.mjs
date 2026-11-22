import { describe, expect, it } from 'vitest'
import { createRestartBudget } from '../../desktop/service-health.mjs'
import { assertExecutionAllowed, assertTrustedRepository, withExecutionPolicy } from '../../server/services/execution-policy.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

describe('host lifecycle and repository trust', () => {
  it('bounds rapid crashes even if every process briefly became ready', () => {
    let now = 0
    const budget = createRestartBudget({ clock: () => now })
    for (let attempt = 1; attempt <= 5; attempt++) expect(budget.next().attempt).toBe(attempt)
    expect(budget.next()).toBeNull()
    now = 10 * 60_000
    expect(budget.next().attempt).toBe(1)
  })
  it('blocks untrusted hosted code and observes revocation across async operations', async () => {
    const project = { hosting: { executionMode: 'blocked' } }
    expect(() => assertTrustedRepository(project)).toThrow(/blocked/)
    project.hosting.executionMode = 'trusted-local'
    await withExecutionPolicy({ assertAllowed: () => assertTrustedRepository(project) }, async () => {
      assertExecutionAllowed()
      await Promise.resolve()
      project.hosting.executionMode = 'blocked'
      expect(assertExecutionAllowed).toThrow(/blocked/)
    })
  })
  it.runIf(process.platform === 'win32')('cleans a running child when the host crashes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-host-crash-'))
    const pidFile = path.join(dir, 'child.pid')
    const script = path.join(dir, 'child.mjs')
    const hostScript = path.join(dir, 'host.mjs')
    const executor = new URL('../../server/services/agent/executor.mjs', import.meta.url).href
    await fs.writeFile(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    await fs.writeFile(hostScript, `import {runCommand} from ${JSON.stringify(executor)}; await runCommand({cwd:${JSON.stringify(dir)}, command:${JSON.stringify(`node "${script}"`)}, timeoutMs:30000})`)
    const child = spawn(process.execPath, [hostScript], { stdio: 'ignore', windowsHide: true })
    let runnerPid
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        runnerPid = Number(await fs.readFile(pidFile, 'utf8').catch(() => ''))
        if (runnerPid) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(runnerPid).toBeGreaterThan(0)
      child.kill()
      let alive = true
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(runnerPid, 0) } catch { alive = false; break }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(alive).toBe(false)
    } finally {
      child.kill()
      if (runnerPid) { try { process.kill(runnerPid) } catch {} }
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 30000)
})
