import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity, AlertTriangle, ArrowUpRight, Bot, Boxes, CheckCircle2, CircleDot, Code2, GitBranch,
  GitFork, GitPullRequest, Hammer, LayoutDashboard, ListChecks, Loader2, Menu, PackageCheck, Plus, Radio, RefreshCw,
  Rocket, Search, Settings2, ShieldCheck, Sparkles, TerminalSquare, Webhook, XCircle
} from 'lucide-react'
import { api, IntegrationJob, IntegrationReport, Project, Task } from './api'
import { formatStamp } from './i18n/format'

type Page = 'Overview' | 'Projects' | 'Build Center' | 'Release Center' | 'Auto Update' | 'Repository Scanner' | 'AI Pipeline' | 'Adapter Center' | 'Update Security' | 'Integration History' | 'GitHub Connections' | 'Monitoring' | 'AI Operations' | 'Task Center' | 'Security Center' | 'Settings'

// Internal page identifiers stay stable; labels are resolved through i18n.
const NAV_PAGES: { page: Page; key: string; icon: typeof LayoutDashboard }[] = [
  { page: 'Overview', key: 'overview', icon: LayoutDashboard },
  { page: 'Projects', key: 'projects', icon: Boxes },
  { page: 'Build Center', key: 'buildCenter', icon: Hammer },
  { page: 'Release Center', key: 'releaseCenter', icon: PackageCheck },
  { page: 'Auto Update', key: 'autoUpdate', icon: RefreshCw },
  { page: 'Repository Scanner', key: 'repositoryScanner', icon: Code2 },
  { page: 'AI Pipeline', key: 'aiPipeline', icon: Bot },
  { page: 'Adapter Center', key: 'adapterCenter', icon: Boxes },
  { page: 'Update Security', key: 'updateSecurity', icon: ShieldCheck },
  { page: 'Integration History', key: 'integrationHistory', icon: Activity },
  { page: 'GitHub Connections', key: 'githubConnections', icon: GitFork },
  { page: 'Monitoring', key: 'monitoring', icon: Radio },
  { page: 'AI Operations', key: 'aiOperations', icon: Bot },
  { page: 'Task Center', key: 'taskCenter', icon: ListChecks },
  { page: 'Security Center', key: 'securityCenter', icon: ShieldCheck },
  { page: 'Settings', key: 'serverSettings', icon: Settings2 }
]

const METRICS: { key: string; labelKey: string; icon: typeof Boxes; tone: string }[] = [
  { key: 'repositories', labelKey: 'repositories', icon: GitFork, tone: 'cyan' },
  { key: 'managedProjects', labelKey: 'managedProjects', icon: Boxes, tone: 'blue' },
  { key: 'runningTasks', labelKey: 'runningTasks', icon: Activity, tone: 'violet' },
  { key: 'successfulBuilds', labelKey: 'successfulBuilds', icon: CheckCircle2, tone: 'green' },
  { key: 'failedBuilds', labelKey: 'failedBuilds', icon: XCircle, tone: 'red' },
  { key: 'releases', labelKey: 'releases', icon: PackageCheck, tone: 'amber' },
  { key: 'autoUpdateProjects', labelKey: 'autoUpdateProjects', icon: RefreshCw, tone: 'teal' },
  { key: 'alerts', labelKey: 'alerts', icon: AlertTriangle, tone: 'orange' }
]

function StatusPill({ status }: { status: string }) {
  const { t } = useTranslation()
  const normalized = status.toLowerCase()
  const tone = normalized.includes('success') || normalized === 'completed' ? 'success' : normalized.includes('fail') ? 'danger' : normalized.includes('block') ? 'warning' : normalized.includes('run') || normalized.includes('pend') ? 'info' : 'muted'
  // Server and GitHub enum values map onto dictionary keys when available;
  // unknown external values stay as-is (raw data is never invented).
  return <span className={`status-pill ${tone}`}><span className="status-dot" />{t(`common:status.${status}`, { defaultValue: status })}</span>
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-orbit"><CircleDot size={18} /></div><h3>{title}</h3><p>{detail}</p>{action}</div>
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const { t } = useTranslation()
  return <button className="project-card" onClick={onOpen}>
    <div className="project-card-top"><div className="repo-mark"><GitFork size={17} /></div><span className="project-visibility">{project.visibility}</span></div>
    <div className="project-card-title">{project.name}</div>
    <div className="project-card-repo">{project.fullName}</div>
    <p>{project.description || t('git:projects.noDescription')}</p>
    <div className="project-card-footer"><span>{project.language}</span><span>{project.group}</span><span>{formatStamp(project.updatedAt)}</span></div>
  </button>
}

export default function App({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation()
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
    } catch (error) { setToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) }
    finally { setLoading(false) }
  }

  useEffect(() => { void refresh() }, [query]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const handler = (event: Event) => setPage((event as CustomEvent<Page>).detail)
    window.addEventListener('navigate', handler)
    return () => window.removeEventListener('navigate', handler)
  }, [])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 4200); return () => window.clearTimeout(timer) }, [toast])

  const openProject = (project: Project) => { setSelectedProject(project); setPage('Build Center') }
  const sync = async () => { try { await api.syncRepositories(); setToast(t('git:shell.toast.syncQueued')); void refresh() } catch (error) { setToast(error instanceof Error ? error.message : t('git:shell.toast.syncFailed')) } }
  const metrics = overview?.metrics || {}
  const navLabels: Record<Page, string> = useMemo(() => Object.fromEntries(
    NAV_PAGES.map(({ page: target, key }) => [target, t(`git:shell.nav.${key}`)])
  ) as Record<Page, string>, [t])

  return <div className={`app-shell ${embedded ? 'embedded-console' : ''}`}>
    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <div className="brand"><div className="brand-glyph"><span /></div><div><strong>NEXUS</strong><small>{t('common:app.remoteTagline')}</small></div></div>
      <div className="sidebar-section-label">{t('git:shell.sections.workspace')}</div>
      <nav>{NAV_PAGES.map(({ page: target, icon: Icon }) => <button key={target} className={page === target ? 'nav-item active' : 'nav-item'} onClick={() => { setPage(target); setMobileNav(false) }}><Icon size={17} /><span>{navLabels[target]}</span>{target === 'Task Center' && tasks.some((task) => ['Pending', 'Running'].includes(task.status)) && <span className="nav-count">{tasks.filter((task) => ['Pending', 'Running'].includes(task.status)).length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="connection-card"><div className={`connection-led ${status?.configured ? 'live' : ''}`} /><div><strong>{status?.configured ? t('git:shell.connection.connected') : t('git:shell.connection.notConnected')}</strong><span>{status?.configured ? status.owner || t('git:shell.connection.authenticated') : t('git:shell.connection.addToken')}</span></div></div><div className="sidebar-foot"><ShieldCheck size={14} /> {t('git:shell.foot')}</div></div>
    </aside>
    {mobileNav && <button className="scrim" onClick={() => setMobileNav(false)} aria-label={t('common:aria.closeDialog')} />}
    <main className="main-area">
      <header className="topbar"><button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)}><Menu size={20} /></button><div className="breadcrumb"><span>PROJECT NEXUS</span><span>/</span><strong>{page === 'Overview' ? t('git:overview.title') : navLabels[page]}</strong></div><div className="top-actions"><div className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('git:shell.topbar.searchPlaceholder')} aria-label={t('git:shell.topbar.searchPlaceholder')} /></div><button className="icon-button" onClick={() => void refresh()} aria-label={t('git:shell.topbar.refresh')}><RefreshCw size={16} /></button><div className="avatar">LN</div></div></header>
      <div className="content">
        {page === 'Overview' && <Overview metrics={metrics} projects={overview?.projects || []} tasks={overview?.tasks || []} activity={overview?.activity || []} configured={Boolean(status?.configured)} onSync={sync} onOpen={openProject} loading={loading} />}
        {page === 'Projects' && <Projects projects={projects} query={query} onSync={sync} onOpen={openProject} onScan={(project) => api.integrationScan(project.id).then(() => { setToast(t('git:projects.scanToast', { repository: project.fullName })); void refresh() }).catch((error) => setToast(error.message))} />}
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
  const { t } = useTranslation()
  return <><PageIntro eyebrow={t('git:overview.eyebrow')} title={t('git:overview.title')} detail={t('git:overview.subtitle')} action={<button className="primary-button" onClick={onSync}><RefreshCw size={16} /> {t('git:overview.syncGithub')}</button>} />
    {!configured && <div className="notice-banner"><div className="notice-icon"><GitFork size={17} /></div><div><strong>{t('git:overview.connectTitle')}</strong><span>{t('git:overview.connectDetail')}</span></div><button className="text-button">{t('git:overview.openSetup')} <ArrowUpRight size={14} /></button></div>}
    <section className="metric-grid">{METRICS.map(({ key, labelKey, icon: Icon, tone }) => <div className={`metric-card ${tone}`} key={key}><div className="metric-icon"><Icon size={17} /></div><div className="metric-label">{t(`git:overview.metrics.${labelKey}`)}</div><div className="metric-value">{metrics[key] ?? 0}</div><div className="metric-foot">{key === 'alerts' ? t('git:overview.metricFoot.needsReview') : configured ? t('git:overview.metricFoot.live') : t('git:overview.metricFoot.waiting')}</div></div>)}</section>
    <section className="overview-grid"><div className="panel projects-panel"><div className="panel-head"><div><div className="panel-kicker">{t('git:overview.projectsPanel.kicker')}</div><h2>{t('git:overview.projectsPanel.title')}</h2></div><button className="ghost-button" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: 'Projects' }))}>{t('common:actions.viewAll')} <ArrowUpRight size={14} /></button></div>{loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> {t('git:overview.projectsPanel.loading')}</div> : projects.length ? <div className="project-grid">{projects.slice(0, 4).map((project) => <ProjectCard key={project.id} project={project} onOpen={() => onOpen(project)} />)}</div> : <EmptyState title={t('git:overview.empty.projectsTitle')} detail={t('git:overview.empty.projectsDetail')} action={<button className="secondary-button" onClick={onSync}>{t('git:overview.empty.syncButton')}</button>} />}</div>
      <div className="panel activity-panel"><div className="panel-head"><div><div className="panel-kicker">{t('git:overview.activityPanel.kicker')}</div><h2>{t('git:overview.activityPanel.title')}</h2></div><Activity size={17} className="muted-icon" /></div>{activity.length ? <div className="activity-list">{activity.map((item) => <div className="activity-row" key={item.id}><div className="activity-dot" /><div><strong>{item.message}</strong><span>{formatStamp(item.at)}</span></div></div>)}</div> : <EmptyState title={t('git:overview.activityPanel.emptyTitle')} detail={t('git:overview.activityPanel.emptyDetail')} />}</div></section>
    <section className="panel task-strip"><div className="panel-head"><div><div className="panel-kicker">{t('git:overview.taskPanel.kicker')}</div><h2>{t('git:overview.taskPanel.title')}</h2></div><div className="live-chip"><span /> {t('git:overview.taskPanel.liveState')}</div></div>{tasks.length ? <div className="task-table">{tasks.slice(0, 5).map((task) => <div className="task-row" key={task.id}><div className="task-name"><span className="task-type">{task.type}</span><strong>{task.label}</strong></div><StatusPill status={task.status} /><span className="task-time">{formatStamp(task.createdAt)}</span></div>)}</div> : <EmptyState title={t('git:overview.empty.tasksTitle')} detail={t('git:overview.empty.tasksDetail')} />}</section>
  </>
}

function Projects({ projects, query, onSync, onOpen, onScan }: { projects: Project[]; query: string; onSync: () => void; onOpen: (p: Project) => void; onScan: (p: Project) => void }) {
  const { t } = useTranslation()
  const groups = useMemo(() => [...new Set(projects.map((project) => project.group))].filter(Boolean), [projects])
  return <><PageIntro eyebrow={t('git:projects.eyebrow')} title={t('git:projects.title')} detail={t('git:projects.subtitle')} action={<button className="primary-button" onClick={onSync}><RefreshCw size={16} /> {t('git:projects.sync')}</button>} /><div className="filter-bar"><div className="filter-summary"><span className="data-count">{projects.length}</span><span>{t('git:projects.visible', { count: projects.length })}</span>{query && <span className="filter-query">{t('git:projects.matching', { query })}</span>}</div><div className="group-chips"><button className="chip active">{t('git:projects.all')}</button>{groups.map((group) => <button className="chip" key={group}>{group}</button>)}</div></div>{projects.length ? <div className="project-list-grid">{projects.map((project) => <div className="project-list-item" key={project.id}><ProjectCard project={project} onOpen={() => onOpen(project)} /><button className="scan-button" onClick={() => onScan(project)} title={t('git:projects.scanStack')}><Code2 size={15} /> {t('git:projects.scanStack')}</button></div>)}</div> : <div className="panel"><EmptyState title={t('git:projects.emptyTitle')} detail={t('git:projects.emptyDetail')} action={<button className="secondary-button" onClick={onSync}>{t('git:projects.startSync')}</button>} /></div>}</>
}

function BuildCenter({ projects, selectedProject, onSelect, onToast }: { projects: Project[]; selectedProject: Project | null; onSelect: (p: Project | null) => void; onToast: (message: string) => void }) {
  const { t } = useTranslation()
  const [workflows, setWorkflows] = useState<{ id: number; name: string; path: string; state: string }[]>([])
  const [runs, setRuns] = useState<{ id: number; name: string; status: string; conclusion: string | null; created_at: string; html_url: string }[]>([])
  const [loading, setLoading] = useState(false)
  const load = async (project: Project) => { setLoading(true); try { const [wf, run] = await Promise.all([api.workflows(project.id), api.runs(project.id)]); setWorkflows(wf.workflows); setRuns(run.runs) } catch (error) { onToast(error instanceof Error ? error.message : t('build:workflows.loadFailed')) } finally { setLoading(false) } }
  useEffect(() => { if (selectedProject) void load(selectedProject); else { setWorkflows([]); setRuns([]) } }, [selectedProject]) // eslint-disable-line react-hooks/exhaustive-deps
  const trigger = async (workflowId: number) => { if (!selectedProject) return; try { await api.build(selectedProject.id, workflowId, selectedProject.defaultBranch); onToast(t('build:workflows.dispatched')); void load(selectedProject) } catch (error) { onToast(error instanceof Error ? error.message : t('build:workflows.dispatchFailed')) } }
  return <><PageIntro eyebrow={t('build:eyebrow')} title={t('build:title')} detail={t('build:subtitle')} /><div className="build-layout"><div className="panel project-picker"><div className="panel-kicker">{t('build:picker.kicker')}</div><h2>{t('build:picker.title')}</h2><div className="select-list">{projects.length ? projects.map((project) => <button key={project.id} className={selectedProject?.id === project.id ? 'select-row selected' : 'select-row'} onClick={() => onSelect(project)}><div className="repo-mark"><GitFork size={15} /></div><div><strong>{project.fullName}</strong><span>{project.defaultBranch} · {project.language}</span></div><ArrowUpRight size={14} /></button>) : <EmptyState title={t('build:picker.emptyTitle')} detail={t('build:picker.emptyDetail')} />}</div></div><div className="build-main"><div className="panel"><div className="panel-head"><div><div className="panel-kicker">{t('build:workflows.kicker')}</div><h2>{selectedProject ? selectedProject.fullName : t('build:workflows.selectRepository')}</h2></div>{loading && <Loader2 className="spin" size={18} />}</div>{selectedProject ? workflows.length ? <div className="workflow-list">{workflows.map((workflow) => <div className="workflow-row" key={workflow.id}><div className="workflow-icon"><GitBranch size={16} /></div><div className="workflow-copy"><strong>{workflow.name}</strong><span>{workflow.path} · {workflow.state}</span></div><button className="secondary-button compact" onClick={() => void trigger(workflow.id)}><Rocket size={14} /> {t('build:workflows.runAction')}</button></div>)}</div> : <EmptyState title={t('build:workflows.emptyTitle')} detail={t('build:workflows.emptyDetail')} /> : <EmptyState title={t('build:workflows.waitingTitle')} detail={t('build:workflows.waitingDetail')} />}</div><div className="panel"><div className="panel-head"><div><div className="panel-kicker">{t('build:runs.kicker')}</div><h2>{t('build:runs.title')}</h2></div><GitPullRequest size={17} className="muted-icon" /></div>{runs.length ? <div className="run-list">{runs.map((run) => <a className="run-row" href={run.html_url} target="_blank" rel="noreferrer" key={run.id}><div><strong>{run.name}</strong><span>{formatStamp(run.created_at)}</span></div><StatusPill status={run.conclusion || run.status} /><ArrowUpRight size={14} /></a>)}</div> : <EmptyState title={t('build:runs.emptyTitle')} detail={t('build:runs.emptyDetail')} />}</div></div></div></>
}

function ReleaseCenter({ projects, onToast }: { projects: Project[]; onToast: (message: string) => void }) {
  const { t } = useTranslation()
  const [releases, setReleases] = useState<Awaited<ReturnType<typeof api.releases>>['releases']>([])
  const [loading, setLoading] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id || '')
  const [tagName, setTagName] = useState('v0.1.0')
  const [releaseName, setReleaseName] = useState('')
  const [releaseBody, setReleaseBody] = useState('')
  const load = async () => { setLoading(true); try { const data = await api.releases(); setReleases(data.releases) } catch (error) { onToast(error instanceof Error ? error.message : t('release:center.loadFailed')) } finally { setLoading(false) } }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const createDraft = async () => {
    if (!selectedProjectId) return onToast(t('release:center.chooseRepositoryFirst'))
    try { await api.createRelease(selectedProjectId, { tagName, name: releaseName || tagName, body: releaseBody }); onToast(t('release:center.draftQueued')); setReleaseBody(''); void load() } catch (error) { onToast(error instanceof Error ? error.message : t('release:center.draftFailed')) }
  }
  return <><PageIntro eyebrow={t('release:center.eyebrow')} title={t('release:center.title')} detail={t('release:center.subtitle')} action={<button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} /> {t('release:center.refresh')}</button>} />
    <div className="release-create-grid"><div className="panel release-form"><div className="panel-kicker">{t('release:form.kicker')}</div><h2>{t('release:form.title')}</h2><label>{t('release:form.repository')}<select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>{projects.map((project) => <option value={project.id} key={project.id}>{project.fullName}</option>)}</select></label><div className="form-two"><label>{t('release:form.tag')}<input value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder={t('release:form.tagPlaceholder')} /></label><label>{t('release:form.name')}<input value={releaseName} onChange={(event) => setReleaseName(event.target.value)} placeholder={t('release:form.namePlaceholder')} /></label></div><label>{t('release:form.notes')}<textarea value={releaseBody} onChange={(event) => setReleaseBody(event.target.value)} placeholder={t('release:form.notesPlaceholder')} /></label><button className="primary-button" onClick={() => void createDraft()}><Plus size={15} /> {t('release:form.create')}</button></div><div className="panel release-policy"><div className="panel-kicker">{t('release:policy.kicker')}</div><h2>{t('release:policy.title')}</h2><div className="guardrail"><ShieldCheck size={16} /><div><strong>{t('release:policy.semverTitle')}</strong><span>{t('release:policy.semverDetail')}</span></div></div><div className="guardrail"><ShieldCheck size={16} /><div><strong>{t('release:policy.digestTitle')}</strong><span>{t('release:policy.digestDetail')}</span></div></div><div className="guardrail"><ShieldCheck size={16} /><div><strong>{t('release:policy.adminTitle')}</strong><span>{t('release:policy.adminDetail')}</span></div></div></div></div>
    {!projects.length && <div className="notice-banner"><div className="notice-icon"><PackageCheck size={17} /></div><div><strong>{t('release:list.emptyBannerTitle')}</strong><span>{t('release:list.emptyBannerDetail')}</span></div></div>}
    <div className="panel release-panel">{loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> {t('release:center.loading')}</div> : releases.length ? <div className="release-list">{releases.map((release) => <div className="release-row" key={release.id}><a className="release-copy" href={release.html_url} target="_blank" rel="noreferrer"><strong>{release.name || release.tag_name}</strong><span>{release.projectName} · {release.published_at ? formatStamp(release.published_at) : t('release:list.unpublishedDraft')}</span></a><div className="release-tag">{release.tag_name}</div><div className="release-state">{release.draft ? t('release:list.stateDraft') : release.prerelease ? t('release:list.statePrerelease') : t('release:list.statePublished')}</div>{release.draft && <button className="secondary-button compact" onClick={() => { const project = projects.find((item) => release.projectName === item.fullName); if (project) void api.publishRelease(project.id, release.id).then(() => onToast(t('release:center.publishQueued'))).catch((error) => onToast(error.message)) }}><Rocket size={14} /> {t('common:actions.publish')}</button>}<ArrowUpRight size={15} /></div>)}</div> : <EmptyState title={t('release:list.emptyTitle')} detail={t('release:list.emptyDetail')} action={<button className="secondary-button" onClick={() => void load()}>{t('common:actions.tryAgain')}</button>} />}</div></>
}

function AutoUpdate({ projects, onToast }: { projects: Project[]; onToast: (message: string) => void }) {
  const { t } = useTranslation()
  const [configs, setConfigs] = useState<Awaited<ReturnType<typeof api.autoUpdate>>['configs']>([])
  const [loading, setLoading] = useState(false)
  const load = async () => { setLoading(true); try { setConfigs((await api.autoUpdate()).configs) } catch (error) { onToast(error instanceof Error ? error.message : t('release:autoUpdate.loadFailed')) } finally { setLoading(false) } }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const checkAll = async () => { try { await api.updateCheckAll(); onToast(t('release:autoUpdate.checkQueued')); void load() } catch (error) { onToast(error instanceof Error ? error.message : t('release:autoUpdate.checkFailed')) } }
  return <><PageIntro eyebrow={t('release:autoUpdate.eyebrow')} title={t('release:autoUpdate.title')} detail={t('release:autoUpdate.subtitle')} action={<button className="primary-button" onClick={() => void checkAll()}><RefreshCw size={15} /> {t('release:autoUpdate.checkAll')}</button>} />
    <div className="update-summary"><div><span>{t('release:autoUpdate.summary.checked')}</span><strong>{configs.length}</strong></div><div><span>{t('release:autoUpdate.summary.ready')}</span><strong className="success-text">{configs.filter((item) => item.security.status === 'READY').length}</strong></div><div><span>{t('release:autoUpdate.summary.blocked')}</span><strong className="danger-text">{configs.filter((item) => item.security.status === 'BLOCKED').length}</strong></div><div><span>{t('release:autoUpdate.summary.lastCheck')}</span><strong>{configs[0] ? formatStamp(configs[0].checkedAt) : '—'}</strong></div></div>
    <div className="panel update-panel">{loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> {t('release:autoUpdate.loading')}</div> : configs.length ? <div className="update-list">{configs.map((config) => <div className="update-row" key={config.id}><div className="repo-mark"><RefreshCw size={15} /></div><div className="update-copy"><strong>{config.projectName}</strong><span>{config.framework} · {config.channel} · {config.currentVersion || t('release:autoUpdate.versionUnknown')}</span><small>{config.evidence.length ? t('release:autoUpdate.evidence', { count: config.evidence.length, samples: config.evidence.slice(0, 3).join(', ') }) : t('release:autoUpdate.noEvidence')}</small></div><div className="update-health"><strong>{config.completeness}%</strong><StatusPill status={config.security.status} /></div><button className="icon-button" title={t('release:autoUpdate.recheck')} onClick={() => void api.updateCheck(config.projectId).then(() => { onToast(t('release:autoUpdate.recheckToast', { project: config.projectName })); void load() }).catch((error) => onToast(error.message))}><RefreshCw size={14} /></button></div>)}</div> : <EmptyState title={t('release:autoUpdate.emptyTitle')} detail={t('release:autoUpdate.emptyDetail')} action={<button className="secondary-button" onClick={() => void checkAll()}>{t('release:autoUpdate.runFirst')}</button>} />}</div>
    <div className="panel"><div className="panel-head"><div><div className="panel-kicker">{t('release:autoUpdate.semantics.kicker')}</div><h2>{t('release:autoUpdate.semantics.title')}</h2></div><ShieldCheck size={17} className="muted-icon" /></div><div className="signal-row"><span>SHA-256</span><strong>{t('release:autoUpdate.semantics.sha')}</strong></div><div className="signal-row"><span>{t('release:autoUpdate.semantics.signatureLabel')}</span><strong>{t('release:autoUpdate.semantics.signature')}</strong></div><div className="signal-row"><span>HTTPS</span><strong>{t('release:autoUpdate.semantics.https')}</strong></div><div className="signal-row"><span>{t('common:states.blocked')}</span><strong>{t('release:autoUpdate.semantics.blocked')}</strong></div></div></>
}

function RepositoryScanner({ projects, onToast }: { projects: Project[]; onToast: (message: string) => void }) {
  const { t } = useTranslation()
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
    } catch (error) { onToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 4000); return () => window.clearInterval(timer) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const latest = new Map<string, IntegrationReport>()
  for (const report of reports) if (!latest.has(report.projectId)) latest.set(report.projectId, report)
  const activeFor = (projectId: string) => jobs.some((job) => job.projectId === projectId && ['Pending', 'Running'].includes(job.status))
  const scanAll = async () => {
    setQueueing(true)
    try {
      const result = await api.integrationScanAll()
      onToast(t('automation:scanner.queuedToast', { queued: result.jobs.filter((entry) => !entry.reused).length, blocked: result.blocked.length }))
      await load()
    }
    catch (error) { onToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) }
    finally { setQueueing(false) }
  }
  const toggleSchedule = async () => {
    try {
      const result = await api.updateIntegrationSchedule({ enabled: !schedule.enabled, intervalHours: schedule.intervalHours })
      setSchedule({ enabled: result.schedule.enabled, intervalHours: result.schedule.intervalHours, nextRunAt: result.schedule.nextRunAt })
      onToast(result.schedule.enabled ? t('automation:scanner.scheduleEnabled') : t('automation:scanner.schedulePaused'))
    } catch (error) { onToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) }
  }
  const intervalLabel = (hours: number) => hours === 24 ? t('automation:scanner.intervalDaily') : hours === 168 ? t('automation:scanner.intervalWeekly') : t('automation:scanner.intervalHours', { count: hours })
  return <>
    <PageIntro eyebrow={t('automation:scanner.eyebrow')} title={t('automation:scanner.title')} detail={t('automation:scanner.subtitle')} action={<button className="primary-button" onClick={() => void scanAll()} disabled={queueing || !projects.length}><RefreshCw size={15} /> {queueing ? t('automation:scanner.queueing') : t('automation:scanner.scanAll')}</button>} />
    <div className="update-summary"><div><span>{t('git:projects.title')}</span><strong>{projects.length}</strong></div><div><span>{t('automation:scanner.columns.assessment')}</span><strong>{new Set(reports.map((report) => report.projectId)).size}</strong></div><div><span>{t('git:overview.metrics.runningTasks')}</span><strong>{jobs.filter((job) => ['Pending', 'Running'].includes(job.status)).length}</strong></div><div><span>{t('automation:updateSecurity.verified')}</span><strong className="warning-text">0</strong></div></div>
    <div className="panel scanner-panel"><div className="panel-head"><div><div className="panel-kicker">{t('automation:scanner.inventoryKicker')}</div><h2>{t('automation:scanner.evidenceTitle')}</h2></div><button className="secondary-button compact" onClick={() => void load()}><RefreshCw size={14} /> {t('common:actions.refresh')}</button></div>
      {loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> {t('common:states.loading')}</div> : <div className="table-scroll"><table className="data-table"><thead><tr><th>{t('automation:scanner.columns.repository')}</th><th>{t('automation:scanner.columns.stack')}</th><th>{t('automation:scanner.columns.assessment')}</th><th>{t('automation:scanner.columns.commit')}</th><th>{t('automation:scanner.columns.action')}</th></tr></thead><tbody>{projects.map((project) => {
        const report = latest.get(project.id); const running = activeFor(project.id)
        return <tr key={project.id}><td><strong>{project.fullName}</strong><small>{project.defaultBranch}</small></td><td>{report?.components.length ? report.components.map((component) => component.name).join(', ') : <span className="muted-text">{report ? t('automation:scanner.noComponent') : t('automation:scanner.notScanned')}</span>}</td><td>{report ? <StatusPill status={`${report.assessment.status} · ${report.assessment.score}`} /> : <StatusPill status={t('automation:scanner.notScanned')} />}</td><td><code>{report?.commitSha.slice(0, 10) || '—'}</code><small>{formatStamp(report?.scannedAt)}</small></td><td><button className="secondary-button compact" disabled={running} onClick={() => void api.integrationScan(project.id).then(() => { onToast(t('git:projects.scanToast', { repository: project.fullName })); void load() }).catch((error) => onToast(error.message))}>{running ? t('common:states.scanning') : t('common:actions.scan')}</button></td></tr>
      })}</tbody></table>{!projects.length && <EmptyState title={t('automation:scanner.noRepositories')} detail={t('automation:scanner.noRepositoriesDetail')} />}</div>}
    </div>
    <div className="scanner-bottom-grid"><div className="panel"><div className="panel-head"><div><div className="panel-kicker">{t('automation:scanner.scheduleKicker')}</div><h2>{t('automation:scanner.scheduleTitle')}</h2></div><StatusPill status={schedule.enabled ? t('common:states.enabled') : t('common:states.paused')} /></div><div className="schedule-row"><label>{t('automation:scanner.intervalLabel')}<select value={schedule.intervalHours} onChange={(event) => setSchedule((value) => ({ ...value, intervalHours: Number(event.target.value) }))}><option value={6}>{t('automation:scanner.intervalHours', { count: 6 })}</option><option value={12}>{t('automation:scanner.intervalHours', { count: 12 })}</option><option value={24}>{t('automation:scanner.intervalDaily')}</option><option value={168}>{t('automation:scanner.intervalWeekly')}</option></select></label><button className="secondary-button" onClick={() => void toggleSchedule()}>{schedule.enabled ? t('automation:scanner.pauseSchedule') : t('automation:scanner.enableSchedule')}</button></div><p className="helper-copy">{schedule.enabled ? t('automation:scanner.nextRun', { time: formatStamp(schedule.nextRunAt || undefined) }) : t('automation:scanner.nextRunUnscheduled')}</p></div>
      <div className="panel"><div className="panel-head"><div><div className="panel-kicker">{t('automation:scanner.boundaryKicker')}</div><h2>{t('automation:scanner.boundaryTitle')}</h2></div><ShieldCheck size={17} className="muted-icon" /></div><div className="guardrail"><Code2 size={16} /><div><strong>{t('automation:scanner.commitPinnedTitle')}</strong><span>{t('automation:scanner.commitPinnedDetail')}</span></div></div><div className="guardrail"><AlertTriangle size={16} /><div><strong>{t('automation:scanner.staticTitle')}</strong><span>{t('automation:scanner.staticDetail')}</span></div></div></div></div>
  </>
}

function AIIntegrationPipeline({ onToast }: { onToast: (message: string) => void }) {
  const { t } = useTranslation()
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
    } catch (error) { onToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 4000); return () => window.clearInterval(timer) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const selected = reports.find((report) => report.id === selectedReportId)
  const prepare = async () => {
    if (!selected || !window.confirm(t('automation:pipeline.confirmPrepare', { repository: selected.repository }))) return
    setBusy(true)
    try { const result = await api.prepareIntegration(selected.id, true); onToast(result.blocked ? t('automation:pipeline.resultBlocked') : t('automation:pipeline.resultQueued')); await load() }
    catch (error) { onToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) }
    finally { setBusy(false) }
  }
  const createPullRequest = async (job: IntegrationJob) => {
    const branch = job.currentBranch || job.branch || 'unknown branch'
    if (!window.confirm(t('automation:pipeline.confirmPr', { repository: job.repository, branch }))) return
    try { const result = await api.createIntegrationPullRequest(job, true); onToast(t('automation:pipeline.prOpened', { number: result.pullRequest.number })); await load() }
    catch (error) { onToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) }
  }
  return <>
    <PageIntro eyebrow={t('automation:pipeline.eyebrow')} title={t('automation:pipeline.title')} detail={t('automation:pipeline.subtitle')} />
    <div className="ai-hero"><div className="ai-orb"><Bot size={25} /></div><div><div className="eyebrow purple">{t('automation:pipeline.providerEyebrow')}</div><h2>{provider?.configured ? t('automation:pipeline.providerConfigured', { model: provider.model || '' }) : t('automation:pipeline.providerRequired')}</h2><p>{provider?.configured ? t('automation:pipeline.providerDetail', { baseUrl: provider.baseUrl || '' }) : t('automation:pipeline.providerMissingDetail')}</p></div><StatusPill status={provider?.configured ? t('common:states.ready') : t('common:states.blocked')} /></div>
    <div className="panel pipeline-start"><div className="panel-head"><div><div className="panel-kicker">{t('automation:pipeline.startKicker')}</div><h2>{t('automation:pipeline.assessmentTitle')}</h2></div><button className="primary-button" disabled={!provider?.configured || !reports.length || busy} onClick={() => void prepare()}><Sparkles size={15} /> {busy ? t('automation:pipeline.queueing') : t('automation:pipeline.prepare')}</button></div><div className="pipeline-select-row"><label htmlFor="integration-report">{t('automation:pipeline.reportLabel')}</label><select id="integration-report" value={selectedReportId} onChange={(event) => setSelectedReportId(event.target.value)}><option value="">{t('automation:pipeline.reportPlaceholder')}</option>{reports.map((report) => <option value={report.id} key={report.id}>{report.repository} · {report.commitSha.slice(0, 8)} · {formatStamp(report.scannedAt)}</option>)}</select>{selected && <StatusPill status={selected.assessment.status} />}</div>{selected && <div className="pipeline-steps"><div className="pipeline-step done"><span>1</span><strong>{t('automation:pipeline.steps.scan')}</strong><small>{t('automation:pipeline.steps.scanDetail', { count: selected.scannedFileCount })}</small></div><div className="pipeline-step"><span>2</span><strong>{t('automation:pipeline.steps.generate')}</strong><small>{t('automation:pipeline.steps.generateDetail')}</small></div><div className="pipeline-step"><span>3</span><strong>{t('automation:pipeline.steps.checks')}</strong><small>{t('automation:pipeline.steps.checksDetail')}</small></div><div className="pipeline-step"><span>4</span><strong>{t('automation:pipeline.steps.review')}</strong><small>{t('automation:pipeline.steps.reviewDetail')}</small></div></div>}</div>
    <div className="panel agent-jobs-panel"><div className="panel-head"><div><div className="panel-kicker">{t('automation:pipeline.jobsKicker')}</div><h2>{t('automation:pipeline.jobsTitle')}</h2></div><button className="secondary-button compact" onClick={() => void load()}><RefreshCw size={14} /> {t('common:actions.refresh')}</button></div>{loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> {t('common:states.loading')}</div> : jobs.filter((job) => job.type === 'agent').length ? <div className="agent-job-list">{jobs.filter((job) => job.type === 'agent').map((job) => <article className="agent-job" key={job.id}><div className="agent-job-head"><div><strong>{job.repository}</strong><small>{job.currentStep}</small></div><StatusPill status={job.status} /><span className="job-progress-value">{job.progress}%</span></div><div className="progress-track"><span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div>{job.error && <div className="task-error visible">{job.error}</div>}{job.modifiedFiles?.length ? <><div className="change-files"><strong>{t('automation:pipeline.changedFiles')}</strong><ul>{job.modifiedFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul></div><div className="job-result-row"><span>{t('automation:pipeline.branch', { branch: job.currentBranch || job.branch || '' })}</span><span>{t('automation:pipeline.agentPhase', { phase: job.run?.phase || 'unknown' })}</span><span>{t('automation:pipeline.checksLabel')} <StatusPill status={job.tests?.status || 'Pending'} /></span></div>{job.tests?.output && <details className="job-output"><summary>{t('automation:pipeline.outputSummary')}</summary><pre>{job.tests.output}</pre></details>}{job.diff && <details className="job-output"><summary>{t('automation:pipeline.diffSummary')}</summary><pre>{job.diff}</pre></details>}{job.patch && <details className="job-output"><summary>{t('automation:pipeline.patchSummary')}</summary><pre>{job.patch}</pre></details>}{job.pullRequest ? <a className="secondary-button" href={job.pullRequest.url} target="_blank" rel="noreferrer"><GitPullRequest size={14} /> {t('automation:pipeline.draftPr', { number: job.pullRequest.number })}</a> : <button className="secondary-button" disabled={!provider?.remoteWritesEnabled || job.status !== 'ReadyForReview' || job.tests?.status !== 'PASS'} onClick={() => void createPullRequest(job)} title={!provider?.remoteWritesEnabled ? t('automation:pipeline.remoteWritesDisabled') : undefined}><GitPullRequest size={14} /> {t('automation:pipeline.openDraftPr')}</button>}</> : <p className="helper-copy">{t('automation:pipeline.noSourceChanges')}</p>}{job.logs.length > 0 && <details className="job-output"><summary>{t('automation:pipeline.logSummary', { count: job.logs.length })}</summary><pre>{job.logs.join('\n')}</pre></details>}</article>)}</div> : <EmptyState title={t('automation:pipeline.noJobsTitle')} detail={t('automation:pipeline.noJobsDetail')} />}</div>
  </>
}

function AdapterCenter({ onToast }: { onToast: (message: string) => void }) {
  const { t } = useTranslation()
  const [adapters, setAdapters] = useState<Awaited<ReturnType<typeof api.integrationAdapters>>['adapters']>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { void api.integrationAdapters().then((result) => setAdapters(result.adapters)).catch((error) => onToast(error.message)).finally(() => setLoading(false)) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const adapterDetail = (id: string) => id === 'electron' ? t('automation:adapters.electronDetail')
    : id === 'tauri' ? t('automation:adapters.tauriDetail')
      : id === 'python' ? t('automation:adapters.pythonDetail')
        : id === 'dotnet' ? t('automation:adapters.dotnetDetail')
          : t('automation:adapters.webDetail')
  return <><PageIntro eyebrow={t('automation:adapters.eyebrow')} title={t('automation:adapters.title')} detail={t('automation:adapters.subtitle')} /><div className="adapter-grid">{loading ? <div className="panel loading-row"><Loader2 className="spin" size={18} /> {t('automation:adapters.loading')}</div> : adapters.map((adapter) => <article className="panel adapter-card" key={adapter.id}><div className="adapter-icon"><Code2 size={18} /></div><h2>{adapter.name}</h2><p>{adapterDetail(adapter.id)}</p><div className="adapter-capabilities">{adapter.capabilities.map((capability) => <span key={capability}>{capability.replaceAll('-', ' ')}</span>)}</div><StatusPill status={t('automation:adapters.evidenceBadge')} /></article>)}</div><div className="notice-banner"><div className="notice-icon"><AlertTriangle size={16} /></div><div><strong>{t('automation:adapters.heuristicTitle')}</strong><span>{t('automation:adapters.heuristicDetail')}</span></div></div></>
}

function UpdateSecurity({ onToast }: { onToast: (message: string) => void }) {
  const { t } = useTranslation()
  const [data, setData] = useState<Awaited<ReturnType<typeof api.integrationSecurity>> | null>(null)
  const [loading, setLoading] = useState(true)
  const load = async () => { try { setData(await api.integrationSecurity()) } catch (error) { onToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) } finally { setLoading(false) } }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const summary = data?.summary || {}
  return <><PageIntro eyebrow={t('automation:updateSecurity.eyebrow')} title={t('automation:updateSecurity.title')} detail={t('automation:updateSecurity.subtitle')} action={<button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} /> {t('common:actions.refresh')}</button>} />
    <div className="update-summary"><div><span>{t('automation:updateSecurity.scanned')}</span><strong>{summary.scannedRepositories ?? 0}</strong></div><div><span>{t('automation:updateSecurity.signing')}</span><strong>{summary.signingConfigured ?? 0}</strong></div><div><span>{t('automation:updateSecurity.verified')}</span><strong className="warning-text">{summary.signatureCryptographicallyVerified ?? 0}</strong></div><div><span>{t('automation:updateSecurity.oldClient')}</span><strong className="warning-text">{summary.oldClientUpdateVerified ?? 0}</strong></div></div>
    <div className="settings-grid"><div className="panel settings-panel"><div className="panel-kicker">{t('automation:updateSecurity.runtimeKicker')}</div><h2>{t('automation:updateSecurity.runtimeTitle')}</h2>{Object.entries(data?.configuration || {}).map(([key, value]) => <div className="setting-line" key={key}><span>{key.replaceAll(/([A-Z])/g, ' $1')}</span><StatusPill status={String(value)} /></div>)}</div><div className="panel settings-panel"><div className="panel-kicker">{t('automation:updateSecurity.levelsKicker')}</div><h2>{t('automation:updateSecurity.levelsTitle')}</h2><div className="guardrail"><CheckCircle2 size={16} /><div><strong>{t('automation:updateSecurity.codeEvidenceTitle')}</strong><span>{t('automation:updateSecurity.codeEvidenceDetail', { code: summary.codeSupport ?? 0, pipeline: summary.pipelineEvidence ?? 0 })}</span></div></div><div className="guardrail"><AlertTriangle size={16} /><div><strong>{t('automation:updateSecurity.cryptoTitle')}</strong><span>{t('automation:updateSecurity.cryptoDetail')}</span></div></div><div className="guardrail"><AlertTriangle size={16} /><div><strong>{t('automation:updateSecurity.clientTitle')}</strong><span>{t('automation:updateSecurity.clientDetail')}</span></div></div></div></div>
    <div className="panel security-findings"><div className="panel-head"><div><div className="panel-kicker">{t('automation:updateSecurity.findingsKicker')}</div><h2>{t('automation:updateSecurity.findingsTitle')}</h2></div></div>{loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> {t('common:states.loading')}</div> : data?.findings.length ? <div className="finding-list">{data.findings.slice(0, 60).map((finding, index) => <div className="finding-row" key={`${finding.reportId}-${finding.framework}-${finding.check}-${index}`}><div><strong>{finding.repository}</strong><span>{finding.framework} · {finding.check.replaceAll(/([A-Z])/g, ' $1')}</span></div><StatusPill status={finding.status} /></div>)}</div> : <EmptyState title={t('automation:updateSecurity.noFindingsTitle')} detail={t('automation:updateSecurity.noFindingsDetail')} />}</div>
  </>
}

function IntegrationHistory({ onToast }: { onToast: (message: string) => void }) {
  const { t } = useTranslation()
  const [reports, setReports] = useState<IntegrationReport[]>([])
  const [jobs, setJobs] = useState<IntegrationJob[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<IntegrationReport | null>(null)
  const load = async () => { try { const [reportResult, jobResult] = await Promise.all([api.integrationReports(), api.integrationJobs()]); setReports(reportResult.reports); setJobs(jobResult.jobs) } catch (error) { onToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) } finally { setLoading(false) } }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 5000); return () => window.clearInterval(timer) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <><PageIntro eyebrow={t('tasks:history.eyebrow')} title={t('tasks:history.title')} detail={t('tasks:history.subtitle')} action={<button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} /> {t('tasks:history.refresh')}</button>} />
    <div className="history-columns"><div className="panel"><div className="panel-head"><div><div className="panel-kicker">{t('tasks:history.reportsKicker')}</div><h2>{t('tasks:history.reportsTitle', { count: reports.length })}</h2></div></div>{loading ? <div className="loading-row"><Loader2 className="spin" size={18} /> {t('common:states.loading')}</div> : reports.length ? <div className="history-list">{reports.map((report) => <button className={`history-row ${selected?.id === report.id ? 'selected' : ''}`} key={report.id} onClick={() => setSelected(report)}><div><strong>{report.repository}</strong><span>{report.commitSha.slice(0, 12)} · {formatStamp(report.scannedAt)}</span></div><StatusPill status={report.assessment.status} /></button>)}</div> : <EmptyState title={t('tasks:history.noReportsTitle')} detail={t('tasks:history.noReportsDetail')} />}</div>
      <div className="panel history-detail"><div className="panel-head"><div><div className="panel-kicker">{t('tasks:history.detailKicker')}</div><h2>{selected?.repository || t('tasks:history.detailEmptyTitle')}</h2></div></div>{selected ? <><div className="signal-row"><span>{t('tasks:history.fields.commit')}</span><code>{selected.commitSha}</code></div><div className="signal-row"><span>{t('tasks:history.fields.files')}</span><strong>{t('tasks:history.fields.filesValue', { read: selected.scannedFileCount, selected: selected.selectedPaths.length })}</strong></div><div className="signal-row"><span>{t('tasks:history.fields.status')}</span><StatusPill status={`${selected.assessment.status} · ${selected.assessment.score}`} /></div><div className="signal-row"><span>{t('tasks:history.fields.codeSupport')}</span><StatusPill status={selected.readiness.codeSupportsUpdates ? t('tasks:history.evidenceFound') : t('tasks:history.evidenceMissing')} /></div><div className="signal-row"><span>{t('tasks:history.fields.releasePipeline')}</span><StatusPill status={selected.readiness.ciBuildsUpdateArtifacts ? t('tasks:history.evidenceFound') : t('tasks:history.evidenceMissing')} /></div><div className="signal-row"><span>{t('tasks:history.fields.coverage')}</span><StatusPill status={selected.truncated ? t('tasks:history.coveragePartial') : t('tasks:history.coverageComplete')} /></div><div className="signal-row"><span>{t('tasks:history.fields.verified')}</span><StatusPill status={t('tasks:history.notVerified')} /></div>{(selected.detectedPlatforms || []).length > 0 && <div className="change-files"><strong>{t('tasks:history.platformsTitle')}</strong><ul>{(selected.detectedPlatforms || []).map((item) => <li key={item.platform}><code>{item.platform}</code> · {item.status} · {item.evidencePaths.join(', ')}</li>)}</ul></div>}<div className="change-files"><strong>{t('tasks:history.pathsTitle')}</strong><ul>{selected.selectedPaths.map((file) => <li key={file}><code>{file}</code></li>)}</ul></div>{selected.readErrors.length > 0 && <div className="task-error visible">{t('tasks:history.readErrors', { count: selected.readErrors.length })}</div>}</> : <EmptyState title={t('tasks:history.chooseTitle')} detail={t('tasks:history.chooseDetail')} />}</div></div>
    <div className="panel history-jobs"><div className="panel-head"><div><div className="panel-kicker">{t('tasks:history.jobsKicker')}</div><h2>{t('tasks:history.jobsTitle')}</h2></div></div><div className="finding-list">{jobs.slice(0, 30).map((job) => <div className="finding-row" key={job.id}><div><strong>{job.repository}</strong><span>{job.type} · {job.currentStep} · {formatStamp(job.createdAt)}</span></div><StatusPill status={job.status} /></div>)}{!jobs.length && <EmptyState title={t('tasks:history.noJobsTitle')} detail={t('tasks:history.noJobsDetail')} />}</div></div>
  </>
}

function GitHubConnections({ onToast }: { onToast: (message: string) => void }) {
  const { t } = useTranslation()
  const [config, setConfig] = useState<Awaited<ReturnType<typeof api.appConfig>> | null>(null)
  const load = async () => { try { setConfig(await api.appConfig()) } catch (error) { onToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) } }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const install = async () => { try { const result = await api.appInstallUrl(); window.open(result.url, '_blank', 'noopener,noreferrer') } catch (error) { onToast(error instanceof Error ? error.message : t('git:connections.installFailed')) } }
  return <><PageIntro eyebrow={t('git:connections.eyebrow')} title={t('git:connections.title')} detail={t('git:connections.subtitle')} action={<button className="primary-button" onClick={() => void install()}><GitFork size={15} /> {t('git:connections.install')}</button>} /><div className="connection-summary"><div className="panel connection-status"><div className="panel-kicker">{t('git:connections.appKicker')}</div><h2>{config?.configured ? t('git:connections.appConfigured') : t('git:connections.appSetupRequired')}</h2><div className="setting-line"><span>{t('git:connections.fields.appId')}</span><strong>{config?.appId || '—'}</strong></div><div className="setting-line"><span>{t('git:connections.fields.privateKey')}</span><StatusPill status={config?.privateKeyConfigured ? t('common:states.ready') : t('common:states.blocked')} /></div><div className="setting-line"><span>{t('git:connections.fields.webhookSecret')}</span><StatusPill status={config?.webhookSecretConfigured ? t('common:states.ready') : t('common:states.blocked')} /></div></div><div className="panel connection-status"><div className="panel-kicker">{t('git:connections.legacyKicker')}</div><h2>{t('git:connections.legacyTitle')}</h2><p className="settings-copy">{t('git:connections.legacyDetail')}</p><button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} /> {t('common:actions.refresh')}</button></div></div><div className="panel"><div className="panel-head"><div><div className="panel-kicker">{t('git:connections.installationsKicker')}</div><h2>{t('git:connections.installationsTitle')}</h2></div><Webhook size={17} className="muted-icon" /></div>{config?.installations?.length ? <div className="installation-list">{config.installations.map((installation) => <div className="installation-row" key={installation.installationId}><div className="repo-mark"><GitFork size={15} /></div><div><strong>{installation.accountLogin || installation.installationId}</strong><span>{installation.repositorySelection || t('git:connections.repositorySelection')} · {installation.tokenConfigured ? t('git:connections.tokenCached') : t('git:connections.tokenOnUse')}</span></div><StatusPill status={t('git:shell.connection.authenticated')} /></div>)}</div> : <EmptyState title={t('git:connections.noInstallationsTitle')} detail={t('git:connections.noInstallationsDetail')} />}</div></>
}

function SecurityCenter({ onToast }: { onToast: (message: string) => void }) {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<Awaited<ReturnType<typeof api.auditLogs>>['logs']>([])
  const load = () => { void api.auditLogs().then((result) => setLogs(result.logs)).catch((error) => onToast(error.message)) }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <><PageIntro eyebrow={t('git:security.eyebrow')} title={t('git:security.title')} detail={t('git:security.subtitle')} action={<button className="secondary-button" onClick={load}><RefreshCw size={15} /> {t('git:security.refresh')}</button>} /><div className="security-grid"><div className="panel security-card"><div className="metric-icon cyan"><ShieldCheck size={17} /></div><h2>{t('git:security.roleCard.title')}</h2><p>{t('git:security.roleCard.detail')}</p></div><div className="panel security-card"><div className="metric-icon violet"><Webhook size={17} /></div><h2>{t('git:security.webhookCard.title')}</h2><p>{t('git:security.webhookCard.detail')}</p></div><div className="panel security-card"><div className="metric-icon amber"><PackageCheck size={17} /></div><h2>{t('git:security.releaseCard.title')}</h2><p>{t('git:security.releaseCard.detail')}</p></div></div><div className="panel audit-panel"><div className="panel-head"><div><div className="panel-kicker">{t('git:security.auditKicker')}</div><h2>{t('git:security.auditTitle')}</h2></div><ShieldCheck size={17} className="muted-icon" /></div>{logs.length ? <div className="audit-list">{logs.map((log) => <div className="audit-row" key={log.id}><div><strong>{log.action}</strong><span>{log.target} · {log.actor} · {formatStamp(log.at)}</span></div><StatusPill status={log.risk === 'high' ? t('git:security.highRisk') : log.result} /></div>)}</div> : <EmptyState title={t('git:security.noAuditTitle')} detail={t('git:security.noAuditDetail')} />}</div></>
}

function Monitoring({ projects, tasks, metrics }: { projects: Project[]; tasks: Task[]; metrics: Record<string, number> }) {
  const { t } = useTranslation()
  const healthy = projects.filter((project) => project.openIssues === 0).length
  return <><PageIntro eyebrow={t('git:monitoring.eyebrow')} title={t('git:monitoring.title')} detail={t('git:monitoring.subtitle')} /><div className="monitor-grid"><div className="panel health-score"><div className="panel-kicker">{t('git:monitoring.healthKicker')}</div><div className="score-ring"><strong>{projects.length ? Math.round((healthy / projects.length) * 100) : 0}<small>%</small></strong><span>{t('git:monitoring.healthyByIssues')}</span></div><div className="score-note"><ShieldCheck size={15} /> {t('git:monitoring.noSynthetic')}</div></div><div className="panel signal-list"><div className="panel-head"><div><div className="panel-kicker">{t('git:monitoring.signalsKicker')}</div><h2>{t('git:monitoring.signalsTitle')}</h2></div><Activity size={17} className="muted-icon" /></div><div className="signal-row"><span>{t('git:monitoring.signal.tracked')}</span><strong>{metrics.repositories || 0}</strong></div><div className="signal-row"><span>{t('git:monitoring.signal.failures')}</span><strong className="danger-text">{metrics.failedBuilds || 0}</strong></div><div className="signal-row"><span>{t('git:monitoring.signal.alerts')}</span><strong className="warning-text">{metrics.alerts || 0}</strong></div><div className="signal-row"><span>{t('git:monitoring.signal.lastTask')}</span><strong>{tasks[0]?.status || t('git:monitoring.noTasks')}</strong></div></div></div><div className="panel"><div className="panel-head"><div><div className="panel-kicker">{t('git:monitoring.coverageKicker')}</div><h2>{t('git:monitoring.coverageTitle')}</h2></div></div>{projects.length ? <div className="monitor-project-list">{projects.map((project) => <div className="monitor-project" key={project.id}><div className="repo-mark"><GitFork size={15} /></div><div><strong>{project.fullName}</strong><span>{project.language} · {t('git:monitoring.lastUpdated', { time: formatStamp(project.updatedAt) })}</span></div><StatusPill status={project.openIssues === 0 ? t('common:states.healthy') : t('git:monitoring.issues', { count: project.openIssues })} /></div>)}</div> : <EmptyState title={t('git:monitoring.emptyTitle')} detail={t('git:monitoring.emptyDetail')} />}</div></>
}

function AIOperations({ configured }: { configured: boolean }) {
  const { t } = useTranslation()
  const [provider, setProvider] = useState<{ configured: boolean; model: string | null; remoteWritesEnabled: boolean } | null>(null)
  const [registry, setRegistry] = useState<Awaited<ReturnType<typeof api.aiProviders>> | null>(null)
  useEffect(() => {
    void Promise.all([api.integrationAdapters(), api.aiProviders()])
      .then(([result, providers]) => { setProvider({ ...result.ai, remoteWritesEnabled: result.remoteWritesEnabled }); setRegistry(providers) })
      .catch(() => { setProvider(null); setRegistry(null) })
  }, [])
  const open = (page: string) => window.dispatchEvent(new CustomEvent('navigate', { detail: page }))
  const capabilities: { title: string; detail: string; status: string; page: string }[] = [
    { title: t('automation:operations.capabilities.evidenceTitle'), detail: configured ? t('automation:operations.capabilities.evidenceReady') : t('automation:operations.capabilities.evidenceBlocked'), status: configured ? t('common:states.ready') : t('common:states.blocked'), page: 'Repository Scanner' },
    { title: t('automation:operations.capabilities.proposalsTitle'), detail: provider?.configured ? t('automation:operations.capabilities.proposalsReady') : t('automation:operations.capabilities.proposalsBlocked'), status: provider?.configured ? t('common:states.ready') : t('common:states.blocked'), page: 'AI Pipeline' },
    { title: t('automation:operations.capabilities.localChecksTitle'), detail: t('automation:operations.capabilities.localChecksDetail'), status: t('common:states.guarded'), page: 'Task Center' },
    { title: t('automation:operations.capabilities.prTitle'), detail: provider?.remoteWritesEnabled ? t('automation:operations.capabilities.prEnabled') : t('automation:operations.capabilities.prDisabled'), status: provider?.remoteWritesEnabled ? t('common:states.ready') : t('common:states.disabled'), page: 'AI Pipeline' }
  ]
  return <><PageIntro eyebrow={t('automation:operations.eyebrow')} title={t('automation:operations.title')} detail={t('automation:operations.subtitle')} /><div className="ai-hero"><div className="ai-orb"><Sparkles size={27} /></div><div><div className="eyebrow purple">{t('automation:operations.providerEyebrow')}</div><h2>{provider?.configured ? t('automation:operations.providerConfigured', { model: provider.model || '' }) : t('automation:operations.providerRequired')}</h2><p>{provider?.configured ? t('automation:operations.providerDetail') : t('automation:operations.providerMissingDetail')}</p></div><StatusPill status={provider?.configured ? t('common:states.ready') : t('common:states.blocked')} /></div><div className="panel"><div className="panel-head"><div><div className="panel-kicker">{t('automation:operations.registryKicker')}</div><h2>{t('automation:operations.registryTitle', { count: registry?.providers.length || 0 })}</h2></div><span className="helper-copy">{t('automation:operations.keysNote')}</span></div>{registry?.providers.length ? <div className="finding-list">{registry.providers.map((item) => <div className="finding-row" key={item.id}><div><strong>{item.id} · {item.kind}</strong><span>{item.host || t('automation:operations.noEndpoint')} · {item.models.join(', ') || t('automation:operations.noModel')}{item.routedTasks.length ? ` · ${t('automation:operations.routes', { routes: item.routedTasks.join(', ') })}` : ''}</span></div><StatusPill status={item.configured ? item.default ? t('automation:operations.default') : t('common:states.ready') : t('common:states.blocked')} /></div>)}</div> : <EmptyState title={t('automation:operations.noProvidersTitle')} detail={t('automation:operations.noProvidersDetail')} />}</div><div className="capability-grid">{capabilities.map(({ title, detail, status, page }) => <button className="capability-card" key={title} onClick={() => open(page)}><div className="capability-icon"><Bot size={17} /></div><h3>{title}</h3><p>{detail}</p><span>{t('automation:operations.capabilities.open', { status, page: t(`git:shell.nav.${NAV_PAGES.find((entry) => entry.page === page)?.key || page}`) })}</span></button>)}</div></>
}

function TaskCenter({ tasks, onRefresh, onToast }: { tasks: Task[]; onRefresh: () => void; onToast: (message: string) => void }) {
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<IntegrationJob[]>([])
  const loadJobs = async () => { try { setJobs((await api.integrationJobs()).jobs) } catch (error) { onToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) } }
  useEffect(() => { void loadJobs(); const timer = window.setInterval(() => void loadJobs(), 3500); return () => window.clearInterval(timer) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const cancel = async (job: IntegrationJob) => { try { await api.cancelIntegrationJob(job.id); onToast(t('tasks:center.cancelToast', { repository: job.repository })); await loadJobs(); onRefresh() } catch (error) { onToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) } }
  const retry = async (job: IntegrationJob) => {
    const confirmDisclosure = job.type === 'agent'
    if (confirmDisclosure && !window.confirm(t('automation:pipeline.confirmRetry', { repository: job.repository }))) return
    try { await api.retryIntegrationJob(job.id, confirmDisclosure); onToast(t('tasks:center.retryToast', { repository: job.repository })); await loadJobs(); onRefresh() } catch (error) { onToast(error instanceof Error ? error.message : t('git:shell.toast.loadFailed')) }
  }
  return <><PageIntro eyebrow={t('tasks:center.eyebrow')} title={t('tasks:center.title')} detail={t('tasks:center.subtitle')} action={<button className="secondary-button" onClick={() => { onRefresh(); void loadJobs() }}><RefreshCw size={15} /> {t('tasks:center.refresh')}</button>} />
    <div className="panel task-center-panel"><div className="panel-head"><div><div className="panel-kicker">{t('tasks:center.appKicker')}</div><h2>{t('tasks:center.appTitle')}</h2></div></div>{tasks.length ? <div className="task-table full">{tasks.map((task) => <div className="task-row detailed" key={task.id}><div className="task-name"><span className="task-type">{task.type}</span><strong>{task.label}</strong>{task.error && <span className="task-error">{task.error}</span>}</div><StatusPill status={task.status} /><div className="task-dates"><span>{formatStamp(task.createdAt)}</span>{task.finishedAt && <span>{t('tasks:center.finished', { time: formatStamp(task.finishedAt) })}</span>}</div></div>)}</div> : <EmptyState title={t('tasks:center.emptyTitle')} detail={t('tasks:center.emptyDetail')} />}</div>
    <div className="panel integration-task-panel"><div className="panel-head"><div><div className="panel-kicker">{t('tasks:center.jobsKicker')}</div><h2>{t('tasks:center.jobsTitle')}</h2></div></div>{jobs.length ? <div className="integration-task-list">{jobs.map((job) => <article className="integration-task" key={job.id}><div className="integration-task-top"><div><strong>{job.repository}</strong><span>{job.type} · {job.currentStep}</span></div><StatusPill status={job.status} /><span className="job-progress-value">{job.progress}%</span></div><div className="progress-track"><span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div>{job.error && <p className="task-error visible">{job.error}</p>}{job.tests && <div className="signal-row"><span>{t('tasks:center.buildTestLabel')}</span><StatusPill status={job.tests.status} /></div>}<div className="integration-task-actions">{['Pending', 'Running'].includes(job.status) && <button className="secondary-button compact" onClick={() => void cancel(job)}>{t('common:actions.cancel')}</button>}{['Failed', 'Blocked', 'Cancelled'].includes(job.status) && <button className="secondary-button compact" onClick={() => void retry(job)}>{t('common:actions.retry')}</button>}{job.reportId && <button className="ghost-button" onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: 'Integration History' }))}>{t('tasks:center.viewReport')}</button>}</div><details className="job-output"><summary>{t('tasks:center.logSummary', { count: job.logs.length })}</summary><pre>{job.logs.join('\n') || t('tasks:center.noLogs')}</pre></details></article>)}</div> : <EmptyState title={t('tasks:center.emptyJobsTitle')} detail={t('tasks:center.emptyJobsDetail')} />}</div>
  </>
}

function SettingsPage({ status }: { status: { configured: boolean; owner: string | null; apiUrl: string; permissions: string[] } | null }) {
  const { t } = useTranslation()
  return <><PageIntro eyebrow={t('git:serverSettings.eyebrow')} title={t('git:serverSettings.title')} detail={t('git:serverSettings.subtitle')} /><div className="settings-grid"><div className="panel settings-panel"><div className="panel-kicker">{t('git:serverSettings.githubKicker')}</div><h2>{t('git:serverSettings.githubTitle')}</h2><div className="setting-line"><span>{t('git:serverSettings.fields.status')}</span><StatusPill status={status?.configured ? t('git:serverSettings.fields.connected') : t('common:states.blocked')} /></div><div className="setting-line"><span>{t('git:serverSettings.fields.owner')}</span><strong>{status?.owner || t('git:serverSettings.fields.notConfigured')}</strong></div><div className="setting-line"><span>{t('git:serverSettings.fields.apiEndpoint')}</span><code>{status?.apiUrl || '—'}</code></div><div className="setting-line"><span>{t('git:serverSettings.fields.grantedSurface')}</span><strong>{status?.permissions?.length ? status.permissions.join(', ') : t('git:serverSettings.fields.noToken')}</strong></div></div><div className="panel settings-panel"><div className="panel-kicker">{t('git:serverSettings.safetyKicker')}</div><h2>{t('git:serverSettings.safetyTitle')}</h2><div className="guardrail"><ShieldCheck size={16} /><div><strong>{t('git:serverSettings.credentialsTitle')}</strong><span>{t('git:serverSettings.credentialsDetail')}</span></div></div><div className="guardrail"><GitBranch size={16} /><div><strong>{t('git:serverSettings.refTitle')}</strong><span>{t('git:serverSettings.refDetail')}</span></div></div><div className="guardrail"><AlertTriangle size={16} /><div><strong>{t('git:serverSettings.guardsTitle')}</strong><span>{t('git:serverSettings.guardsDetail')}</span></div></div></div></div></>
}
