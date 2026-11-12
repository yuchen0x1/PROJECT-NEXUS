import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { release as osRelease } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, Tray } from 'electron'
import { detectDevelopmentEnvironment } from '../server/services/local-environment.mjs'
import { listLocalProjects, registerLocalProject, scanLocalProject, unregisterLocalProject } from '../server/services/local-projects.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const smokeTest = process.argv.includes('--nexus-smoke-test')
const traceSmoke = (event) => { if (smokeTest) process.stdout.write(`NEXUS_DESKTOP_TRACE:${event}\n`) }
traceSmoke('main-module-loaded')
const requestedDataRoot = smokeTest ? process.env.NEXUS_DESKTOP_DATA_DIR : ''
const defaultDataRoot = process.platform === 'win32'
  ? (process.env.LOCALAPPDATA && path.win32.isAbsolute(process.env.LOCALAPPDATA)
      ? process.env.LOCALAPPDATA
      : path.join(app.getPath('appData'), '..', 'Local'))
  : app.getPath('appData')
const productDataRoot = requestedDataRoot
  ? path.resolve(requestedDataRoot)
  : path.join(defaultDataRoot, 'PROJECT NEXUS')
app.setPath('userData', productDataRoot)
app.setPath('sessionData', path.join(productDataRoot, 'cache'))
traceSmoke('paths-configured')

const userDataPath = app.getPath('userData')
const logsPath = path.join(userDataPath, 'logs')
const cachePath = app.getPath('sessionData')
const settingsPath = path.join(userDataPath, 'desktop-settings.json')
const windowStatePath = path.join(userDataPath, 'window-state.json')
const apiToken = crypto.randomBytes(32).toString('hex')
let apiOrigin = ''
let apiProcess = null
let mainWindow = null
let tray = null
let windowSaveTimer = null
let isQuitting = false
let preferences = { autoStart: false }

process.env.NEXUS_LOCAL_API_TOKEN = apiToken
process.env.NEXUS_DESKTOP_VERSION = app.getVersion()

const maxLogBytes = 2 * 1024 * 1024

async function writeLog(level, event, details = {}) {
  try {
    await fs.mkdir(logsPath, { recursive: true })
    const logFile = path.join(logsPath, 'workstation.log')
    const stat = await fs.stat(logFile).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (stat && stat.size > maxLogBytes) {
      await fs.rm(`${logFile}.1`, { force: true })
      await fs.rename(logFile, `${logFile}.1`)
    }
    const safeDetails = Object.fromEntries(Object.entries(details).filter(([key, value]) => !/token|secret|key|path|content/i.test(key) && ['string', 'number', 'boolean'].includes(typeof value)))
    await fs.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), level, event, ...safeDetails })}\n`, 'utf8')
  } catch { /* Logging failures must not crash the workstation. */ }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return fallback
    await writeLog('error', 'configuration-read-failed')
    return fallback
  }
}

async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function startApiProcess() {
  return await new Promise((resolve, reject) => {
    const appRoot = app.getAppPath()
    const serverEntry = path.join(appRoot, 'server', 'index.mjs')
    const serviceWorkingDirectory = app.isPackaged ? process.resourcesPath : appRoot
    const childEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: '0',
      NEXUS_HOST: '127.0.0.1',
      NEXUS_DESKTOP_MODE: 'true',
      NEXUS_LOCAL_API_TOKEN: apiToken,
      NEXUS_DATA_DIR: userDataPath,
      NEXUS_STATE_FILE: path.join(userDataPath, 'state.json'),
      NEXUS_AGENT_WORKSPACE_ROOT: path.join(userDataPath, 'agent-workspaces'),
      NEXUS_LOG_DIR: logsPath
    }
    const child = spawn(process.execPath, [serverEntry], {
      cwd: serviceWorkingDirectory,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    })
    apiProcess = child
    let output = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('The local service did not become ready before timeout.'))
    }, 20_000)
    const finish = (error, port) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(port)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.on('data', () => { void writeLog('warning', 'local-service-stderr') })
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-16_000)
      const match = output.match(/NEXUS_DESKTOP_READY:(\d{1,5})/)
      if (match) finish(null, Number(match[1]))
      const newline = output.lastIndexOf('\n')
      if (newline >= 0) output = output.slice(newline + 1)
    })
    child.on('error', (error) => finish(Object.assign(new Error('The local service process could not be started.'), { code: error?.code || 'PROCESS_START_FAILED' })))
    child.on('exit', (code) => {
      if (!settled) finish(Object.assign(new Error(`The local service exited during startup (${code ?? 'unknown'}).`), { code: 'LOCAL_SERVICE_EARLY_EXIT', exitCode: Number(code ?? -1) }))
      else if (!isQuitting) {
        void writeLog('error', 'local-service-exited', { code: Number(code ?? -1) })
        if (mainWindow && !mainWindow.isDestroyed()) dialog.showErrorBox('Local service stopped', `PROJECT NEXUS local services stopped unexpectedly. Check the logs under ${logsPath}.`)
      }
    })
  })
}

async function loadWindowState() {
  const saved = await readJson(windowStatePath, null)
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return { width: 1480, height: 940 }
  const bounds = {
    width: Math.max(1100, Math.min(2400, Math.round(saved.width))),
    height: Math.max(700, Math.min(1800, Math.round(saved.height)))
  }
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return bounds
  const hasVisibleDisplay = screen.getAllDisplays().some(({ workArea }) => saved.x < workArea.x + workArea.width - 80 && saved.x + bounds.width > workArea.x + 80 && saved.y < workArea.y + workArea.height - 80 && saved.y + bounds.height > workArea.y + 80)
  if (!hasVisibleDisplay) return bounds
  return { ...bounds, x: Math.round(saved.x), y: Math.round(saved.y), maximized: Boolean(saved.maximized) }
}

async function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const maximized = mainWindow.isMaximized()
  const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
  await writeJson(windowStatePath, { ...bounds, maximized }).catch(() => {})
}

function scheduleWindowStateSave() {
  clearTimeout(windowSaveTimer)
  windowSaveTimer = setTimeout(() => void saveWindowState(), 250)
}

function isTrustedFrame(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || !apiOrigin) return false
  try { return new URL(event.senderFrame?.url || '').origin === apiOrigin }
  catch { return false }
}

function registerIpc(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedFrame(event)) throw new Error('This local capability is available only to the PROJECT NEXUS window.')
    return await handler(...args)
  })
}

function registerLocalCapabilities() {
  registerIpc('desktop:api:request', async (request) => {
    if (!request || typeof request.url !== 'string' || request.url.length > 4096) throw new Error('Invalid local API request.')
    const method = String(request.method || 'GET').toUpperCase()
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('This API method is not available from the desktop client.')
    let target
    try { target = new URL(request.url, apiOrigin) }
    catch { throw new Error('Invalid local API request URL.') }
    if (target.origin !== apiOrigin || !target.pathname.startsWith('/api/')) throw new Error('Desktop API requests are restricted to this local service.')
    let body
    if (request.body !== undefined) {
      if (typeof request.body !== 'string' || Buffer.byteLength(request.body) > 1024 * 1024) throw new Error('Local API request body is invalid or too large.')
      body = request.body
    }
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), 30_000)
    try {
      const response = await fetch(target, {
        method,
        headers: { Authorization: `Bearer ${apiToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
        signal: abortController.signal
      })
      const payload = await response.json().catch(() => ({}))
      return { status: response.status, body: payload }
    } finally { clearTimeout(timeout) }
  })
  registerIpc('desktop:info', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
    dataPath: userDataPath,
    logsPath,
    cachePath,
    autoStart: Boolean(preferences.autoStart)
  }))
  registerIpc('desktop:environment:detect', async () => {
    const result = await detectDevelopmentEnvironment()
    await writeLog('info', 'environment-scan-complete', { available: result.available || 0, total: result.total || 0 })
    return result
  })
  registerIpc('desktop:projects:list', async () => await listLocalProjects({ dataDir: userDataPath }))
  registerIpc('desktop:projects:add', async () => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Add a local project folder',
      properties: ['openDirectory', 'dontAddToRecent']
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    const result = await registerLocalProject({ dataDir: userDataPath, folderPath: selection.filePaths[0] })
    await writeLog('info', result.added ? 'local-project-added' : 'local-project-already-registered', { projectId: result.project.id })
    return result
  })
  registerIpc('desktop:projects:remove', async (projectId, projectName) => {
    if (typeof projectName !== 'string' || projectName.length > 160) throw new Error('Invalid project name.')
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Remove project from NEXUS',
      message: `Remove ${projectName} from the local project list?`,
      detail: 'This removes only the NEXUS reference. No project files will be deleted or changed.',
      buttons: ['Keep project', 'Remove from NEXUS'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (confirmation.response !== 1) return { removed: false }
    const result = await unregisterLocalProject({ dataDir: userDataPath, projectId })
    await writeLog('info', 'local-project-unregistered', { projectId })
    return result
  })
  registerIpc('desktop:projects:scan', async (projectId) => {
    const report = await scanLocalProject({ dataDir: userDataPath, projectId })
    await writeLog('info', 'local-project-scan-complete', { projectId, visitedEntries: report.visitedEntries, truncated: report.truncated })
    return report
  })
  registerIpc('desktop:settings:auto-start', async (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('Auto-start setting must be enabled or disabled explicitly.')
    app.setLoginItemSettings({ openAtLogin: enabled, path: app.getPath('exe') })
    preferences = { ...preferences, autoStart: enabled }
    await writeJson(settingsPath, preferences)
    await writeLog('info', 'auto-start-setting-changed', { enabled })
    return { enabled }
  })
}

async function createMainWindow() {
  const bounds = await loadWindowState()
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'PROJECT NEXUS — Windows Workstation',
    backgroundColor: '#171d1b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, target) => {
    try { if (new URL(target).origin !== apiOrigin) event.preventDefault() }
    catch { event.preventDefault() }
  })
  mainWindow.on('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) mainWindow.show()
    if (bounds.maximized) mainWindow.maximize()
    void writeLog('info', 'window-ready')
  })
  mainWindow.on('resize', scheduleWindowStateSave)
  mainWindow.on('move', scheduleWindowStateSave)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow.hide()
      void writeLog('info', 'window-hidden-to-tray')
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
  await mainWindow.loadURL(apiOrigin)
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray() {
  const iconPath = path.join(here, 'assets', 'app.ico')
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) throw new Error('The NEXUS tray icon could not be loaded.')
  tray = new Tray(icon)
  tray.setToolTip('PROJECT NEXUS — Windows Workstation')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open PROJECT NEXUS', click: showWindow },
    { type: 'separator' },
    { label: 'Exit PROJECT NEXUS', click: () => app.quit() }
  ]))
  tray.on('double-click', showWindow)
}

const singleInstance = app.requestSingleInstanceLock()
traceSmoke(`single-instance:${singleInstance}`)
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  registerLocalCapabilities()
  app.on('before-quit', () => {
    isQuitting = true
    clearTimeout(windowSaveTimer)
    void saveWindowState()
    if (apiProcess && !apiProcess.killed) apiProcess.kill()
  })
  app.on('window-all-closed', () => {})
  app.on('activate', showWindow)

  void startDesktop()
}

async function startDesktop() {
  traceSmoke('waiting-for-ready')
  await app.whenReady()
  traceSmoke('app-ready')
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.mkdir(logsPath, { recursive: true })
  await fs.mkdir(cachePath, { recursive: true })
  preferences = await readJson(settingsPath, { autoStart: false })
  if (typeof preferences.autoStart !== 'boolean') preferences = { autoStart: false }
  if (preferences.autoStart) app.setLoginItemSettings({ openAtLogin: true, path: app.getPath('exe') })
  await writeLog('info', 'application-starting', { version: app.getVersion(), platform: process.platform, arch: process.arch })

  try {
    const port = await startApiProcess()
    traceSmoke('local-service-ready')
    apiOrigin = `http://127.0.0.1:${port}`
    createTray()
    traceSmoke('tray-ready')
    await createMainWindow()
    traceSmoke('window-created')
    await writeLog('info', 'application-ready')
  } catch (error) {
    await writeLog('error', 'application-start-failed', {
      code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'STARTUP_ERROR',
      exitCode: Number.isFinite(error?.exitCode) ? error.exitCode : -1
    })
    dialog.showErrorBox('PROJECT NEXUS could not start', `The local workstation service did not start. Check ${logsPath} and try again.`)
    app.quit()
  }
}
