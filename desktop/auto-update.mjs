// GitHub can supply HTML or a versioned note list. Send bounded plain text over
// the bridge; the renderer never inserts release content as HTML.
function releaseDetails(info) {
  const raw = Array.isArray(info.releaseNotes) ? info.releaseNotes.find((entry) => entry?.version === info.version)?.note : info.releaseNotes
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  const releaseNotes = typeof raw !== 'string' ? '' : raw.slice(0, 32_768)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:p|div|h[1-6]|li|ul|ol|br)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_match, name) => entities[name])
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 16_384)
  const date = typeof info.releaseDate === 'string' ? Date.parse(info.releaseDate) : NaN
  return { releaseNotes, releaseDate: Number.isFinite(date) ? new Date(date).toISOString() : null }
}

// The renderer can request a check or an update, never supply a feed or installer.
export function createAppUpdater({ updater, currentVersion, enabled, onState = () => {}, prepareInstall = async () => {}, recoverInstall = async () => {}, log = () => {} }) {
  let state = { revision: 0, phase: enabled ? 'idle' : 'disabled', currentVersion, version: null, percent: 0, errorCode: null, retry: 'check', releaseNotes: '', releaseDate: null }
  let checking = null
  let updating = null
  let downloaded = false
  let recovery = null
  let startupTimer
  let interval
  const listeners = []
  const snapshot = () => ({ ...state })
  const publish = (patch) => {
    state = { ...state, ...patch, revision: state.revision + 1 }
    onState(snapshot())
  }
  const fail = async () => {
    if (recovery || state.phase === 'error') return recovery
    const installing = state.phase === 'installing'
    const retry = downloaded || ['downloading', 'available', 'downloaded'].includes(state.phase) ? 'update' : 'check'
    const errorCode = installing ? 'install' : state.phase === 'downloading' ? 'download' : 'check'
    log('error', 'app-update-failed', { stage: errorCode })
    if (installing) {
      recovery = Promise.resolve().then(recoverInstall)
      try { await recovery } catch { /* The desktop recovery reports service errors itself. */ }
      finally { recovery = null }
    }
    publish({ phase: 'error', errorCode, retry })
  }
  const listen = (event, callback) => { updater.on(event, callback); listeners.push([event, callback]) }

  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.autoRunAppAfterInstall = true
  updater.allowDowngrade = false
  updater.allowPrerelease = false
  updater.disableWebInstaller = true
  // Do not persist provider URLs, download paths, tokens or raw network errors.
  updater.logger = { info() {}, warn() {}, error() {}, debug() {} }
  if (enabled) updater.setFeedURL({ provider: 'github', owner: 'yuchen0x1', repo: 'PROJECT-NEXUS' })

  listen('update-available', (info) => {
    downloaded = false
    publish({ phase: 'available', version: info.version, percent: 0, errorCode: null, retry: 'update', ...releaseDetails(info) })
    log('info', 'app-update-available', { version: info.version })
  })
  listen('update-not-available', () => publish({ phase: 'up-to-date', version: null, errorCode: null, retry: 'check', releaseNotes: '', releaseDate: null }))
  listen('download-progress', (progress) => publish({ percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)) }))
  listen('update-downloaded', () => {
    downloaded = true
    publish({ phase: 'downloaded', percent: 100, errorCode: null })
  })
  listen('error', () => { void fail() })

  async function check() {
    if (!enabled || updating || recovery || ['available', 'downloaded', 'installing'].includes(state.phase)) return snapshot()
    if (checking) return checking
    publish({ phase: 'checking', errorCode: null })
    checking = Promise.resolve().then(async () => {
      try { await updater.checkForUpdates() }
      catch { await fail() }
      finally { checking = null }
      return snapshot()
    })
    return checking
  }

  function update() {
    if (!enabled || checking || updating || recovery || !['available', 'downloaded', 'error'].includes(state.phase) || state.retry !== 'update') return snapshot()
    // Start in a microtask so the operation lock is set before any event fires.
    updating = Promise.resolve().then(async () => {
      try {
        if (!downloaded) {
          publish({ phase: 'downloading', percent: 0, errorCode: null })
          await updater.downloadUpdate()
          if (state.phase === 'error') return
          if (!downloaded) throw new Error('The downloader did not verify a completed update.')
        }
        publish({ phase: 'installing', errorCode: null })
        await prepareInstall()
        log('info', 'app-update-installing', { version: state.version })
        updater.quitAndInstall(true, true)
      } catch { await fail() }
      finally { updating = null }
    })
    return snapshot()
  }

  function stopTimers() { clearTimeout(startupTimer); clearInterval(interval) }
  return {
    getStatus: snapshot, check, update, stopTimers, isRecovering: () => Boolean(recovery),
    start() {
      stopTimers()
      if (!enabled) return
      startupTimer = setTimeout(() => void check(), 15_000)
      interval = setInterval(() => void check(), 4 * 60 * 60_000)
      startupTimer.unref?.(); interval.unref?.()
    },
    dispose() { stopTimers(); for (const [event, callback] of listeners) updater.removeListener(event, callback) }
  }
}
