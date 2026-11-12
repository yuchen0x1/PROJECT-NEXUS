import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity, AlertTriangle, Bell, Bot, Boxes, Check, ChevronDown, ChevronRight, CircleDot, Code2,
  Command, Computer, FolderPlus, GitBranch, HardDrive, Languages, LayoutDashboard, Moon, PanelLeftClose,
  PanelLeftOpen, PanelRightClose, PanelRightOpen, RefreshCw, ScanSearch, Search, Settings2, ShieldCheck,
  Sun, TerminalSquare, Trash2, Wrench, X
} from 'lucide-react'
import App from '../App'
import { api, type LocalAgentTask } from '../api'
import { useSettings } from '../i18n/settings'
import { LANGUAGES } from '../i18n/languages'
import { formatCurrency, formatRelative, formatStamp, formatTime, formatTokens } from '../i18n/format'
import './workstation.css'
import type { EnvironmentReport, LocalProject, WorkstationInfo } from './types'

type Page = 'workstation' | 'projects' | 'environment' | 'agent' | 'remote' | 'settings'

type ActivityEntry = {
  id: string
  at: string
  kind: 'ok' | 'note' | 'warning'
  labelKey: string
  labelParams?: Record<string, unknown>
  detailKey?: string
  detailParams?: Record<string, unknown>
  /** Raw message from the system, a provider or a scan — rendered untranslated. */
  detailText?: string
  /** Workstation page a notification click should open. */
  page?: Page
}

type ToastEntry = { id: string; messageKey: string; params?: Record<string, unknown> }

type CommandItem = {
  id: string
  group: 'pages' | 'actions' | 'projects' | 'appearance' | 'language'
  label: string
  icon?: ReactNode
  run: () => void
}

const AGENT_ACTIVE_STATUSES = ['Queued', 'Running']
/** Statuses that end a task; Paused is deliberately absent (it resumes). */
const AGENT_TERMINAL_STATUSES = ['Succeeded', 'Failed', 'Blocked', 'Cancelled', 'Interrupted', 'TimedOut']

function statusClass(status: string) {
  return status.toLowerCase()
}

export default function Workstation() {
  const bridge = window.nexusDesktop!
  const { t } = useTranslation()
  const { preferences, resolvedTheme, setLanguage, setTheme, systemLocale } = useSettings()
  const [page, setPage] = useState<Page>('workstation')
  const [info, setInfo] = useState<WorkstationInfo | null>(null)
  const [projects, setProjects] = useState<LocalProject[]>([])
  const [environment, setEnvironment] = useState<EnvironmentReport | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'environment' | 'add' | string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showActivity, setShowActivity] = useState(true)
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [logHeight, setLogHeight] = useState(190)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const [agentConfig, setAgentConfig] = useState<Awaited<ReturnType<typeof api.localAgentConfig>> | null>(null)
  const [agentTasks, setAgentTasks] = useState<LocalAgentTask[]>([])
  const [selectedAgentTaskId, setSelectedAgentTaskId] = useState<string | null>(null)
  const [agentDetail, setAgentDetail] = useState<Awaited<ReturnType<typeof api.localAgentTask>> | null>(null)
  const [agentPrompt, setAgentPrompt] = useState('')
  const [agentProjectId, setAgentProjectId] = useState('')
  const [agentProviderId, setAgentProviderId] = useState('')
  const [agentDisclosureConfirmed, setAgentDisclosureConfirmed] = useState(false)
  const prevAgentTasks = useRef<LocalAgentTask[]>([])

  const selectedProject = projects.find((project) => project.id === selectedProjectId) || projects[0] || null
  const availableTools = environment?.tools.filter((tool) => ['AVAILABLE', 'SHIM_FOUND', 'PATH_FOUND'].includes(tool.status)).length || 0
  const scannedCount = projects.filter((project) => project.lastScan).length
  const hasActiveAgentTasks = agentTasks.some((task) => AGENT_ACTIVE_STATUSES.includes(task.status))

  // Localized window title.
  useEffect(() => { document.title = t('common:app.windowTitle') }, [t])

  const pushToast = useCallback((messageKey: string, params?: Record<string, unknown>) => {
    const id = crypto.randomUUID()
    setToasts((current) => [...current.slice(-2), { id, messageKey, params }])
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3800)
  }, [])

  const addActivity = useCallback((entry: Omit<ActivityEntry, 'id' | 'at'>) => {
    const full: ActivityEntry = { ...entry, id: crypto.randomUUID(), at: new Date().toISOString() }
    setActivity((current) => [full, ...current].slice(0, 30))
    setUnreadIds((current) => new Set(current).add(full.id))
  }, [])

  const refreshProjects = useCallback(async () => {
    const next = await bridge.listProjects()
    setProjects(next)
    setSelectedProjectId((current) => current && next.some((project) => project.id === current) ? current : next[0]?.id || null)
  }, [bridge])

  const refreshAgentTasks = useCallback(async () => {
    const result = await api.localAgentTasks()
    setAgentTasks(result.tasks)
    setSelectedAgentTaskId((current) => current && result.tasks.some((task) => task.id === current) ? current : result.tasks[0]?.id || null)
    return result.tasks
  }, [])

  const refreshEnvironment = useCallback(async () => {
    setBusy('environment')
    setError(null)
    try {
      const result = await bridge.detectEnvironment()
      setEnvironment(result)
      addActivity({
        kind: 'ok',
        labelKey: 'notifications:activity.environmentCheckFinished.label',
        detailKey: 'notifications:activity.environmentCheckFinished.detail',
        detailParams: { available: result.available || 0, total: result.total || 0 },
        page: 'environment'
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('errors:environmentCheck')
      setError(message)
      addActivity({ kind: 'warning', labelKey: 'notifications:activity.environmentCheckFailed.label', detailText: message, page: 'environment' })
    } finally { setBusy(null) }
  }, [addActivity, bridge, t])

  useEffect(() => {
    let active = true
    Promise.all([bridge.getInfo(), bridge.listProjects()]).then(([nextInfo, nextProjects]) => {
      if (!active) return
      setInfo(nextInfo)
      setProjects(nextProjects)
      setSelectedProjectId(nextProjects[0]?.id || null)
      addActivity({
        kind: 'ok',
        labelKey: 'notifications:activity.workstationReady.label',
        detailKey: 'notifications:activity.workstationReady.detail_other',
        detailParams: { count: nextProjects.length }
      })
      void refreshEnvironment()
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : t('errors:workstationData'))
    })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge])

  useEffect(() => {
    if (page !== 'agent') return
    let active = true
    Promise.all([api.localAgentConfig(), api.localAgentTasks()]).then(([config, result]) => {
      if (!active) return
      setAgentConfig(config)
      setAgentTasks(result.tasks)
      setAgentProviderId((current) => current || config.defaultProviderId || '')
      setAgentProjectId((current) => current || selectedProject?.id || projects.find((project) => project.available)?.id || '')
      setSelectedAgentTaskId((current) => current && result.tasks.some((task) => task.id === current) ? current : result.tasks[0]?.id || null)
      if (!result.tasks.length) setAgentDetail(null)
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : t('errors:agentConfig'))
    })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, projects])

  useEffect(() => {
    if (page !== 'agent') return
    if (!selectedAgentTaskId) { setAgentDetail(null); return }
    let active = true
    api.localAgentTask(selectedAgentTaskId).then((detail) => { if (active) setAgentDetail(detail) }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : t('errors:agentTaskDetail'))
    })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, selectedAgentTaskId])

  // Poll Agent tasks while any task is queued or running, regardless of the
  // open page, so the right rail and notification center stay current.
  useEffect(() => {
    if (!hasActiveAgentTasks) return
    let active = true
    const timer = setInterval(async () => {
      try {
        const next = await refreshAgentTasks()
        if (selectedAgentTaskId && active) {
          const selected = next.find((task) => task.id === selectedAgentTaskId)
          if (selected) setAgentDetail(await api.localAgentTask(selected.id))
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : t('errors:agentTaskRefresh'))
      }
    }, 2_500)
    return () => { active = false; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveAgentTasks, refreshAgentTasks, selectedAgentTaskId])

  // Detect Agent task completion so the notification center can announce it.
  // Paused is deliberately not a completion: it resumes later.
  useEffect(() => {
    const previous = prevAgentTasks.current
    if (previous.length) {
      for (const task of agentTasks) {
        const before = previous.find((item) => item.id === task.id)
        if (before && AGENT_ACTIVE_STATUSES.includes(before.status) && AGENT_TERMINAL_STATUSES.includes(task.status)) {
          addActivity({
            kind: task.status === 'Succeeded' ? 'ok' : 'warning',
            labelKey: 'notifications:activity.agentTaskCompleted.label',
            detailKey: 'notifications:activity.agentTaskCompleted.detail',
            detailParams: { project: task.projectName, label: task.label },
            page: 'agent'
          })
          pushToast('notifications:activity.agentTaskCompleted.detail', { project: task.projectName, label: task.label })
        }
      }
    }
    prevAgentTasks.current = agentTasks
  }, [agentTasks, addActivity, pushToast])

  // Global command palette shortcut (Ctrl+K).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      } else if (event.key === 'Escape') {
        setNotificationsOpen(false)
        setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleAddProject = async () => {
    setBusy('add')
    setError(null)
    try {
      const result = await bridge.addProject(t('projects:dialogs.addFolder'))
      if (!result) return
      await refreshProjects()
      setSelectedProjectId(result.project.id)
      addActivity({
        kind: 'ok',
        labelKey: result.added ? 'notifications:activity.projectAdded.label' : 'notifications:activity.projectAlreadyRegistered.label',
        detailText: result.project.name,
        page: 'projects'
      })
      pushToast('notifications:toast.projectAdded')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('errors:addProject')
      setError(message)
      addActivity({ kind: 'warning', labelKey: 'notifications:activity.projectAddFailed.label', detailText: message })
    } finally { setBusy(null) }
  }

  const handleScan = async (projectId: string, projectName: string) => {
    setBusy(projectId)
    setError(null)
    try {
      const report = await bridge.scanProject(projectId)
      await refreshProjects()
      addActivity({
        kind: 'ok',
        labelKey: 'notifications:activity.scanComplete.label',
        detailKey: 'notifications:activity.scanComplete.detail',
        detailParams: {
          name: projectName,
          stack: report.technologies.join(', ') || t('projects:tech.none'),
          count: report.visitedEntries
        },
        page: 'projects'
      })
      setShowLog(true)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('errors:scanProject')
      setError(message)
      addActivity({ kind: 'warning', labelKey: 'notifications:activity.scanFailed.label', detailText: message, page: 'projects' })
    } finally { setBusy(null) }
  }

  const handleSelectAgentTask = async (taskId: string) => {
    setSelectedAgentTaskId(taskId)
    try { setAgentDetail(await api.localAgentTask(taskId)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('errors:agentTaskDetail')) }
  }

  const buildAgentPrompt = (prompt: string) => {
    const mode = preferences?.agentReplyLanguage ?? 'ui'
    if (mode === 'input' || !prompt.trim()) return prompt
    const target = mode === 'ui' ? (LANGUAGES.find((language) => language.code === (preferences?.language ?? 'en-US'))?.code ?? 'en-US') : mode
    const nativeName = LANGUAGES.find((language) => language.code === target)?.nativeName ?? target
    return `${prompt}\n\n${t('agent:replyLanguage.instruction', { language: nativeName })}`
  }

  const handleStartAgentTask = async () => {
    setBusy('agent-start')
    setError(null)
    try {
      const result = await api.createLocalAgentTask({
        projectId: agentProjectId,
        prompt: buildAgentPrompt(agentPrompt),
        providerId: agentProviderId || null,
        confirmSourceDisclosure: agentDisclosureConfirmed
      })
      setAgentPrompt('')
      setAgentDisclosureConfirmed(false)
      setSelectedAgentTaskId(result.task.id)
      setAgentTasks((current) => [result.task, ...current.filter((task) => task.id !== result.task.id)])
      setAgentDetail({ task: result.task, changes: [], changesError: null })
      addActivity({
        kind: 'ok',
        labelKey: 'notifications:activity.agentTaskQueued.label',
        detailKey: 'notifications:activity.agentTaskQueued.detail',
        detailParams: { project: result.task.projectName, label: result.task.label },
        page: 'agent'
      })
      setShowLog(true)
      void refreshAgentTasks()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('errors:agentTaskStart')
      setError(message)
      addActivity({ kind: 'warning', labelKey: 'notifications:activity.agentTaskStartError.label', detailText: message })
    } finally { setBusy(null) }
  }

  const handleCancelAgentTask = async (task: LocalAgentTask) => {
    try {
      await api.cancelLocalAgentTask(task.id)
      addActivity({ kind: 'note', labelKey: 'notifications:activity.agentCancellationRequested.label', detailText: task.projectName, page: 'agent' })
      await refreshAgentTasks()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('errors:agentTaskCancel'))
    }
  }

  const handleRetryAgentTask = async (task: LocalAgentTask) => {
    try {
      const result = await api.retryLocalAgentTask(task.id, agentDisclosureConfirmed)
      setAgentDisclosureConfirmed(false)
      setSelectedAgentTaskId(result.task.id)
      setAgentTasks((current) => [result.task, ...current])
      setAgentDetail({ task: result.task, changes: [], changesError: null })
      addActivity({ kind: 'note', labelKey: 'notifications:activity.agentRetryQueued.label', detailText: result.task.projectName, page: 'agent' })
      void refreshAgentTasks()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('errors:agentTaskRetry'))
    }
  }

  const handleRemove = async (project: { id: string; name: string }) => {
    setError(null)
    try {
      const result = await bridge.removeProject(project.id, project.name, {
        title: t('projects:dialogs.removeTitle'),
        message: t('projects:dialogs.removeMessage', { name: project.name }),
        detail: t('projects:dialogs.removeDetail'),
        confirm: t('projects:dialogs.removeConfirm'),
        cancel: t('projects:dialogs.removeCancel')
      })
      if (!result.removed) return
      await refreshProjects()
      addActivity({ kind: 'note', labelKey: 'notifications:activity.projectRemoved.label', detailKey: 'notifications:activity.projectRemoved.detail' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('errors:removeProject'))
    }
  }

  const toggleAutoStart = async (enabled: boolean) => {
    try {
      await bridge.setAutoStart(enabled)
      const nextInfo = await bridge.getInfo()
      setInfo(nextInfo)
      addActivity({
        kind: 'note',
        labelKey: enabled ? 'notifications:activity.autoStartEnabled.label' : 'notifications:activity.autoStartDisabled.label',
        detailKey: 'notifications:activity.autoStartEnabled.detail'
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('errors:autoStart'))
    }
  }

  const sectionTitle = (target: Page): string => ({
    workstation: t('workstation:title'),
    projects: t('projects:page.title'),
    environment: t('environment:page.title'),
    agent: t('agent:page.title'),
    remote: t('navigation:rail.remote'),
    settings: t('settings:page.title')
  })[target]

  const sectionSubtitle = (target: Page): string => ({
    workstation: t('workstation:subtitle'),
    projects: t('workstation:sectionSubtitle.projects'),
    environment: t('workstation:sectionSubtitle.environment'),
    agent: t('workstation:sectionSubtitle.agent'),
    remote: t('workstation:sectionSubtitle.remote'),
    settings: t('settings:page.subtitle')
  })[target]

  const toggleTheme = () => {
    void setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
    pushToast('notifications:toast.themeChanged')
  }

  // ---------------- command palette ----------------
  const commandItems = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = []
    const pushPage = (target: Page, label: string, icon: ReactNode) => items.push({
      id: `page:${target}`, group: 'pages', label, icon,
      run: () => { setPage(target); setPaletteOpen(false) }
    })
    pushPage('workstation', t('navigation:rail.workbench'), <LayoutDashboard size={15} />)
    pushPage('projects', t('navigation:rail.projects'), <Boxes size={15} />)
    pushPage('environment', t('navigation:rail.environment'), <Wrench size={15} />)
    pushPage('agent', t('navigation:rail.agent'), <Bot size={15} />)
    pushPage('remote', t('navigation:rail.remote'), <GitBranch size={15} />)
    pushPage('settings', t('navigation:rail.settings'), <Settings2 size={15} />)
    items.push({ id: 'action:addProject', group: 'actions', label: t('navigation:commandPalette.actions.addProject'), icon: <FolderPlus size={15} />, run: () => { setPaletteOpen(false); void handleAddProject() } })
    items.push({ id: 'action:recheckEnvironment', group: 'actions', label: t('navigation:commandPalette.actions.recheckEnvironment'), icon: <Wrench size={15} />, run: () => { setPaletteOpen(false); void refreshEnvironment() } })
    items.push({ id: 'action:refreshProjects', group: 'actions', label: t('navigation:commandPalette.actions.refreshProjects'), icon: <RefreshCw size={15} />, run: () => { setPaletteOpen(false); void refreshProjects() } })
    items.push({ id: 'action:toggleTheme', group: 'appearance', label: t('navigation:commandPalette.actions.toggleTheme'), icon: resolvedTheme === 'dark' ? <Sun size={15} /> : <Moon size={15} />, run: () => { setPaletteOpen(false); toggleTheme() } })
    for (const language of LANGUAGES) {
      items.push({
        id: `language:${language.code}`, group: 'language', label: `${language.nativeName} · ${language.code}`,
        icon: <Languages size={15} />,
        run: () => { setPaletteOpen(false); void setLanguage(language.code) }
      })
    }
    for (const project of projects) {
      items.push({
        id: `project:${project.id}`, group: 'projects', label: project.name,
        icon: <Boxes size={15} />,
        run: () => { setPaletteOpen(false); setSelectedProjectId(project.id); setPage('projects') }
      })
    }
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, projects, resolvedTheme, preferences?.language])

  const activeAgentTask = agentTasks.find((task) => AGENT_ACTIVE_STATUSES.includes(task.status)) || null

  return <div className="nx-shell" data-page={page}>
    <ActivityBar
      page={page}
      onNavigate={setPage}
      collapsed={railCollapsed}
      onToggleCollapse={() => setRailCollapsed((value) => !value)}
      projectCount={projects.length}
      agentActive={hasActiveAgentTasks}
    />

    <div className="nx-main-column">
      <header className="nx-topbar">
        <div className="nx-location">
          <span>{t('navigation:topbar.machine')}</span>
          <ChevronRight size={13} />
          <strong>{sectionTitle(page)}</strong>
        </div>
        <div className="nx-top-actions">
          <button className="nx-command-trigger" onClick={() => setPaletteOpen(true)} aria-label={t('common:aria.commandPalette')}>
            <Search size={14} />
            <span>{t('navigation:topbar.searchPlaceholder')}</span>
            <kbd>{t('navigation:topbar.searchHint')}</kbd>
          </button>
          <NotificationCenter
            open={notificationsOpen}
            onOpenChange={setNotificationsOpen}
            activity={activity}
            unreadIds={unreadIds}
            onMarkAllRead={() => setUnreadIds(new Set())}
            onOpenActivity={(entry) => {
              if (entry.page) setPage(entry.page)
              setUnreadIds((current) => {
                const next = new Set(current)
                next.delete(entry.id)
                return next
              })
              setNotificationsOpen(false)
            }}
          />
          <button className="nx-icon-button" onClick={toggleTheme} aria-label={t('common:theme.toggle')} title={t('common:theme.toggle')}>
            {resolvedTheme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button className={`nx-icon-button ${page === 'settings' ? 'toggled' : ''}`} onClick={() => setPage('settings')} aria-label={t('navigation:topbar.settings')} title={t('navigation:topbar.settings')}>
            <Settings2 size={15} />
          </button>
        </div>
      </header>

      <div className="nx-content-grid" data-rail={showActivity && page !== 'remote' && page !== 'settings' ? 'open' : 'closed'}>
        <main className="nx-workarea">
          <div className="nx-page-heading">
            <div>
              <p className="nx-overline">{t('workstation:overline')}</p>
              <h1>{sectionTitle(page)}</h1>
              <p className="nx-subtitle">{sectionSubtitle(page)}</p>
            </div>
            {page !== 'environment' && page !== 'remote' && page !== 'settings' && (
              <button className="nx-primary" onClick={() => void handleAddProject()} disabled={busy === 'add'}>
                <FolderPlus size={15} />{busy === 'add' ? t('common:states.working') : t('common:actions.addFolder')}
              </button>
            )}
          </div>

          {error && <div className="nx-alert" role="alert"><AlertTriangle size={16} /><span>{error}</span><button aria-label={t('common:aria.dismissError')} onClick={() => setError(null)}><X size={14} /></button></div>}

          {page === 'workstation' && <WorkbenchPage
            projects={projects}
            environment={environment}
            availableTools={availableTools}
            scannedCount={scannedCount}
            info={info}
            selectedProject={selectedProject}
            busy={busy}
            activeAgentTask={activeAgentTask}
            onSelectProject={setSelectedProjectId}
            onScan={handleScan}
            onRemove={handleRemove}
            onAdd={() => void handleAddProject()}
            onRecheck={() => void refreshEnvironment()}
            onOpenProjects={() => setPage('projects')}
            onOpenEnvironment={() => setPage('environment')}
            onOpenAgent={() => setPage('agent')}
          />}

          {page === 'projects' && <section className="nx-section-block nx-project-page">
            <div className="nx-section-heading">
              <div><h2>{t('projects:registered.title')}</h2><p>{t('projects:registered.detail')}</p></div>
              <span className="nx-count-label">{t('projects:registered.count', { count: projects.length })}</span>
            </div>
            <ProjectTable projects={projects} selectedId={selectedProject?.id || null} busy={busy} onSelect={setSelectedProjectId} onScan={handleScan} onRemove={handleRemove} onAdd={() => void handleAddProject()} />
          </section>}

          {page === 'environment' && <EnvironmentPage
            environment={environment}
            availableTools={availableTools}
            busy={busy === 'environment'}
            onRecheck={() => void refreshEnvironment()}
          />}

          {page === 'agent' && <LocalAgentPage
            projects={projects}
            config={agentConfig}
            tasks={agentTasks}
            selectedTaskId={selectedAgentTaskId}
            detail={agentDetail}
            prompt={agentPrompt}
            projectId={agentProjectId}
            providerId={agentProviderId}
            disclosureConfirmed={agentDisclosureConfirmed}
            busy={busy === 'agent-start'}
            onPromptChange={setAgentPrompt}
            onProjectChange={setAgentProjectId}
            onProviderChange={setAgentProviderId}
            onDisclosureChange={setAgentDisclosureConfirmed}
            onStart={() => void handleStartAgentTask()}
            onSelectTask={(id) => void handleSelectAgentTask(id)}
            onCancel={(task) => void handleCancelAgentTask(task)}
            onRetry={(task) => void handleRetryAgentTask(task)}
            onRefresh={() => void refreshAgentTasks()}
          />}

          {page === 'remote' && <div className="nx-remote-content"><App embedded /></div>}

          {page === 'settings' && <WorkstationSettings info={info} systemLocale={systemLocale} onAutoStartChange={toggleAutoStart} />}
        </main>

        {showActivity && page !== 'remote' && page !== 'settings' && <aside className="nx-activity-pane" aria-label={t('common:aria.notifications')}>
          <div className="nx-side-heading">
            <div><Activity size={15} /><h2>{t('navigation:notifications.title')}</h2></div>
            <button className="nx-icon-button" aria-label={t('common:aria.collapsePanel')} onClick={() => setShowActivity(false)}><PanelRightClose size={14} /></button>
          </div>
          <div className="nx-activity-status"><span className={`nx-state-dot ${info ? '' : 'busy'}`} />{info ? t('common:states.online') : t('common:states.starting')}</div>
          {selectedProject && <div className="nx-selected-project">
            <span>{t('projects:selected.label')}</span>
            <strong>{selectedProject.name}</strong>
            <code title={selectedProject.path}>{selectedProject.path}</code>
            {selectedProject.lastScan && <small>{t('projects:selected.lastScan', { time: formatTime(selectedProject.lastScan.scannedAt) })}</small>}
          </div>}
          {activeAgentTask && <div className="nx-agent-mini">
            <span>{t('workstation:agentPanel.activeTask')}</span>
            <strong>{activeAgentTask.label}</strong>
            <div className="nx-agent-mini-status">
              <span className={`nx-status-chip ${statusClass(activeAgentTask.status)}`}>{t(`agent:status.${activeAgentTask.status}`, { defaultValue: activeAgentTask.status })}</span>
              <small>{activeAgentTask.projectName}</small>
            </div>
          </div>}
          <div className="nx-activity-list">
            {activity.length === 0 && <div className="nx-activity-empty">
              <CircleDot size={16} />
              <strong>{t('navigation:notifications.empty')}</strong>
              <span>{t('navigation:notifications.emptyDetail')}</span>
            </div>}
            {activity.slice(0, 12).map((entry) => <ActivityRow entry={entry} key={entry.id} />)}
          </div>
        </aside>}
      </div>

      {!showActivity && page !== 'remote' && page !== 'settings' && (
        <button className="nx-reopen-activity" onClick={() => setShowActivity(true)} aria-label={t('common:aria.expandPanel')}><PanelRightOpen size={16} /></button>
      )}

      {page !== 'remote' && page !== 'settings' && <footer className={`nx-log-drawer ${showLog ? 'open' : ''}`} style={showLog ? { height: logHeight } : undefined}>
        <div className="nx-log-resize" role="separator" aria-orientation="horizontal" aria-label={t('navigation:bottomPanel.resize')} onMouseDown={(event) => {
          event.preventDefault()
          const startY = event.clientY
          const startHeight = logHeight
          const move = (moveEvent: MouseEvent) => setLogHeight(Math.max(120, Math.min(420, startHeight + (startY - moveEvent.clientY))))
          const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        }} />
        <button className="nx-log-trigger" onClick={() => setShowLog((value) => !value)} aria-expanded={showLog}>
          <TerminalSquare size={14} />
          <strong>{t('navigation:bottomPanel.label')}</strong>
          <span>{t('navigation:bottomPanel.events', { count: activity.length })}</span>
          {showLog ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {showLog && <div className="nx-log-content" role="log">
          {activity.length ? activity.slice(0, 40).map((entry) => <ActivityRow entry={entry} key={entry.id} compact />)
            : <span className="nx-log-empty">{t('navigation:bottomPanel.empty')}</span>}
        </div>}
      </footer>}
    </div>

    <CommandPalette
      open={paletteOpen}
      onClose={() => setPaletteOpen(false)}
      items={commandItems}
    />


    <div className="nx-toast-stack" aria-live="polite">
      {toasts.map((toast) => <div className="nx-toast" key={toast.id}>
        <Check size={14} />
        <span>{t(toast.messageKey, { defaultValue: toast.messageKey, ...toast.params })}</span>
        <button onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))} aria-label={t('common:actions.close')}><X size={12} /></button>
      </div>)}
    </div>
  </div>
}

function ActivityRow({ entry, compact = false }: { entry: ActivityEntry; compact?: boolean }) {
  const { t } = useTranslation()
  return <div className={`nx-activity-item ${compact ? 'compact' : ''}`}>
    <span className={`nx-activity-marker ${entry.kind}`} />
    <div>
      <strong>{t(entry.labelKey, { defaultValue: entry.labelKey, ...entry.labelParams })}</strong>
      {entry.detailKey && <span>{t(entry.detailKey, { defaultValue: entry.detailKey, ...entry.detailParams })}</span>}
      {entry.detailText !== undefined && <span>{entry.detailText}</span>}
      <small>{compact ? formatStamp(entry.at) : formatRelative(entry.at)}</small>
    </div>
  </div>
}

function ActivityBar({ page, onNavigate, collapsed, onToggleCollapse, projectCount, agentActive }: {
  page: Page
  onNavigate: (page: Page) => void
  collapsed: boolean
  onToggleCollapse: () => void
  projectCount: number
  agentActive: boolean
}) {
  const { t } = useTranslation()
  const item = (target: Page, label: string, icon: ReactNode, options?: { count?: number; badge?: boolean; arrow?: boolean }) => (
    <button
      className={`nx-nav-item ${page === target ? 'active' : ''}`}
      onClick={() => onNavigate(target)}
      aria-current={page === target ? 'page' : undefined}
      title={collapsed ? label : undefined}
    >
      {icon}
      {!collapsed && <span className="nx-nav-label">{label}</span>}
      {!collapsed && options?.count !== undefined && <span className="nx-nav-count">{options.count}</span>}
      {!collapsed && options?.badge && <span className="nx-nav-badge" />}
      {!collapsed && options?.arrow && <ChevronRight size={13} className="nx-nav-arrow" />}
    </button>
  )
  return <nav className={`nx-rail ${collapsed ? 'collapsed' : ''}`} aria-label={t('common:aria.mainNavigation')}>
    <div className="nx-brand">
      <div className="nx-brand-mark">N</div>
      {!collapsed && <div><strong>{t('common:app.productName')}</strong><span>{t('common:app.tagline')}</span></div>}
    </div>
    {!collapsed && <div className="nx-rail-label">{t('navigation:rail.workspace')}</div>}
    <div className="nx-rail-group">
      {item('workstation', t('navigation:rail.workbench'), <LayoutDashboard size={16} />)}
      {item('projects', t('navigation:rail.projects'), <Boxes size={16} />, { count: projectCount })}
      {item('environment', t('navigation:rail.environment'), <Wrench size={16} />)}
      {item('agent', t('navigation:rail.agent'), <Bot size={16} />, { badge: agentActive })}
    </div>
    {!collapsed && <div className="nx-rail-label nx-rail-lower">{t('navigation:rail.management')}</div>}
    <div className="nx-rail-group">
      {item('remote', t('navigation:rail.remote'), <GitBranch size={16} />, { arrow: true })}
      {item('settings', t('navigation:rail.settings'), <Settings2 size={16} />)}
    </div>
    <button className="nx-rail-collapse" onClick={onToggleCollapse} aria-label={collapsed ? t('navigation:rail.expand') : t('navigation:rail.collapse')}>
      {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      {!collapsed && <span>{t('navigation:rail.collapse')}</span>}
    </button>
  </nav>
}

function NotificationCenter({ open, onOpenChange, activity, unreadIds, onMarkAllRead, onOpenActivity }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  activity: ActivityEntry[]
  unreadIds: Set<string>
  onMarkAllRead: () => void
  onOpenActivity: (entry: ActivityEntry) => void
}) {
  const { t } = useTranslation()
  return <div className="nx-bell-wrap">
    <button
      className={`nx-icon-button ${open ? 'toggled' : ''}`}
      onClick={() => onOpenChange(!open)}
      aria-label={t('common:aria.notifications')}
      aria-expanded={open}
    >
      <Bell size={15} />
      {unreadIds.size > 0 && <span className="nx-bell-badge">{unreadIds.size > 9 ? '9+' : unreadIds.size}</span>}
    </button>
    {open && <>
      <div className="nx-overlay-backdrop" onClick={() => onOpenChange(false)} />
      <div className="nx-notification-panel" role="dialog" aria-label={t('navigation:notifications.title')}>
        <div className="nx-notification-head">
          <strong>{t('navigation:notifications.title')}</strong>
          <div>
            <button className="nx-text-button" onClick={onMarkAllRead}>{t('navigation:notifications.markAllRead')}</button>
            <button className="nx-icon-button" onClick={() => onOpenChange(false)} aria-label={t('common:actions.close')}><X size={13} /></button>
          </div>
        </div>
        <div className="nx-notification-list">
          {activity.length === 0 && <div className="nx-notification-empty">
            <Bell size={16} />
            <strong>{t('navigation:notifications.empty')}</strong>
            <span>{t('navigation:notifications.emptyDetail')}</span>
          </div>}
          {activity.slice(0, 10).map((entry) => (
            <button
              className={`nx-notification-row ${unreadIds.has(entry.id) ? 'unread' : ''} ${entry.page ? 'clickable' : ''}`}
              key={entry.id}
              onClick={entry.page ? () => onOpenActivity(entry) : undefined}
              title={entry.page ? t('navigation:notifications.open') : undefined}
            >
              <span className={`nx-activity-marker ${entry.kind}`} />
              <div>
                <strong>{t(entry.labelKey, { defaultValue: entry.labelKey, ...entry.labelParams })}</strong>
                {entry.detailKey && <span>{t(entry.detailKey, { defaultValue: entry.detailKey, ...entry.detailParams })}</span>}
                {entry.detailText !== undefined && <span>{entry.detailText}</span>}
                <small>{formatRelative(entry.at)}</small>
              </div>
            </button>
          ))}
        </div>
      </div>
    </>}
  </div>
}

function CommandPalette({ open, onClose, items }: { open: boolean; onClose: () => void; items: CommandItem[] }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) { setQuery(''); setSelected(0); window.setTimeout(() => inputRef.current?.focus(), 20) }
  }, [open])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return items
    return items.filter((item) => item.label.toLowerCase().includes(normalized) || item.id.includes(normalized))
  }, [items, query])

  if (!open) return null

  const groupLabels: Record<CommandItem['group'], string> = {
    pages: t('navigation:commandPalette.groups.pages'),
    actions: t('navigation:commandPalette.groups.actions'),
    projects: t('navigation:commandPalette.groups.projects'),
    appearance: t('navigation:commandPalette.groups.appearance'),
    language: t('navigation:commandPalette.groups.language')
  }

  const runIndex = (index: number) => {
    const item = filtered[index]
    if (item) item.run()
  }

  let lastGroup: CommandItem['group'] | null = null
  return <div className="nx-palette-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="nx-palette" role="dialog" aria-label={t('navigation:commandPalette.title')}>
      <div className="nx-palette-input">
        <Command size={15} />
        <input
          ref={inputRef}
          value={query}
          placeholder={t('navigation:commandPalette.placeholder')}
          onChange={(event) => { setQuery(event.target.value); setSelected(0) }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => Math.min(value + 1, filtered.length - 1)) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => Math.max(value - 1, 0)) }
            else if (event.key === 'Enter') { event.preventDefault(); runIndex(selected) }
            else if (event.key === 'Escape') { event.preventDefault(); onClose() }
          }}
        />
      </div>
      <div className="nx-palette-list" role="listbox">
        {filtered.length === 0 && <div className="nx-palette-empty">{t('navigation:commandPalette.empty')}</div>}
        {filtered.map((item, index) => {
          const header = item.group !== lastGroup ? groupLabels[item.group] : null
          lastGroup = item.group
          return <div key={item.id}>
            {header && <div className="nx-palette-group">{header}</div>}
            <button
              className={`nx-palette-item ${index === selected ? 'selected' : ''}`}
              role="option"
              aria-selected={index === selected}
              onMouseEnter={() => setSelected(index)}
              onClick={() => runIndex(index)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          </div>
        })}
      </div>
      <div className="nx-palette-foot">{t('navigation:commandPalette.hint')}</div>
    </div>
  </div>
}

function WorkbenchPage({ projects, environment, availableTools, scannedCount, info, selectedProject, busy, activeAgentTask, onSelectProject, onScan, onRemove, onAdd, onRecheck, onOpenProjects, onOpenEnvironment, onOpenAgent }: {
  projects: LocalProject[]
  environment: EnvironmentReport | null
  availableTools: number
  scannedCount: number
  info: WorkstationInfo | null
  selectedProject: LocalProject | null
  busy: string | null
  activeAgentTask: LocalAgentTask | null
  onSelectProject: (id: string) => void
  onScan: (id: string, name: string) => void
  onRemove: (project: { id: string; name: string }) => void
  onAdd: () => void
  onRecheck: () => void
  onOpenProjects: () => void
  onOpenEnvironment: () => void
  onOpenAgent: () => void
}) {
  const { t } = useTranslation()
  return <>
    <section className="nx-readiness-bar" aria-label={t('workstation:readiness.title')}>
      <div className="nx-ready-symbol"><Computer size={18} /></div>
      <div className="nx-readiness-copy">
        <strong>{t('workstation:readiness.title')}</strong>
        <span>{t('workstation:readiness.detail')}</span>
      </div>
      <div className="nx-mode"><span className="nx-mode-dot" />{t('common:mode.readOnly')}</div>
    </section>

    <section className="nx-summary-strip" aria-label={t('workstation:title')}>
      <div><span>{t('workstation:summary.projects')}</span><strong>{projects.length.toString().padStart(2, '0')}</strong><small>{t('workstation:summary.projectsDetail')}</small></div>
      <div><span>{t('workstation:summary.tools')}</span><strong>{environment ? `${availableTools}/${environment.total}` : '—'}</strong><small>{environment ? t('workstation:summary.toolsDetail') : t('workstation:summary.toolsChecking')}</small></div>
      <div><span>{t('workstation:summary.scans')}</span><strong>{scannedCount.toString().padStart(2, '0')}</strong><small>{t('workstation:summary.scansDetail')}</small></div>
      <div><span>{t('workstation:summary.startup')}</span><strong>{info?.autoStart ? t('common:states.on') : t('common:states.off')}</strong><small>{t('workstation:summary.startupDetail')}</small></div>
    </section>

    <div className="nx-bottom-grid nx-workbench-grid">
      <section className="nx-panel nx-env-panel">
        <div className="nx-panel-heading">
          <div><span className="nx-panel-icon"><Wrench size={15} /></span><h2>{t('workstation:recentProjects.title')}</h2></div>
          <button className="nx-quiet-button" onClick={onOpenProjects}>{t('common:actions.viewAll')} <ChevronRight size={13} /></button>
        </div>
        {projects.length ? <div className="nx-tool-preview">
          {projects.slice(0, 4).map((project) => <div className="nx-workbench-project" key={project.id}>
            <span className={`nx-tool-mark ${project.available ? 'found' : ''}`} />
            <button className="nx-workbench-project-name" onClick={() => onSelectProject(project.id)}>{project.name}</button>
            <span className="nx-workbench-project-meta">{project.lastScan ? formatRelative(project.lastScan.scannedAt) : t('projects:row.notScanned')}</span>
            <button className="nx-row-action" onClick={() => onScan(project.id, project.name)} disabled={!project.available || busy === project.id}>
              <ScanSearch size={13} />{busy === project.id ? t('common:states.scanning') : t('projects:row.scanAction')}
            </button>
            <button className="nx-delete-action" onClick={() => onRemove(project)} aria-label={t('projects:row.removeAria', { name: project.name })}><Trash2 size={13} /></button>
          </div>)}
        </div> : <div className="nx-empty-projects slim">
          <div className="nx-empty-symbol"><FolderPlus size={17} /></div>
          <strong>{t('projects:empty.title')}</strong>
          <span>{t('projects:empty.detail')}</span>
          <button className="nx-secondary" onClick={onAdd}><FolderPlus size={13} /> {t('common:actions.addFolder')}</button>
        </div>}
      </section>

      <div className="nx-workbench-side">
        <div className="nx-panel nx-agent-mini-panel">
          <div className="nx-panel-heading">
            <div><span className="nx-panel-icon subdued"><Bot size={15} /></span><h2>{t('workstation:agentPanel.title')}</h2></div>
          </div>
          {activeAgentTask
            ? <div className="nx-agent-mini padded">
              <strong>{activeAgentTask.label}</strong>
              <div className="nx-agent-mini-status">
                <span className={`nx-status-chip ${statusClass(activeAgentTask.status)}`}>{t(`agent:status.${activeAgentTask.status}`, { defaultValue: activeAgentTask.status })}</span>
                <small>{activeAgentTask.projectName}</small>
              </div>
            </div>
            : <div className="nx-agent-mini padded muted">
              <span>{t('workstation:agentPanel.empty')}</span>
            </div>}
          <button className="nx-text-action" onClick={onOpenAgent}>{t('workstation:agentPanel.start')} <ChevronRight size={13} /></button>
        </div>
        <div className="nx-panel nx-env-panel">
          <div className="nx-panel-heading">
            <div><span className="nx-panel-icon"><Wrench size={15} /></span><h2>{t('workstation:environmentPreview.title')}</h2></div>
            <button className="nx-icon-button" aria-label={t('workstation:environmentPreview.recheck')} onClick={onRecheck} disabled={busy === 'environment'}>
              <RefreshCw size={14} className={busy === 'environment' ? 'nx-spinning' : ''} />
            </button>
          </div>
          {environment ? <div className="nx-tool-preview">
            {environment.tools.filter((tool) => ['git', 'node', 'python', 'docker'].includes(tool.id)).map((tool) => (
              <div className="nx-tool-line" key={tool.id}>
                <span className={`nx-tool-mark ${['AVAILABLE', 'SHIM_FOUND', 'PATH_FOUND'].includes(tool.status) ? 'found' : ''}`} />
                <span>{tool.label}</span>
                <code>{tool.version || t(`environment:status.${tool.status}`, { defaultValue: tool.status })}</code>
              </div>
            ))}
          </div> : <div className="nx-inline-loading">{t('workstation:environmentPreview.checking')}</div>}
          <button className="nx-text-action" onClick={onOpenEnvironment}>{t('workstation:environmentPreview.openReport')} <ChevronRight size={13} /></button>
        </div>
        <div className="nx-panel nx-policy-panel">
          <div className="nx-panel-heading"><div><span className="nx-panel-icon subdued"><ShieldCheck size={15} /></span><h2>{t('workstation:boundary.title')}</h2></div><span className="nx-policy-label">{t('workstation:boundary.inForce')}</span></div>
          <div className="nx-policy-row"><Check size={13} /><span>{t('workstation:boundary.folderDialog')}</span></div>
          <div className="nx-policy-row"><Check size={13} /><span>{t('workstation:boundary.scanLimits')}</span></div>
          <div className="nx-policy-row pending"><CircleDot size={13} /><span>{t('workstation:boundary.changesDisabled')}</span></div>
        </div>
      </div>
    </div>
  </>
}

function EnvironmentPage({ environment, availableTools, busy, onRecheck }: {
  environment: EnvironmentReport | null
  availableTools: number
  busy: boolean
  onRecheck: () => void
}) {
  const { t } = useTranslation()
  return <>
    <section className="nx-readiness-bar compact">
      <div className="nx-ready-symbol"><HardDrive size={17} /></div>
      <div className="nx-readiness-copy">
        <strong>{environment ? t('environment:summary.detected', { available: availableTools, total: environment.total }) : t('environment:summary.running')}</strong>
        <span>{t('environment:summary.detail')}</span>
      </div>
      <button className="nx-secondary" onClick={onRecheck} disabled={busy}>
        <RefreshCw size={13} className={busy ? 'nx-spinning' : ''} /> {t('common:actions.recheck')}
      </button>
    </section>
    <section className="nx-panel nx-environment-table">
      <div className="nx-panel-heading">
        <div><span className="nx-panel-icon"><Code2 size={15} /></span><h2>{t('environment:table.title')}</h2></div>
        <span className="nx-count-label">{environment ? t('environment:table.scannedAt', { time: formatTime(environment.scannedAt) }) : t('environment:table.checking')}</span>
      </div>
      {!environment && <div className="nx-empty-row">{t('environment:table.stillRunning')}</div>}
      {environment?.tools.map((tool) => <div className="nx-env-row" key={tool.id}>
        <span className={`nx-tool-mark ${['AVAILABLE', 'SHIM_FOUND', 'PATH_FOUND'].includes(tool.status) ? 'found' : ''}`} />
        <div className="nx-env-name"><strong>{tool.label}</strong><span>{tool.group}</span></div>
        <div className="nx-env-paths">
          {tool.paths.length ? tool.paths.map((entry) => <code key={entry} title={entry}>{entry}</code>) : <span>{t('environment:table.noPath')}</span>}
        </div>
        <div className="nx-env-version">
          {tool.version || t(`environment:status.${tool.status}`, { defaultValue: tool.status })}
          {tool.conflict && <span className="nx-conflict"><AlertTriangle size={11} /> {t('environment:table.pathConflict')}</span>}
          {tool.diagnostic && <small>{tool.diagnostic}</small>}
        </div>
      </div>)}
    </section>
    <div className="nx-note"><ShieldCheck size={14} /><span>{t('environment:note')}</span></div>
  </>
}

function WorkstationSettings({ info, systemLocale, onAutoStartChange }: {
  info: WorkstationInfo | null
  systemLocale: string
  onAutoStartChange: (enabled: boolean) => Promise<void>
}) {
  const { t } = useTranslation()
  const { preferences, setLanguage, setTheme, setReduceMotion, setAgentReplyLanguage } = useSettings()
  if (!preferences) return null
  const systemLanguageName = LANGUAGES.find((language) => language.code === systemLocale)?.nativeName ?? systemLocale

  return <div className="nx-settings-page">
    <section className="nx-settings-section">
      <div className="nx-settings-section-head">
        <Languages size={16} />
        <h2>{t('settings:sections.appearance')}</h2>
      </div>
      <div className="nx-setting-block">
        <div className="nx-setting-copy">
          <strong>{t('settings:appearance.languageLabel')}</strong>
          <span>{t('settings:appearance.languageHint')}</span>
        </div>
        <div className="nx-language-select">
          <select
            value={preferences.language ?? 'en-US'}
            aria-label={t('settings:appearance.languageLabel')}
            onChange={(event) => void setLanguage(event.target.value)}
          >
            {LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.nativeName}</option>)}
          </select>
        </div>
        <p className="nx-setting-note">{t('settings:appearance.coverageNote')}</p>
      </div>
      <div className="nx-setting-block">
        <div className="nx-setting-copy">
          <strong>{t('settings:appearance.themeLabel')}</strong>
          <span>{t('settings:appearance.themeHint')}</span>
        </div>
        <div className="nx-segmented" role="radiogroup" aria-label={t('settings:appearance.themeLabel')}>
          {(['dark', 'light', 'system'] as const).map((option) => (
            <button
              key={option}
              role="radio"
              aria-checked={preferences.theme === option}
              className={preferences.theme === option ? 'selected' : ''}
              onClick={() => void setTheme(option)}
            >
              {option === 'dark' && <Moon size={13} />}
              {option === 'light' && <Sun size={13} />}
              {option === 'system' && <Computer size={13} />}
              {t(`common:theme.${option}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="nx-setting-block">
        <div className="nx-setting-copy">
          <strong>{t('settings:appearance.motionLabel')}</strong>
          <span>{t('settings:appearance.motionHint')}</span>
        </div>
        <button
          className={`nx-switch ${preferences.reduceMotion ? 'on' : ''}`}
          role="switch"
          aria-checked={preferences.reduceMotion}
          aria-label={t('settings:appearance.motionLabel')}
          onClick={() => void setReduceMotion(!preferences.reduceMotion)}
        ><span /></button>
      </div>
    </section>

    <section className="nx-settings-section">
      <div className="nx-settings-section-head">
        <Bot size={16} />
        <h2>{t('settings:sections.agent')}</h2>
      </div>
      <div className="nx-setting-block column">
        <div className="nx-setting-copy">
          <strong>{t('settings:appearance.agentReplyLabel')}</strong>
          <span>{t('settings:appearance.agentReplyHint')}</span>
        </div>
        <div className="nx-radio-column" role="radiogroup" aria-label={t('settings:appearance.agentReplyLabel')}>
          {(['ui', 'input'] as const).map((mode) => (
            <label key={mode} className="nx-radio-row">
              <input
                type="radio"
                name="agent-reply-language"
                checked={preferences.agentReplyLanguage === mode}
                onChange={() => void setAgentReplyLanguage(mode)}
              />
              <span>{t(`settings:appearance.agentReply${mode === 'ui' ? 'Ui' : 'Input'}`)}</span>
            </label>
          ))}
          <label className="nx-radio-row">
            <input
              type="radio"
              name="agent-reply-language"
              checked={!['ui', 'input'].includes(preferences.agentReplyLanguage)}
              onChange={() => void setAgentReplyLanguage('ja-JP')}
            />
            <span>{t('settings:appearance.agentReplyFixed')}</span>
            <select
              value={!['ui', 'input'].includes(preferences.agentReplyLanguage) ? preferences.agentReplyLanguage : 'ja-JP'}
              disabled={['ui', 'input'].includes(preferences.agentReplyLanguage)}
              aria-label={t('settings:appearance.agentReplyFixed')}
              onChange={(event) => void setAgentReplyLanguage(event.target.value)}
            >
              {LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.nativeName}</option>)}
            </select>
          </label>
        </div>
      </div>
    </section>

    <section className="nx-settings-section">
      <div className="nx-settings-section-head">
        <Computer size={16} />
        <h2>{t('settings:sections.startup')}</h2>
      </div>
      <div className="nx-setting-block">
        <div className="nx-setting-copy">
          <strong>{t('settings:startup.autoStartLabel')}</strong>
          <span>{t('settings:startup.autoStartDetail')}</span>
        </div>
        <button
          className={`nx-switch ${info?.autoStart ? 'on' : ''}`}
          role="switch"
          aria-checked={Boolean(info?.autoStart)}
          aria-label={t('settings:startup.autoStartLabel')}
          onClick={() => void onAutoStartChange(!info?.autoStart)}
        ><span /></button>
      </div>
    </section>

    <section className="nx-settings-section">
      <div className="nx-settings-section-head">
        <ShieldCheck size={16} />
        <h2>{t('settings:sections.about')}</h2>
      </div>
      <div className="nx-about-grid">
        <div><span>{t('settings:about.version')}</span><strong>{info ? `v${info.version}` : '—'}</strong></div>
        <div><span>{t('settings:about.platform')}</span><strong>{info ? `${info.platform} · ${info.arch} · ${info.osRelease}` : '—'}</strong></div>
        <div><span>{t('settings:about.systemLocale')}</span><strong>{systemLanguageName || '—'}</strong></div>
        <div><span>{t('settings:about.dataPath')}</span><code title={info?.dataPath}>{info?.dataPath || '—'}</code></div>
        <div><span>{t('settings:about.logsPath')}</span><code title={info?.logsPath}>{info?.logsPath || '—'}</code></div>
        <div><span>{t('settings:about.cachePath')}</span><code title={info?.cachePath}>{info?.cachePath || '—'}</code></div>
      </div>
    </section>
  </div>
}

function LocalAgentPage({ projects, config, tasks, selectedTaskId, detail, prompt, projectId, providerId, disclosureConfirmed, busy, onPromptChange, onProjectChange, onProviderChange, onDisclosureChange, onStart, onSelectTask, onCancel, onRetry, onRefresh }: {
  projects: LocalProject[]
  config: Awaited<ReturnType<typeof api.localAgentConfig>> | null
  tasks: LocalAgentTask[]
  selectedTaskId: string | null
  detail: Awaited<ReturnType<typeof api.localAgentTask>> | null
  prompt: string
  projectId: string
  providerId: string
  disclosureConfirmed: boolean
  busy: boolean
  onPromptChange: (value: string) => void
  onProjectChange: (value: string) => void
  onProviderChange: (value: string) => void
  onDisclosureChange: (value: boolean) => void
  onStart: () => void
  onSelectTask: (id: string) => void
  onCancel: (task: LocalAgentTask) => void
  onRetry: (task: LocalAgentTask) => void
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null
  const configuredProviders = config?.providers.filter((provider) => provider.configured) || []
  const availableProjects = projects.filter((project) => project.available)
  const activeTask = selectedTask && AGENT_ACTIVE_STATUSES.includes(selectedTask.status)
  const maxPromptBytes = config?.limits.maxPromptBytes || 8192
  const promptBytes = new TextEncoder().encode(prompt).length

  return <div className="nx-agent-page">
    <section className="nx-agent-compose nx-panel" aria-labelledby="nx-agent-compose-title">
      <div className="nx-panel-heading">
        <div><span className="nx-panel-icon"><Bot size={15} /></span><h2 id="nx-agent-compose-title">{t('agent:compose.title')}</h2></div>
        <span className={`nx-agent-provider-state ${config?.configured ? 'ready' : 'blocked'}`}>{config?.configured ? t('agent:compose.providerReady') : t('agent:compose.providerRequired')}</span>
      </div>
      <div className="nx-agent-compose-body">
        <div className="nx-agent-field-row">
          <label className="nx-agent-field">
            <span>{t('agent:compose.projectLabel')}</span>
            <select value={projectId} onChange={(event) => onProjectChange(event.target.value)} disabled={!availableProjects.length}>
              <option value="">{t('agent:compose.projectPlaceholder')}</option>
              {availableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="nx-agent-field">
            <span>{t('agent:compose.providerLabel')}</span>
            <select value={providerId} onChange={(event) => onProviderChange(event.target.value)} disabled={!configuredProviders.length}>
              <option value="">{t('agent:compose.providerPlaceholder')}</option>
              {configuredProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.id} · {provider.model || provider.kind}</option>)}
            </select>
          </label>
        </div>
        {!availableProjects.length && <div className="nx-agent-inline-note">{t('agent:compose.noProjects')}</div>}
        {!configuredProviders.length && <div className="nx-agent-inline-note warning">{t('agent:compose.noProviders')}</div>}
        <label className="nx-agent-field nx-agent-prompt">
          <span>{t('agent:compose.promptLabel')} <small>{t('agent:compose.promptBytes', { used: promptBytes, limit: maxPromptBytes })}</small></span>
          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            maxLength={8192}
            placeholder={t('agent:compose.promptPlaceholder')}
          />
        </label>
        <div className="nx-agent-disclosure">
          <div className="nx-agent-disclosure-heading"><ShieldCheck size={15} /><strong>{t('agent:compose.disclosureTitle')}</strong></div>
          <p>{t('agent:compose.disclosureBody', {
            maxFiles: config?.limits.maxContextFiles || 20,
            maxKiB: Math.round((config?.limits.maxProviderSourceBytesAfterRedaction || 122880) / 1024)
          })}</p>
          <label className="nx-agent-consent">
            <input type="checkbox" checked={disclosureConfirmed} onChange={(event) => onDisclosureChange(event.target.checked)} />
            <span>{t('agent:compose.consent')}</span>
          </label>
        </div>
        <div className="nx-agent-compose-footer">
          <span>{t('agent:compose.footerNote')}</span>
          <button className="nx-primary" onClick={onStart} disabled={busy || !config?.configured || !projectId || !providerId || !prompt.trim() || !disclosureConfirmed}>
            <Bot size={14} />{busy ? t('agent:compose.submitting') : t('agent:compose.submit')}
          </button>
        </div>
      </div>
    </section>

    <div className="nx-agent-work-grid">
      <section className="nx-agent-queue nx-panel" aria-labelledby="nx-agent-queue-title">
        <div className="nx-panel-heading">
          <div><span className="nx-panel-icon subdued"><Activity size={15} /></span><h2 id="nx-agent-queue-title">{t('agent:history.title')}</h2></div>
          <button className="nx-icon-button" aria-label={t('agent:history.refresh')} onClick={onRefresh}><RefreshCw size={13} /></button>
        </div>
        {tasks.length ? <div className="nx-agent-task-list">{tasks.map((task) => <div className={`nx-agent-task-row ${selectedTaskId === task.id ? 'selected' : ''}`} key={task.id}>
          <button className="nx-agent-task-select" onClick={() => onSelectTask(task.id)} aria-current={selectedTaskId === task.id ? 'true' : undefined}>
            <span className={`nx-agent-status-dot ${statusClass(task.status)}`} />
            <span className="nx-agent-task-copy">
              <strong>{task.label}</strong>
              <small>{task.projectName} · {formatRelative(task.updatedAt || task.createdAt)}</small>
              <small>{t('common:units.change', { count: task.changedFiles.length })}</small>
            </span>
            <span className={`nx-agent-status ${statusClass(task.status)}`}>{t(`agent:status.${task.status}`, { defaultValue: task.status })}</span>
          </button>
          {AGENT_ACTIVE_STATUSES.includes(task.status) && (
            <button className="nx-agent-cancel" onClick={() => onCancel(task)} aria-label={t('agent:history.cancelAria', { label: task.label })} title={t('agent:history.cancelTitle')}><X size={13} /></button>
          )}
        </div>)}</div>
          : <div className="nx-agent-empty"><CircleDot size={17} /><strong>{t('agent:history.emptyTitle')}</strong><span>{t('agent:history.emptyDetail')}</span></div>}
      </section>

      <section className="nx-agent-detail nx-panel" aria-labelledby="nx-agent-detail-title">
        <div className="nx-panel-heading">
          <div><span className="nx-panel-icon"><ScanSearch size={15} /></span><h2 id="nx-agent-detail-title">{t('agent:review.title')}</h2></div>
          {selectedTask && <span className={`nx-agent-status ${statusClass(selectedTask.status)}`}>{t(`agent:status.${selectedTask.status}`, { defaultValue: selectedTask.status })}</span>}
        </div>
        {!selectedTask
          ? <div className="nx-agent-empty"><ScanSearch size={17} /><strong>{t('agent:review.emptyTitle')}</strong><span>{t('agent:review.emptyDetail')}</span></div>
          : <div className="nx-agent-detail-body">
            <div className="nx-agent-request"><span>{t('agent:review.requestLabel')}</span><p>{selectedTask.prompt}</p></div>
            {selectedTask.provider && <div className="nx-agent-meta">
              <span>{selectedTask.provider.id} · {selectedTask.provider.model}</span>
              {selectedTask.usage && <span>{t('agent:meta.tokens', { value: formatTokens(selectedTask.usage.totalTokens) })}</span>}
              {selectedTask.costUsd !== null && <span>{formatCurrency(selectedTask.costUsd)}</span>}
            </div>}
            {selectedTask.disclosedPaths.length > 0 && <details className="nx-agent-paths">
              <summary>{t('agent:review.pathsSummary', { count: selectedTask.disclosedPaths.length })}</summary>
              <ul>{selectedTask.disclosedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
            </details>}
            {selectedTask.error && <div className="nx-agent-error" role="alert">{selectedTask.error}</div>}
            {selectedTask.rationale && <div className="nx-agent-rationale"><span>{t('agent:review.rationaleLabel')}</span><p>{selectedTask.rationale}</p></div>}
            <div className="nx-agent-change-heading">
              <strong>{t('agent:review.changesTitle')}</strong>
              <span>{t('agent:review.changesCount', { count: detail?.changes.length ?? selectedTask.changedFiles.length })}</span>
            </div>
            {detail?.changesError && <div className="nx-agent-error">{t('agent:review.changesError', { message: detail.changesError })}</div>}
            {detail?.changes.length
              ? <div className="nx-agent-diff-list">{detail.changes.map((change) => <details className="nx-agent-diff" key={`${change.action}:${change.path}`} open={detail.changes.length === 1}>
                <summary><span className={`nx-agent-diff-action ${change.action}`}>{change.action}</span><code>{change.path}</code></summary>
                {change.contentStatus === 'available'
                  ? <div className="nx-agent-diff-content">
                    {change.before !== null && <div><span>{t('agent:review.before')}</span><pre>{change.before}</pre></div>}
                    {change.after !== null && <div><span>{t('agent:review.after')}</span><pre>{change.after}</pre></div>}
                    {change.action === 'deleted' && <div className="nx-agent-delete-note">{t('agent:review.deletedNote')}</div>}
                  </div>
                  : <div className="nx-agent-inline-note">{t('agent:review.previewUnavailable', { status: change.contentStatus })}</div>}
              </details>)}</div>
              : <div className="nx-agent-no-diff">
                {activeTask
                  ? t('agent:review.runningNote')
                  : detail?.changesError
                    ? t('agent:review.noDiffError')
                    : t('agent:review.noDiff')}
              </div>}
            {selectedTask.events.length > 0 && <details className="nx-agent-events">
              <summary>{t('agent:review.eventsSummary', { count: selectedTask.events.length })}</summary>
              <ol>{selectedTask.events.map((event, index) => <li key={`${event.at}:${index}`}>
                <time>{formatTime(event.at)}</time>
                <span>{event.type && t(`agent:events.${event.type}`, {
                  defaultValue: t('agent:events.rawDetail', { detail: event.detail }),
                  from: event.fromStatus ? t(`agent:status.${event.fromStatus}`, { defaultValue: event.fromStatus }) : undefined,
                  to: t(`agent:status.${event.status ?? ''}`, { defaultValue: event.status ?? '' })
                })}</span>
              </li>)}</ol>
            </details>}
            {selectedTask.status !== 'Queued' && selectedTask.status !== 'Running' && <div className="nx-agent-retry-row">
              <span>{t('agent:review.retryNote')}</span>
              <button className="nx-secondary" onClick={() => onRetry(selectedTask)} disabled={!disclosureConfirmed || !configuredProviders.some((provider) => provider.id === selectedTask.providerId)}>{t('agent:review.retryAction')}</button>
            </div>}
          </div>}
      </section>
    </div>
    <div className="nx-note nx-agent-capability-note"><ShieldCheck size={14} /><span>{t('agent:capabilityNote')}</span></div>
  </div>
}

function ProjectTable({ projects, selectedId, busy, onSelect, onScan, onRemove, onAdd }: {
  projects: LocalProject[]
  selectedId: string | null
  busy: string | null
  onSelect: (id: string) => void
  onScan: (id: string, name: string) => void
  onRemove: (project: { id: string; name: string }) => void
  onAdd: () => void
}) {
  const { t } = useTranslation()
  if (!projects.length) return <div className="nx-empty-projects">
    <div className="nx-empty-symbol"><FolderPlus size={17} /></div>
    <strong>{t('projects:empty.title')}</strong>
    <span>{t('projects:empty.detail')}</span>
    <button className="nx-secondary" onClick={onAdd}><FolderPlus size={13} /> {t('common:actions.addFolder')}</button>
  </div>
  return <div className="nx-project-list" role="list">
    {projects.map((project) => <article className={`nx-project-row ${selectedId === project.id ? 'selected' : ''} ${project.available ? '' : 'missing'}`} key={project.id} role="listitem">
      <button className="nx-project-identity" onClick={() => onSelect(project.id)} aria-pressed={selectedId === project.id}>
        <div className="nx-project-glyph"><Boxes size={16} /></div>
        <div className="nx-project-copy">
          <strong title={project.name}>{project.name}{!project.available && <span className="nx-missing-label">{project.availability === 'MISSING' ? t('projects:row.missing') : t('projects:row.pathChanged')}</span>}</strong>
          <code title={project.path}>{project.path}</code>
          <div className="nx-tech-list">
            {project.lastScan?.technologies.length
              ? project.lastScan.technologies.map((technology) => <span key={technology}>{technology}</span>)
              : <span className="quiet">{t('projects:row.notScanned')}</span>}
            {project.lastScan?.truncated && <span className="nx-truncated">{t('projects:row.scanLimit')}</span>}
          </div>
        </div>
      </button>
      <div className="nx-project-scan">
        {project.lastScan
          ? <><span className="nx-scan-status"><Check size={12} /> {t('projects:row.scanned')}</span><small>{formatTime(project.lastScan.scannedAt)}</small></>
          : <span className="nx-scan-status waiting"><CircleDot size={12} /> {t('projects:row.awaitingScan')}</span>}
      </div>
      <div className="nx-project-actions">
        <button className="nx-row-action" onClick={() => onScan(project.id, project.name)} disabled={!project.available || busy === project.id} aria-label={t('projects:row.scanAria', { name: project.name })}>
          <ScanSearch size={14} />{busy === project.id ? t('common:states.scanning') : t('projects:row.scanAction')}
        </button>
        <button className="nx-delete-action" onClick={() => onRemove(project)} aria-label={t('projects:row.removeAria', { name: project.name })}><Trash2 size={14} /></button>
      </div>
    </article>)}
  </div>
}
