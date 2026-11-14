import { describe, expect, it } from 'vitest'
import { parseUninstallQuery, detectCodexDesktop, revealFolderInExplorer } from '../../server/services/agent/desktop-assist.mjs'
import { detectAgentAdapters, registerAgentAdapter, listAgentAdapterIds } from '../../server/services/agent/adapters.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const REG_OUTPUT = `

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Codex++
    DisplayName    REG_SZ    Codex++
    DisplayVersion    REG_SZ    2.6.9
    InstallLocation    REG_SZ    C:\\Users\\demo\\AppData\\Local\\Programs\\Codex++
    DisplayIcon    REG_SZ    C:\\Users\\demo\\AppData\\Local\\Programs\\Codex++\\codex-plus-plus.exe,0

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\UnrelatedApp
    DisplayName    REG_SZ    Something Else
    DisplayVersion    REG_SZ    1.0.0
`

describe('desktop assist channel', () => {
  it('parses reg query output into matching uninstall entries', () => {
    const entries = parseUninstallQuery(REG_OUTPUT, /codex/i)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      displayName: 'Codex++',
      version: '2.6.9',
      installLocation: 'C:\\Users\\demo\\AppData\\Local\\Programs\\Codex++',
      displayIcon: 'C:\\Users\\demo\\AppData\\Local\\Programs\\Codex++\\codex-plus-plus.exe,0'
    })
  })

  it('detects an installed, running desktop app from injected probes', async () => {
    // Resolve the launcher through the real filesystem: build a fixture dir
    // whose layout matches the registry entry.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-desktop-'))
    const exe = path.join(dir, 'codex-plus-plus.exe')
    await fs.writeFile(exe, 'exe', 'utf8')
    const regOutput = REG_OUTPUT.split('C:\\Users\\demo\\AppData\\Local\\Programs\\Codex++').join(dir)
    const detection = await detectCodexDesktop({
      execImpl: async (command) => {
        if (command === 'reg') return regOutput
        if (command === 'tasklist') return '"codex-plus-plus.exe","39320","Console","1","122,192 K"'
        throw new Error(`unexpected command ${command}`)
      }
    })
    expect(detection.installed).toBe(true)
    expect(detection.running).toBe(true)
    expect(detection.appName).toBe('Codex++')
    expect(detection.launcherExe?.toLowerCase()).toBe(exe.toLowerCase())
    expect(detection.capabilities).toMatchObject({ taskInjection: false, windowAutomation: false, mode: 'assist-only' })
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('refuses to reveal missing folders', async () => {
    await expect(revealFolderInExplorer({ folderPath: path.join(os.tmpdir(), 'nexus-does-not-exist-xyz') }))
      .rejects.toMatchObject({ code: 'REVEAL_PATH_MISSING' })
  })
})

describe('agent adapter registry', () => {
  it('rejects malformed adapters and lists registered ids', () => {
    expect(() => registerAgentAdapter({ id: 'Bad_Id', name: 'x', detect: async () => ({}) })).toThrow(/kebab-case/)
    expect(() => registerAgentAdapter({ id: 'no-detect', name: 'x' })).toThrow(/detect/)
    const ids = listAgentAdapterIds()
    expect(ids).toContain('codex-app-server')
    expect(ids).toContain('codex-desktop-assist')
  })

  it('returns honest detections for every registered adapter', async () => {
    const adapters = await detectAgentAdapters()
    const byId = Object.fromEntries(adapters.map((adapter) => [adapter.id, adapter]))
    expect(byId['codex-app-server']).toBeDefined()
    expect(byId['codex-app-server'].channel).toBe('native')
    expect(byId['codex-app-server'].capabilities.nativeAgentSessions).toBe(true)
    expect(byId['codex-desktop-assist']).toBeDefined()
    expect(byId['codex-desktop-assist'].channel).toBe('desktop-assist')
    expect(byId['codex-desktop-assist'].capabilities.taskInjection).toBe(false)
    // Every adapter reports a boolean installed state; none may fake a value.
    for (const adapter of adapters) expect(typeof adapter.installed).toBe('boolean')
  })
})
