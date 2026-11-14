import { describe, expect, it } from 'vitest'
import {
  installDevelopmentTools,
  planMissingInstalls,
  refreshProcessPathFromRegistry,
  resolveWingetExecutable
} from '../../server/services/local-environment-install.mjs'

function fakeScanEnvironment(missingIds) {
  const missing = new Set(missingIds)
  const markInstalled = (id) => missing.delete(id)
  const scan = async () => ({
    platform: 'win32',
    scannedAt: new Date().toISOString(),
    status: 'COMPLETE',
    available: 20 - missing.size,
    total: 20,
    tools: ['git', 'node', 'npm', 'python', 'pip'].map((id) => ({
      id,
      label: id,
      executable: `${id}.exe`,
      versionArgs: ['--version'],
      group: 'Test',
      status: missing.has(id) ? 'MISSING' : 'AVAILABLE',
      paths: missing.has(id) ? [] : [`C:\\Tools\\${id}.exe`],
      version: missing.has(id) ? null : '1.0.0',
      conflict: false
    }))
  })
  return { scan, markInstalled }
}

describe('development environment install plan', () => {
  it('plans parent packages and skips tools they provide', () => {
    const report = {
      tools: [
        { id: 'node', status: 'MISSING', label: 'Node.js' },
        { id: 'npm', status: 'MISSING', label: 'npm' },
        { id: 'python', status: 'MISSING', label: 'Python' },
        { id: 'pip', status: 'MISSING', label: 'pip' },
        { id: 'python-launcher', status: 'MISSING', label: 'Python launcher' },
        { id: 'git', status: 'AVAILABLE', label: 'Git' },
        { id: 'maven', status: 'MISSING', label: 'Maven' }
      ]
    }
    const plan = planMissingInstalls(report)
    expect(plan.map((item) => item.toolId)).toEqual(['node', 'python', 'maven'])
    expect(plan[0]).toMatchObject({ label: 'Node.js', packageId: 'OpenJS.NodeJS.LTS' })
    expect(plan[1].provides).toEqual(['pip', 'python-launcher'])
  })

  it('returns an empty plan when everything is available or the report is unusable', () => {
    expect(planMissingInstalls({ tools: [{ id: 'git', status: 'AVAILABLE' }] })).toEqual([])
    expect(planMissingInstalls(null)).toEqual([])
    expect(planMissingInstalls({})).toEqual([])
  })
})

describe('process PATH refresh', () => {
  it('merges machine and user registry PATH into the environment', async () => {
    const env = { Path: 'C:\\Existing', SystemRoot: 'C:\\Windows' }
    const runCommand = async (file, args) => {
      if (file !== 'reg.exe') throw new Error(`unexpected ${file}`)
      if (args[1].startsWith('HKLM')) return { ok: true, stdout: 'Path REG_EXPAND_SZ C:\\Machine;%SystemRoot%\\Tools' }
      return { ok: true, stdout: 'Path REG_SZ C:\\User\\bin' }
    }
    const changed = await refreshProcessPathFromRegistry({ runCommand, env })
    expect(changed).toBe(true)
    const entries = env.Path.split(';')
    expect(entries).toEqual(['C:\\Existing', 'C:\\Machine', 'C:\\Windows\\Tools', 'C:\\User\\bin'])
  })

  it('returns false when the registry cannot be read', async () => {
    const env = { Path: 'C:\\Existing' }
    const runCommand = async () => ({ ok: false, stdout: '', stderr: 'access denied' })
    expect(await refreshProcessPathFromRegistry({ runCommand, env })).toBe(false)
    expect(env.Path).toBe('C:\\Existing')
  })
})

describe('winget resolution', () => {
  it('resolves winget through where.exe and a version probe', async () => {
    const runCommand = async (file, args) => {
      if (file === 'where.exe') return { ok: true, stdout: 'C:\\WindowsApps\\winget.exe\r\n' }
      if (file === 'C:\\WindowsApps\\winget.exe' && args[0] === '--version') return { ok: true, stdout: 'v1.9.0' }
      throw new Error(`unexpected ${file}`)
    }
    expect(await resolveWingetExecutable({ runCommand })).toBe('C:\\WindowsApps\\winget.exe')
  })

  it('returns null when winget is absent', async () => {
    const runCommand = async () => ({ ok: false, stdout: '', stderr: 'not found' })
    expect(await resolveWingetExecutable({ runCommand })).toBe(null)
  })
})

describe('installing missing development tools', () => {
  it('refuses to run off Windows', async () => {
    const result = await installDevelopmentTools({ planned: [{ toolId: 'git', label: 'Git', packageId: 'Git.Git', provides: [] }], platform: 'linux' })
    expect(result).toMatchObject({ ok: false, reason: 'UNSUPPORTED_PLATFORM', installed: [] })
  })

  it('reports ALL_PRESENT for an empty plan', async () => {
    const result = await installDevelopmentTools({ planned: [] })
    expect(result).toMatchObject({ ok: true, reason: 'ALL_PRESENT' })
  })

  it('returns WINGET_MISSING without invoking any package installer', async () => {
    const runCommand = async () => ({ ok: false, stdout: '', stderr: 'not found' })
    const { scan } = fakeScanEnvironment(['git'])
    const result = await installDevelopmentTools({
      planned: [{ toolId: 'git', label: 'Git', packageId: 'Git.Git', provides: [] }],
      runCommand,
      refreshPath: async () => true,
      scan
    })
    expect(result).toMatchObject({ ok: false, reason: 'WINGET_MISSING' })
    expect(result.report.tools).toHaveLength(5)
  })

  it('installs sequentially with silent flags and reports the final scan', async () => {
    const calls = []
    const { scan, markInstalled } = fakeScanEnvironment(['git'])
    const runCommand = async (file, args) => {
      if (file === 'winget.exe') {
        calls.push(['winget', args])
        if (args.includes('Docker.DockerDesktop')) return { ok: false, code: 1, stdout: 'setup failed', stderr: '' }
        markInstalled('git')
        return { ok: true, code: 0, stdout: 'Successfully installed', stderr: '' }
      }
      throw new Error(`unexpected ${file}`)
    }
    const refreshed = []
    const progress = []
    const result = await installDevelopmentTools({
      planned: [
        { toolId: 'git', label: 'Git', packageId: 'Git.Git', provides: [] },
        { toolId: 'docker', label: 'Docker CLI', packageId: 'Docker.DockerDesktop', provides: [] }
      ],
      winget: 'winget.exe',
      runCommand,
      refreshPath: async () => { refreshed.push(true); return true },
      scan,
      onProgress: (event) => progress.push(event)
    })
    expect(calls).toHaveLength(2)
    for (const [, args] of calls) {
      expect(args.slice(0, 3)).toEqual(['install', '--id', expect.any(String)])
      expect(args).toContain('--exact')
      expect(args).toContain('--silent')
      expect(args).toContain('--accept-package-agreements')
      expect(args).toContain('--accept-source-agreements')
    }
    expect(calls[0][1][2]).toBe('Git.Git')
    expect(calls[1][1][2]).toBe('Docker.DockerDesktop')
    expect(refreshed).toHaveLength(3) // before each install + one before the final scan
    expect(result.ok).toBe(false)
    expect(result.installed.map((item) => item.toolId)).toEqual(['git'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({ toolId: 'docker', detail: 'setup failed' })
    expect(result.report.tools.find((tool) => tool.id === 'git')).toMatchObject({ status: 'AVAILABLE' })
    expect(progress[0]).toMatchObject({ phase: 'installing', current: 1, total: 2, toolId: 'git' })
    expect(progress.at(-2)).toMatchObject({ phase: 'refreshing' })
    expect(progress.at(-1)).toMatchObject({ phase: 'finalizing' })
  })

  it('treats reboot-required and already-installed outcomes as installed', async () => {
    const responses = [
      { ok: false, code: 3010, stdout: 'reboot required', stderr: '' },
      { ok: false, code: 1, stdout: 'package is already installed', stderr: '' }
    ]
    const runCommand = async (file) => {
      if (file !== 'winget.exe') throw new Error(`unexpected ${file}`)
      return responses.shift()
    }
    const result = await installDevelopmentTools({
      planned: [
        { toolId: 'git', label: 'Git', packageId: 'Git.Git', provides: [] },
        { toolId: 'uv', label: 'uv', packageId: 'astral-sh.uv', provides: [] }
      ],
      winget: 'winget.exe',
      runCommand,
      refreshPath: async () => true,
      scan: fakeScanEnvironment(['git', 'uv']).scan
    })
    expect(result.ok).toBe(true)
    expect(result.installed.map((item) => item.toolId)).toEqual(['git', 'uv'])
    expect(result.failed).toEqual([])
  })
})
