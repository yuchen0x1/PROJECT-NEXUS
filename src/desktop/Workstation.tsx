import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, Bot, Boxes, Check, ChevronDown, ChevronRight, CircleDot, Code2,
  Computer, FolderPlus, GitBranch, HardDrive, LayoutDashboard, PanelRightClose,
  PanelRightOpen, RefreshCw, ScanSearch, Settings2, ShieldCheck, TerminalSquare,
  Trash2, Wrench, X
} from 'lucide-react'
import App from '../App'
import { api, type LocalAgentTask } from '../api'
import './workstation.css'
import type { LocalProject, EnvironmentReport, WorkstationInfo } from './types'

type Page = 'workstation' | 'projects' | 'environment' | 'agent' | 'remote'
type ActivityEntry = { id: string; label: string; detail: string; at: string; kind: 'ok' | 'note' | 'warning' }

function shortTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Just now' : new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
}

function toolSummary(status: string) {
  if (status === 'AVAILABLE') return 'Available'
  if (status === 'SHIM_FOUND') return 'Shim found · version not queried'
  if (status === 'PATH_FOUND') return 'Path found · version not queried'
  if (status === 'MISSING') return 'Not found'
  if (status === 'TIMEOUT') return 'Version check timed out'
  return status === 'VERSION_ERROR' ? 'Could not read version' : status
}

export default function Workstation() {
  const bridge = window.nexusDesktop!
  const [page, setPage] = useState<Page>('workstation')
  const [info, setInfo] = useState<WorkstationInfo | null>(null)
  const [projects, setProjects] = useState<LocalProject[]>([])
  const [environment, setEnvironment] = useState<EnvironmentReport | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [busy, setBusy] = useState<'environment' | 'add' | string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showActivity, setShowActivity] = useState(true)
  const [showLog, setShowLog] = useState(false)
  const [agentConfig, setAgentConfig] = useState<Awaited<ReturnType<typeof api.localAgentConfig>> | null>(null)
  const [agentTasks, setAgentTasks] = useState<LocalAgentTask[]>([])
  const [selectedAgentTaskId, setSelectedAgentTaskId] = useState<string | null>(null)
  const [agentDetail, setAgentDetail] = useState<Awaited<ReturnType<typeof api.localAgentTask>> | null>(null)
  const [agentPrompt, setAgentPrompt] = useState('')
  const [agentProjectId, setAgentProjectId] = useState('')
  const [agentProviderId, setAgentProviderId] = useState('')
  const [agentDisclosureConfirmed, setAgentDisclosureConfirmed] = useState(false)

  const selectedProject = projects.find((project) => project.id === selectedProjectId) || projects[0] || null
  const availableTools = environment?.tools.filter((tool) => ['AVAILABLE', 'SHIM_FOUND', 'PATH_FOUND'].includes(tool.status)).length || 0
  const scannedCount = projects.filter((project) => project.lastScan).length

  const addActivity = useCallback((label: string, detail: string, kind: ActivityEntry['kind'] = 'ok') => {
    setActivity((current) => [{ id: crypto.randomUUID(), label, detail, at: new Date().toISOString(), kind }, ...current].slice(0, 30))
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
      addActivity('Environment check finished', `${result.available || 0} of ${result.total || 0} development tools available.`)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The environment check failed.'
      setError(message)
      addActivity('Environment check failed', message, 'warning')
    } finally { setBusy(null) }
  }, [addActivity, bridge])

  useEffect(() => {
    let active = true
    Promise.all([bridge.getInfo(), bridge.listProjects()]).then(([nextInfo, nextProjects]) => {
      if (!active) return
      setInfo(nextInfo)
      setProjects(nextProjects)
      setSelectedProjectId(nextProjects[0]?.id || null)
      addActivity('Workstation ready', `${nextProjects.length} local project${nextProjects.length === 1 ? '' : 's'} registered.`)
      void refreshEnvironment()
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not load local workstation data.')
    })
    return () => { active = false }
  }, [addActivity, bridge, refreshEnvironment])

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
      if (active) setError(cause instanceof Error ? cause.message : 'Could not load the local Agent status.')
    })
    return () => { active = false }
  }, [page, projects, selectedProject?.id])

  useEffect(() => {
    if (page !== 'agent') return
    if (!selectedAgentTaskId) { setAgentDetail(null); return }
    let active = true
    api.localAgentTask(selectedAgentTaskId).then((detail) => { if (active) setAgentDetail(detail) }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not load the Agent task details.')
    })
    return () => { active = false }
  }, [page, selectedAgentTaskId])

  const hasActiveAgentTasks = agentTasks.some((task) => ['Queued', 'Running'].includes(task.status))
  useEffect(() => {
    if (page !== 'agent' || !hasActiveAgentTasks) return
    let active = true
    const timer = setInterval(async () => {
      try {
        const next = await refreshAgentTasks()
        const selected = next.find((task) => task.id === selectedAgentTaskId)
        if (selected && active) setAgentDetail(await api.localAgentTask(selected.id))
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not refresh Agent task status.')
      }
    }, 2_500)
    return () => { active = false; clearInterval(timer) }
  }, [page, hasActiveAgentTasks, refreshAgentTasks, selectedAgentTaskId])

  const handleAddProject = async () => {
    setBusy('add')
    setError(null)
    try {
      const result = await bridge.addProject()
      if (!result) return
      await refreshProjects()
      setSelectedProjectId(result.project.id)
      addActivity(result.added ? 'Local project added' : 'Project already registered', result.project.name)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not add that folder.'
      setError(message)
      addActivity('Project could not be added', message, 'warning')
    } finally { setBusy(null) }
  }

  const handleScan = async (projectId: string, projectName: string) => {
    setBusy(projectId)
    setError(null)
    try {
      const report = await bridge.scanProject(projectId)
      await refreshProjects()
      addActivity('Read-only scan complete', `${projectName}: ${report.technologies.join(', ') || 'no known stack markers'}; ${report.visitedEntries} entries checked.`)
      setShowLog(true)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The project scan failed.'
      setError(message)
      addActivity('Project scan failed', message, 'warning')
    } finally { setBusy(null) }
  }

  const handleSelectAgentTask = async (taskId: string) => {
    setSelectedAgentTaskId(taskId)
    try { setAgentDetail(await api.localAgentTask(taskId)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load the Agent task details.') }
  }

  const handleStartAgentTask = async () => {
    setBusy('agent-start')
    setError(null)
    try {
      const result = await api.createLocalAgentTask({
        projectId: agentProjectId,
        prompt: agentPrompt,
        providerId: agentProviderId || null,
        confirmSourceDisclosure: agentDisclosureConfirmed
      })
      setAgentPrompt('')
      setAgentDisclosureConfirmed(false)
      setSelectedAgentTaskId(result.task.id)
      setAgentTasks((current) => [result.task, ...current.filter((task) => task.id !== result.task.id)])
      setAgentDetail({ task: result.task, changes: [], changesError: null })
      addActivity('Local Agent task queued', `${result.task.projectName}: ${result.task.label}`)
      setShowLog(true)
      void refreshAgentTasks()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not start the local Agent task.'
      setError(message)
      addActivity('Local Agent task could not start', message, 'warning')
    } finally { setBusy(null) }
  }

  const handleCancelAgentTask = async (task: LocalAgentTask) => {
    try {
      await api.cancelLocalAgentTask(task.id)
      addActivity('Local Agent cancellation requested', task.projectName, 'note')
      await refreshAgentTasks()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not cancel the Agent task.')
    }
  }

  const handleRetryAgentTask = async (task: LocalAgentTask) => {
    try {
      const result = await api.retryLocalAgentTask(task.id, agentDisclosureConfirmed)
      setAgentDisclosureConfirmed(false)
      setSelectedAgentTaskId(result.task.id)
      setAgentTasks((current) => [result.task, ...current])
      setAgentDetail({ task: result.task, changes: [], changesError: null })
      addActivity('Local Agent retry queued', result.task.projectName)
      void refreshAgentTasks()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not retry the Agent task.')
    }
  }

  const handleRemove = async (project: { id: string; name: string }) => {
    setError(null)
    try {
      const result = await bridge.removeProject(project.id, project.name)
      if (!result.removed) return
      await refreshProjects()
      addActivity('Project removed from NEXUS', 'The folder and its files were left unchanged.', 'note')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not remove the project reference.'
      setError(message)
    }
  }

  const toggleAutoStart = async (enabled: boolean) => {
    try {
      await bridge.setAutoStart(enabled)
      const nextInfo = await bridge.getInfo()
      setInfo(nextInfo)
      addActivity(enabled ? 'Start with Windows enabled' : 'Start with Windows disabled', 'This setting changes only after your confirmation.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change the Windows startup setting.')
    }
  }

  const currentSection = useMemo(() => ({
    workstation: ['Workstation', 'A local-first view of this Windows machine and its approved project folders.'],
    projects: ['Local projects', 'Choose folders explicitly. The first scan reads names and project markers only.'],
    environment: ['Development environment', 'Detected executable paths and versions from this Windows user account.'],
    agent: ['AI Agent', 'Generate reviewable code changes in an isolated copy of a registered project.'],
    remote: ['Remote control', 'Existing GitHub and release workflows, kept separate from local execution permissions.']
  } satisfies Record<Page, [string, string]>)[page], [page])

  if (page === 'remote') {
    return <div className="nx-shell nx-shell-remote">
      <nav className="nx-rail" aria-label="NEXUS workstation navigation">
        <div className="nx-brand"><div className="nx-brand-mark">N</div><div><strong>NEXUS</strong><span>Windows Workstation</span></div></div>
        <div className="nx-rail-label">Workspace</div>
        <button className="nx-nav-item" onClick={() => setPage('workstation')}><LayoutDashboard size={17} /><span>Workstation</span></button>
        <button className="nx-nav-item" onClick={() => setPage('projects')}><Boxes size={17} /><span>Local projects</span></button>
        <button className="nx-nav-item" onClick={() => setPage('environment')}><Wrench size={17} /><span>Environment</span></button>
      <button className="nx-nav-item" onClick={() => setPage('agent')}><Bot size={17} /><span>AI Agent</span></button>
        <div className="nx-rail-label nx-rail-lower">Management</div>
        <button className="nx-nav-item active" aria-current="page"><GitBranch size={17} /><span>Remote control</span></button>
        <div className="nx-rail-bottom"><ShieldCheck size={15} /><span>Local execution stays on this machine</span></div>
      </nav>
      <div className="nx-remote-content"><App embedded /></div>
    </div>
  }

  return <div className="nx-shell">
    <nav className="nx-rail" aria-label="NEXUS workstation navigation">
      <div className="nx-brand"><div className="nx-brand-mark">N</div><div><strong>NEXUS</strong><span>Windows Workstation</span></div></div>
      <div className="nx-rail-label">Workspace</div>
      <button className={`nx-nav-item ${page === 'workstation' ? 'active' : ''}`} onClick={() => setPage('workstation')} aria-current={page === 'workstation' ? 'page' : undefined}><LayoutDashboard size={17} /><span>Workstation</span></button>
      <button className={`nx-nav-item ${page === 'projects' ? 'active' : ''}`} onClick={() => setPage('projects')} aria-current={page === 'projects' ? 'page' : undefined}><Boxes size={17} /><span>Local projects</span><span className="nx-nav-count">{projects.length}</span></button>
      <button className={`nx-nav-item ${page === 'environment' ? 'active' : ''}`} onClick={() => setPage('environment')} aria-current={page === 'environment' ? 'page' : undefined}><Wrench size={17} /><span>Environment</span></button>
      <button className={`nx-nav-item ${page === 'agent' ? 'active' : ''}`} onClick={() => setPage('agent')} aria-current={page === 'agent' ? 'page' : undefined}><Bot size={17} /><span>AI Agent</span></button>
      <div className="nx-rail-label nx-rail-lower">Management</div>
      <button className="nx-nav-item" onClick={() => setPage('remote')}><GitBranch size={17} /><span>Remote control</span><ChevronRight size={14} className="nx-nav-arrow" /></button>
      <div className="nx-rail-bottom"><ShieldCheck size={15} /><span>Folder access is user-selected</span></div>
    </nav>

    <div className="nx-main-column">
      <header className="nx-topbar">
        <div className="nx-location"><span>LOCAL MACHINE</span><ChevronRight size={14} /><strong>{currentSection[0]}</strong></div>
        <div className="nx-machine-state"><span className="nx-state-dot" /><span>Desktop agent active</span><span className="nx-top-divider" />{info ? `Windows ${info.osRelease} · ${info.arch}` : 'Starting local services'}</div>
      </header>

      <div className="nx-content-grid">
        <main className="nx-workarea">
          <div className="nx-page-heading">
            <div><p className="nx-overline">WINDOWS DEVELOPMENT WORKSTATION</p><h1>{currentSection[0]}</h1><p className="nx-subtitle">{currentSection[1]}</p></div>
            {page !== 'environment' && <button className="nx-primary" onClick={() => void handleAddProject()} disabled={busy === 'add'}><FolderPlus size={16} />{busy === 'add' ? 'Opening folder picker…' : 'Add local folder'}</button>}
          </div>

          {error && <div className="nx-alert" role="alert"><AlertTriangle size={17} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={15} /></button></div>}

          {page === 'workstation' && <>
            <section className="nx-readiness-bar" aria-label="Current execution permissions">
              <div className="nx-ready-symbol"><Computer size={19} /></div>
              <div className="nx-readiness-copy"><strong>This machine is ready for local project setup</strong><span>Scanning is read-only. File edits, builds, Git writes and publishing are not enabled in this phase.</span></div>
              <div className="nx-mode"><span className="nx-mode-dot" />READ-ONLY MODE</div>
            </section>
            <section className="nx-summary-strip" aria-label="Workstation summary">
              <div><span>Local projects</span><strong>{projects.length.toString().padStart(2, '0')}</strong><small>registered folders</small></div>
              <div><span>Tools detected</span><strong>{environment ? `${availableTools}/${environment.total}` : '—'}</strong><small>{environment ? 'paths and safe version probes completed' : 'checking environment'}</small></div>
              <div><span>Project scans</span><strong>{scannedCount.toString().padStart(2, '0')}</strong><small>read-only reports saved locally</small></div>
              <div><span>Windows startup</span><strong>{info?.autoStart ? 'On' : 'Off'}</strong><small>user-controlled preference</small></div>
            </section>
            <section className="nx-section-block">
              <div className="nx-section-heading"><div><h2>Local projects</h2><p>Only folders you add are visible to the workstation.</p></div><button className="nx-quiet-button" onClick={() => setPage('projects')}>View all <ChevronRight size={14} /></button></div>
              <ProjectTable projects={projects.slice(0, 5)} selectedId={selectedProject?.id || null} busy={busy} onSelect={setSelectedProjectId} onScan={handleScan} onRemove={handleRemove} onAdd={() => void handleAddProject()} />
            </section>
            <section className="nx-bottom-grid">
              <div className="nx-panel nx-env-panel"><div className="nx-panel-heading"><div><span className="nx-panel-icon"><Wrench size={16} /></span><h2>Development environment</h2></div><button className="nx-icon-button" aria-label="Recheck development tools" onClick={() => void refreshEnvironment()} disabled={busy === 'environment'}><RefreshCw size={15} className={busy === 'environment' ? 'nx-spinning' : ''} /></button></div>
                {environment ? <div className="nx-tool-preview">{environment.tools.filter((tool) => ['git', 'node', 'python', 'docker'].includes(tool.id)).map((tool) => <div className="nx-tool-line" key={tool.id}><span className={`nx-tool-mark ${['AVAILABLE', 'SHIM_FOUND', 'PATH_FOUND'].includes(tool.status) ? 'found' : ''}`} /> <span>{tool.label}</span><code>{tool.version || toolSummary(tool.status)}</code></div>)}</div> : <div className="nx-inline-loading">Checking installed tools…</div>}
                <button className="nx-text-action" onClick={() => setPage('environment')}>Open full environment report <ChevronRight size={14} /></button>
              </div>
              <div className="nx-panel nx-policy-panel"><div className="nx-panel-heading"><div><span className="nx-panel-icon subdued"><ShieldCheck size={16} /></span><h2>Execution boundary</h2></div><span className="nx-policy-label">IN FORCE</span></div>
                <div className="nx-policy-row"><Check size={14} /><span>Projects are chosen through the Windows folder dialog</span></div>
                <div className="nx-policy-row"><Check size={14} /><span>Scans skip symbolic links and stay within size limits</span></div>
                <div className="nx-policy-row pending"><CircleDot size={14} /><span>Changes and commands remain disabled until approval controls ship</span></div>
              </div>
            </section>
          </>}

          {page === 'projects' && <section className="nx-section-block nx-project-page"><div className="nx-section-heading"><div><h2>Registered folders</h2><p>Folder references are stored in this Windows user profile, separate from GitHub project records.</p></div><span className="nx-count-label">{projects.length} PROJECTS</span></div>
            <ProjectTable projects={projects} selectedId={selectedProject?.id || null} busy={busy} onSelect={setSelectedProjectId} onScan={handleScan} onRemove={handleRemove} onAdd={() => void handleAddProject()} />
          </section>}

          {page === 'environment' && <>
            <section className="nx-readiness-bar compact"><div className="nx-ready-symbol"><HardDrive size={18} /></div><div className="nx-readiness-copy"><strong>{environment ? `${availableTools} of ${environment.total} tools detected` : 'Environment detection is running'}</strong><span>Executables receive bounded version checks where safe. Command shims and Windows Terminal are detected by path without being invoked; multiple PATH entries are flagged as conflicts.</span></div><button className="nx-secondary" onClick={() => void refreshEnvironment()} disabled={busy === 'environment'}><RefreshCw size={14} className={busy === 'environment' ? 'nx-spinning' : ''} /> Recheck</button></section>
            <section className="nx-panel nx-environment-table"><div className="nx-panel-heading"><div><span className="nx-panel-icon"><Code2 size={16} /></span><h2>Installed development tools</h2></div><span className="nx-count-label">{environment ? new Date(environment.scannedAt).toLocaleTimeString() : 'CHECKING'}</span></div>
              {!environment && <div className="nx-empty-row">The first environment check is still running.</div>}
              {environment?.tools.map((tool) => <div className="nx-env-row" key={tool.id}>
                <span className={`nx-tool-mark ${['AVAILABLE', 'SHIM_FOUND', 'PATH_FOUND'].includes(tool.status) ? 'found' : ''}`} />
                <div className="nx-env-name"><strong>{tool.label}</strong><span>{tool.group}</span></div>
                <div className="nx-env-paths">{tool.paths.length ? tool.paths.map((entry) => <code key={entry} title={entry}>{entry}</code>) : <span>Not found on PATH</span>}</div>
                <div className="nx-env-version">{tool.version || toolSummary(tool.status)}{tool.conflict && <span className="nx-conflict"><AlertTriangle size={12} /> Multiple PATH entries</span>}{tool.diagnostic && <small>{tool.diagnostic}</small>}</div>
              </div>)}
            </section>
            <div className="nx-note"><ShieldCheck size={15} /><span>Detection only runs version commands for binaries found on PATH. It does not change PATH, install packages or elevate permissions.</span></div>
          </>}

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
        </main>

        {showActivity && <aside className="nx-activity-pane" aria-label="Recent local activity">
          <div className="nx-side-heading"><div><Activity size={16} /><h2>Activity</h2></div><button className="nx-icon-button" aria-label="Collapse activity panel" onClick={() => setShowActivity(false)}><PanelRightClose size={15} /></button></div>
          <div className="nx-activity-status"><span className="nx-state-dot" />Local service online</div>
          {selectedProject && <div className="nx-selected-project"><span>SELECTED PROJECT</span><strong>{selectedProject.name}</strong><code title={selectedProject.path}>{selectedProject.path}</code>{selectedProject.lastScan && <small>Last scan {shortTime(selectedProject.lastScan.scannedAt)}</small>}</div>}
          <div className="nx-activity-list">
            {activity.length === 0 && <div className="nx-activity-empty"><CircleDot size={17} /><strong>No activity yet</strong><span>Add a folder or check the environment to begin.</span></div>}
            {activity.slice(0, 12).map((entry) => <div className="nx-activity-item" key={entry.id}><span className={`nx-activity-marker ${entry.kind}`} /> <div><strong>{entry.label}</strong><span>{entry.detail}</span><small>{shortTime(entry.at)}</small></div></div>)}
          </div>
          <div className="nx-startup-setting"><div><strong>Start with Windows</strong><span>Launch NEXUS after you sign in</span></div><button className={`nx-switch ${info?.autoStart ? 'on' : ''}`} role="switch" aria-checked={Boolean(info?.autoStart)} aria-label="Start NEXUS with Windows" onClick={() => void toggleAutoStart(!info?.autoStart)}><span /></button></div>
        </aside>}
      </div>

      {!showActivity && <button className="nx-reopen-activity" onClick={() => setShowActivity(true)} aria-label="Open activity panel"><PanelRightOpen size={17} /></button>}
      <footer className={`nx-log-drawer ${showLog ? 'open' : ''}`}>
        <button className="nx-log-trigger" onClick={() => setShowLog((value) => !value)} aria-expanded={showLog}><TerminalSquare size={15} /><strong>Activity log</strong><span>{activity.length} events</span>{showLog ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        {showLog && <div className="nx-log-content" role="log">{activity.length ? activity.slice(0, 20).map((entry) => <div className="nx-log-row" key={entry.id}><time>{shortTime(entry.at)}</time><strong>{entry.label}</strong><span>{entry.detail}</span></div>) : <span className="nx-log-empty">Environment and project scan details will appear here. No terminal commands have been run.</span>}</div>}
      </footer>
    </div>
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
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null
  const configuredProviders = config?.providers.filter((provider) => provider.configured) || []
  const availableProjects = projects.filter((project) => project.available)
  const activeTask = selectedTask && ['Queued', 'Running'].includes(selectedTask.status)

  return <div className="nx-agent-page">
    <section className="nx-agent-compose nx-panel" aria-labelledby="nx-agent-compose-title">
      <div className="nx-panel-heading"><div><span className="nx-panel-icon"><Bot size={16} /></span><h2 id="nx-agent-compose-title">Describe a code change</h2></div><span className={`nx-agent-provider-state ${config?.configured ? 'ready' : 'blocked'}`}>{config?.configured ? 'Provider ready' : 'Provider required'}</span></div>
      <div className="nx-agent-compose-body">
        <div className="nx-agent-field-row">
          <label className="nx-agent-field"><span>Registered project</span><select value={projectId} onChange={(event) => onProjectChange(event.target.value)} disabled={!availableProjects.length}><option value="">Choose a project</option>{availableProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label className="nx-agent-field"><span>Configured provider</span><select value={providerId} onChange={(event) => onProviderChange(event.target.value)} disabled={!configuredProviders.length}><option value="">Choose a provider</option>{configuredProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.id} · {provider.model || provider.kind}</option>)}</select></label>
        </div>
        {!availableProjects.length && <div className="nx-agent-inline-note">Add a local folder with the button above before starting an Agent task.</div>}
        {!configuredProviders.length && <div className="nx-agent-inline-note warning">No provider is configured. Set AI provider values in the local service environment; API keys stay out of the renderer.</div>}
        <label className="nx-agent-field nx-agent-prompt"><span>Request <small>{new TextEncoder().encode(prompt).length} / {config?.limits.maxPromptBytes || 8192} bytes</small></span><textarea value={prompt} onChange={(event) => onPromptChange(event.target.value)} maxLength={8192} placeholder="Describe the intended change, constraints, and how you want the result structured." /></label>
        <div className="nx-agent-disclosure">
          <div className="nx-agent-disclosure-heading"><ShieldCheck size={16} /><strong>Source disclosure</strong></div>
          <p>Starting this task sends your prompt and up to {config?.limits.maxContextFiles || 20} eligible UTF-8 files from a bounded isolated copy to the selected provider. Source text is redacted and capped at {Math.round((config?.limits.maxProviderSourceBytesAfterRedaction || 122880) / 1024)} KiB after redaction. Secret-shaped paths and built-in dependency/build folders are skipped. Supported project <code>.gitignore</code> rules are applied; malformed or unsupported patterns stop workspace creation.</p>
          <label className="nx-agent-consent"><input type="checkbox" checked={disclosureConfirmed} onChange={(event) => onDisclosureChange(event.target.checked)} /><span>I reviewed this disclosure and authorize sending this task's bounded source context to the selected provider.</span></label>
        </div>
        <div className="nx-agent-compose-footer"><span>Candidate edits stay under the task workspace in app data.</span><button className="nx-primary" onClick={onStart} disabled={busy || !config?.configured || !projectId || !providerId || !prompt.trim() || !disclosureConfirmed}><Bot size={15} />{busy ? 'Queuing task…' : 'Generate isolated changes'}</button></div>
      </div>
    </section>

    <div className="nx-agent-work-grid">
      <section className="nx-agent-queue nx-panel" aria-labelledby="nx-agent-queue-title">
        <div className="nx-panel-heading"><div><span className="nx-panel-icon subdued"><Activity size={16} /></span><h2 id="nx-agent-queue-title">Task history</h2></div><button className="nx-icon-button" aria-label="Refresh Agent tasks" onClick={onRefresh}><RefreshCw size={14} /></button></div>
        {tasks.length ? <div className="nx-agent-task-list">{tasks.map((task) => <div className={`nx-agent-task-row ${selectedTaskId === task.id ? 'selected' : ''}`} key={task.id}>
          <button className="nx-agent-task-select" onClick={() => onSelectTask(task.id)} aria-current={selectedTaskId === task.id ? 'true' : undefined}><span className={`nx-agent-status-dot ${task.status.toLowerCase()}`} /><span className="nx-agent-task-copy"><strong>{task.label}</strong><small>{task.projectName} · {shortTime(task.updatedAt || task.createdAt)}</small><small>{task.changedFiles.length} isolated file change{task.changedFiles.length === 1 ? '' : 's'}</small></span><span className={`nx-agent-status ${task.status.toLowerCase()}`}>{task.status}</span></button>
          {['Queued', 'Running'].includes(task.status) && <button className="nx-agent-cancel" onClick={() => onCancel(task)} aria-label={`Cancel task ${task.label}`} title="Cancel task"><X size={14} /></button>}
        </div>)}</div> : <div className="nx-agent-empty"><CircleDot size={18} /><strong>No local Agent tasks</strong><span>New proposals and their saved state will appear here.</span></div>}
      </section>

      <section className="nx-agent-detail nx-panel" aria-labelledby="nx-agent-detail-title">
        <div className="nx-panel-heading"><div><span className="nx-panel-icon"><ScanSearch size={16} /></span><h2 id="nx-agent-detail-title">Isolated change review</h2></div>{selectedTask && <span className={`nx-agent-status ${selectedTask.status.toLowerCase()}`}>{selectedTask.status}</span>}</div>
        {!selectedTask ? <div className="nx-agent-empty"><ScanSearch size={18} /><strong>Select a task to inspect its result</strong><span>Generated file changes are shown here; the registered project stays untouched.</span></div> : <div className="nx-agent-detail-body">
          <div className="nx-agent-request"><span>REQUEST</span><p>{selectedTask.prompt}</p></div>
          {selectedTask.provider && <div className="nx-agent-meta"><span>{selectedTask.provider.id} · {selectedTask.provider.model}</span>{selectedTask.usage && <span>{selectedTask.usage.totalTokens.toLocaleString()} tokens</span>}{selectedTask.costUsd !== null && <span>${selectedTask.costUsd.toFixed(4)}</span>}</div>}
          {selectedTask.disclosedPaths.length > 0 && <details className="nx-agent-paths"><summary>Source paths disclosed ({selectedTask.disclosedPaths.length})</summary><ul>{selectedTask.disclosedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></details>}
          {selectedTask.error && <div className="nx-agent-error" role="alert">{selectedTask.error}</div>}
          {selectedTask.rationale && <div className="nx-agent-rationale"><span>PROVIDER RATIONALE</span><p>{selectedTask.rationale}</p></div>}
          <div className="nx-agent-change-heading"><strong>File differences</strong><span>{detail?.changes.length ?? selectedTask.changedFiles.length} change(s)</span></div>
          {detail?.changesError && <div className="nx-agent-error">Changes could not be read from the isolated workspace: {detail.changesError}</div>}
          {detail?.changes.length ? <div className="nx-agent-diff-list">{detail.changes.map((change) => <details className="nx-agent-diff" key={`${change.action}:${change.path}`} open={detail.changes.length === 1}><summary><span className={`nx-agent-diff-action ${change.action}`}>{change.action}</span><code>{change.path}</code></summary>
            {change.contentStatus === 'available' ? <div className="nx-agent-diff-content">{change.before !== null && <div><span>Before</span><pre>{change.before}</pre></div>}{change.after !== null && <div><span>After</span><pre>{change.after}</pre></div>}{change.action === 'deleted' && <div className="nx-agent-delete-note">This deletion occurred inside the isolated workspace.</div>}</div> : <div className="nx-agent-inline-note">Text preview unavailable: {change.contentStatus}.</div>}
          </details>)}</div> : <div className="nx-agent-no-diff">{activeTask ? 'The task is running. Its workspace and disclosed paths will appear as they are recorded.' : detail?.changesError ? 'No difference preview is available.' : 'No file changes were generated for this task.'}</div>}
          {selectedTask.events.length > 0 && <details className="nx-agent-events"><summary>Task events ({selectedTask.events.length})</summary><ol>{selectedTask.events.map((event, index) => <li key={`${event.at}:${index}`}><time>{shortTime(event.at)}</time><span>{event.detail}</span></li>)}</ol></details>}
          {selectedTask.status !== 'Queued' && selectedTask.status !== 'Running' && <div className="nx-agent-retry-row"><span>Retry creates a new isolated task and requires fresh source disclosure.</span><button className="nx-secondary" onClick={() => onRetry(selectedTask)} disabled={!disclosureConfirmed || !configuredProviders.some((provider) => provider.id === selectedTask.providerId)}>Retry task</button></div>}
        </div>}
      </section>
    </div>
    <div className="nx-note nx-agent-capability-note"><ShieldCheck size={15} /><span>This version records task state and creates reviewable changes in an isolated copy. It does not apply changes to the registered folder, execute commands, run tests, or provide Git apply/rollback controls.</span></div>
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
  if (!projects.length) return <div className="nx-empty-projects"><div className="nx-empty-symbol"><FolderPlus size={19} /></div><strong>No local projects have been added</strong><span>Choose a project folder. NEXUS will not search other folders on this computer.</span><button className="nx-secondary" onClick={onAdd}><FolderPlus size={14} /> Add local folder</button></div>
  return <div className="nx-project-list" role="list">
    {projects.map((project) => <article className={`nx-project-row ${selectedId === project.id ? 'selected' : ''} ${project.available ? '' : 'missing'}`} key={project.id} role="listitem">
      <button className="nx-project-identity" onClick={() => onSelect(project.id)} aria-pressed={selectedId === project.id}>
        <div className="nx-project-glyph"><Boxes size={17} /></div>
        <div className="nx-project-copy"><strong title={project.name}>{project.name}{!project.available && <span className="nx-missing-label">{project.availability === 'MISSING' ? 'Folder missing' : 'Path changed'}</span>}</strong><code title={project.path}>{project.path}</code><div className="nx-tech-list">{project.lastScan?.technologies.length ? project.lastScan.technologies.map((technology) => <span key={technology}>{technology}</span>) : <span className="quiet">Not scanned</span>}{project.lastScan?.truncated && <span className="nx-truncated">Scan limit reached</span>}</div></div>
      </button>
      <div className="nx-project-scan">{project.lastScan ? <><span className="nx-scan-status"><Check size={13} /> Scanned</span><small>{shortTime(project.lastScan.scannedAt)}</small></> : <span className="nx-scan-status waiting"><CircleDot size={13} /> Awaiting scan</span>}</div>
      <div className="nx-project-actions"><button className="nx-row-action" onClick={() => onScan(project.id, project.name)} disabled={!project.available || busy === project.id} aria-label={`Scan ${project.name}`}><ScanSearch size={15} />{busy === project.id ? 'Scanning…' : 'Scan'}</button><button className="nx-delete-action" onClick={() => void onRemove(project)} aria-label={`Remove ${project.name} from NEXUS`}><Trash2 size={15} /></button></div>
    </article>)}
  </div>
}
