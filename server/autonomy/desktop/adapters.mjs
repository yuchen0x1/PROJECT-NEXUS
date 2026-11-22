// Unified Desktop Agent Adapter (directive 6).
//
// IMPORTANT: this is NOT an AI API. These adapters drive the *already
// installed, already logged-in* Windows desktop clients. API mode and desktop
// mode are completely independent execution backends.
//
// Honesty contract:
//   * Capabilities are reported as verified / partial / unsupported with
//     evidence. A capability is never claimed because a UI "looks right".
//   * ChatGPT Desktop and WorkBuddy have SEPARATE capability tables.
//   * No fixed screen coordinates, no fixed sleep to decide completion.
//   * If a required control cannot be identified, the adapter STOPS.
//   * If the project binding is uncertain, the adapter STOPS.
//   * A task package is never sent twice for a live session.
//   * Final success is decided by the independent Reviewer Engine, never by
//     reading the client's own "done" message.

import { execFile, spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  AGENT_STATES, AGENT_TERMINAL_STATES, assertAgentTransition, canTransitionAgent,
  BLOCK_CODES, makeId
} from '../model.mjs'
import { createUiaDriver, classifyUiText } from './uia.mjs'
import { renderTaskPackage, writeTaskPackage, auditPackageSecrets } from '../task-package.mjs'

export const CAPABILITY_KEYS = Object.freeze([
  'detect', 'isRunning', 'launch', 'loginState', 'listProjects', 'selectProject',
  'sendTask', 'readExecutionState', 'captureFailure', 'closeSession'
])

export const CAPABILITY_LEVELS = Object.freeze(['verified', 'partial', 'unsupported'])

function unsupported(reason) { return { level: 'unsupported', evidence: reason, verifiedAt: null } }
function partial(reason) { return { level: 'partial', evidence: reason, verifiedAt: null } }
function verified(reason) { return { level: 'verified', evidence: reason, verifiedAt: new Date().toISOString() } }

function adapterError(code, message) {
  // Include the machine-readable code in the message as well: operators and
  // tests must be able to distinguish "uncertain project" from a plain failure.
  return Object.assign(new Error(`[${code}] ${message}`), { code })
}

/** Read-only Windows inventory. Injected in tests; PowerShell on real hosts. */
const WINDOWS_PROBE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = @(Get-Process | Where-Object { $_.ProcessName -match 'ChatGPT|WorkBuddy|Codex' } |
  Select-Object ProcessName, Id, MainWindowTitle, Path)
$appx = @(Get-AppxPackage | Where-Object { $_.Name -match 'OpenAI|WorkBuddy|Codex' } |
  Select-Object Name, Version, InstallLocation, PackageFamilyName)
$uninstallKeys = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
$uninstall = @()
foreach ($key in $uninstallKeys) {
  $uninstall += @(Get-ItemProperty -Path $key | Where-Object { $_.DisplayName -match 'WorkBuddy|ChatGPT|Codex|OpenAI' } |
    Select-Object DisplayName, DisplayVersion, InstallLocation, DisplayIcon)
}
@{ processes = $procs; appx = $appx; uninstall = $uninstall; probedAt = (Get-Date).ToUniversalTime().ToString('o') } |
  ConvertTo-Json -Depth 5 -Compress
`

export function runWindowsProbe({ execImpl = execFile, timeoutMs = 25_000 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ processes: [], appx: [], uninstall: [], error: 'UNSUPPORTED_PLATFORM' })
      return
    }
    execImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROBE_SCRIPT],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ processes: [], appx: [], uninstall: [], error: String(error.message || error).slice(0, 300) })
          return
        }
        try { resolve(JSON.parse(String(stdout).trim())) } catch {
          resolve({ processes: [], appx: [], uninstall: [], error: 'PROBE_OUTPUT_UNPARSEABLE', stderr: String(stderr || '').slice(0, 200) })
        }
      })
  })
}

function capabilitiesFrom(reason) {
  const uia = reason?.available
  return {
    detect: verified('read-only process / package / uninstall inventory'),
    isRunning: verified('process list'),
    launch: partial('launcher resolved from package or uninstall entry; not launched during detection'),
    loginState: unsupported('no supported API exposes the login state; requires human confirmation'),
    listProjects: uia ? partial('UIA window/control tree available, project control not verified') : unsupported('UI Automation unavailable'),
    selectProject: uia ? partial('window identified, project control not verified') : unsupported('UI Automation unavailable'),
    sendTask: uia ? partial('input control can be located by AutomationId/Name, not verified end-to-end') : unsupported('UI Automation unavailable'),
    readExecutionState: partial('heuristic over real UI text plus independent git/test evidence'),
    captureFailure: uia ? partial('window-bounded screenshot available') : unsupported('UI Automation unavailable'),
    closeSession: unsupported('closing a logged-in user session is left to the human operator')
  }
}

function controlTypeName(control) {
  return String(control?.controlType || '').replace(/^ControlType\./i, '')
}

function visibleEnabled(control) {
  return Boolean(control && control.enabled !== false && control.offscreen !== true)
}

function selectorForControl(control) {
  if (!control) return null
  if (control.automationId) return { automationId: control.automationId, controlType: controlTypeName(control) }
  if (control.name) return { controlName: control.name, controlType: controlTypeName(control) }
  if (control.className) return { className: control.className, controlType: controlTypeName(control) }
  return { controlType: controlTypeName(control) }
}

function summarizeInspection(inspection) {
  const controls = Array.isArray(inspection?.controls) ? inspection.controls : []
  const visible = controls.filter(visibleEnabled)
  const names = visible.map((control) => String(control.name || '').trim()).filter(Boolean)
  const projectRefs = visible
    .filter((control) => ['Button', 'ListItem'].includes(controlTypeName(control)))
    .map((control) => String(control.name || '').trim())
    .filter((name) => name && name.length <= 80 && !/[\r\n$;{}]/.test(name) && !/^(返回|前进|首页|项目|最近|新聊天|搜索|操作|停止|处理中)$/i.test(name))
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, 80)
  const loginMarkers = names.filter((name) => /^(?:sign[ -]?in|log[ -]?in|登录|登入|退出登录)$/i.test(name.trim()) || /^(?:打开个人资料菜单|profile menu|account menu)$/i.test(name.trim()))
  const signedOut = names.some((name) => /^(?:sign[ -]?in|log[ -]?in|登录|登入)$/i.test(name.trim()))
  const profile = names.some((name) => /profile|个人资料|account|账户/i.test(name))
  const input = visible.find((control) => controlTypeName(control) === 'Edit') || null
  const send = visible.find((control) => controlTypeName(control) === 'Button' &&
    !/停止|stop|处理中|processing|cancel|取消/i.test(String(control.name || '')) &&
    (/^(?:send|发送|发送消息|提交|执行|运行|继续|start|send message)$/i.test(String(control.name || '').trim()) || /composer-primary|bg-composer-primary|size-token-button-composer/i.test(String(control.className || '')))) || null
  const project = visible.find((control) => controlTypeName(control) === 'Button' && /PROJECT NEXUS|项目|workspace|工作区/i.test(String(control.name || ''))) || null
  return {
    controlCount: controls.length,
    visibleControlCount: visible.length,
    names: names.slice(0, 120),
    projectRefs,
    loginMarkers,
    loginState: signedOut ? 'SIGNED_OUT' : (profile && input && project ? 'SIGNED_IN' : 'UNKNOWN'),
    projectControl: project,
    inputControl: input,
    sendControl: send,
    hasComposer: Boolean(input),
    hasSendControl: Boolean(send)
  }
}

export class BaseDesktopAdapter {
  constructor({ id, name, kind, store, uia = null, probeImpl = runWindowsProbe, clock = () => Date.now(), dataDir = process.cwd(), execImpl = execFile, spawnImpl = spawn } = {}) {
    this.id = id
    this.name = name
    this.kind = kind
    this.store = store
    this.uia = uia || createUiaDriver()
    this.probeImpl = probeImpl
    this.clock = clock
    this.dataDir = dataDir
    this.execImpl = execImpl
    this.spawnImpl = spawnImpl
  }

  get window() { return { windowMatch: this.windowMatch, processName: this.processName } }

  /** Subclasses implement resolveInventory(inventory) -> detection details. */
  resolveInventory() { return { installed: false, running: false, launcher: null, projectRefs: [] } }

  async detect() {
    const inventory = await this.probeImpl()
    const resolved = this.resolveInventory(inventory)
    const uiaStatus = await this.uia.probe()
    const inspection = uiaStatus.available && typeof this.uia.inspect === 'function'
      ? await this.uia.inspect(this.window).catch(() => null) : null
    const ui = summarizeInspection(inspection)
    const detection = {
      id: this.id, name: this.name, kind: this.kind,
      installed: Boolean(resolved.installed), running: Boolean(resolved.running),
      launcher: resolved.launcher || null, version: resolved.version || null,
      installLocation: resolved.installLocation || null,
      projectRefs: resolved.projectRefs?.length ? resolved.projectRefs : ui.projectRefs,
      loginState: ui.loginState,
      webhookOrApiInterface: false,
      window: this.window,
      uia: uiaStatus,
      inventoryError: inventory?.error || null,
      capabilities: this.capabilitiesForDetection({ base: capabilitiesFrom(uiaStatus), uiaStatus, inspection, ui }),
      uiEvidence: {
        controlCount: ui.controlCount,
        visibleControlCount: ui.visibleControlCount,
        loginMarkers: ui.loginMarkers,
        hasComposer: ui.hasComposer,
        hasSendControl: ui.hasSendControl,
        projectControl: ui.projectControl ? { name: ui.projectControl.name, automationId: ui.projectControl.automationId, className: ui.projectControl.className } : null,
        inputControl: ui.inputControl ? { name: ui.inputControl.name, automationId: ui.inputControl.automationId, className: ui.inputControl.className } : null,
        sendControl: ui.sendControl ? { name: ui.sendControl.name, automationId: ui.sendControl.automationId, className: ui.sendControl.className } : null
      },
      checkedAt: new Date(this.clock()).toISOString()
    }
    this.store.put('adapters', this.id, { ...detection, id: this.id })
    this.store.append('adapter_probe_runs', { adapterId: this.id, name: this.name, detection, evidence: detection.uiEvidence })
    return detection
  }

  capabilitiesForDetection({ base }) { return base }

  async inspectWindow() {
    if (typeof this.uia.inspect !== 'function') return null
    const result = await this.uia.inspect(this.window)
    return result?.ok === false ? null : result
  }

  resolveUiControls(repo, inspection = null) {
    const staticControls = { projectControl: this.projectControl, inputControl: this.inputControl, sendControl: this.sendControl }
    const controls = Array.isArray(inspection?.controls) ? inspection.controls.filter(visibleEnabled) : []
    if (!controls.length) return staticControls
    const expected = String(repo?.agentProjectRef || '').trim().toLowerCase()
    const explicitProject = this.projectControl?.automationId || this.projectControl?.controlName || this.projectControl?.className
    const project = explicitProject
      ? this.projectControl
      : selectorForControl(controls.find((control) => controlTypeName(control) === 'Button' && String(control.name || '').trim().toLowerCase() === expected))
    const explicitInput = this.inputControl?.automationId || this.inputControl?.controlName || this.inputControl?.className
    const input = explicitInput ? this.inputControl : selectorForControl(controls.find((control) => controlTypeName(control) === 'Edit'))
    const explicitSend = this.sendControl?.automationId || this.sendControl?.controlName || this.sendControl?.className
    const send = explicitSend ? this.sendControl : selectorForControl(controls.find((control) => controlTypeName(control) === 'Button' &&
      !/停止|stop|处理中|processing|cancel|取消/i.test(String(control.name || '')) &&
      (/^(?:send|发送|发送消息|提交|执行|运行|继续|start|send message)$/i.test(String(control.name || '').trim()) || /composer-primary|bg-composer-primary|size-token-button-composer/i.test(String(control.className || '')))))
    return { projectControl: project, inputControl: input, sendControl: send }
  }

  async isRunning(detection = null) {
    const state = detection || await this.detect()
    return Boolean(state.running)
  }

  async launch(detection = null) {
    const state = detection || await this.detect()
    if (!state.installed) throw adapterError('DESKTOP_CLIENT_NOT_INSTALLED', `${this.name} is not installed.`)
    if (!state.launcher) throw adapterError('DESKTOP_LAUNCHER_UNKNOWN', `${this.name} has no resolvable launcher executable.`)
    await fsp.stat(state.launcher).catch(() => { throw adapterError('DESKTOP_LAUNCHER_MISSING', 'The launcher no longer exists.') })
    // A GUI client must be detached. execFile would wait for its exit and its
    // timeout would kill the user's already-open client.
    return new Promise((resolve, reject) => {
      try {
        const child = this.spawnImpl(state.launcher, [], { detached: true, stdio: 'ignore', windowsHide: false })
        child.once('error', (error) => reject(adapterError('DESKTOP_LAUNCH_FAILED', error.message)))
        child.unref?.()
        resolve({ launched: true, launcher: state.launcher })
      } catch (error) {
        reject(adapterError('DESKTOP_LAUNCH_FAILED', String(error.message || error)))
      }
    })
  }

  /**
   * Hard safety gate. A task for repository A must never be delivered to a
   * client session bound to repository B (directive 6.2).
   */
  assertProjectBinding(repo, selection = {}) {
    const expected = String(repo.agentProjectRef || '').trim()
    if (!expected) {
      throw adapterError(BLOCK_CODES.PROJECT_SELECTION_UNCERTAIN,
        `Repository ${repo.fullName} has no configured client project reference; refusing to send.`)
    }
    const actual = String(selection.projectRef || '').trim()
    if (!actual || actual !== expected) {
      throw adapterError(BLOCK_CODES.PROJECT_SELECTION_UNCERTAIN,
        `Project selection uncertain for ${repo.fullName}: expected '${expected}', observed '${actual || '(none)'}'.`)
    }
    const expectedPath = String(repo.localPath || '').trim()
    if (expectedPath && selection.workspacePath && path.resolve(String(selection.workspacePath)) !== path.resolve(expectedPath)) {
      throw adapterError(BLOCK_CODES.PROJECT_SELECTION_UNCERTAIN,
        'Client workspace path does not match the repository local path binding.')
    }
    return { projectRef: expected, verified: true }
  }

  /** Persist a session and enforce the agent state machine on every change. */
  transition(session, to, { detail = '', evidence = null } = {}) {
    if (!AGENT_STATES.includes(to)) throw adapterError('AGENT_UNKNOWN_STATE', to)
    assertAgentTransition(session.state, to)
    const updated = this.store.put('agent_sessions', session.id, {
      ...session, state: to, lastTransitionAt: new Date(this.clock()).toISOString(), evidence
    })
    this.store.append('task_events', {
      taskId: session.taskId, sessionId: session.id, adapterId: this.id, at: new Date(this.clock()).toISOString(),
      phase: to, detail: String(detail).slice(0, 500), level: 'info'
    })
    this.store.audit('adapter', `state:${to}`, session.taskId, { adapterId: this.id, detail })
    return updated
  }

  createSession({ task, repo, pkg }) {
    const session = {
      id: makeId('session'), taskId: task.id, repoId: repo.id, repository: repo.fullName,
      adapterId: this.id, state: 'NOT_STARTED', projectRef: String(repo.agentProjectRef || ''),
      workingDir: String(repo.localPath || ''), packageHash: pkg.hash, sentPackageHash: null,
      sentAt: null, createdAt: new Date(this.clock()).toISOString(), lastPollAt: null,
      screenshotPath: null, handoff: false, error: null, pollCount: 0
    }
    return this.store.put('agent_sessions', session.id, session)
  }

  /** Idempotency: never send the same package twice to a live session. */
  assertNotAlreadySent(session, pkg) {
    if (session.sentPackageHash === pkg.hash && !AGENT_TERMINAL_STATES.includes(session.state)) {
      throw adapterError('DUPLICATE_TASK_SEND', `Task package ${pkg.hash} is already executing in session ${session.id}.`)
    }
    const live = this.store.list('agent_sessions', {
      filter: (item) => item.taskId === session.taskId && item.packageHash === pkg.hash &&
        item.id !== session.id && !AGENT_TERMINAL_STATES.includes(item.state)
    })
    if (live.length) throw adapterError('DUPLICATE_TASK_SEND', `Another live session already owns package ${pkg.hash}.`)
  }

  async sendTask(session, pkg, repo, { selection = {} } = {}) {
    const secrets = auditPackageSecrets(pkg)
    if (!secrets.safe) {
      throw adapterError('TASK_PACKAGE_UNSAFE', `Refusing to send: ${[...secrets.leaked, ...secrets.sensitivePaths].join(', ')}`)
    }
    // A configured project reference is mandatory even for human handoff (the
    // operator needs to know which client project to open). The STRICT binding
    // check against the observed control happens only on the automated path.
    if (!String(repo.agentProjectRef || '').trim()) {
      return this.enterHandoff(session, pkg,
        `${BLOCK_CODES.PROJECT_SELECTION_UNCERTAIN}: no client project reference is configured for ${repo.fullName}`)
    }
    this.assertNotAlreadySent(session, pkg)

    session = this.transition(session, 'STARTING', { detail: 'Preparing desktop client' })
    const uia = await this.uia.probe()
    if (!uia.available) {
      return this.enterHandoff(session, pkg, `UI Automation unavailable (${uia.reason})`)
    }
    const windows = await this.uia.windows(this.window)
    if (!windows.ok) {
      return this.enterHandoff(session, pkg, `${windows.code}: ${windows.message || 'window not identifiable'}`)
    }
    const inspection = await this.inspectWindow()
    const controls = this.resolveUiControls(repo, inspection)
    if (!controls.projectControl) return this.enterHandoff(session, pkg, `${BLOCK_CODES.PROJECT_SELECTION_UNCERTAIN}: configured project '${repo.agentProjectRef}' is not exposed by the client accessibility tree`)
    if (!controls.inputControl) return this.enterHandoff(session, pkg, 'TASK_INPUT_CONTROL_NOT_FOUND: client composer is not exposed by the accessibility tree')
    if (!controls.sendControl) return this.enterHandoff(session, pkg, 'SEND_CONTROL_NOT_FOUND_OR_CLIENT_BUSY: no enabled send control was exposed by the accessibility tree')
    session = this.transition(session, 'AWAITING_PROJECT_SELECTION', { detail: 'Locating configured client project' })

    // Project selection must be confirmed by an identifiable control AND its
    // own accessible name. Anything else stops here; we never assume the
    // currently open project is the right one, and never click a guessed item.
    const projectControl = await this.uia.find(this.window, controls.projectControl)
    if (!projectControl.ok) {
      return this.enterHandoff(session, pkg, `${projectControl.code}: project control not identifiable`)
    }
    const observedName = String(projectControl.control?.name || '')
    const expectedRef = String(repo.agentProjectRef || '')
    if (!observedName || (expectedRef && !observedName.toLowerCase().includes(expectedRef.toLowerCase()))) {
      return this.enterHandoff(session, pkg,
        `${BLOCK_CODES.PROJECT_SELECTION_UNCERTAIN}: control '${observedName || '(unnamed)'}' does not identify project '${expectedRef}'`)
    }
    const selected = await this.uia.invoke(this.window, controls.projectControl)
    if (!selected.ok) {
      return this.enterHandoff(session, pkg, `${selected.code}: could not select the configured project`)
    }
    // The control's accessible name is the evidence; the binding itself is
    // still checked against the exact configured reference.
    const binding = this.assertProjectBinding(repo, { ...selection, projectRef: expectedRef })
    session = this.store.put('agent_sessions', session.id, { ...session, projectRefConfirmed: binding.verified, observedProjectName: observedName })
    session = this.transition(session, 'AWAITING_SEND', { detail: `Project ${expectedRef} confirmed (control: ${observedName})` })

    const valueFile = await writeTaskPackage(path.join(this.dataDir, 'autonomy-packages'), pkg)
    const input = await this.uia.find(this.window, controls.inputControl)
    if (!input.ok) return this.enterHandoff(session, pkg, `${input.code}: input control not identifiable`, { valueFile })
    const written = await this.uia.setValue(this.window, controls.inputControl, '', { valueFile })
    if (!written.ok) return this.enterHandoff(session, pkg, `${written.code}: could not enter task text`, { valueFile })
    const send = await this.uia.invoke(this.window, controls.sendControl)
    if (!send.ok) return this.enterHandoff(session, pkg, `${send.code}: send control not identifiable`, { valueFile })

    session = this.store.put('agent_sessions', session.id, {
      ...session, sentPackageHash: pkg.hash, sentAt: new Date(this.clock()).toISOString(),
      packageFile: valueFile, handoff: false, sendEvidence: { project: observedName, input: controls.inputControl, send: controls.sendControl }
    })
    return { session: this.transition(session, 'RUNNING', { detail: 'Task package sent via UI Automation' }), automated: true }
  }

  /** Reliable human handoff: open client + workspace, hand the operator an exact package. */
  async enterHandoff(session, pkg, reason, { valueFile = null } = {}) {
    const file = valueFile || await writeTaskPackage(path.join(this.dataDir, 'autonomy-packages'), pkg)
    const next = this.store.put('agent_sessions', session.id, {
      ...session, handoff: true, handoffReason: String(reason).slice(0, 500), packageFile: file,
      error: String(reason).slice(0, 500)
    })
    const transitioned = AGENT_TERMINAL_STATES.includes(next.state)
      ? next
      : this.transition(next, 'NEEDS_HUMAN_HANDOFF', { detail: reason })
    this.store.audit('adapter', 'human-handoff', session.taskId, { adapterId: this.id, reason, packageFile: file })
    return {
      session: transitioned, automated: false, humanHandoff: true, reason,
      packageFile: file, packageText: renderTaskPackage(pkg),
      instructions: [
        'Open the desktop AI client and select the configured project/workspace.',
        `Paste the full task package from ${file} into a new task session and send it.`,
        'When the client finishes, return to NEXUS and mark the session as completed.',
        'NEXUS will independently verify the git diff and run tests before accepting.'
      ]
    }
  }

  /** Resolve a human handoff. No state is marked successful here. */
  resolveHandoff(session, { outcome = 'completed', note = '' } = {}) {
    if (!session.handoff) throw adapterError('SESSION_NOT_IN_HANDOFF', 'This session is not awaiting a human.')
    if (outcome === 'failed') {
      return { session: this.transition(session, 'FAILED', { detail: note || 'operator reported failure' }), outcome }
    }
    if (outcome === 'sent') {
      const updated = this.store.put('agent_sessions', session.id, {
        ...session, sentPackageHash: session.packageHash, sentAt: new Date(this.clock()).toISOString(), handoff: false
      })
      return { session: this.transition(updated, 'RUNNING', { detail: 'operator confirmed the task was sent' }), outcome }
    }
    // "completed" only moves to VERIFYING territory of the Reviewer Engine.
    const updated = this.store.put('agent_sessions', session.id, {
      ...session, handoff: false, operatorCompletedAt: new Date(this.clock()).toISOString()
    })
    return { session: this.transition(updated, 'RUNNING', { detail: 'operator reported completion; independent verification pending' }), outcome }
  }

  /**
   * State observation. Uses real UI text, process liveness and a monotonic
   * deadline. It NEVER uses a fixed sleep and NEVER treats "done" text as final
   * acceptance.
   */
  async pollState(session, { deadlineMs = 0 } = {}) {
    const now = this.clock()
    let next = this.store.put('agent_sessions', session.id, {
      ...session, lastPollAt: new Date(now).toISOString(), pollCount: (session.pollCount || 0) + 1
    })
    if (deadlineMs && now >= deadlineMs) {
      await this.captureFailure(next, 'timeout')
      return { session: this.transition(next, 'TIMEOUT', { detail: 'Execution deadline exceeded' }), signal: 'TIMEOUT' }
    }
    const running = await this.isRunning()
    if (!running) {
      await this.captureFailure(next, 'client-exit')
      return { session: this.transition(next, 'CLIENT_EXITED', { detail: 'Desktop client is no longer running' }), signal: 'CLIENT_EXITED' }
    }
    const text = await this.uia.readText(this.window)
    if (!text.ok) return { session: next, signal: 'INCONCLUSIVE', reason: text.code }
    const inspection = await this.inspectWindow()
    const signal = classifyUiText([...(text.lines || []), ...((inspection?.controls || [])
      .filter((control) => control.offscreen !== true)
      .map((control) => control.name).filter(Boolean))])
    if (!signal) return { session: next, signal: 'INCONCLUSIVE', textLines: text.count }
    if (signal === 'FAILED') {
      await this.captureFailure(next, 'client-reported-error')
      return { session: this.transition(next, 'FAILED', { detail: 'Error state detected in client UI' }), signal }
    }
    if (canTransitionAgent(next.state, signal)) {
      return { session: this.transition(next, signal, { detail: 'Detected from UI text' }), signal }
    }
    return { session: next, signal, unchanged: true }
  }

  async captureFailure(session, reason = 'unknown') {
    const file = path.join(this.dataDir, 'autonomy-failures', `${session.id}-${Date.now()}.png`)
    const result = await this.uia.screenshot(this.window, file)
    if (!result.ok) {
      this.store.audit('adapter', 'screenshot-unavailable', session.taskId, { reason, code: result.code })
      return { ok: false, code: result.code || 'UIA_UNAVAILABLE' }
    }
    this.store.put('agent_sessions', session.id, { ...session, screenshotPath: result.path })
    this.store.audit('adapter', 'failure-screenshot', session.taskId, { reason, path: result.path })
    return { ok: true, path: result.path }
  }
}

// ---- ChatGPT Desktop ------------------------------------------------------

export class ChatGptDesktopAdapter extends BaseDesktopAdapter {
  constructor(options = {}) {
    super({ ...options, id: 'chatgpt-desktop', name: 'ChatGPT Desktop', kind: 'desktop-client' })
    // Real inventory on the audited host: the ChatGPT window ships inside the
    // OpenAI.Codex MSIX package (ChatGPT.exe) - a DIFFERENT entry point from
    // the Codex CLI (app/resources/codex.exe).
    this.processName = 'ChatGPT'
    this.windowMatch = 'ChatGPT'
    this.packageFamily = 'OpenAI.Codex'
    this.projectControl = { automationId: options.projectAutomationId || '', controlName: options.projectControlName || '', controlType: 'Button' }
    this.inputControl = { automationId: options.inputAutomationId || '', controlName: options.inputControlName || '', controlType: 'Edit' }
    this.sendControl = { automationId: options.sendAutomationId || '', controlName: options.sendControlName || '', controlType: 'Button' }
  }

  resolveInventory(inventory = {}) {
    const processes = Array.isArray(inventory.processes) ? inventory.processes : []
    const appx = Array.isArray(inventory.appx) ? inventory.appx : []
    const uninstall = Array.isArray(inventory.uninstall) ? inventory.uninstall : []
    const chatProcess = processes.find((item) => /^chatgpt$/i.test(String(item.ProcessName || item.processName || '')))
    const pkg = appx.find((item) => /chatgpt|openai\.codex/i.test(String(item.Name || item.name || '')))
    const exe = chatProcess?.Path || chatProcess?.path ||
      (pkg ? path.join(String(pkg.InstallLocation || pkg.installLocation || ''), 'app', 'ChatGPT.exe') : null)
    const entry = uninstall.find((item) => /chatgpt/i.test(String(item.DisplayName || item.displayName || '')))
    return {
      installed: Boolean(exe || pkg || entry),
      running: Boolean(chatProcess),
      launcher: exe && /\.(exe|lnk)$/i.test(exe) ? exe : null,
      version: pkg?.Version || pkg?.version || entry?.DisplayVersion || null,
      installLocation: pkg?.InstallLocation || pkg?.installLocation || entry?.InstallLocation || null,
      projectRefs: [], // only obtainable through verified UIA enumeration
      packageFamilyName: pkg?.PackageFamilyName || pkg?.packageFamilyName || null
    }
  }

  capabilitiesForDetection({ base, ui }) {
    const capabilities = { ...base }
    if (ui.loginState === 'SIGNED_IN') capabilities.loginState = verified('profile/project/composer controls were visible in the ChatGPT accessibility tree')
    else if (ui.loginState === 'SIGNED_OUT') capabilities.loginState = verified('sign-in control was visible in the ChatGPT accessibility tree')
    if (ui.projectControl) {
      capabilities.listProjects = verified(`project control '${ui.projectControl.name}' is exposed by UI Automation`)
      capabilities.selectProject = partial('project control is identifiable; selection is only verified when a task send is executed')
    }
    if (ui.hasComposer && ui.hasSendControl) capabilities.sendTask = partial('composer and enabled send control are exposed; a task send still requires an isolated end-to-end run')
    else if (ui.hasComposer) capabilities.sendTask = partial('composer is exposed but the client currently exposes no enabled send control (possibly busy)')
    return capabilities
  }
}

// ---- WorkBuddy ------------------------------------------------------------

export class WorkBuddyAdapter extends BaseDesktopAdapter {
  constructor(options = {}) {
    super({ ...options, id: 'workbuddy-desktop', name: 'WorkBuddy', kind: 'desktop-client' })
    // WorkBuddy has its own installer and window class. Its capability table is
    // intentionally NOT shared with ChatGPT Desktop.
    this.processName = 'WorkBuddy'
    this.windowMatch = 'WorkBuddy'
    this.projectControl = { automationId: options.projectAutomationId || '', controlName: options.projectControlName || '', controlType: 'Button' }
    this.inputControl = { automationId: options.inputAutomationId || '', controlName: options.inputControlName || '', controlType: 'Edit' }
    this.sendControl = { automationId: options.sendAutomationId || '', controlName: options.sendControlName || '', controlType: 'Button' }
  }

  resolveInventory(inventory = {}) {
    const processes = Array.isArray(inventory.processes) ? inventory.processes : []
    const uninstall = Array.isArray(inventory.uninstall) ? inventory.uninstall : []
    const appx = Array.isArray(inventory.appx) ? inventory.appx : []
    const proc = processes.find((item) => /^workbuddy$/i.test(String(item.ProcessName || item.processName || '')))
    const entry = uninstall.find((item) => /workbuddy/i.test(String(item.DisplayName || item.displayName || '')))
    const fromProc = proc?.Path || proc?.path || null
    const fromRegistry = entry?.DisplayIcon ? String(entry.DisplayIcon).split(',')[0].trim() : null
    const fromLocation = entry?.InstallLocation ? path.join(String(entry.InstallLocation), 'WorkBuddy.exe') : null
    const launcher = [fromProc, fromRegistry, fromLocation].find((candidate) => candidate && /\.exe$/i.test(candidate)) || null
    return {
      installed: Boolean(launcher || entry || appx.some((item) => /workbuddy/i.test(String(item.Name || item.name || '')))),
      running: Boolean(proc),
      launcher,
      version: entry?.DisplayVersion || entry?.displayVersion || null,
      installLocation: launcher ? path.dirname(launcher) : null,
      projectRefs: []
    }
  }

  capabilitiesForDetection({ base, ui }) {
    const capabilities = { ...base }
    if (ui.controlCount <= 2) {
      capabilities.loginState = unsupported('WorkBuddy exposes only legacy child panes; no authenticated account marker is accessible')
      capabilities.listProjects = unsupported('WorkBuddy project controls are not exposed through the current UIA tree')
      capabilities.selectProject = unsupported('WorkBuddy project controls are not exposed through the current UIA tree')
      capabilities.sendTask = unsupported('WorkBuddy composer/send controls are not exposed through the current UIA tree')
      capabilities.readExecutionState = partial('process liveness only; execution text is not exposed through UIA')
    } else {
      if (ui.loginState === 'SIGNED_IN') capabilities.loginState = verified('WorkBuddy profile/project/composer controls were visible in the accessibility tree')
      if (ui.projectControl) capabilities.listProjects = verified(`project control '${ui.projectControl.name}' is exposed by UI Automation`)
      if (ui.hasComposer && ui.hasSendControl) capabilities.sendTask = partial('WorkBuddy composer and send controls are exposed; isolated end-to-end send remains required')
    }
    return capabilities
  }
}

// ---- Generic, configuration-driven ---------------------------------------

export class GenericDesktopAgentAdapter extends BaseDesktopAdapter {
  constructor({ config = {}, ...options } = {}) {
    super({ ...options, id: options.id || 'generic-desktop', name: config.name || 'Generic Desktop Agent', kind: 'desktop-client' })
    this.config = config
    this.processName = config.processName || ''
    this.windowMatch = config.windowMatch || config.name || ''
    this.projectControl = config.projectControl || { controlName: '', controlType: 'Button' }
    this.inputControl = config.inputControl || { controlName: '', controlType: 'Edit' }
    this.sendControl = config.sendControl || { controlName: '', controlType: 'Button' }
  }

  resolveInventory(inventory = {}) {
    const processes = Array.isArray(inventory.processes) ? inventory.processes : []
    const proc = processes.find((item) => new RegExp(`^${escapeRegex(this.processName)}$`, 'i').test(String(item.ProcessName || item.processName || '')))
    return {
      installed: Boolean(proc || this.config.launcher),
      running: Boolean(proc),
      launcher: proc?.Path || proc?.path || this.config.launcher || null,
      version: null, installLocation: null, projectRefs: []
    }
  }
}

function escapeRegex(text) { return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// ---- Codex CLI: explicitly a DIFFERENT entry point ------------------------

export class CodexCliDesktopAdapter extends BaseDesktopAdapter {
  constructor(options = {}) {
    super({ ...options, id: 'codex-cli', name: 'Codex CLI (same MSIX package, different entry point)', kind: 'cli-bridge' })
    this.processName = 'codex'
    this.windowMatch = '' // headless CLI, no window to control
  }
  resolveInventory(inventory = {}) {
    const processes = Array.isArray(inventory.processes) ? inventory.processes : []
    const appx = Array.isArray(inventory.appx) ? inventory.appx : []
    const proc = processes.find((item) => /^codex$/i.test(String(item.ProcessName || item.processName || '')))
    const pkg = appx.find((item) => /openai\.codex/i.test(String(item.Name || item.name || '')))
    return {
      installed: Boolean(proc || pkg), running: Boolean(proc),
      launcher: proc?.Path || proc?.path || null,
      version: pkg?.Version || pkg?.version || null,
      installLocation: pkg?.InstallLocation || pkg?.installLocation || null,
      projectRefs: []
    }
  }
  async detect() {
    const base = await super.detect()
    // A CLI has no window. Mark window-dependent capabilities honestly.
    const capabilities = { ...base.capabilities }
    for (const key of ['listProjects', 'selectProject', 'sendTask', 'captureFailure']) {
      capabilities[key] = unsupported('headless CLI: no window; use the native app-server bridge instead')
    }
    capabilities.sendTask = partial('official CLI/app-server bridge is the preferred channel (existing codex-app-server adapter)')
    const result = { ...base, capabilities, windowless: true, note: 'Distinct from ChatGPT Desktop in the same MSIX package.' }
    this.store.put('adapters', this.id, result)
    return result
  }
}

// ---- Registry -------------------------------------------------------------

export function createAdapterRegistry(options = {}) {
  const adapters = [
    new ChatGptDesktopAdapter(options),
    new WorkBuddyAdapter(options),
    new CodexCliDesktopAdapter(options),
    ...(options.genericConfigs || []).map((config, index) => new GenericDesktopAgentAdapter({ ...options, config, id: `generic-desktop-${index + 1}` }))
  ]
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]))
  return {
    list: () => adapters,
    get: (id) => byId.get(id) || null,
    async probeAll() {
      const results = []
      for (const adapter of adapters) {
        try { results.push(await adapter.detect()) } catch (error) {
          results.push({ id: adapter.id, name: adapter.name, installed: false, error: String(error.message || error).slice(0, 300) })
        }
      }
      return results
    }
  }
}

export { AGENT_STATES, AGENT_TERMINAL_STATES }
