import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity, AlertTriangle, ArrowUpRight, Bot, Boxes, CheckCircle2, CircleDot, Code2, GitBranch,
  GitFork, GitPullRequest, Hammer, LayoutDashboard, ListChecks, Loader2, Menu, PackageCheck, Plus, Radio, RefreshCw,
  Rocket, Search, Settings2, ShieldCheck, Sparkles, TerminalSquare, Webhook, XCircle
} from 'lucide-react'
import { api, IntegrationJob, IntegrationReport, Project, Task } from './api'

type Page = 'Overview' | 'Projects' | 'Build Center' | 'Release Center' | 'Auto Update' | 'Repository Scanner' | 'AI Pipeline' | 'Adapter Center' | 'Update Security' | 'Integration History' | 'GitHub Connections' | 'Monitoring' | 'AI Operations' | 'Task Center' | 'Security Center' | 'Settings'

const nav: { label: Page; icon: typeof LayoutDashboard }[] = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Projects', icon: Boxes },
  { label: 'Build Center', icon: Hammer },
  { label: 'Release Center', icon: PackageCheck },
  { label: 'Auto Update', icon: RefreshCw },
  { label: 'Repository Scanner', icon: Code2 },
  { label: 'AI Pipeline', icon: Bot },
  { label: 'Adapter Center', icon: Boxes },
  { label: 'Update Security', icon: ShieldCheck },
  { label: 'Integration History', icon: Activity },
  { label: 'GitHub Connections', icon: GitFork },
  { label: 'Monitoring', icon: Radio },
  { label: 'AI Operations', icon: Bot },
  { label: 'Task Center', icon: ListChecks },
  { label: 'Security Center', icon: ShieldCheck },
  { label: 'Settings', icon: Settings2 }
]

const metricMeta: { key: string; label: string; icon: typeof Boxes; tone: string }[] = [
  { key: 'repositories', label: 'Repositories', icon: GitFork, tone: 'cyan' },
  { key: 'managedProjects', label: 'Managed projects', icon: Boxes, tone: 'blue' },
  { key: 'runningTasks', label: 'Running tasks', icon: Activity, tone: 'violet' },
  { key: 'successfulBuilds', label: 'Successful builds', icon: CheckCircle2, tone: 'green' },
  { key: 'failedBuilds', label: 'Failed builds', icon: XCircle, tone: 'red' },
  { key: 'releases', label: 'Latest releases', icon: PackageCheck, tone: 'amber' },
  { key: 'autoUpdateProjects', label: 'Auto update ready', icon: RefreshCw, tone: 'teal' },
  { key: 'alerts', label: 'Open alerts', icon: AlertTriangle, tone: 'orange' }
]

function formatDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function StatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase()
  const tone = normalized.includes('success') || normalized === 'completed' ? 'success' : normalized.includes('fail') ? 'danger' : normalized.includes('block') ? 'warning' : normalized.includes('run') || normalized.includes('pend') ? 'info' : 'muted'
  return <span className={`status-pill ${tone}`}><span className="status-dot" />{status}</span>
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-orbit"><CircleDot size={18} /></div><h3>{title}</h3><p>{detail}</p>{action}</div>
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
  return <button className="project-card" onClick={onOpen}>
    <div className="project-card-top"><div className="repo-mark"><GitFork size={17} /></div><span className="project-visibility">{project.visibility}</span></div>
    <div className="project-card-title">{project.name}</div>
    <div className="project-card-repo">{project.fullName}</div>
    <p>{project.description || 'No repository description provided.'}</p>
    <div className="project-card-footer"><span>{project.language}</span><span>{project.group}</span><span>{formatDate(project.updatedAt)}</span></div>
  </button>
}

export default function App({ embedded = false }: { embedded?: boolean } = {}) {
  const [page, setPage] = useState<Page>('Overview')
  const [mobileNav, setMobileNav] = useState(false)
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof api.overview>> | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [status, setStatus] = useState<{ configured: boolean; owner: string | null; apiUrl: string; permissions: string[] } | null>(null)
  const [query, setQuery] = useState('')
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    setLoading(true)
    try {
      const [nextOverview, nextProjects, nextStatus, nextTasks] = await Promise.all([api.overview(), api.projects(query), api.githubStatus(), api.tasks()])
      setOverview(nextOverview); setProjects(nextProjects.projects); setStatus(nextStatus); setTasks(nextTasks.tasks)
    } catch (error) { setToast(error instanceof Error ? error.message : 'Unable to load control center') }
    finally { setLoading(false) }
  }

  useEffect(() => { void refresh() }, [query])
  useEffect(() => {
    const handler = (event: Event) => setPage((event as CustomEvent<Page>).detail)
    window.addEventListener('navigate', handler)
    return () => window.removeEventListener('navigate', handler)
  }, [])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 4200); return () => window.clearTimeout(timer) }, [toast])

  const openProject = (project: Project) => { setSelectedProject(project); setPage('Build Center') }
  const sync = async () => { try { await api.syncRepositories(); setToast('Repository sync queued'); void refresh() } catch (error) { setToast(error instanceof Error ? error.message : 'Sync failed') } }
  const metrics = overview?.metrics || {}
  const pageTitle = page === 'Overview' ? 'Control center' : page

  return <div className={`app-shell ${embedded ? 'embedded-console' : ''}`}>
    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <div className="brand"><div className="brand-glyph"><span /></div><div><strong>NEXUS</strong><small>GitHub control center</small></div></div>
      <div className="sidebar-section-label">Workspace</div>
      <nav>{nav.map(({ label, icon: Icon }) => <button key={label} className={page === label ? 'nav-item active' : 'nav-item'} onClick={() => { setPage(label); setMobileNav(false) }}><Icon size={17} /><span>{label}</span>{label === 'Task Center' && tasks.some((task) => ['Pending', 'Running'].includes(task.status)) && <span className="nav-count">{tasks.filter((task) => ['Pending', 'Running'].includes(task.status)).length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="connection-card"><div className={`connection-led ${status?.configured ? 'live' : ''}`} /><div><strong>{status?.configured ? 'GitHub connected' : 'GitHub not connected'}</strong><span>{status?.configured ? status.owner || 'Authenticated account' : 'Add token to unlock live data'}</span></div></div><div className="sidebar-foot"><ShieldCheck size={14} /> Least privilege by default</div></div>
    </aside>
    {mobileNav && <button className="scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}
    <main className="main-area">
      <header className="topbar"><button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)}><Menu size={20} /></button><div className="breadcrumb"><span>PROJECT NEXUS</span><span>/</span><strong>{pageTitle}</strong></div><div className="top-actions"><div className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search repositories" aria-label="Search repositories" /></div><button className="icon-button" onClick={() => void refresh()} aria-label="Refresh"><RefreshCw size={16} /></button><div className="avatar">LN</div></div></header>
      <div className="content">
        {page === 'Overview' && <Overview metrics={metrics} projects={overview?.projects || []} tasks={overview?.tasks || []} activity={overview?.activity || []} configured={Boolean(status?.configured)} onSync={sync} onOpen={openProject} loading={loading} />}
        {page === 'Projects' && <Projects projects={projects} query={query} onSync={sync} onOpen={openProject} onScan={(project) => api.integrationScan(project.id).then(() => { setToast(`Scan queued for ${project.fullName}`); void refresh() }).catch((error) => setToast(error.message))} />}
        {page === 'Build Center' && <BuildCenter projects={projects} selectedProject={selectedProject} onSelect={setSelectedProject} onToast={setToast} />}
        {page === 'Release Center' && <ReleaseCenter projects={projects} onToast={setToast} />}
        {page === 'Auto Update' && <AutoUpdate projects={projects} onToast={setToast} />}
        {page === 'Repository Scanner' && <RepositoryScanner projects={projects} onToast={setToast} />}
        {page === 'AI Pipeline' && <AIIntegrationPipeline onToast={setToast} />}
        {page === 'Adapter Center' && <AdapterCenter onToast={setToast} />}
        {page === 'Update Security' && <UpdateSecurity onToast={setToast} />}
        {page === 'Integration History' && <IntegrationHistory onToast={setToast} />}
        {page === 'GitHub Connections' && <GitHubConnections onToast={setToast} />}
        {page === 'Monitoring' && <Monitoring projects={projects} tasks={tasks} metrics={metrics} />}
        {page === 'AI Operations' && <AIOperations configured={Boolean(status?.configured)} />}
        {page === 'Task Center' && <TaskCenter tasks={tasks} onRefresh={refresh} onToast={setToast} />}
        {page === 'Security Center' && <SecurityCenter onToast={setToast} />}
        {page === 'Settings' && <SettingsPage status={status} />}
      </div>
    </main>
    {toast && <div className="toast"><TerminalSquare size={16} />{toast}<button onClick={() => setToast(null)}><XCircle size={14} /></button></div>}
  </div>
}

function PageIntro({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: ReactNode }) {
  return <div className="page-intro"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{detail}</p></div>{action}</div>
}

function Overview({ metrics, projects, tasks, activity, configured, onSync, onOpen, loading }: { metrics: Record<string, number>; projects: Project[]; tasks: Task[]; activity: { id: string; message: string; at: string }[]; configured: boolean; onSync: () => void; onOpen: (p: Project) => void; loading: boolean }) {
  return <><PageIntro eyebrow="Operational overview" title="Control center" detail="A single operating surface for repositories, builds, releases, and project health." action={<button className="primary-button" onClick={onSync}><RefreshCw size={16} /> Sync GitHub</button>} />
    {!configured && <div className="notice-banner"><div className="notice-icon"><GitFork size={17} /></div><div><strong>Connect GitHub to populate this workspace</strong><span>Set GITHUB_TOKEN in .env, restart the API, then sync repositories. The interface stays empty until it has real data.</span></div><button className="text-button">Open setup <ArrowUpRight size={14} /></button></div>}
    <section className="metric-grid">{metricMeta.map(({ key, label, icon: Icon, tone }) => <div className={`metric-card ${tone}`} key={key}><div className="metric-icon"><Icon size={17} /></div><div className="metric-label">{label}</div><div className="metric-value">{metrics[key] ?? 0}</div><div className="metric-foot">{key === 'alerts' ? 'Needs review' : configured ? 'Live workspace data' : 'Waiting for connection'}</div></div>)}</section>
    <section className="overview-grid"><div className="panel projects-panel"><div className="panel-head"><div><div className="panel-kicker">Managed surface</div><h2>Projects</h2></div><button className="ghost-button" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: 'Projects' }))}>View all <ArrowUpRight size={14} /></button></div>{loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> Loading workspace</div> : projects.length ? <div className="project-grid">{projects.slice(0, 4).map((project) => <ProjectCard key={project.id} project={project} onOpen={() => onOpen(project)} />)}</div> : <EmptyState title="No repositories in this workspace" detail="Sync authorized GitHub repositories to make this surface useful." action={<button className="secondary-button" onClick={onSync}>Sync repositories</button>} />}</div>
      <div className="panel activity-panel"><div className="panel-head"><div><div className="panel-kicker">Signal feed</div><h2>Recent activity</h2></div><Activity size={17} className="muted-icon" /></div>{activity.length ? <div className="activity-list">{activity.map((item) => <div className="activity-row" key={item.id}><div className="activity-dot" /><div><strong>{item.message}</strong><span>{formatDate(item.at)}</span></div></div>)}</div> : <EmptyState title="Activity will appear here" detail="Repository syncs and build actions are recorded as they happen." />}</div></section>
    <section className="panel task-strip"><div className="panel-head"><div><div className="panel-kicker">Execution layer</div><h2>Task pulse</h2></div><div className="live-chip"><span /> Live state</div></div>{tasks.length ? <div className="task-table">{tasks.slice(0, 5).map((task) => <div className="task-row" key={task.id}><div className="task-name"><span className="task-type">{task.type}</span><strong>{task.label}</strong></div><StatusPill status={task.status} /><span className="task-time">{formatDate(task.createdAt)}</span></div>)}</div> : <EmptyState title="No tasks yet" detail="Syncing repositories and dispatching builds will create durable task records." />}</section>
  </>
}

function Projects({ projects, query, onSync, onOpen, onScan }: { projects: Project[]; query: string; onSync: () => void; onOpen: (p: Project) => void; onScan: (p: Project) => void }) {
  const groups = useMemo(() => [...new Set(projects.map((project) => project.group))].filter(Boolean), [projects])
  return <><PageIntro eyebrow="Repository registry" title="Projects" detail="Every repository keeps its own branch, build, release, and deployment context." action={<button className="primary-button" onClick={onSync}><RefreshCw size={16} /> Sync repositories</button>} /><div className="filter-bar"><div className="filter-summary"><span className="data-count">{projects.length}</span><span>repositories visible</span>{query && <span className="filter-query">matching “{query}”</span>}</div><div className="group-chips"><button className="chip active">All</button>{groups.map((group) => <button className="chip" key={group}>{group}</button>)}</div></div>{projects.length ? <div className="project-list-grid">{projects.map((project) => <div className="project-list-item" key={project.id}><ProjectCard project={project} onOpen={() => onOpen(project)} /><button className="scan-button" onClick={() => onScan(project)} title="Scan repository files"><Code2 size={15} /> Scan stack</button></div>)}</div> : <div className="panel"><EmptyState title="Repository registry is empty" detail="Use Sync repositories after configuring a GitHub token. Public and private access follow the token's scope." action={<button className="secondary-button" onClick={onSync}>Start sync</button>} /></div>}</>
}

function BuildCenter({ projects, selectedProject, onSelect, onToast }: { projects: Project[]; selectedProject: Project | null; onSelect: (p: Project | null) => void; onToast: (message: string) => void }) {
  const [workflows, setWorkflows] = useState<{ id: number; name: string; path: string; state: string }[]>([])
  const [runs, setRuns] = useState<{ id: number; name: string; status: string; conclusion: string | null; created_at: string; html_url: string }[]>([])
  const [loading, setLoading] = useState(false)
  const load = async (project: Project) => { setLoading(true); try { const [wf, run] = await Promise.all([api.workflows(project.id), api.runs(project.id)]); setWorkflows(wf.workflows); setRuns(run.runs) } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to load workflows') } finally { setLoading(false) } }
  useEffect(() => { if (selectedProject) void load(selectedProject); else { setWorkflows([]); setRuns([]) } }, [selectedProject])
  const trigger = async (workflowId: number) => { if (!selectedProject) return; try { await api.build(selectedProject.id, workflowId, selectedProject.defaultBranch); onToast('Build dispatch queued'); void load(selectedProject) } catch (error) { onToast(error instanceof Error ? error.message : 'Build dispatch failed') } }
  return <><PageIntro eyebrow="GitHub Actions" title="Build Center" detail="Inspect workflows, dispatch builds, and follow runs from one project-aware surface." /><div className="build-layout"><div className="panel project-picker"><div className="panel-kicker">Target repository</div><h2>Choose a project</h2><div className="select-list">{projects.length ? projects.map((project) => <button key={project.id} className={selectedProject?.id === project.id ? 'select-row selected' : 'select-row'} onClick={() => onSelect(project)}><div className="repo-mark"><GitFork size={15} /></div><div><strong>{project.fullName}</strong><span>{project.defaultBranch} · {project.language}</span></div><ArrowUpRight size={14} /></button>) : <EmptyState title="No target repositories" detail="Sync repositories before opening a build context." />}</div></div><div className="build-main"><div className="panel"><div className="panel-head"><div><div className="panel-kicker">Workflow catalog</div><h2>{selectedProject ? selectedProject.fullName : 'Select a repository'}</h2></div>{loading && <Loader2 className="spin" size={18} />}</div>{selectedProject ? workflows.length ? <div className="workflow-list">{workflows.map((workflow) => <div className="workflow-row" key={workflow.id}><div className="workflow-icon"><GitBranch size={16} /></div><div className="workflow-copy"><strong>{workflow.name}</strong><span>{workflow.path} · {workflow.state}</span></div><button className="secondary-button compact" onClick={() => void trigger(workflow.id)}><Rocket size={14} /> Run workflow</button></div>)}</div> : <EmptyState title="No workflows discovered" detail="GitHub returned no Actions workflows for this repository." /> : <EmptyState title="Build context is waiting" detail="Select a repository to load its real GitHub Actions workflows." />}</div><div className="panel"><div className="panel-head"><div><div className="panel-kicker">Execution history</div><h2>Recent runs</h2></div><GitPullRequest size={17} className="muted-icon" /></div>{runs.length ? <div className="run-list">{runs.map((run) => <a className="run-row" href={run.html_url} target="_blank" rel="noreferrer" key={run.id}><div><strong>{run.name}</strong><span>{formatDate(run.created_at)}</span></div><StatusPill status={run.conclusion || run.status} /><ArrowUpRight size={14} /></a>)}</div> : <EmptyState title="No run history loaded" detail="Choose a repository with Actions access to view recent runs." />}</div></div></div></>
}

function ReleaseCenter({ projects, onToast }: { projects: Project[]; onToast: (message: string) => void }) {
  const [releases, setReleases] = useState<Awaited<ReturnType<typeof api.releases>>['releases']>([])
  const [loading, setLoading] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id || '')
  const [tagName, setTagName] = useState('v0.1.0')
  const [releaseName, setReleaseName] = useState('')
  const [releaseBody, setReleaseBody] = useState('')
  const load = async () => { setLoading(true); try { const data = await api.releases(); setReleases(data.releases) } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to load releases') } finally { setLoading(false) } }
  useEffect(() => { void load() }, [])
  const createDraft = async () => {
    if (!selectedProjectId) return onToast('Choose a repository first')
    try { await api.createRelease(selectedProjectId, { tagName, name: releaseName || tagName, body: releaseBody }); onToast('Release draft queued'); setReleaseBody(''); void load() } catch (error) { onToast(error instanceof Error ? error.message : 'Release draft failed') }
  }
  return <><PageIntro eyebrow="Version control" title="Release Center" detail="Create drafts, inspect release assets, and keep publishing behind an explicit administrator confirmation." action={<button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} /> Refresh releases</button>} />
    <div className="release-create-grid"><div className="panel release-form"><div className="panel-kicker">Draft a release</div><h2>Prepare a version</h2><label>Repository<select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>{projects.map((project) => <option value={project.id} key={project.id}>{project.fullName}</option>)}</select></label><div className="form-two"><label>Tag<input value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="v1.2.3" /></label><label>Name<input value={releaseName} onChange={(event) => setReleaseName(event.target.value)} placeholder="Release name" /></label></div><label>Notes<textarea value={releaseBody} onChange={(event) => setReleaseBody(event.target.value)} placeholder="Release notes can be edited before publishing." /></label><button className="primary-button" onClick={() => void createDraft()}><Plus size={15} /> Create draft</button></div><div className="panel release-policy"><div className="panel-kicker">Publishing policy</div><h2>Approval gates</h2><div className="guardrail"><ShieldCheck size={16} /><div><strong>Semantic version required</strong><span>Existing tags are checked before a draft is created.</span></div></div><div className="guardrail"><ShieldCheck size={16} /><div><strong>Assets are digestable</strong><span>Uploaded assets receive a SHA-256 record in the audit trail.</span></div></div><div className="guardrail"><ShieldCheck size={16} /><div><strong>Publish requires Administrator</strong><span>Production release publishing needs confirm=true and an administrator role.</span></div></div></div></div>
    {!projects.length && <div className="notice-banner"><div className="notice-icon"><PackageCheck size={17} /></div><div><strong>Release data is empty</strong><span>Sync repositories first. Releases are fetched from GitHub when a token is configured.</span></div></div>}
    <div className="panel release-panel">{loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> Reading GitHub Releases</div> : releases.length ? <div className="release-list">{releases.map((release) => <div className="release-row" key={release.id}><a className="release-copy" href={release.html_url} target="_blank" rel="noreferrer"><strong>{release.name || release.tag_name}</strong><span>{release.projectName} · {release.published_at ? formatDate(release.published_at) : 'Unpublished draft'}</span></a><div className="release-tag">{release.tag_name}</div><div className="release-state">{release.draft ? 'Draft' : release.prerelease ? 'Pre-release' : 'Published'}</div>{release.draft && <button className="secondary-button compact" onClick={() => { const project = projects.find((item) => release.projectName === item.fullName); if (project) void api.publishRelease(project.id, release.id).then(() => onToast('Release publish queued')).catch((error) => onToast(error.message)) }}><Rocket size={14} /> Publish</button>}<ArrowUpRight size={15} /></div>)}</div> : <EmptyState title="No releases returned" detail="This is a live read. A blank result means GitHub returned no releases for the current repository set." action={<button className="secondary-button" onClick={() => void load()}>Try again</button>} />}</div></>
}

function AutoUpdate({ projects, onToast }: { projects: Project[]; onToast: (message: string) => void }) {
  const [configs, setConfigs] = useState<Awaited<ReturnType<typeof api.autoUpdate>>['configs']>([])
  const [loading, setLoading] = useState(false)
  const load = async () => { setLoading(true); try { setConfigs((await api.autoUpdate()).configs) } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to load update checks') } finally { setLoading(false) } }
  useEffect(() => { void load() }, [])
  const checkAll = async () => { try { await api.updateCheckAll(); onToast('Update checks queued'); void load() } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to queue update checks') } }
  return <><PageIntro eyebrow="Cross-platform updates" title="Auto Update" detail="Inspect real project files, manifests, channels, digests, and signing evidence across the repository set." action={<button className="primary-button" onClick={() => void checkAll()}><RefreshCw size={15} /> Check all projects</button>} />
    <div className="update-summary"><div><span>Projects checked</span><strong>{configs.length}</strong></div><div><span>Ready</span><strong className="success-text">{configs.filter((item) => item.security.status === 'READY').length}</strong></div><div><span>Blocked</span><strong className="danger-text">{configs.filter((item) => item.security.status === 'BLOCKED').length}</strong></div><div><span>Last check</span><strong>{configs[0] ? formatDate(configs[0].checkedAt) : '—'}</strong></div></div>
    <div className="panel update-panel">{loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> Reading update evidence</div> : configs.length ? <div className="update-list">{configs.map((config) => <div className="update-row" key={config.id}><div className="repo-mark"><RefreshCw size={15} /></div><div className="update-copy"><strong>{config.projectName}</strong><span>{config.framework} · {config.channel} · {config.currentVersion || 'version unknown'}</span><small>{config.evidence.length ? `${config.evidence.length} evidence files · ${config.evidence.slice(0, 3).join(', ')}` : 'No supported update evidence found'}</small></div><div className="update-health"><strong>{config.completeness}%</strong><StatusPill status={config.security.status} /></div><button className="icon-button" title="Recheck project" onClick={() => void api.updateCheck(config.projectId).then(() => { onToast(`Update check queued for ${config.projectName}`); void load() }).catch((error) => onToast(error.message))}><RefreshCw size={14} /></button></div>)}</div> : <EmptyState title="No update checks yet" detail="Run a check to inspect Electron, Tauri, Python, .NET, Java, and web update signals from real repository files." action={<button className="secondary-button" onClick={() => void checkAll()}>Run first check</button>} />}</div>
    <div className="panel"><div className="panel-head"><div><div className="panel-kicker">Security semantics</div><h2>What the checks mean</h2></div><ShieldCheck size={17} className="muted-icon" /></div><div className="signal-row"><span>SHA-256</span><strong>Content integrity</strong></div><div className="signal-row"><span>Signature</span><strong>Publisher authenticity</strong></div><div className="signal-row"><span>HTTPS</span><strong>Transport protection</strong></div><div className="signal-row"><span>Blocked</span><strong>Required evidence missing</strong></div></div></>
}

function RepositoryScanner({ projects, onToast }: { projects: Project[]; onToast: (message: string) => void }) {
  const [reports, setReports] = useState<IntegrationReport[]>([])
  const [jobs, setJobs] = useState<IntegrationJob[]>([])
  const [schedule, setSchedule] = useState<{ enabled: boolean; intervalHours: number; nextRunAt: string | null }>({ enabled: false, intervalHours: 24, nextRunAt: null })
  const [loading, setLoading] = useState(true)
  const [queueing, setQueueing] = useState(false)
  const load = async () => {
    try {
      const [reportResult, jobResult, scheduleResult] = await Promise.all([api.integrationReports(), api.integrationJobs(), api.integrationSchedule()])
      setReports(reportResult.reports); setJobs(jobResult.jobs)
      const current = scheduleResult.schedules.find((item) => item.id === 'repository-update-scan')
      if (current) setSchedule({ enabled: current.enabled, intervalHours: current.intervalHours, nextRunAt: current.nextRunAt })
    } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to load repository scan data') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 4000); return () => window.clearInterval(timer) }, [])
  const latest = new Map<string, IntegrationReport>()
  for (const report of reports) if (!latest.has(report.projectId)) latest.set(report.projectId, report)
  const activeFor = (projectId: string) => jobs.some((job) => job.projectId === projectId && ['Pending', 'Running'].includes(job.status))
  const scanAll = async () => {
    setQueueing(true)
    try { const result = await api.integrationScanAll(); onToast(`Queued ${result.jobs.filter((entry) => !entry.reused).length} repository scan(s)${result.blocked.length ? ` · ${result.blocked.length} blocked` : ''}`); await load() }
    catch (error) { onToast(error instanceof Error ? error.message : 'Unable to queue scans') }
    finally { setQueueing(false) }
  }
  const toggleSchedule = async () => {
    try {
      const result = await api.updateIntegrationSchedule({ enabled: !schedule.enabled, intervalHours: schedule.intervalHours })
      setSchedule({ enabled: result.schedule.enabled, intervalHours: result.schedule.intervalHours, nextRunAt: result.schedule.nextRunAt })
      onToast(result.schedule.enabled ? 'Scheduled repository checks enabled' : 'Scheduled repository checks paused')
    } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to update scan schedule') }
  }
  return <>
    <PageIntro eyebrow="Repository evidence" title="Repository Scanner" detail="Read the default branch at a fixed commit, inspect bounded source evidence, and save one assessment per repository." action={<button className="primary-button" onClick={() => void scanAll()} disabled={queueing || !projects.length}><RefreshCw size={15} /> {queueing ? 'Queueing scans' : 'Scan all repositories'}</button>} />
    <div className="update-summary"><div><span>Managed repositories</span><strong>{projects.length}</strong></div><div><span>Repositories assessed</span><strong>{new Set(reports.map((report) => report.projectId)).size}</strong></div><div><span>Queued or running</span><strong>{jobs.filter((job) => ['Pending', 'Running'].includes(job.status)).length}</strong></div><div><span>End-to-end verified</span><strong className="warning-text">0</strong></div></div>
    <div className="panel scanner-panel"><div className="panel-head"><div><div className="panel-kicker">Repository inventory</div><h2>Update capability evidence</h2></div><button className="secondary-button compact" onClick={() => void load()}><RefreshCw size={14} /> Refresh</button></div>
      {loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> Loading scan history</div> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Repository</th><th>Detected stack</th><th>Assessment</th><th>Last scanned commit</th><th>Action</th></tr></thead><tbody>{projects.map((project) => {
        const report = latest.get(project.id); const running = activeFor(project.id)
        return <tr key={project.id}><td><strong>{project.fullName}</strong><small>{project.defaultBranch}</small></td><td>{report?.components.length ? report.components.map((component) => component.name).join(', ') : <span className="muted-text">{report ? 'No supported component detected' : 'Not scanned'}</span>}</td><td>{report ? <StatusPill status={`${report.assessment.status} · ${report.assessment.score}`} /> : <StatusPill status="Not scanned" />}</td><td><code>{report?.commitSha.slice(0, 10) || '—'}</code><small>{formatDate(report?.scannedAt)}</small></td><td><button className="secondary-button compact" disabled={running} onClick={() => void api.integrationScan(project.id).then(() => { onToast(`Scan queued for ${project.fullName}`); void load() }).catch((error) => onToast(error.message))}>{running ? 'Scanning' : 'Scan'}</button></td></tr>
      })}</tbody></table>{!projects.length && <EmptyState title="No repositories to scan" detail="Sync GitHub repositories to start collecting update evidence." />}</div>}
    </div>
    <div className="scanner-bottom-grid"><div className="panel"><div className="panel-head"><div><div className="panel-kicker">Scheduled inspection</div><h2>Recurring checks</h2></div><StatusPill status={schedule.enabled ? 'Enabled' : 'Paused'} /></div><div className="schedule-row"><label>Interval<select value={schedule.intervalHours} onChange={(event) => setSchedule((value) => ({ ...value, intervalHours: Number(event.target.value) }))}><option value={6}>Every 6 hours</option><option value={12}>Every 12 hours</option><option value={24}>Daily</option><option value={168}>Weekly</option></select></label><button className="secondary-button" onClick={() => void toggleSchedule()}>{schedule.enabled ? 'Pause schedule' : 'Enable schedule'}</button></div><p className="helper-copy">Next run: {schedule.enabled ? formatDate(schedule.nextRunAt || undefined) : 'Not scheduled'}. Scheduling queues bounded scans and skips repositories that already have an active scan.</p></div>
      <div className="panel"><div className="panel-head"><div><div className="panel-kicker">Evidence boundary</div><h2>What this scanner proves</h2></div><ShieldCheck size={17} className="muted-icon" /></div><div className="guardrail"><Code2 size={16} /><div><strong>Commit pinned source evidence</strong><span>Each report records the commit SHA, selected paths, read errors and scan limits.</span></div></div><div className="guardrail"><AlertTriangle size={16} /><div><strong>Static evidence remains unverified</strong><span>Textual configuration does not prove a valid signature or an installed client update.</span></div></div></div></div>
  </>
}

function AIIntegrationPipeline({ onToast }: { onToast: (message: string) => void }) {
  const [reports, setReports] = useState<IntegrationReport[]>([])
  const [jobs, setJobs] = useState<IntegrationJob[]>([])
  const [provider, setProvider] = useState<{ configured: boolean; baseUrl: string | null; model: string | null; remoteWritesEnabled: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedReportId, setSelectedReportId] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try {
      const [reportResult, jobResult, adapterResult] = await Promise.all([api.integrationReports(), api.integrationJobs(), api.integrationAdapters()])
      setReports(reportResult.reports); setJobs(jobResult.jobs); setProvider({ ...adapterResult.ai, remoteWritesEnabled: adapterResult.remoteWritesEnabled })
      if (!selectedReportId && reportResult.reports[0]) setSelectedReportId(reportResult.reports[0].id)
    } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to load AI pipeline') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 4000); return () => window.clearInterval(timer) }, [])
  const selected = reports.find((report) => report.id === selectedReportId)
  const prepare = async () => {
    if (!selected || !window.confirm(`Selected source files from ${selected.repository} will be sent to the configured AI provider for analysis. Continue?`)) return
    setBusy(true)
    try { const result = await api.prepareIntegration(selected.id, true); onToast(result.blocked ? 'AI change job recorded as blocked' : 'Isolated AI change job queued'); await load() }
    catch (error) { onToast(error instanceof Error ? error.message : 'Unable to queue AI change job') }
    finally { setBusy(false) }
  }
  const createPullRequest = async (job: IntegrationJob) => {
    const branch = job.currentBranch || job.branch || 'unknown branch'
    if (!window.confirm(`Open a draft pull request for ${job.repository} from ${branch}? This pushes the reviewed branch. It does not merge or publish.`)) return
    try { const result = await api.createIntegrationPullRequest(job, true); onToast(`Draft pull request #${result.pullRequest.number} opened`); await load() }
    catch (error) { onToast(error instanceof Error ? error.message : 'Pull request creation failed') }
  }
  return <>
    <PageIntro eyebrow="Local code change workflow" title="AI Integration Pipeline" detail="Analyze a saved report, propose scoped file operations, test in an isolated workspace, then prepare a reviewable draft PR." />
    <div className="ai-hero"><div className="ai-orb"><Bot size={25} /></div><div><div className="eyebrow purple">Model provider</div><h2>{provider?.configured ? `${provider.model} configured` : 'Provider configuration required'}</h2><p>{provider?.configured ? `Selected source is disclosed to ${provider.baseUrl}. Secret-like values are redacted before sending.` : 'Set AI_BASE_URL, AI_API_KEY, and AI_MODEL on the server. NEXUS records the blocked job and does not fabricate generated changes.'}</p></div><StatusPill status={provider?.configured ? 'Ready' : 'Blocked'} /></div>
    <div className="panel pipeline-start"><div className="panel-head"><div><div className="panel-kicker">Start from a real scan</div><h2>Repository assessment</h2></div><button className="primary-button" disabled={!provider?.configured || !reports.length || busy} onClick={() => void prepare()}><Sparkles size={15} /> {busy ? 'Queueing' : 'Prepare local changes'}</button></div><div className="pipeline-select-row"><label htmlFor="integration-report">Scan report</label><select id="integration-report" value={selectedReportId} onChange={(event) => setSelectedReportId(event.target.value)}><option value="">Choose a saved report</option>{reports.map((report) => <option value={report.id} key={report.id}>{report.repository} · {report.commitSha.slice(0, 8)} · {formatDate(report.scannedAt)}</option>)}</select>{selected && <StatusPill status={selected.assessment.status} />}</div>{selected && <div className="pipeline-steps"><div className="pipeline-step done"><span>1</span><strong>Scan source</strong><small>{selected.scannedFileCount} files read</small></div><div className="pipeline-step"><span>2</span><strong>Generate changes</strong><small>Model call, after confirmation</small></div><div className="pipeline-step"><span>3</span><strong>Run isolated checks</strong><small>No network in build container</small></div><div className="pipeline-step"><span>4</span><strong>Human review</strong><small>Draft PR is separately gated</small></div></div>}</div>
    <div className="panel agent-jobs-panel"><div className="panel-head"><div><div className="panel-kicker">Real job state</div><h2>Change proposals</h2></div><button className="secondary-button compact" onClick={() => void load()}><RefreshCw size={14} /> Refresh</button></div>{loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> Loading integration jobs</div> : jobs.filter((job) => job.type === 'agent').length ? <div className="agent-job-list">{jobs.filter((job) => job.type === 'agent').map((job) => <article className="agent-job" key={job.id}><div className="agent-job-head"><div><strong>{job.repository}</strong><small>{job.currentStep}</small></div><StatusPill status={job.status} /><span className="job-progress-value">{job.progress}%</span></div><div className="progress-track"><span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div>{job.error && <div className="task-error visible">{job.error}</div>}{job.modifiedFiles?.length ? <><div className="change-files"><strong>Changed files</strong><ul>{job.modifiedFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul></div><div className="job-result-row"><span>Branch <code>{job.currentBranch || job.branch}</code></span><span>Agent phase <code>{job.run?.phase || 'unknown'}</code></span><span>Checks <StatusPill status={job.tests?.status || 'Pending'} /></span></div>{job.tests?.output && <details className="job-output"><summary>Build and test output</summary><pre>{job.tests.output}</pre></details>}{job.diff && <details className="job-output"><summary>Change summary</summary><pre>{job.diff}</pre></details>}{job.patch && <details className="job-output"><summary>Review patch</summary><pre>{job.patch}</pre></details>}{job.pullRequest ? <a className="secondary-button" href={job.pullRequest.url} target="_blank" rel="noreferrer"><GitPullRequest size={14} /> Draft PR #{job.pullRequest.number}</a> : <button className="secondary-button" disabled={!provider?.remoteWritesEnabled || job.status !== 'ReadyForReview' || job.tests?.status !== 'PASS'} onClick={() => void createPullRequest(job)} title={!provider?.remoteWritesEnabled ? 'Remote writes are disabled in server configuration' : undefined}><GitPullRequest size={14} /> Open draft PR</button>}</> : <p className="helper-copy">No source changes have been prepared for this job.</p>}{job.logs.length > 0 && <details className="job-output"><summary>Job log ({job.logs.length})</summary><pre>{job.logs.join('\n')}</pre></details>}</article>)}</div> : <EmptyState title="No AI change jobs" detail="Select a scan report and confirm source disclosure. A configured provider is required for real code generation." />}</div>
  </>
}

function AdapterCenter({ onToast }: { onToast: (message: string) => void }) {
  const [adapters, setAdapters] = useState<Awaited<ReturnType<typeof api.integrationAdapters>>['adapters']>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { void api.integrationAdapters().then((result) => setAdapters(result.adapters)).catch((error) => onToast(error.message)).finally(() => setLoading(false)) }, [])
  return <><PageIntro eyebrow="Framework-specific evidence" title="Adapter Center" detail="Each adapter applies framework-native update conventions and reports repository evidence without treating text hints as verified behavior." /><div className="adapter-grid">{loading ? <div className="panel loading-row"><Loader2 className="spin" size={18} /> Loading adapters</div> : adapters.map((adapter) => <article className="panel adapter-card" key={adapter.id}><div className="adapter-icon"><Code2 size={18} /></div><h2>{adapter.name}</h2><p>{adapter.id === 'electron' ? 'electron-updater and electron-builder release metadata, platform signing configuration and package scripts.' : adapter.id === 'tauri' ? 'Tauri updater plugin configuration, signed update manifest evidence and Rust build entrypoints.' : adapter.id === 'python' ? 'Desktop packaging signals with installer-specific update strategies and Python test discovery.' : adapter.id === 'dotnet' ? 'Velopack, MSIX and ClickOnce evidence with .NET build and test entrypoints.' : 'Web deployment and PWA service-worker lifecycle, manifest, and browser-managed updates.'}</p><div className="adapter-capabilities">{adapter.capabilities.map((capability) => <span key={capability}>{capability.replaceAll('-', ' ')}</span>)}</div><StatusPill status="Evidence adapter" /></article>)}</div><div className="notice-banner"><div className="notice-icon"><AlertTriangle size={16} /></div><div><strong>Adapter findings are heuristic</strong><span>Source evidence indicates likely configuration. Signature validity, server accessibility and old-client installation need independent verification.</span></div></div></>
}

function UpdateSecurity({ onToast }: { onToast: (message: string) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.integrationSecurity>> | null>(null)
  const [loading, setLoading] = useState(true)
  const load = async () => { try { setData(await api.integrationSecurity()) } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to load update security data') } finally { setLoading(false) } }
  useEffect(() => { void load() }, [])
  const summary = data?.summary || {}
  return <><PageIntro eyebrow="Trust and release boundaries" title="Update Security" detail="Review transport, signing, artifact, permission and client-update evidence from repository scans." action={<button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button>} />
    <div className="update-summary"><div><span>Repositories scanned</span><strong>{summary.scannedRepositories ?? 0}</strong></div><div><span>Signing configured</span><strong>{summary.signingConfigured ?? 0}</strong></div><div><span>Signature verified</span><strong className="warning-text">{summary.signatureCryptographicallyVerified ?? 0}</strong></div><div><span>Old client updated</span><strong className="warning-text">{summary.oldClientUpdateVerified ?? 0}</strong></div></div>
    <div className="settings-grid"><div className="panel settings-panel"><div className="panel-kicker">Runtime authorization</div><h2>Configured controls</h2>{Object.entries(data?.configuration || {}).map(([key, value]) => <div className="setting-line" key={key}><span>{key.replaceAll(/([A-Z])/g, ' $1')}</span><StatusPill status={String(value)} /></div>)}</div><div className="panel settings-panel"><div className="panel-kicker">Verification levels</div><h2>Readiness evidence</h2><div className="guardrail"><CheckCircle2 size={16} /><div><strong>Code and CI evidence</strong><span>{summary.codeSupport ?? 0} repositories show update code; {summary.pipelineEvidence ?? 0} show release workflow evidence.</span></div></div><div className="guardrail"><AlertTriangle size={16} /><div><strong>Cryptographic checks</strong><span>0 signatures or digests are cryptographically verified by repository text scanning.</span></div></div><div className="guardrail"><AlertTriangle size={16} /><div><strong>Installed client updates</strong><span>0 old-client update cycles have been executed and verified end to end.</span></div></div></div></div>
    <div className="panel security-findings"><div className="panel-head"><div><div className="panel-kicker">Open evidence gaps</div><h2>Repository findings</h2></div></div>{loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> Loading security findings</div> : data?.findings.length ? <div className="finding-list">{data.findings.slice(0, 60).map((finding, index) => <div className="finding-row" key={`${finding.reportId}-${finding.framework}-${finding.check}-${index}`}><div><strong>{finding.repository}</strong><span>{finding.framework} · {finding.check.replaceAll(/([A-Z])/g, ' $1')}</span></div><StatusPill status={finding.status} /></div>)}</div> : <EmptyState title="No scan findings yet" detail="Run repository scans to populate evidence gaps. An empty list is not proof that update controls are secure." />}</div>
  </>
}

function IntegrationHistory({ onToast }: { onToast: (message: string) => void }) {
  const [reports, setReports] = useState<IntegrationReport[]>([])
  const [jobs, setJobs] = useState<IntegrationJob[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<IntegrationReport | null>(null)
  const load = async () => { try { const [reportResult, jobResult] = await Promise.all([api.integrationReports(), api.integrationJobs()]); setReports(reportResult.reports); setJobs(jobResult.jobs) } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to load integration history') } finally { setLoading(false) } }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 5000); return () => window.clearInterval(timer) }, [])
  return <><PageIntro eyebrow="Persisted scan and job records" title="Integration History" detail="Compare commit-pinned reports and inspect the real outcome of scan and code-change jobs." action={<button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} /> Refresh history</button>} />
    <div className="history-columns"><div className="panel"><div className="panel-head"><div><div className="panel-kicker">Repository assessments</div><h2>{reports.length} saved reports</h2></div></div>{loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> Loading reports</div> : reports.length ? <div className="history-list">{reports.map((report) => <button className={`history-row ${selected?.id === report.id ? 'selected' : ''}`} key={report.id} onClick={() => setSelected(report)}><div><strong>{report.repository}</strong><span>{report.commitSha.slice(0, 12)} · {formatDate(report.scannedAt)}</span></div><StatusPill status={report.assessment.status} /></button>)}</div> : <EmptyState title="No integration reports" detail="Scan one or more repositories to save commit-specific assessments." />}</div>
      <div className="panel history-detail"><div className="panel-head"><div><div className="panel-kicker">Assessment detail</div><h2>{selected?.repository || 'Select a report'}</h2></div></div>{selected ? <><div className="signal-row"><span>Scanned commit</span><code>{selected.commitSha}</code></div><div className="signal-row"><span>Files read</span><strong>{selected.scannedFileCount} / {selected.selectedPaths.length} selected</strong></div><div className="signal-row"><span>Update status</span><StatusPill status={`${selected.assessment.status} · ${selected.assessment.score}`} /></div><div className="signal-row"><span>Code supports updates</span><StatusPill status={selected.readiness.codeSupportsUpdates ? 'Evidence found' : 'Not found'} /></div><div className="signal-row"><span>Release pipeline</span><StatusPill status={selected.readiness.ciBuildsUpdateArtifacts ? 'Evidence found' : 'Not found'} /></div><div className="signal-row"><span>Scan coverage</span><StatusPill status={selected.truncated ? 'PARTIAL · limits reached' : 'Tree scan complete'} /></div><div className="signal-row"><span>Signature / old-client verified</span><StatusPill status="Not verified" /></div>{(selected.detectedPlatforms || []).length > 0 && <div className="change-files"><strong>Detected unsupported platforms</strong><ul>{(selected.detectedPlatforms || []).map((item) => <li key={item.platform}><code>{item.platform}</code> · {item.status} · {item.evidencePaths.join(', ')}</li>)}</ul></div>}<div className="change-files"><strong>Selected paths</strong><ul>{selected.selectedPaths.map((file) => <li key={file}><code>{file}</code></li>)}</ul></div>{selected.readErrors.length > 0 && <div className="task-error visible">{selected.readErrors.length} file read error(s) were recorded.</div>}</> : <EmptyState title="Choose an assessment" detail="Select a saved scan from the list to inspect its evidence and limits." />}</div></div>
    <div className="panel history-jobs"><div className="panel-head"><div><div className="panel-kicker">Workflow records</div><h2>Recent integration jobs</h2></div></div><div className="finding-list">{jobs.slice(0, 30).map((job) => <div className="finding-row" key={job.id}><div><strong>{job.repository}</strong><span>{job.type} · {job.currentStep} · {formatDate(job.createdAt)}</span></div><StatusPill status={job.status} /></div>)}{!jobs.length && <EmptyState title="No integration jobs" detail="Scan or prepare a local change proposal to create job history." />}</div></div>
  </>
}

function GitHubConnections({ onToast }: { onToast: (message: string) => void }) {
  const [config, setConfig] = useState<Awaited<ReturnType<typeof api.appConfig>> | null>(null)
  const load = async () => { try { setConfig(await api.appConfig()) } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to load App status') } }
  useEffect(() => { void load() }, [])
  const install = async () => { try { const result = await api.appInstallUrl(); window.open(result.url, '_blank', 'noopener,noreferrer') } catch (error) { onToast(error instanceof Error ? error.message : 'GitHub App is not configured') } }
  return <><PageIntro eyebrow="Authorization surface" title="GitHub Connections" detail="Keep legacy token compatibility while moving repository access toward scoped GitHub App installations." action={<button className="primary-button" onClick={() => void install()}><GitFork size={15} /> Install GitHub App</button>} /><div className="connection-summary"><div className="panel connection-status"><div className="panel-kicker">GitHub App</div><h2>{config?.configured ? 'Configured' : 'Setup required'}</h2><div className="setting-line"><span>App ID</span><strong>{config?.appId || '—'}</strong></div><div className="setting-line"><span>Private key</span><StatusPill status={config?.privateKeyConfigured ? 'Ready' : 'Blocked'} /></div><div className="setting-line"><span>Webhook secret</span><StatusPill status={config?.webhookSecretConfigured ? 'Ready' : 'Blocked'} /></div></div><div className="panel connection-status"><div className="panel-kicker">Legacy compatibility</div><h2>Migration path</h2><p className="settings-copy">The current `GITHUB_TOKEN` path remains available for local development. App installations add scoped repository access and short-lived tokens without sending a private key to the browser.</p><button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} /> Refresh status</button></div></div><div className="panel"><div className="panel-head"><div><div className="panel-kicker">Installations</div><h2>Authorized accounts</h2></div><Webhook size={17} className="muted-icon" /></div>{config?.installations?.length ? <div className="installation-list">{config.installations.map((installation) => <div className="installation-row" key={installation.installationId}><div className="repo-mark"><GitFork size={15} /></div><div><strong>{installation.accountLogin || installation.installationId}</strong><span>{installation.repositorySelection || 'selected repositories'} · {installation.tokenConfigured ? 'token cached' : 'token will be refreshed on use'}</span></div><StatusPill status="Scoped" /></div>)}</div> : <EmptyState title="No App installations" detail="Configure the App credentials, install it for an account, then refresh this page." />}</div></>
}

function SecurityCenter({ onToast }: { onToast: (message: string) => void }) {
  const [logs, setLogs] = useState<Awaited<ReturnType<typeof api.auditLogs>>['logs']>([])
  useEffect(() => { void api.auditLogs().then((result) => setLogs(result.logs)).catch((error) => onToast(error.message)) }, [onToast])
  return <><PageIntro eyebrow="Guardrails and evidence" title="Security Center" detail="Review the operations that changed external state and the evidence recorded for each one." action={<button className="secondary-button" onClick={() => void api.auditLogs().then((result) => setLogs(result.logs))}><RefreshCw size={15} /> Refresh audit</button>} /><div className="security-grid"><div className="panel security-card"><div className="metric-icon cyan"><ShieldCheck size={17} /></div><h2>Role model</h2><p>Viewer reads. Operator queues builds, scans, and drafts. Administrator publishes and changes authorization.</p></div><div className="panel security-card"><div className="metric-icon violet"><Webhook size={17} /></div><h2>Webhook evidence</h2><p>HMAC verification, delivery IDs, and event lifecycle records prevent duplicate or unsigned updates.</p></div><div className="panel security-card"><div className="metric-icon amber"><PackageCheck size={17} /></div><h2>Release evidence</h2><p>Version checks, asset digests, and explicit confirmation are recorded before publishing.</p></div></div><div className="panel audit-panel"><div className="panel-head"><div><div className="panel-kicker">Operator trail</div><h2>Audit log</h2></div><ShieldCheck size={17} className="muted-icon" /></div>{logs.length ? <div className="audit-list">{logs.map((log) => <div className="audit-row" key={log.id}><div><strong>{log.action}</strong><span>{log.target} · {log.actor} · {formatDate(log.at)}</span></div><StatusPill status={log.risk === 'high' ? 'High risk' : log.result} /></div>)}</div> : <EmptyState title="No audit entries yet" detail="High-impact operations will appear here after they are executed." />}</div></>
}

function Monitoring({ projects, tasks, metrics }: { projects: Project[]; tasks: Task[]; metrics: Record<string, number> }) {
  const healthy = projects.filter((project) => project.openIssues === 0).length
  return <><PageIntro eyebrow="Health signals" title="Monitoring" detail="A compact view of repository activity and the execution signals NEXUS already knows." /><div className="monitor-grid"><div className="panel health-score"><div className="panel-kicker">Repository health</div><div className="score-ring"><strong>{projects.length ? Math.round((healthy / projects.length) * 100) : 0}<small>%</small></strong><span>healthy by issue count</span></div><div className="score-note"><ShieldCheck size={15} /> No synthetic uptime data is shown.</div></div><div className="panel signal-list"><div className="panel-head"><div><div className="panel-kicker">Current signals</div><h2>Operational indicators</h2></div><Activity size={17} className="muted-icon" /></div><div className="signal-row"><span>Repositories tracked</span><strong>{metrics.repositories || 0}</strong></div><div className="signal-row"><span>Build failures</span><strong className="danger-text">{metrics.failedBuilds || 0}</strong></div><div className="signal-row"><span>Open task alerts</span><strong className="warning-text">{metrics.alerts || 0}</strong></div><div className="signal-row"><span>Last task state</span><strong>{tasks[0]?.status || 'No tasks'}</strong></div></div></div><div className="panel"><div className="panel-head"><div><div className="panel-kicker">Coverage</div><h2>Project checks</h2></div></div>{projects.length ? <div className="monitor-project-list">{projects.map((project) => <div className="monitor-project" key={project.id}><div className="repo-mark"><GitFork size={15} /></div><div><strong>{project.fullName}</strong><span>{project.language} · last updated {formatDate(project.updatedAt)}</span></div><StatusPill status={project.openIssues === 0 ? 'Healthy' : `${project.openIssues} issues`} /></div>)}</div> : <EmptyState title="Monitoring starts with projects" detail="Import repositories to create real health records." />}</div></>
}

function AIOperations({ configured }: { configured: boolean }) {
  const [provider, setProvider] = useState<{ configured: boolean; model: string | null; remoteWritesEnabled: boolean } | null>(null)
  const [registry, setRegistry] = useState<Awaited<ReturnType<typeof api.aiProviders>> | null>(null)
  useEffect(() => {
    void Promise.all([api.integrationAdapters(), api.aiProviders()])
      .then(([result, providers]) => { setProvider({ ...result.ai, remoteWritesEnabled: result.remoteWritesEnabled }); setRegistry(providers) })
      .catch(() => { setProvider(null); setRegistry(null) })
  }, [])
  const open = (page: string) => window.dispatchEvent(new CustomEvent('navigate', { detail: page }))
  return <><PageIntro eyebrow="Assisted operations" title="AI Operations" detail="Review the available source-analysis and local change workflow. Remote writes remain separately gated." /><div className="ai-hero"><div className="ai-orb"><Sparkles size={27} /></div><div><div className="eyebrow purple">Provider status</div><h2>{provider?.configured ? `${provider.model || 'AI model'} configured` : 'AI provider configuration required'}</h2><p>{provider?.configured ? 'A model-backed change proposal can start from a saved repository scan. Selected source files are disclosed only after confirmation.' : 'Configure a provider on the server. NEXUS keeps provider keys out of browser state and records blocked work instead of fabricating results.'}</p></div><StatusPill status={provider?.configured ? 'Ready' : 'Blocked'} /></div><div className="panel"><div className="panel-head"><div><div className="panel-kicker">Provider registry</div><h2>{registry?.providers.length || 0} provider(s) visible</h2></div><span className="helper-copy">Keys remain server-side</span></div>{registry?.providers.length ? <div className="finding-list">{registry.providers.map((item) => <div className="finding-row" key={item.id}><div><strong>{item.id} · {item.kind}</strong><span>{item.host || 'No endpoint'} · {item.models.join(', ') || 'No model'}{item.routedTasks.length ? ` · routes: ${item.routedTasks.join(', ')}` : ''}</span></div><StatusPill status={item.configured ? item.default ? 'Default' : 'Ready' : 'Blocked'} /></div>)}</div> : <EmptyState title="No configured providers" detail="Set a server-side provider registry or the legacy AI_BASE_URL/API key/model values." />}</div><div className="capability-grid">{[['Repository evidence', configured ? 'GitHub connection is configured for repository reads.' : 'Configure GitHub access before scanning repositories.', configured ? 'Ready' : 'Blocked', 'Repository Scanner'], ['AI change proposals', provider?.configured ? 'Selected source can be sent after an explicit disclosure confirmation.' : 'Requires an AI provider and a saved scan report.', provider?.configured ? 'Ready' : 'Blocked', 'AI Pipeline'], ['Local checks', 'Proposed changes run in a network-disabled Docker container; offline dependency restore may block the run.', 'Guarded', 'Task Center'], ['Draft pull requests', provider?.remoteWritesEnabled ? 'Server remote-write flag is enabled; caller authentication is not provided by this application.' : 'Remote writes are disabled by server configuration.', provider?.remoteWritesEnabled ? 'Review required' : 'Disabled', 'AI Pipeline']].map(([title, detail, status, page]) => <button className="capability-card" key={title} onClick={() => open(page)}><div className="capability-icon"><Bot size={17} /></div><h3>{title}</h3><p>{detail}</p><span>{status} · Open {page}</span></button>)}</div></>
}

function TaskCenter({ tasks, onRefresh, onToast }: { tasks: Task[]; onRefresh: () => void; onToast: (message: string) => void }) {
  const [jobs, setJobs] = useState<IntegrationJob[]>([])
  const loadJobs = async () => { try { setJobs((await api.integrationJobs()).jobs) } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to load integration job details') } }
  useEffect(() => { void loadJobs(); const timer = window.setInterval(() => void loadJobs(), 3500); return () => window.clearInterval(timer) }, [])
  const cancel = async (job: IntegrationJob) => { try { await api.cancelIntegrationJob(job.id); onToast(`Cancellation requested for ${job.repository}`); await loadJobs(); onRefresh() } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to cancel integration job') } }
  const retry = async (job: IntegrationJob) => {
    const confirmDisclosure = job.type === 'agent'
    if (confirmDisclosure && !window.confirm(`Retrying will send selected source files from ${job.repository} to the configured AI provider. Continue?`)) return
    try { await api.retryIntegrationJob(job.id, confirmDisclosure); onToast(`Retry queued for ${job.repository}`); await loadJobs(); onRefresh() } catch (error) { onToast(error instanceof Error ? error.message : 'Unable to retry integration job') }
  }
  return <><PageIntro eyebrow="Persisted execution state" title="Task Center" detail="Inspect live integration steps, logs, test outcomes, and supported retry or cancellation actions." action={<button className="secondary-button" onClick={() => { onRefresh(); void loadJobs() }}><RefreshCw size={15} /> Refresh tasks</button>} />
    <div className="panel task-center-panel"><div className="panel-head"><div><div className="panel-kicker">Application tasks</div><h2>Recent tasks</h2></div></div>{tasks.length ? <div className="task-table full">{tasks.map((task) => <div className="task-row detailed" key={task.id}><div className="task-name"><span className="task-type">{task.type}</span><strong>{task.label}</strong>{task.error && <span className="task-error">{task.error}</span>}</div><StatusPill status={task.status} /><div className="task-dates"><span>{formatDate(task.createdAt)}</span>{task.finishedAt && <span>finished {formatDate(task.finishedAt)}</span>}</div></div>)}</div> : <EmptyState title="Task history is empty" detail="Repository syncs and build dispatches will appear here with their own status." />}</div>
    <div className="panel integration-task-panel"><div className="panel-head"><div><div className="panel-kicker">Phase 3 execution</div><h2>Repository jobs</h2></div></div>{jobs.length ? <div className="integration-task-list">{jobs.map((job) => <article className="integration-task" key={job.id}><div className="integration-task-top"><div><strong>{job.repository}</strong><span>{job.type} · {job.currentStep}</span></div><StatusPill status={job.status} /><span className="job-progress-value">{job.progress}%</span></div><div className="progress-track"><span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div>{job.error && <p className="task-error visible">{job.error}</p>}{job.tests && <div className="signal-row"><span>Build and test result</span><StatusPill status={job.tests.status} /></div>}<div className="integration-task-actions">{['Pending', 'Running'].includes(job.status) && <button className="secondary-button compact" onClick={() => void cancel(job)}>Cancel</button>}{['Failed', 'Blocked', 'Cancelled'].includes(job.status) && <button className="secondary-button compact" onClick={() => void retry(job)}>Retry</button>}{job.reportId && <button className="ghost-button" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: 'Integration History' }))}>View report</button>}</div><details className="job-output"><summary>Job log ({job.logs.length})</summary><pre>{job.logs.join('\n') || 'No log messages recorded.'}</pre></details></article>)}</div> : <EmptyState title="No Phase 3 jobs" detail="Repository scans and local integration proposals will appear with their current step and result." />}</div>
  </>
}

function SettingsPage({ status }: { status: { configured: boolean; owner: string | null; apiUrl: string; permissions: string[] } | null }) {
  return <><PageIntro eyebrow="System configuration" title="Settings" detail="Environment-backed configuration keeps credentials out of browser state and project records." /><div className="settings-grid"><div className="panel settings-panel"><div className="panel-kicker">GitHub connection</div><h2>Live integration</h2><div className="setting-line"><span>Status</span><StatusPill status={status?.configured ? 'Connected' : 'Blocked'} /></div><div className="setting-line"><span>Account or owner</span><strong>{status?.owner || 'Not configured'}</strong></div><div className="setting-line"><span>API endpoint</span><code>{status?.apiUrl || '—'}</code></div><div className="setting-line"><span>Granted surface</span><strong>{status?.permissions?.length ? status.permissions.join(', ') : 'No token loaded'}</strong></div></div><div className="panel settings-panel"><div className="panel-kicker">Safety defaults</div><h2>Guardrails</h2><div className="guardrail"><ShieldCheck size={16} /><div><strong>Credentials stay server-side</strong><span>Tokens are read from environment variables and never returned to the browser.</span></div></div><div className="guardrail"><GitBranch size={16} /><div><strong>Builds target an explicit ref</strong><span>Dispatch requests use the selected repository's default branch unless overridden.</span></div></div><div className="guardrail"><AlertTriangle size={16} /><div><strong>Release and PR actions are guarded</strong><span>High-impact GitHub writes require route-level gates and explicit confirmation; remote writes stay disabled by default.</span></div></div></div></div></>
}
