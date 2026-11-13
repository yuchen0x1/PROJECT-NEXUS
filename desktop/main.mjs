import { createRestartBudget } from './service-health.mjs'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { release as osRelease } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, screen, shell, Tray } from 'electron'
import { detectDevelopmentEnvironment } from '../server/services/local-environment.mjs'
import { listLocalProjects, registerLocalProject, scanLocalProject, unregisterLocalProject } from '../server/services/local-projects.mjs'
import { listProviderRecords, resolveProviderForInvocation } from '../server/services/provider-store.mjs'
import { listDraftProviderModels } from '../server/services/provider-models.mjs'

// Languages shipped in src/i18n/languages.ts. Kept in sync manually; the
// renderer validates as well, this is the durable boundary.
const SUPPORTED_LANGUAGES = Object.freeze(['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'pt-BR', 'ru-RU'])
const THEMES = Object.freeze(['dark', 'light', 'system'])

const TRAY_STRINGS = {
  'zh-CN': { open: '打开 PROJECT NEXUS', exit: '退出 PROJECT NEXUS', pause: '暂停自动维护', resume: '恢复自动维护', tooltip: 'PROJECT NEXUS — Windows 工作站' },
  'zh-TW': { open: '開啟 PROJECT NEXUS', exit: '結束 PROJECT NEXUS', pause: '暫停自動維護', resume: '恢復自動維護', tooltip: 'PROJECT NEXUS — Windows 工作站' },
  'en-US': { open: 'Open PROJECT NEXUS', exit: 'Exit PROJECT NEXUS', pause: 'Pause autonomous maintenance', resume: 'Resume autonomous maintenance', tooltip: 'PROJECT NEXUS — Windows Workstation' },
  'ja-JP': { open: 'PROJECT NEXUS を開く', exit: 'PROJECT NEXUS を終了', pause: '自動メンテナンスを一時停止', resume: '自動メンテナンスを再開', tooltip: 'PROJECT NEXUS — Windows ワークステーション' },
  'ko-KR': { open: 'PROJECT NEXUS 열기', exit: 'PROJECT NEXUS 종료', pause: '자동 유지 관리 일시 중지', resume: '자동 유지 관리 재개', tooltip: 'PROJECT NEXUS — Windows 워크스테이션' },
  'fr-FR': { open: 'Ouvrir PROJECT NEXUS', exit: 'Quitter PROJECT NEXUS', pause: 'Suspendre la maintenance automatique', resume: 'Reprendre la maintenance automatique', tooltip: 'PROJECT NEXUS — Station de travail Windows' },
  'de-DE': { open: 'PROJECT NEXUS öffnen', exit: 'PROJECT NEXUS beenden', pause: 'Automatische Wartung pausieren', resume: 'Automatische Wartung fortsetzen', tooltip: 'PROJECT NEXUS — Windows-Arbeitsbereich' },
  'es-ES': { open: 'Abrir PROJECT NEXUS', exit: 'Salir de PROJECT NEXUS', pause: 'Pausar mantenimiento automático', resume: 'Reanudar mantenimiento automático', tooltip: 'PROJECT NEXUS — Estación de trabajo Windows' },
  'pt-BR': { open: 'Abrir PROJECT NEXUS', exit: 'Encerrar PROJECT NEXUS', pause: 'Pausar manutenção automática', resume: 'Retomar manutenção automática', tooltip: 'PROJECT NEXUS — Estação de trabalho Windows' },
  'ru-RU': { open: 'Открыть PROJECT NEXUS', exit: 'Выйти из PROJECT NEXUS', pause: 'Приостановить автообслуживание', resume: 'Возобновить автообслуживание', tooltip: 'PROJECT NEXUS — рабочая станция Windows' }
}

function trayLanguage(preferences) {
  return SUPPORTED_LANGUAGES.includes(preferences.language) ? preferences.language : 'en-US'
}

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
const providerKeysPath = path.join(userDataPath, 'provider-keys.json')
const githubCredentialsPath = path.join(userDataPath, 'github-credentials.json')
const apiToken = crypto.randomBytes(32).toString('hex')
let apiOrigin = ''
let apiProcess = null
let mainWindow = null
let tray = null
let windowSaveTimer = null
let isQuitting = false
let hostingPaused = false
const serviceRestartBudget = createRestartBudget()
let serviceRespawnAttempts = 0
let serviceRespawnTimer = null
let preferences = { autoStart: false, language: null, theme: 'dark', reduceMotion: false, agentReplyLanguage: 'ui' }

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
      NEXUS_REPO_WORKSPACE_ROOT: path.join(userDataPath, 'repositories'),
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
        // PART 2.2: the background service must survive crashes — respawn with
        // exponential backoff instead of giving up.
        void writeLog('error', 'local-service-exited', { code: Number(code ?? -1) })
        void respawnApiService()
      }
    })
  })
}

// PART 2.2: crash auto-recovery for the background service. Exponential
// backoff capped at 30 s; after 5 consecutive failures the user is informed
// instead of silently retrying forever.
async function respawnApiService() {
  if (isQuitting) return
  const restart = serviceRestartBudget.next()
  if (!restart) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('Local service stopped', `PROJECT NEXUS local services stopped repeatedly and were not restarted automatically. Check the logs under ${logsPath}.`)
    }
    return
  }
  serviceRespawnAttempts = restart.attempt
  const delay = restart.delay
  await writeLog('warning', 'local-service-respawn-scheduled', { attempt: serviceRespawnAttempts })
  clearTimeout(serviceRespawnTimer)
  serviceRespawnTimer = setTimeout(async () => {
    if (isQuitting) return
    try {
      const port = await startApiProcess()
      apiOrigin = `http://127.0.0.1:${port}`
      void syncStoredProviderKeys()
      void syncHostingPauseState()
      await writeLog('info', 'local-service-respawned')
    } catch (error) {
      await writeLog('error', 'local-service-respawn-failed', { code: typeof error?.code === 'string' ? error.code.slice(0, 80) : 'UNKNOWN' })
      void respawnApiService()
    }
  }, delay)
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

// ---- Provider API key vault (PHASE 6) ----
// Keys are encrypted with the OS-level safeStorage backend (DPAPI on Windows),
// stored outside any project directory, never sent to the renderer (only
// written/deleted), and forwarded in memory to the local service over the
// authenticated loopback API.
function providerKeyId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(value)) throw new Error('Provider id is invalid.')
  return value.toLowerCase()
}

async function readProviderKeyVault() {
  try {
    const parsed = JSON.parse(await fs.readFile(providerKeysPath, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 1 && parsed.keys && typeof parsed.keys === 'object') return parsed
    throw new Error('Credential vault format is invalid; existing credentials were preserved.')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { schemaVersion: 1, keys: {} }
}

async function writeProviderKeyVault(vault) {
  const temporary = `${providerKeysPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.mkdir(path.dirname(providerKeysPath), { recursive: true })
  await fs.writeFile(temporary, JSON.stringify(vault, null, 2), { encoding: 'utf8', flag: 'wx' })
  await fs.rename(temporary, providerKeysPath).catch(async (error) => {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  })
}

async function decryptVaultKeys(vault) {
  const keys = {}
  for (const [id, encrypted] of Object.entries(vault.keys || {})) {
    if (typeof encrypted !== 'string' || !encrypted) continue
    try {
      const buffer = Buffer.from(encrypted, 'latin1')
      keys[id] = safeStorage.decryptString(buffer)
    } catch { /* skip undecryptable entries instead of failing startup */ }
  }
  return keys
}

async function syncProviderKeysToService(keys) {
  if (!apiOrigin) return { synced: false, reason: 'service-not-ready' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${apiOrigin}/api/local-agent/provider-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ keys }),
      signal: controller.signal
    })
    const body = await response.json().catch(() => ({}))
    return { synced: response.ok, status: response.status, body }
  } catch (error) {
    return { synced: false, reason: String(error?.message || 'sync failed').slice(0, 120) }
  } finally { clearTimeout(timeout) }
}

async function syncStoredProviderKeys() {
  await syncStoredGitHubCredential()
  try {
    const vault = await readProviderKeyVault()
    const keys = await decryptVaultKeys(vault)
    if (Object.keys(keys).length) {
      const result = await syncProviderKeysToService(keys)
      await writeLog('info', 'provider-keys-synced', { count: Object.keys(keys).length, synced: Boolean(result.synced) })
      return result
    }
  } catch (error) {
    await writeLog('error', 'provider-keys-sync-failed', {})
  }
  return { synced: false }
}

async function syncGitHubCredential(token) {
  const response = await fetch(`${apiOrigin}/api/github/credentials`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }), signal: AbortSignal.timeout(20_000)
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.message || 'GitHub connection failed.')
  return body
}

async function syncStoredGitHubCredential() {
  try {
    const record = JSON.parse(await fs.readFile(githubCredentialsPath, 'utf8'))
    if (record.schemaVersion !== 1 || typeof record.encrypted !== 'string') throw new Error('Invalid GitHub credential vault.')
    await syncGitHubCredential(safeStorage.decryptString(Buffer.from(record.encrypted, 'base64')))
  } catch (error) {
    if (error.code !== 'ENOENT') await writeLog('warning', 'github-credential-sync-failed', {})
  }
}

function registerLocalCapabilities() {
  registerIpc('desktop:provider-models:list', async (draft) => {
    const records = await listProviderRecords({ dataDir: userDataPath })
    return await listDraftProviderModels(draft, {
      records,
      getSavedKey: async (provider) => {
        if (provider.source === 'env') return (await resolveProviderForInvocation({ dataDir: userDataPath, providerId: provider.id }))?.apiKey || ''
        const keys = await decryptVaultKeys(await readProviderKeyVault())
        return keys[provider.id] || ''
      }
    })
  })
  registerIpc('desktop:github:open-token-page', async () => {
    await shell.openExternal('https://github.com/settings/tokens/new')
  })
  registerIpc('desktop:github:connect', async (token) => {
    if (typeof token !== 'string' || !token.trim() || token.length > 4096) throw new Error('Enter a GitHub access token.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential encryption is unavailable.')
    const result = await syncGitHubCredential(token.trim())
    const temporary = `${githubCredentialsPath}.${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, encrypted: safeStorage.encryptString(token.trim()).toString('base64') }), { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, githubCredentialsPath)
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
    return result
  })
  registerIpc('desktop:provider-keys:set', async (providerId, apiKey) => {
    const id = providerKeyId(providerId)
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096) throw new Error('The API key must be a non-empty string.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The operating system refused secure credential encryption; the key was NOT saved.')
    const vault = await readProviderKeyVault()
    vault.keys[id] = safeStorage.encryptString(apiKey.trim()).toString('latin1')
    await writeProviderKeyVault(vault)
    await writeLog('info', 'provider-key-set', { providerId: id })
    return { providerId: id, saved: true, sync: await syncProviderKeysToService(await decryptVaultKeys(vault)) }
  })
  registerIpc('desktop:provider-keys:delete', async (providerId) => {
    const id = providerKeyId(providerId)
    const vault = await readProviderKeyVault()
    delete vault.keys[id]
    await writeProviderKeyVault(vault)
    await writeLog('info', 'provider-key-deleted', { providerId: id })
    return { providerId: id, deleted: true, sync: await syncProviderKeysToService(await decryptVaultKeys(vault)) }
  })
  registerIpc('desktop:provider-keys:status', async () => {
    const vault = await readProviderKeyVault()
    return { providerIds: Object.keys(vault.keys || {}), encryptionAvailable: safeStorage.isEncryptionAvailable() }
  })

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
    // Readiness performs bounded GitHub, provider and tool probes in sequence.
    const requestTimeout = /\/hosting\/readiness$/.test(target.pathname) ? 75_000 : 30_000
    const timeout = setTimeout(() => abortController.abort(), requestTimeout)
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
  registerIpc('desktop:projects:add', async (dialogTitle) => {
    const title = typeof dialogTitle === 'string' && dialogTitle.length <= 160 ? dialogTitle : 'Add a local project folder'
    const selection = await dialog.showOpenDialog(mainWindow, {
      title,
      properties: ['openDirectory', 'dontAddToRecent']
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    const result = await registerLocalProject({ dataDir: userDataPath, folderPath: selection.filePaths[0] })
    await writeLog('info', result.added ? 'local-project-added' : 'local-project-already-registered', { projectId: result.project.id })
    return result
  })
  registerIpc('desktop:projects:remove', async (projectId, projectName, dialogText) => {
    if (typeof projectName !== 'string' || projectName.length > 160) throw new Error('Invalid project name.')
    const text = (dialogText && typeof dialogText === 'object')
      ? {
          title: typeof dialogText.title === 'string' ? dialogText.title.slice(0, 160) : 'Remove project from NEXUS',
          message: typeof dialogText.message === 'string' && dialogText.message.length <= 400 ? dialogText.message : `Remove ${projectName} from the local project list?`,
          detail: typeof dialogText.detail === 'string' ? dialogText.detail.slice(0, 500) : 'This removes only the NEXUS reference. No project files will be deleted or changed.',
          confirm: typeof dialogText.confirm === 'string' ? dialogText.confirm.slice(0, 80) : 'Remove from NEXUS',
          cancel: typeof dialogText.cancel === 'string' ? dialogText.cancel.slice(0, 80) : 'Keep project'
        }
      : null
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: text?.title ?? 'Remove project from NEXUS',
      message: text?.message ?? `Remove ${projectName} from the local project list?`,
      detail: text?.detail ?? 'This removes only the NEXUS reference. No project files will be deleted or changed.',
      buttons: [text?.cancel ?? 'Keep project', text?.confirm ?? 'Remove from NEXUS'],
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
    // PART 2.2: boot launches restore the background service silently to the tray.
    app.setLoginItemSettings({ openAtLogin: enabled, path: app.getPath('exe'), args: ['--hidden'] })
    preferences = { ...preferences, autoStart: enabled }
    await writeJson(settingsPath, preferences)
    await writeLog('info', 'auto-start-setting-changed', { enabled })
    return { enabled }
  })
  registerIpc('desktop:settings:get', async () => ({
    preferences: {
      language: preferences.language ?? null,
      theme: preferences.theme ?? 'dark',
      reduceMotion: Boolean(preferences.reduceMotion),
      agentReplyLanguage: preferences.agentReplyLanguage ?? 'ui'
    },
    systemLocale: app.getLocale(),
    settingsPath
  }))
  registerIpc('desktop:settings:update', async (partial) => {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new Error('Settings update payload must be an object.')
    const next = { ...preferences }
    if ('language' in partial) {
      const language = partial.language
      if (language !== null && !SUPPORTED_LANGUAGES.includes(language)) throw new Error('That language is not available in this build.')
      next.language = language
    }
    if ('theme' in partial) {
      if (!THEMES.includes(partial.theme)) throw new Error('Theme must be dark, light or system.')
      next.theme = partial.theme
    }
    if ('reduceMotion' in partial) {
      if (typeof partial.reduceMotion !== 'boolean') throw new Error('reduceMotion must be a boolean.')
      next.reduceMotion = partial.reduceMotion
    }
    if ('agentReplyLanguage' in partial) {
      const mode = partial.agentReplyLanguage
      if (mode !== 'ui' && mode !== 'input' && !SUPPORTED_LANGUAGES.includes(mode)) throw new Error('agentReplyLanguage must be "ui", "input" or a supported language code.')
      next.agentReplyLanguage = mode
    }
    preferences = next
    await writeJson(settingsPath, preferences)
    await writeLog('info', 'settings-updated', { keys: Object.keys(partial).join(',') })
    return {
      language: preferences.language ?? null,
      theme: preferences.theme,
      reduceMotion: Boolean(preferences.reduceMotion),
      agentReplyLanguage: preferences.agentReplyLanguage
    }
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
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    void writeLog('error', 'renderer-gone', { reason: String(details?.reason || 'unknown').slice(0, 80) })
    // The window destroyed itself; recreate it so the tray keeps working.
    mainWindow = null
    setTimeout(() => { if (!isQuitting) void createMainWindow().catch(() => {}) }, 1_000)
  })
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
  if (!mainWindow || mainWindow.isDestroyed()) {
    // A destroyed window (renderer crash) no longer leaves a dead tray item:
    // the window is recreated against the running background service.
    void createMainWindow().catch((error) => void writeLog('error', 'window-recreate-failed', {}))
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

async function syncHostingPauseState() {
  if (!apiOrigin) return { synced: false, paused: hostingPaused }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${apiOrigin}/api/hosting/overview`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: controller.signal
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || typeof body?.scheduler?.paused !== 'boolean') return { synced: false, paused: hostingPaused }
    hostingPaused = body.scheduler.paused
    rebuildTrayMenu()
    return { synced: true, paused: hostingPaused }
  } catch {
    return { synced: false, paused: hostingPaused }
  } finally { clearTimeout(timeout) }
}

async function setHostingPaused(paused) {
  if (!apiOrigin) return { paused: hostingPaused }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${apiOrigin}/api/hosting/pause`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ paused: Boolean(paused) }),
      signal: controller.signal
    })
    if (response.ok) hostingPaused = Boolean(paused)
    rebuildTrayMenu()
    await writeLog('info', 'hosting-pause-toggled', { paused: hostingPaused })
    return { paused: hostingPaused }
  } catch (error) {
    await writeLog('error', 'hosting-pause-failed', {})
    return { paused: hostingPaused }
  } finally { clearTimeout(timeout) }
}

function rebuildTrayMenu() {
  if (!tray) return
  const strings = TRAY_STRINGS[trayLanguage(preferences)] || TRAY_STRINGS['en-US']
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: strings.open, click: showWindow },
    { type: 'separator' },
    { label: hostingPaused ? strings.resume : strings.pause, click: () => void setHostingPaused(!hostingPaused) },
    { type: 'separator' },
    { label: strings.exit, click: () => app.quit() }
  ]))
  tray.setToolTip(hostingPaused ? `${strings.tooltip} (${strings.resume})` : strings.tooltip)
}

function createTray() {
  const iconPath = path.join(here, 'assets', 'app.ico')
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) throw new Error('The NEXUS tray icon could not be loaded.')
  tray = new Tray(icon)
  const strings = TRAY_STRINGS[trayLanguage(preferences)] || TRAY_STRINGS['en-US']
  tray.setToolTip(strings.tooltip)
  rebuildTrayMenu()
  tray.on('double-click', showWindow)
}

// PART 2.2: unexpected exceptions must not silently kill the workstation
// (the background service dies with the Electron process). Log and continue.
process.on('uncaughtException', (error) => { void writeLog('error', 'uncaught-exception', { message: String(error?.message || '').slice(0, 300) }) })
process.on('unhandledRejection', (reason) => { void writeLog('error', 'unhandled-rejection', { message: String(reason?.message || reason || '').slice(0, 300) }) })

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
  // The product renders its own localized chrome; the default English
  // Electron menu (and its Alt accelerator) would break that illusion.
  Menu.setApplicationMenu(null)
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.mkdir(logsPath, { recursive: true })
  await fs.mkdir(cachePath, { recursive: true })
  const stored = await readJson(settingsPath, {})
  preferences = {
    autoStart: typeof stored.autoStart === 'boolean' ? stored.autoStart : false,
    language: SUPPORTED_LANGUAGES.includes(stored.language) ? stored.language : null,
    theme: THEMES.includes(stored.theme) ? stored.theme : 'dark',
    reduceMotion: typeof stored.reduceMotion === 'boolean' ? stored.reduceMotion : false,
    agentReplyLanguage: (stored.agentReplyLanguage === 'ui' || stored.agentReplyLanguage === 'input' || SUPPORTED_LANGUAGES.includes(stored.agentReplyLanguage)) ? stored.agentReplyLanguage : 'ui'
  }
  if (preferences.autoStart) app.setLoginItemSettings({ openAtLogin: true, path: app.getPath('exe'), args: ['--hidden'] })
  await writeLog('info', 'application-starting', { version: app.getVersion(), platform: process.platform, arch: process.arch })

  try {
    const port = await startApiProcess()
    traceSmoke('local-service-ready')
    apiOrigin = `http://127.0.0.1:${port}`
    void syncStoredProviderKeys()
    void syncHostingPauseState()
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
