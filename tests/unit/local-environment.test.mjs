import { describe, expect, it } from 'vitest'
import { detectDevelopmentEnvironment } from '../../server/services/local-environment.mjs'

describe('Windows development environment detection', () => {
  it('uses bounded direct version checks and reports PATH conflicts', async () => {
    const calls = []
    const runCommand = async (file, args) => {
      calls.push([file, args])
      if (file === 'where.exe') {
        if (args[0] === 'git.exe') return { ok: true, stdout: 'C:\\Tools\\git.exe\r\nD:\\Legacy\\git.exe' }
        if (args[0] === 'node.exe') return { ok: true, stdout: 'C:\\Tools\\node.exe' }
        if (args[0] === 'npm.cmd') return { ok: true, stdout: 'C:\\Tools\\npm.cmd' }
        return { ok: false, stdout: '', stderr: 'not found' }
      }
      if (file === 'C:\\Tools\\git.exe') return { ok: true, stdout: 'git version 2.50.0', stderr: '' }
      if (file === 'C:\\Tools\\node.exe') return { ok: true, stdout: 'v24.20.0', stderr: '' }
      throw new Error('Unexpected executable invocation')
    }

    const report = await detectDevelopmentEnvironment({ platform: 'win32', runCommand })
    const git = report.tools.find((tool) => tool.id === 'git')
    const node = report.tools.find((tool) => tool.id === 'node')
    const npm = report.tools.find((tool) => tool.id === 'npm')

    expect(report.status).toBe('COMPLETE')
    expect(git).toMatchObject({ status: 'AVAILABLE', version: 'git version 2.50.0', conflict: true, paths: ['C:\\Tools\\git.exe', 'D:\\Legacy\\git.exe'] })
    expect(node).toMatchObject({ status: 'AVAILABLE', version: 'v24.20.0' })
    expect(npm).toMatchObject({ status: 'SHIM_FOUND', version: null })
    expect(calls.some(([file]) => file === 'C:\\Tools\\npm.cmd')).toBe(false)
  })

  it('checks the remaining requested Windows tools without launching command shims or Windows Terminal', async () => {
    const pathsByCommand = {
      'gh.exe': 'C:\\Tools\\gh.exe',
      'pip.exe': 'C:\\Python\\Scripts\\pip.exe',
      'mvn.cmd': 'C:\\Tools\\mvn.cmd',
      'gradle.bat': 'C:\\Tools\\gradle.bat',
      'pwsh.exe': 'C:\\PowerShell\\pwsh.exe',
      'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'wt.exe': 'C:\\WindowsApps\\wt.exe'
    }
    const calls = []
    const runCommand = async (file, args) => {
      calls.push([file, args])
      if (file === 'where.exe') {
        const resolved = pathsByCommand[args[0]]
        return resolved ? { ok: true, stdout: resolved } : { ok: false, stdout: '', stderr: 'not found' }
      }
      if (file === pathsByCommand['gh.exe']) return { ok: true, stdout: 'gh version 2.83.1 (2026-10-01)', stderr: '' }
      if (file === pathsByCommand['pip.exe']) return { ok: true, stdout: 'pip 25.2 from C:\\Python\\Lib\\site-packages\\pip (python 3.14)', stderr: '' }
      if (file === pathsByCommand['pwsh.exe']) return { ok: true, stdout: 'PowerShell 7.5.0', stderr: '' }
      if (file === pathsByCommand['powershell.exe']) return { ok: true, stdout: '5.1.19041.6381', stderr: '' }
      throw new Error(`Unexpected executable invocation: ${file}`)
    }

    const report = await detectDevelopmentEnvironment({ platform: 'win32', runCommand })
    const tool = (id) => report.tools.find((item) => item.id === id)

    expect(tool('github-cli')).toMatchObject({ status: 'AVAILABLE', version: 'gh version 2.83.1 (2026-10-01)' })
    expect(tool('pip')).toMatchObject({ status: 'AVAILABLE', version: 'pip 25.2 from C:\\Python\\Lib\\site-packages\\pip (python 3.14)' })
    expect(tool('maven')).toMatchObject({ status: 'SHIM_FOUND', version: null, paths: [pathsByCommand['mvn.cmd']] })
    expect(tool('gradle')).toMatchObject({ status: 'SHIM_FOUND', version: null, paths: [pathsByCommand['gradle.bat']] })
    expect(tool('powershell-core')).toMatchObject({ status: 'AVAILABLE', version: 'PowerShell 7.5.0' })
    expect(tool('windows-powershell')).toMatchObject({ status: 'AVAILABLE', version: '5.1.19041.6381' })
    expect(tool('windows-terminal')).toMatchObject({
      status: 'PATH_FOUND',
      version: null,
      paths: [pathsByCommand['wt.exe']],
      diagnostic: expect.stringContaining('could open a terminal window')
    })
    expect(report.available).toBe(7)
    expect(calls).toContainEqual([pathsByCommand['powershell.exe'], ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']])
    expect(calls.some(([file]) => file === pathsByCommand['mvn.cmd'] || file === pathsByCommand['gradle.bat'] || file === pathsByCommand['wt.exe'])).toBe(false)
  })

  it('does not probe tools on unsupported platforms', async () => {
    const report = await detectDevelopmentEnvironment({ platform: 'linux', runCommand: () => { throw new Error('must not run') } })
    expect(report).toMatchObject({ status: 'UNSUPPORTED_PLATFORM', tools: [] })
  })
})
