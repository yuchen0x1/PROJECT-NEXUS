import { execFile } from 'node:child_process'

const toolDefinitions = Object.freeze([
  { id: 'git', label: 'Git', executable: 'git.exe', versionArgs: ['--version'], group: 'Source control' },
  { id: 'github-cli', label: 'GitHub CLI', executable: 'gh.exe', versionArgs: ['--version'], group: 'Source control' },
  { id: 'node', label: 'Node.js', executable: 'node.exe', versionArgs: ['--version'], group: 'JavaScript' },
  { id: 'npm', label: 'npm', executable: 'npm.cmd', versionArgs: ['--version'], group: 'JavaScript' },
  { id: 'pnpm', label: 'pnpm', executable: 'pnpm.cmd', versionArgs: ['--version'], group: 'JavaScript' },
  { id: 'yarn', label: 'Yarn', executable: 'yarn.cmd', versionArgs: ['--version'], group: 'JavaScript' },
  { id: 'python', label: 'Python', executable: 'python.exe', versionArgs: ['--version'], group: 'Python' },
  { id: 'python-launcher', label: 'Python launcher', executable: 'py.exe', versionArgs: ['--version'], group: 'Python' },
  { id: 'pip', label: 'pip', executable: 'pip.exe', versionArgs: ['--version'], group: 'Python' },
  { id: 'uv', label: 'uv', executable: 'uv.exe', versionArgs: ['--version'], group: 'Python' },
  { id: 'java', label: 'Java', executable: 'java.exe', versionArgs: ['--version'], group: 'Java' },
  { id: 'maven', label: 'Maven', executable: 'mvn.cmd', versionArgs: ['--version'], group: 'Java' },
  { id: 'gradle', label: 'Gradle', executable: 'gradle.bat', versionArgs: ['--version'], group: 'Java' },
  { id: 'powershell-core', label: 'PowerShell 7', executable: 'pwsh.exe', versionArgs: ['--version'], group: 'PowerShell' },
  { id: 'windows-powershell', label: 'Windows PowerShell', executable: 'powershell.exe', versionArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], group: 'PowerShell' },
  { id: 'windows-terminal', label: 'Windows Terminal', executable: 'wt.exe', versionArgs: null, group: 'Windows' },
  { id: 'rustc', label: 'Rust compiler', executable: 'rustc.exe', versionArgs: ['--version'], group: 'Rust' },
  { id: 'cargo', label: 'Cargo', executable: 'cargo.exe', versionArgs: ['--version'], group: 'Rust' },
  { id: 'dotnet', label: '.NET SDK', executable: 'dotnet.exe', versionArgs: ['--version'], group: '.NET' },
  { id: 'docker', label: 'Docker CLI', executable: 'docker.exe', versionArgs: ['--version'], group: 'Containers' }
])

function runFile(file, args, { timeoutMs = 2500, maxBuffer = 32 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: error?.killed === true })
    })
  })
}

function outputText(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim().replace(/\s+/g, ' ').slice(0, 220)
}

export async function detectDevelopmentEnvironment({ platform = process.platform, runCommand = runFile } = {}) {
  if (platform !== 'win32') {
    return { platform, scannedAt: new Date().toISOString(), status: 'UNSUPPORTED_PLATFORM', tools: [], message: 'Native environment detection is currently implemented for Windows.' }
  }
  const tools = await Promise.all(toolDefinitions.map(async (definition) => {
    const resolved = await runCommand('where.exe', [definition.executable], { timeoutMs: 2000, maxBuffer: 16 * 1024 })
    const paths = resolved.ok
      ? [...new Set(resolved.stdout.split(/\r?\n/).map((item) => item.trim()).filter((item) => item && item.length < 32000))].slice(0, 6)
      : []
    if (!paths.length) return { ...definition, status: 'MISSING', paths: [], version: null, conflict: false }

    if (definition.versionArgs === null) {
      return {
        ...definition,
        status: 'PATH_FOUND',
        paths,
        version: null,
        conflict: paths.length > 1,
        diagnostic: 'Executable path found. Version probe was skipped because invoking it could open a terminal window.'
      }
    }

    if (/\.(?:cmd|bat)$/i.test(paths[0])) {
      return {
        ...definition,
        status: 'SHIM_FOUND',
        paths,
        version: null,
        conflict: paths.length > 1,
        diagnostic: 'A Windows command shim was found. It was not executed by the environment scanner.'
      }
    }

    const version = await runCommand(paths[0], definition.versionArgs, { timeoutMs: 3500, maxBuffer: 32 * 1024 })
    return {
      ...definition,
      status: version.ok ? 'AVAILABLE' : version.timedOut ? 'TIMEOUT' : 'VERSION_ERROR',
      paths,
      version: version.ok ? outputText(version) : null,
      conflict: paths.length > 1,
      diagnostic: version.ok ? null : version.timedOut ? 'Version check timed out.' : 'The executable was found, but its version could not be read.'
    }
  }))
  const available = tools.filter((tool) => ['AVAILABLE', 'SHIM_FOUND', 'PATH_FOUND'].includes(tool.status)).length
  return { platform, scannedAt: new Date().toISOString(), status: 'COMPLETE', available, total: tools.length, tools }
}
