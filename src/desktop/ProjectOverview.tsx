import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, ChevronDown, ChevronUp, CircleDot, GitBranch, Maximize, Network, RefreshCw, Search, ShieldCheck, TerminalSquare, UserRound, X, ZoomIn, ZoomOut } from 'lucide-react'
import { api, type OverviewStage, type ProjectOverviewSnapshot } from '../api'
import { formatTime, formatStamp } from '../i18n/format'
import { fitOverview, layoutOverview } from './overview-layout'
import './project-overview.css'

const POLL_MS = 3000
const ICONS = { ai: Bot, inspection: Search, analysis: Network, execution: TerminalSquare, verification: ShieldCheck, delivery: GitBranch, research: CircleDot }
type OpenDestination = 'Hosting' | 'Task Center' | 'Research' | 'agent'

export default function ProjectOverview({ onNavigate }: { onNavigate: (page: OpenDestination, projectId?: string, taskId?: string) => void }) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ProjectOverviewSnapshot | null>(null)
  const [error, setError] = useState(false), [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all')
  const [outputOpen, setOutputOpen] = useState(false)
  const [hidden, setHidden] = useState(document.hidden), [clock, setClock] = useState(Date.now())
  const [size, setSize] = useState({ width: 800, height: 540 })
  const [view, setView] = useState({ zoom: 0.65, x: 0, y: 0 })
  const svg = useRef<SVGSVGElement>(null), canvas = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const viewRef = useRef(view); viewRef.current = view
  const sizeRef = useRef(size); sizeRef.current = size
  const refresh = useRef<() => void>(() => {})
  const projectId = selected?.startsWith('repository:') ? selected.slice(11) : ''

  useEffect(() => {
    let active = true, pending = false
    const load = async () => {
      if (!active || pending || document.hidden) return
      pending = true; setRefreshing(true)
      try { const data = await api.projectOverview(projectId); if (active) { setSnapshot(data); setError(false) } }
      catch { if (active) setError(true) }
      finally { pending = false; if (active) setRefreshing(false) }
    }
    refresh.current = () => { void load() }
    const visibility = () => { setHidden(document.hidden); if (!document.hidden) void load() }
    const timer = window.setInterval(() => void load(), POLL_MS)
    document.addEventListener('visibilitychange', visibility)
    void load()
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [projectId])
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    if (canvas.current) observer.observe(canvas.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const element = svg.current
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const bounds = element!.getBoundingClientRect(), dims = sizeRef.current
      const px = event.clientX - bounds.left - dims.width / 2, py = event.clientY - bounds.top - dims.height / 2
      setView((current) => {
        const zoom = Math.max(0.08, Math.min(2.5, current.zoom * Math.exp(-event.deltaY * 0.0012)))
        return { zoom, x: px - (px - current.x) * zoom / current.zoom, y: py - (py - current.y) * zoom / current.zoom }
      })
    }
    element?.addEventListener('wheel', wheel, { passive: false })
    return () => element?.removeEventListener('wheel', wheel)
  }, [])
  const repositories = snapshot?.repositories || []
  const visible = repositories.filter((repo) => repo.fullName.toLowerCase().includes(query.trim().toLowerCase()) && (filter === 'all' || filter === 'active' && ['running', 'queued'].includes(repo.status) || filter === 'attention' && ['blocked', 'failed'].includes(repo.status) || filter === 'enabled' && repo.enabled))
  const signature = visible.map((repo) => repo.id).join('\0')
  const layout = useMemo(() => layoutOverview(signature ? signature.split('\0') : []), [signature])
  const byNode = new Map(layout.nodes.map((node) => [node.id, node]))
  const byRepo = new Map(repositories.map((repo) => [repo.id, repo]))
  const reset = () => setView({ zoom: fitOverview(layout, size), x: 0, y: 0 })
  useEffect(reset, [layout.width, layout.height, size.width, size.height, signature])
  useEffect(() => {
    if (!projectId) return
    const node = layout.nodes.find((item) => item.id === `repository:${projectId}`)
    if (!node) return
    const zoom = Math.max(0.85, Math.min(1.15, fitOverview(layout, size) * 1.8))
    setView({ zoom, x: -node.x * zoom - Math.min(130, size.width * 0.15), y: -node.y * zoom })
  }, [projectId, signature])
  const stale = !snapshot || error || clock - Date.parse(snapshot.updatedAt) > 10_000 || snapshot.warnings.length > 0
  const live = !stale && !hidden
  const relatedTasks = snapshot?.tasks.filter((task) => !projectId || task.projectId === projectId) || []
  const selectedRepo = byRepo.get(projectId)
  const serviceId = selected?.startsWith('service:') ? selected.slice(8) : null
  const nodeTasks = serviceId && serviceId !== 'ai' ? relatedTasks.filter((task) => task.stage === serviceId) : relatedTasks
  const events = snapshot?.eventsScope === (projectId || null) ? snapshot.events : []
  const titleFor = (id: string) => id === 'account' ? snapshot?.account.login || 'GitHub' : id.startsWith('repository:') ? byRepo.get(id.slice(11))?.fullName || id : t(`workstation:overview.services.${id.slice(8)}`)
  const choose = (id: string) => { setSelected(id); if (id.startsWith('repository:')) { setQuery(''); setFilter('all') } }
  const zoomBy = (factor: number) => setView((current) => { const zoom = Math.max(0.08, Math.min(2.5, current.zoom * factor)); return { zoom, x: current.x * zoom / current.zoom, y: current.y * zoom / current.zoom } })
  const taskName = (id: string) => snapshot?.tasks.find((task) => task.id === id)?.label || id
  const output = (items = events) => items.length ? <ol className="nx-map-events">{items.map((event) => <li key={event.id} data-event-id={event.id}>
    <div><time title={formatStamp(event.at)}>{formatTime(event.at)}</time><span>{event.projectId ? byRepo.get(event.projectId)?.fullName : taskName(event.taskId)}</span></div><pre>{event.detail}</pre>
  </li>)}</ol> : <p className="nx-map-empty-output">{refreshing ? t('common:states.loading') : t('workstation:overview.noOutput')}</p>

  return <section className="nx-project-overview" aria-label={t('workstation:overview.title')} data-live={live} onKeyDown={(event) => { if (event.key === 'Escape') setSelected(null) }}>
    <header className="nx-map-header"><div><Network size={19} /><h1>{t('workstation:overview.title')}</h1></div><div className={`nx-map-connection ${live ? 'is-live' : ''}`} role="status"><i />{t(hidden ? 'workstation:overview.background' : stale ? 'workstation:overview.disconnected' : 'workstation:overview.live')}{snapshot && <time title={formatStamp(snapshot.updatedAt)}>{formatTime(snapshot.updatedAt)}</time>}</div><button className="nx-secondary" disabled={refreshing} onClick={() => refresh.current()}><RefreshCw size={14} className={refreshing ? 'spin' : ''} />{t('common:actions.refresh')}</button></header>
    <div className="nx-map-stats">{(['repositories', 'enabled', 'running', 'queued', 'attention'] as const).map((key) => <span key={key} data-stat={key}><b>{snapshot?.stats[key] ?? '—'}</b>{t(`workstation:overview.stats.${key}`)}</span>)}{snapshot?.paused && <strong>{t('workstation:overview.schedulerPaused')}</strong>}</div>
    <div className="nx-map-toolbar"><label><Search size={14} /><input type="search" aria-label={t('workstation:overview.search')} placeholder={t('workstation:overview.search')} value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label={t('workstation:overview.filter')} value={filter} onChange={(event) => setFilter(event.target.value)}>{['all', 'active', 'attention', 'enabled'].map((key) => <option key={key} value={key}>{t(`workstation:overview.filters.${key}`)}</option>)}</select><select className="nx-map-locate" aria-label={t('workstation:overview.locate')} value={projectId} onChange={(event) => { if (event.target.value) choose(`repository:${event.target.value}`) }}><option value="">{t('workstation:overview.locate')}</option>{repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}</select><span>{visible.length} / {repositories.length}</span></div>
    {(error || snapshot?.warnings.length) ? <div className="nx-map-warning" role="alert">{t(error ? 'workstation:overview.refreshFailed' : 'workstation:overview.partial')}</div> : null}
    <div ref={canvas} className="nx-overview-canvas">
      <svg ref={svg} className="nx-overview-svg" aria-label={t('workstation:overview.graphLabel')} onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as Element).closest('[data-node]')) return
        drag.current = { x: event.clientX, y: event.clientY, tx: viewRef.current.x, ty: viewRef.current.y }; event.currentTarget.setPointerCapture(event.pointerId)
      }} onPointerMove={(event) => { if (drag.current) setView((current) => ({ ...current, x: drag.current!.tx + event.clientX - drag.current!.x, y: drag.current!.ty + event.clientY - drag.current!.y })) }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
        <defs><pattern id="nx-map-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" /></pattern><marker id="nx-map-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" /></marker></defs>
        <rect width="100%" height="100%" fill="url(#nx-map-grid)" />
        <g transform={`translate(${size.width / 2 + view.x} ${size.height / 2 + view.y}) scale(${view.zoom})`}>
          <ellipse className="nx-map-orbit" rx="345" ry="260" />
          {visible.map((repo) => { const node = byNode.get(`repository:${repo.id}`)!; return <path key={repo.id} className={`nx-map-ownership${projectId === repo.id ? ' is-selected' : ''}`} d={`M0,0 Q${node.x * 0.48},${node.y * 0.18} ${node.x},${node.y}`} /> })}
          {Object.keys(ICONS).map((key) => { const node = byNode.get(`service:${key}`)!; return <path key={key} className={`nx-map-service-link ${key === 'ai' ? 'is-ai' : ''}`} d={`M0,0 L${node.x},${node.y}`} /> })}
          {(snapshot?.tasks || []).filter((task) => task.status === 'running').map((task) => {
            const from = byNode.get(`service:${task.stage}`), to = task.projectId ? byNode.get(`repository:${task.projectId}`) : byNode.get('service:ai')
            if (!from || !to) return null
            return <g key={task.id}>
              {task.providerId && ['agent', 'hosted'].includes(task.source) && <path data-ai-task={task.id} className={`nx-map-ai-flow${live ? ' is-active' : ''}${projectId && task.projectId !== projectId ? ' is-muted' : ''}`} d={`M-255,-15 Q${to.x * 0.35 - 110},${Math.min(-170, to.y - 130)} ${to.x},${to.y}`}><title>{task.label}</title></path>}
              <path data-flow={task.id} data-flow-project={task.projectId || ''} data-flow-stage={task.stage} className={`nx-map-flow${live ? ' is-active' : ''}${projectId && task.projectId !== projectId ? ' is-muted' : ''}`} markerEnd="url(#nx-map-arrow)" d={`M${from.x},${from.y} Q${(from.x + to.x) / 2 + 65},${Math.min(from.y, to.y) - 65} ${to.x},${to.y}`} />
            </g>
          })}
          {layout.nodes.map((node) => {
            const repo = node.kind === 'repository' ? byRepo.get(node.id.slice(11)) : null
            const key = node.id.slice(8) as keyof typeof ICONS
            const Icon = node.kind === 'account' ? UserRound : node.kind === 'repository' ? GitBranch : ICONS[key]
            const service = snapshot?.services.find((item) => item.id === key)
            const aiTasks = snapshot?.tasks.filter((task) => ['agent', 'hosted'].includes(task.source) && task.status === 'running').length || 0
            const status = repo?.status || ((key === 'ai' ? aiTasks : service?.running || 0) > 0 ? 'running' : 'idle')
            return <g key={node.id} data-node={node.id} data-status={status} role="button" tabIndex={0} aria-label={`${titleFor(node.id)}${repo ? `, ${t(`workstation:overview.states.${repo.status}`)}` : ''}`} aria-pressed={selected === node.id} className={`nx-map-node nx-map-${node.kind}${selected === node.id ? ' is-selected' : ''}${key === 'ai' ? ' is-ai' : ''}`} transform={`translate(${node.x} ${node.y})`} onClick={() => choose(node.id)} onKeyDown={(event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); choose(node.id) } }}>
              <title>{titleFor(node.id)}</title>
              {node.kind === 'account' ? <><circle className="nx-map-account-ring" r="81" /><circle className="nx-map-node-bg" r="70" /><Icon x={-13} y={-44} size={26} /><text textAnchor="middle" y="5" className="nx-map-account-name">{(snapshot?.account.login || 'GitHub').slice(0, 17)}</text><text textAnchor="middle" y="31" className="nx-map-node-detail">{t(snapshot?.account.configured ? 'workstation:overview.connected' : 'workstation:overview.notConnected')}</text></> : <>
                <rect className="nx-map-node-bg" x={-node.width / 2} y={-node.height / 2} width={node.width} height={node.height} rx="7" /><Icon x={-node.width / 2 + 12} y={-13} size={17} />
                <foreignObject x={-node.width / 2 + 38} y={-19} width={node.width - 48} height={24}><div className="nx-map-node-name">{repo?.name || t(`workstation:overview.services.${key}`)}</div></foreignObject>
                <foreignObject x={-node.width / 2 + 38} y={6} width={node.width - 55} height={19}><div className="nx-map-node-small">{repo ? t(`workstation:overview.states.${repo.status}`) : key === 'ai' ? t('workstation:overview.providerCount', { total: snapshot?.providers.filter((provider) => provider.configured).length || 0 }) : t('workstation:overview.serviceCount', { total: service?.running || 0 })}</div></foreignObject>
                <circle className="nx-map-node-dot" cx={node.width / 2 - 10} cy={node.height / 2 - 11} r="3" />
              </>}
            </g>
          })}
        </g>
      </svg>
      {!snapshot && <div className="nx-map-placeholder" role="status">{t(error ? 'workstation:overview.refreshFailed' : 'common:states.loading')}</div>}
      {snapshot && !visible.length && <div className="nx-map-no-repos">{t(repositories.length ? 'workstation:overview.noMatches' : 'workstation:overview.noRepositories')}</div>}
      <div className="nx-map-controls"><button className="nx-icon-button" aria-label={t('workstation:overview.zoomIn')} onClick={() => zoomBy(1.25)}><ZoomIn size={16} /></button><span>{Math.round(view.zoom * 100)}%</span><button className="nx-icon-button" aria-label={t('workstation:overview.zoomOut')} onClick={() => zoomBy(0.8)}><ZoomOut size={16} /></button><button className="nx-icon-button" aria-label={t('workstation:overview.fit')} onClick={reset}><Maximize size={16} /></button></div>
      <div className="nx-map-legend"><span><i />{t('workstation:overview.relation')}</span><span><i className="is-flow" />{t('workstation:overview.activity')}</span><small>{t('workstation:overview.gesture')}</small></div>
      {selected && <aside className="nx-map-inspector" aria-label={t('workstation:overview.details')}><header><h2>{titleFor(selected)}</h2><button className="nx-icon-button" aria-label={t('common:actions.close')} onClick={() => setSelected(null)}><X size={16} /></button></header>
        {selectedRepo && <><p className={`nx-map-inspector-state is-${selectedRepo.status}`}>{t(`workstation:overview.states.${selectedRepo.status}`)}</p><dl><div><dt>{t('workstation:overview.hosting')}</dt><dd>{t(selectedRepo.enabled ? 'workstation:overview.hostingOn' : 'workstation:overview.hostingOff')}</dd></div><div><dt>{t('git:hosting.strategy')}</dt><dd>{t(`git:setup.strategies.${selectedRepo.strategy}`)}</dd></div><div><dt>{t('git:hosting.interval')}</dt><dd>{selectedRepo.intervalMinutes} {t('workstation:overview.minutes')}</dd></div></dl><button className="nx-secondary" onClick={() => onNavigate('Hosting', projectId)}>{t('workstation:overview.openHosting')}</button></>}
        {(selected === 'account' || serviceId === 'ai') && <div className="nx-map-providers"><h3>{t('workstation:overview.aiProviders')}</h3>{snapshot?.providers.length ? snapshot.providers.map((provider) => <p key={provider.id}><b>{provider.name}</b><span>{provider.model} · {t(provider.configured ? 'workstation:overview.ready' : 'workstation:overview.unconfigured')}</span></p>) : <p>{t('workstation:overview.unconfigured')}</p>}<button className="nx-secondary" onClick={() => onNavigate('agent')}>{t('workstation:overview.openAgent')}</button></div>}
        {serviceId === 'research' && <button className="nx-secondary" onClick={() => onNavigate('Research', projectId || undefined)}>{t('workstation:overview.openResearch')}</button>}
        <h3>{t('workstation:overview.tasks')}</h3><div className="nx-map-task-list">{nodeTasks.length ? nodeTasks.slice(0, 12).map((task) => <button key={task.id} onClick={() => {
          if (task.source === 'agent') onNavigate('agent', undefined, task.taskId)
          else if (task.source.startsWith('research')) onNavigate('Research', task.projectId || undefined)
          else if (task.source === 'inspection' || task.source === 'integration') onNavigate('Hosting', task.projectId || undefined)
          else if (task.localTaskId && task.stage !== 'delivery') onNavigate('agent', undefined, task.localTaskId)
          else onNavigate('Task Center', task.projectId || undefined)
        }}><span>{task.label}</span><small>{t(`workstation:overview.states.${task.status}`)} · {t(`workstation:overview.services.${task.stage}`)}</small>{task.error && <em>{task.error}</em>}{task.deliveryStatus && <small>{t('workstation:overview.deliveryStatus')}: {task.deliveryStatus}</small>}</button>) : <p>{t('workstation:overview.noTasks')}</p>}</div>
        <h3>{t('workstation:overview.output')}</h3>{output(serviceId && serviceId !== 'ai' ? events.filter((event) => event.stage === serviceId as OverviewStage) : events)}
      </aside>}
    </div>
    <section className={`nx-map-output${outputOpen ? ' is-open' : ''}`} aria-label={t('workstation:overview.output')}><button className="nx-map-output-toggle" onClick={() => setOutputOpen((value) => !value)} aria-expanded={outputOpen}><TerminalSquare size={14} /><strong>{t('workstation:overview.output')}</strong><span>{events[0]?.detail.split('\n')[0] || t('workstation:overview.noOutput')}</span>{outputOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</button>{outputOpen && output()}</section>
    <footer className="nx-map-footer"><span>{t('workstation:overview.polling')}</span>{snapshot?.eventsTruncated && <span>{t('workstation:overview.limited')}</span>}</footer>
  </section>
}
