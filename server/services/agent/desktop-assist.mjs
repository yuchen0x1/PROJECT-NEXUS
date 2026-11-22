import { spawn as nodeSpawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

// Windows Desktop Automation Adapter (master directive PART 6.3) — assist
// channel only. It detects the installed Codex desktop application, reports
// whether it is running, can start it and can reveal a workspace folder in
// Explorer. It does NOT inject tasks into windows, click controls or read
// results from the screen: with the official app-server channel available,
// those would be unreliable guesswork (directive §6.4 marks this channel
// assist-only; it never gates delivery).

const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
]

function assistError(code, message) {
  return Object.assign(new Error(message), { code })
}

function execPromise(command, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      // reg exits 1 when the /f search finds nothing; that is not an error here.
      if (error && error.code !== 1) { error.stderr = stderr; reject(error); return }
      resolve(String(stdout || ''))
    })
  })
}

// Parse `reg query ...\Uninstall /s /f <term>` output into uninstall entries.
// Blocks start at every key line; value lines are `<name>    REG_SZ    <data>`.
export function parseUninstallQuery(output, termRegex) {
  const entries = []
  let current = null
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) continue
    if (/^HKEY_(LOCAL_MACHINE|CURRENT_USER)\\/i.test(line.trim()) && !/^\s/.test(rawLine)) {
      if (current && current.displayName) entries.push(current)
      current = { key: line.trim(), displayName: null, version: null, installLocation: null, displayIcon: null }
      continue
    }
    if (!current) continue
    const match = line.match(/^\s{2,}(\S[^ ]*)\s+REG_SZ\s+(.*)$/)
    if (!match) continue
    const [, name, data] = match
    if (name === 'DisplayName') current.displayName = data.trim()
    else if (name === 'DisplayVersion') current.version = data.trim()
    else if (name === 'InstallLocation') current.installLocation = data.trim()
    else if (name === 'DisplayIcon') current.displayIcon = data.trim()
  }
  if (current && current.displayName) entries.push(current)
  return entries.filter((entry) => termRegex.test(entry.displayName || ''))
}

async function probeRunningProcess(imageNames, { execImpl = execPromise } = {}) {
  try {
    const output = await execImpl('tasklist', ['/FO', 'CSV', '/NH'], { timeoutMs: 12_000 })
    const lowered = String(output).toLowerCase()
    return imageNames.filter(Boolean).some((name) => lowered.includes(`"${String(name).toLowerCase()}"`))
  } catch {
    return false
  }
}

async function resolveLauncherExe(entry) {
  const candidates = []
  if (entry.displayIcon) candidates.push(entry.displayIcon.split(',')[0].trim())
  if (entry.installLocation && /^[A-Za-z]:\\/.test(entry.installLocation)) {
    try {
      const names = await fsp.readdir(entry.installLocation)
      for (const name of names) {
        if (name.toLowerCase().endsWith('.exe') && name.toLowerCase().includes('codex')) candidates.push(path.join(entry.installLocation, name))
      }
      if (!candidates.length) {
        for (const name of names.filter((item) => item.toLowerCase().endsWith('.exe')).slice(0, 5)) {
          candidates.push(path.join(entry.installLocation, name))
        }
      }
    } catch { /* unreadable location */ }
  }
  for (const candidate of candidates) {
    if (!candidate || !/\.exe$/i.test(candidate)) continue
    try {
      const info = await fsp.stat(candidate)
      if (info.isFile()) return candidate
    } catch { /* keep looking */ }
  }
  return null
}

// Detection result. Nothing here reads app data, sessions or credentials —
// only the uninstall registry (name/version/location) and the process list.
export async function detectCodexDesktop({ env = process.env, execImpl = execPromise, spawnImpl = nodeSpawn } = {}) {
  if (process.platform !== 'win32') {
    return { supported: false, installed: false, running: false, capabilities: desktopCapabilities(false) }
  }
  const termRegex = /codex/i
  let entries = []
  for (const key of UNINSTALL_KEYS) {
    try {
      const output = await execImpl('reg', ['query', key, '/s', '/f', 'Codex', '/d'], { timeoutMs: 12_000 })
      entries = entries.concat(parseUninstallQuery(output, termRegex))
    } catch { /* key missing on this machine */ }
  }
  // De-duplicate by displayName+version (HKCU/HKLM can list the same app).
  const seen = new Set()
  entries = entries.filter((entry) => {
    const id = `${entry.displayName}::${entry.version}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  if (!entries.length) return { supported: true, installed: false, running: false, capabilities: desktopCapabilities(false) }

  const primary = entries.find((entry) => entry.installLocation) || entries[0]
  const exe = await resolveLauncherExe(primary)
  // The injected execImpl must reach the process probe too — otherwise tests
  // silently depend on the host machine's own process list.
  const running = exe
    ? await probeRunningProcess([path.basename(exe), 'codex'], { execImpl })
    : await probeRunningProcess(['codex'], { execImpl })
  return {
    supported: true,
    installed: true,
    appName: primary.displayName,
    version: primary.version || null,
    installLocation: primary.installLocation || null,
    launcherExe: exe,
    running,
    entries: entries.map((entry) => ({ name: entry.displayName, version: entry.version })),
    capabilities: desktopCapabilities(Boolean(exe))
  }
}

function desktopCapabilities(launcherKnown) {
  return {
    detect: true,
    launch: launcherKnown,
    revealWorkspace: true,
    taskInjection: false,
    windowAutomation: false,
    resultReading: false,
    mode: 'assist-only'
  }
}

// Start the desktop application. Explicit user action, never automatic.
export async function launchDesktopApp({ launcherExe, spawnImpl = nodeSpawn } = {}) {
  if (!launcherExe || !/\.exe$/i.test(launcherExe)) throw assistError('DESKTOP_LAUNCHER_UNKNOWN', 'No desktop launcher executable was detected.')
  const info = await fsp.stat(launcherExe).catch(() => null)
  if (!info?.isFile()) throw assistError('DESKTOP_LAUNCHER_MISSING', 'The desktop launcher is no longer present.')
  try {
    const child = spawnImpl(launcherExe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return { launched: true, exe: launcherExe }
  } catch (error) {
    throw assistError('DESKTOP_LAUNCH_FAILED', `Could not start the desktop application: ${error.message}`)
  }
}

// Open Explorer with the folder selected (Windows) or the folder itself.
export async function revealFolderInExplorer({ folderPath, spawnImpl = nodeSpawn } = {}) {
  const info = await fsp.stat(folderPath).catch(() => null)
  if (!info?.isDirectory()) throw assistError('REVEAL_PATH_MISSING', 'The workspace folder no longer exists.')
  if (process.platform !== 'win32') {
    spawnImpl('xdg-open', [folderPath], { detached: true, stdio: 'ignore' }).unref?.()
    return { revealed: true, folderPath }
  }
  // explorer parses its own command line; `/select,` must stay one argument.
  const child = spawnImpl('explorer.exe', [`/select,${path.resolve(folderPath)}`], { detached: true, stdio: 'ignore' })
  child.unref?.()
  // explorer.exe exits immediately with a non-zero code even on success.
  return { revealed: true, folderPath: path.resolve(folderPath) }
}

export function desktopAssistSupported() {
  return process.platform === 'win32' && Boolean(fs.existsSync(process.env.ComSpec || 'C:\\Windows'))
}
