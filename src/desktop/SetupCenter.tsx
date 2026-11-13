import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, GitFork, KeyRound, Loader2, ShieldCheck, X } from 'lucide-react'
import { api, type AgentProvider, type Project } from '../api'
import ProviderModelPicker from './ProviderModelPicker'
import { runSetupBatch, type SetupBatchItem } from './setup-batch'

type BatchPhase = 'policy' | 'inspect' | 'enable' | 'issues'

type Destination = 'GitHub Connections' | 'Projects' | 'Hosting' | 'environment' | 'agent'
const destinations: Destination[] = ['GitHub Connections', 'agent', 'Projects', 'environment', 'Hosting', 'Hosting', 'Hosting']
const isArchivedRepository = (project: Project) => project.archived ?? project.repoMeta?.archived ?? false

export default function SetupCenter({ onClose, guided = false, onNavigate, onComplete }: {
  onClose: () => void; guided?: boolean; onNavigate?: (page: Destination, projectId?: string) => void; onComplete?: (projectId: string) => void
}) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLElement>(null)
  const locationCard = useRef<HTMLElement>(null)
  const close = useRef(onClose); close.current = onClose
  const navigate = useRef(onNavigate); navigate.current = onNavigate
  const inFlight = useRef(false)
  const githubEdited = useRef(false), providerEdited = useRef(false)
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<Set<number>>(new Set())
  const [githubToken, setGithubToken] = useState('')
  const [account, setAccount] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [model, setModel] = useState('')
  const [kind, setKind] = useState('openai-compatible')
  const [provider, setProvider] = useState<AgentProvider | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selected = selectedIds[0] || ''
  const selectedRef = useRef(selectedIds); selectedRef.current = selectedIds
  const selectionEdited = useRef(false)
  const [repositoryQuery, setRepositoryQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [batch, setBatch] = useState<{ phase: BatchPhase; items: SetupBatchItem[] } | null>(null)
  const batchResults = useRef<Partial<Record<BatchPhase, SetupBatchItem[]>>>({})
  const stopBatch = useRef(false), mounted = useRef(true)
  const readiness = useRef<Record<string, { readinessId: string; expiresAt: string }>>({})
  const issueCounts = useRef<Record<string, { scanned: number; newlyActionable: number }>>({})
  const [strategy, setStrategy] = useState(guided ? 'autonomous' : 'observe')
  const [interval, setInterval] = useState(30)
  const [trustedExecution, setTrustedExecution] = useState(false)
  const [allowDelivery, setAllowDelivery] = useState(false)
  const [policyEnabled, setPolicyEnabled] = useState(false)
  const [result, setResult] = useState('')
  const [complete, setComplete] = useState(false)
  const [peek, setPeek] = useState(false)
  const [schedulerChecked, setSchedulerChecked] = useState(false)
  const [schedulerPaused, setSchedulerPaused] = useState(false)
  const invalidate = (from: number) => {
    if (from === 0) githubEdited.current = true
    if (from === 1) providerEdited.current = true
    setDone((current) => new Set([...current].filter((index) => index < from)))
    readiness.current = {}; issueCounts.current = {}
    batchResults.current = {}; setBatch(null); setResult(''); setComplete(false)
  }
  const changeSelection = (ids: string[], edited = true) => {
    if (edited) selectionEdited.current = true
    selectedRef.current = ids; setSelectedIds(ids); invalidate(2)
    setAllowDelivery(false); setTrustedExecution(false); setPolicyEnabled(false)
    setStrategy(guided ? 'autonomous' : 'observe'); setInterval(30)
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; stopBatch.current = true }
  }, [])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    if (peek) locationCard.current?.focus()
    else dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { if (inFlight.current) { stopBatch.current = true; return }; if (peek) setPeek(false); else close.current(); return }
      if (event.key !== 'Tab' || peek) return
      const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)') || [])
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [peek])
  useEffect(() => {
    if (!guided) return
    navigate.current?.(destinations[step], selectedRef.current[0])
    if (dialog.current) dialog.current.scrollTop = 0
    dialog.current?.querySelector<HTMLElement>('.nx-setup-body h3')?.focus()
  }, [guided, step, peek])
  useEffect(() => {
    let active = true
    void api.githubStatus().then((github) => {
      if (!active || githubEdited.current) return
      setAccount(github.owner || 'GitHub')
      if (github.configured) setDone((current) => new Set([...current, 0]))
    }).catch(() => {})
    void api.agentProviders().then((ai) => {
      if (!active || providerEdited.current) return
      const existing = ai.providers.find((item) => item.configured)
      if (!existing) return
      setProvider(existing); setBaseUrl(existing.baseUrl); setModel(existing.model); setKind(existing.kind)
      setDone((current) => new Set([...current, 1]))
    }).catch(() => {})
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (step !== 2) return
    let active = true
    const load = () => api.projects().then((response) => {
      if (!active) return
      setProjects(response.projects)
      const eligible = response.projects.filter((item) => !isArchivedRepository(item))
      const available = new Set(eligible.map((item) => item.id))
      let ids = selectedRef.current.filter((id) => available.has(id))
      if (!selectionEdited.current && !ids.length && eligible[0]) ids = [eligible[0].id]
      if (ids.join('\0') !== selectedRef.current.join('\0')) changeSelection(ids, false)
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : t('git:setup.failed')) })
    const timer = window.setInterval(() => void load(), 2000)
    void load()
    return () => { active = false; window.clearInterval(timer) }
  }, [step])
  useEffect(() => {
    if (selectedIds.length !== 1) return
    let active = true
    void api.hostingProject(selected).then(({ project }) => {
      if (!active) return
      setPolicyEnabled(project.policy.enabled)
      if (project.policy.updatedAt || project.policy.enabled) {
        setStrategy(project.policy.strategy); setInterval(project.policy.intervalMinutes)
        setTrustedExecution(project.policy.executionMode === 'trusted-local')
      } else { setStrategy(guided ? 'autonomous' : 'observe'); setTrustedExecution(false) }
    }).catch(() => {})
    return () => { active = false }
  }, [selected, selectedIds.length, guided])
  useEffect(() => {
    if (step !== 6) return
    let active = true
    setSchedulerChecked(false)
    void api.hostingOverview().then((overview) => {
      if (!active) return
      setSchedulerPaused(overview.scheduler.paused); setSchedulerChecked(true)
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : t('git:setup.failed')) })
    return () => { active = false }
  }, [step, peek])
  const act = async (operation: () => Promise<void>, markDone = true) => {
    if (inFlight.current) return false
    inFlight.current = true; stopBatch.current = false; setBusy(true); setError(''); setResult('')
    try { await operation(); if (markDone) setDone((current) => new Set([...current, step])); return true }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('git:setup.failed')); return false }
    finally { inFlight.current = false; setBusy(false) }
  }
  const connect = async () => {
    invalidate(0)
    const connection = await window.nexusDesktop!.connectGitHub(githubToken)
    setGithubToken(''); setAccount(connection.account.login); setResult(connection.account.login)
  }
  const configure = async () => {
    invalidate(1)
    const records = await api.agentProviders()
    const stored = records.providers.find((item) => item.id === provider?.id && item.source === 'stored')
    const id = stored?.id || 'setup-provider'
    const metadata = { id, name: stored?.name || new URL(baseUrl).hostname, kind, baseUrl, model, priority: stored?.priority ?? 0, capabilities: stored?.capabilities || ['chat'] }
    const sameEndpoint = stored?.kind === kind && stored?.baseUrl.replace(/\/+$/, '') === baseUrl.trim().replace(/\/+$/, '')
    if (!apiKey.trim() && !(stored?.configured && sameEndpoint)) throw new Error(t('git:guide.keyRequired'))
    if (records.providers.some((item) => item.id === id)) await api.updateAgentProvider(id, metadata)
    else await api.createAgentProvider(metadata)
    if (apiKey.trim()) { await window.nexusDesktop!.setProviderKey(id, apiKey); setApiKey('') }
    const refreshed = await api.agentProviders()
    setProvider(refreshed.providers.find((item) => item.id === id) || null)
    const test = await api.testAgentProvider(id)
    if (!test.ok) throw new Error(test.error || t('git:setup.failed'))
    setResult(t('agent:providers.testOk', { latency: test.latencyMs }))
  }
  const detect = async () => {
    const env = await window.nexusDesktop!.detectEnvironment()
    if (!env.tools.some((tool) => tool.id === 'git' && tool.status === 'AVAILABLE')) throw new Error(t('git:guide.gitRequired'))
    setResult(`${env.available || 0} / ${env.total || 0}`)
  }
  const assertContinue = () => { if (!mounted.current || stopBatch.current) throw new Error(t('git:batch.stopped')) }
  const validateSelection = async () => {
    if (!selectedIds.length) throw new Error(t('git:guide.pickRepo'))
    const latest = await api.projects()
    setProjects(latest.projects)
    const eligible = new Set(latest.projects.filter((item) => !isArchivedRepository(item)).map((item) => item.id))
    if (selectedIds.some((id) => !eligible.has(id))) {
      changeSelection(selectedIds.filter((id) => eligible.has(id)))
      throw new Error(t('git:batch.selectionChanged'))
    }
    assertContinue()
  }
  const runBatch = async (phase: BatchPhase, operation: (id: string) => Promise<void>) => {
    await validateSelection()
    const previous = batchResults.current[phase]
    const retrying = previous?.some((item) => item.status !== 'success')
    if (phase === 'policy' || phase === 'inspect') {
      setDone((current) => new Set([...current].filter((index) => index < (phase === 'policy' ? 4 : 5))))
      delete batchResults.current.enable
      if (!retrying) readiness.current = {}
      if (phase === 'policy') delete batchResults.current.inspect
    }
    const items = await runSetupBatch(selectedIds, operation, {
      previous: retrying ? previous : undefined, concurrency: 2,
      shouldStop: () => stopBatch.current || !mounted.current,
      onProgress: (items) => { batchResults.current[phase] = items; if (mounted.current) setBatch({ phase, items }) }
    })
    const successful = items.filter((item) => item.status === 'success').length
    if (successful !== items.length) throw new Error(t('git:batch.incomplete', { successful, total: items.length }))
    assertContinue()
    setResult(t('git:batch.succeeded', { total: items.length }))
  }
  const savePolicy = async () => {
    if (guided && strategy !== 'observe' && !trustedExecution) throw new Error(t('git:guide.requireTrust'))
    await runBatch('policy', async (id) => {
      const current = (await api.hostingProject(id)).project.policy
      assertContinue()
      if (current.strategy !== strategy || current.intervalMinutes !== interval || current.executionMode !== (trustedExecution ? 'trusted-local' : 'blocked')) {
        await api.updateHostingPolicy(id, { strategy, intervalMinutes: interval, executionMode: trustedExecution ? 'trusted-local' : 'blocked', applyPreset: true, enabled: false })
        if (mounted.current) setPolicyEnabled(false)
      }
    })
  }
  const inspect = async () => {
    await runBatch('inspect', async (id) => {
      const response = await api.inspectHosting(id, 'light')
      if (response.run.status !== 'Success') throw new Error(response.run.error || t('git:setup.failed'))
      assertContinue()
      readiness.current[id] = await api.hostingReadiness(id)
    })
  }
  const enable = async () => {
    if (![0, 1, 2, 3, 4, 5].every((index) => done.has(index))) throw new Error(t('git:guide.requirePrereqs'))
    if (guided && strategy !== 'observe' && !allowDelivery) throw new Error(t('git:guide.requireDelivery'))
    await validateSelection()
    const overview = await api.hostingOverview()
    if (overview.scheduler.paused) { setSchedulerPaused(true); throw new Error(t('git:guide.resumeRequired')) }
    assertContinue()
    if (allowDelivery) await api.setRemoteWrites(true)
    assertContinue()
    await runBatch('enable', async (id) => {
      // A large batch can outlast the ten-minute readiness lease. Refresh
      // just before enabling this repository, without bypassing its checks.
      if (!readiness.current[id] || Date.parse(readiness.current[id].expiresAt) <= Date.now() + 30_000) readiness.current[id] = await api.hostingReadiness(id)
      assertContinue()
      try { await api.enableHosting(id, readiness.current[id].readinessId) }
      catch (cause) { delete readiness.current[id]; throw cause }
    })
    setComplete(true); setResult(t('git:hosting.updated'))
    localStorage.setItem('nexus-setup-complete', JSON.stringify({ projectId: selected, projectIds: selectedIds, completedAt: new Date().toISOString() }))
  }
  const inspectIssues = async () => {
    await runBatch('issues', async (id) => { issueCounts.current[id] = await api.syncProjectIssues(id) })
    const totals = selectedIds.reduce((acc, id) => ({ count: acc.count + (issueCounts.current[id]?.scanned || 0), actionable: acc.actionable + (issueCounts.current[id]?.newlyActionable || 0) }), { count: 0, actionable: 0 })
    setResult(t('git:guide.inspected', totals))
  }
  const confirmSelection = async () => {
    if (!selected) throw new Error(t('git:guide.pickRepo'))
    const latest = await api.projects()
    setProjects(latest.projects)
    if (!selectedRef.current.length) throw new Error(t('git:guide.pickRepo'))
    const eligible = new Set(latest.projects.filter((item) => !isArchivedRepository(item)).map((item) => item.id))
    if (selectedRef.current.some((id) => !eligible.has(id))) {
      changeSelection(selectedRef.current.filter((id) => eligible.has(id)))
      throw new Error(t('git:batch.selectionChanged'))
    }
  }
  const operation = [connect, configure, confirmSelection, detect, savePolicy, inspect, enable][step]
  const canRun = step === 0 ? Boolean(githubToken.trim()) : step === 1 ? Boolean(baseUrl && model && (apiKey || provider?.configured && provider.source === 'stored')) : step === 2 ? Boolean(selected) : step === 4 ? Boolean(selected && (strategy === 'observe' || trustedExecution || !guided)) : step === 5 ? Boolean(selected && (!guided || [0, 1, 2, 3, 4].every((index) => done.has(index)))) : step === 6 ? Boolean(selected && schedulerChecked && !schedulerPaused && [0, 1, 2, 3, 4, 5].every((index) => done.has(index)) && (!guided || strategy === 'observe' || allowDelivery)) : true
  const changeStep = (index: number) => { setResult(''); setError(''); setStep(index) }
  const next = async () => {
    if (busy || !canRun && !done.has(step)) return
    if (done.has(step) || await act(operation)) { if (step < 6) changeStep(step + 1) }
  }
  const title = t(`git:setup.steps.${step}`)
  const projectNames = new Map(projects.map((item) => [item.id, item.fullName]))
  const selectedSet = new Set(selectedIds)
  const eligibleProjects = projects.filter((item) => !isArchivedRepository(item))
  const archivedCount = projects.length - eligibleProjects.length
  const visibleProjects = projects.filter((item) => (showArchived || !isArchivedRepository(item)) && item.fullName.toLowerCase().includes(repositoryQuery.trim().toLowerCase()))
  const showBatch = batch && (complete ? ['enable', 'issues'].includes(batch.phase) : ({ policy: 4, inspect: 5, enable: 6, issues: -1 }[batch.phase] === step))
  if (peek) return <aside ref={locationCard} tabIndex={-1} className="nx-product-tour nx-panel" aria-label={t('git:guide.entry')}><header><BookOpen size={17} /><button className="nx-icon-button" onClick={onClose} aria-label={t('common:actions.close')}><X size={16} /></button></header><p className="nx-guide-location">{t('git:guide.location')}: {t(`git:guide.locations.${step}`)}</p><h2>{title}</h2><p>{t(`git:guide.instructions.${step}`)}</p><button className="nx-primary" onClick={() => setPeek(false)}>{t('git:guide.returnToSetup')}</button></aside>
  return <div className="nx-modal-backdrop"><section ref={dialog} className={`nx-setup nx-panel ${guided ? 'nx-setup-guided' : ''}`} role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <header><div>{guided ? <BookOpen size={22} /> : <GitFork size={22} />}<h2 id="setup-title">{guided ? t('git:guide.title') : t('git:setup.title')}</h2></div><button className="nx-icon-button" disabled={busy} onClick={onClose} aria-label={t('common:actions.close')}><X size={18} /></button></header>
    <div className="nx-setup-layout"><nav aria-label={t('git:setup.title')}>{Array.from({ length: 7 }, (_, index) => <button key={index} disabled={busy || complete || guided && index > step && !done.has(index - 1)} aria-current={step === index ? 'step' : undefined} onClick={() => changeStep(index)}><span>{done.has(index) ? <CheckCircle2 size={16} /> : index + 1}</span>{t(`git:setup.steps.${index}`)}</button>)}</nav>
      <div className="nx-setup-body"><h3 tabIndex={-1}>{complete ? t('git:guide.doneTitle') : title}</h3>
        {complete ? <div className="nx-setup-completion"><CheckCircle2 size={24} /><p>{t('git:batch.doneDetail', { total: selectedIds.length, minutes: interval })}</p><ul className="nx-setup-enabled-repos">{selectedIds.map((id) => <li key={id}>{projectNames.get(id) || id}</li>)}</ul><p>{t('git:guide.keepRunning')}</p><p>{t('git:guide.limits')}</p><div className="nx-guide-actions"><button className="nx-primary" disabled={busy} onClick={() => onComplete?.(selected)}>{t('git:guide.viewRunLocations')}<ChevronRight size={15} /></button><button className="nx-secondary" disabled={busy} onClick={() => void act(inspectIssues, false)}>{t('git:guide.inspectNow')}</button></div></div> : <>
        {guided && <><p className="nx-guide-location" aria-live="polite">{t('git:guide.progress', { step: step + 1, total: 7 })} | {t('git:guide.location')}: {t(`git:guide.locations.${step}`)}</p><div className="nx-guide-instructions"><strong>{t('git:guide.doThis')}</strong><p>{t(`git:guide.instructions.${step}`)}</p><p className="nx-guide-expected">{t('git:guide.then')}: {t(`git:guide.expected.${step}`)}</p></div></>}
        {!guided && <p>{t(`git:setup.details.${step}`)}</p>}
        {step === 0 && <>{done.has(0) && <p className="nx-setup-reuse">{t('git:guide.reuseGitHub', { account })}</p>}<div className="nx-setup-token-field"><div className="nx-setup-token-heading"><label htmlFor="setup-github-token">{t('git:setup.githubToken')}</label><a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener noreferrer" onClick={(event) => { if (!window.nexusDesktop?.openGitHubTokenPage) return; event.preventDefault(); void window.nexusDesktop.openGitHubTokenPage().catch((cause) => setError(cause instanceof Error ? cause.message : t('git:setup.failed'))) }}><ExternalLink size={14} aria-hidden="true" />{t('git:setup.getGithubToken')}</a></div><input id="setup-github-token" disabled={busy} type="password" autoComplete="off" value={githubToken} onChange={(event) => { setGithubToken(event.target.value); invalidate(0) }} /></div><button className="nx-primary" disabled={busy || !githubToken.trim()} onClick={() => void act(connect)}><GitFork size={15} />{t('git:setup.connect')}</button></>}
        {step === 1 && <>{done.has(1) && <p className="nx-setup-reuse">{t('git:guide.reuseAI', { model: provider?.model || model })}</p>}<label>{t('agent:providers.form.kind')}<select disabled={busy} value={kind} onChange={(event) => { setKind(event.target.value); invalidate(1) }}>{['openai-compatible', 'openai', 'anthropic', 'gemini'].map((value) => <option key={value}>{value}</option>)}</select></label><label>{t('agent:providers.form.baseUrl')}<input disabled={busy} value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); invalidate(1) }} /></label><label>{t('agent:providers.keyPlaceholder')}<input disabled={busy} type="password" autoComplete="off" value={apiKey} onChange={(event) => { setApiKey(event.target.value); invalidate(1) }} /></label><ProviderModelPicker kind={kind} baseUrl={baseUrl} apiKey={apiKey} providerId={provider?.id} value={model} disabled={busy} onChange={(value) => { setModel(value); invalidate(1) }} /><button className="nx-primary" disabled={busy || !canRun} onClick={() => void act(configure)}><KeyRound size={15} />{t('git:setup.saveTest')}</button></>}
        {step === 2 && <>
          <div className="nx-repo-toolbar">
            <button className="nx-secondary" disabled={busy} onClick={() => void act(async () => { await api.syncRepositories(); setResult(t('git:shell.toast.syncQueued')) }, false)}>{t('git:overview.syncGithub')}</button>
            <button className="nx-secondary nx-repo-select-all" disabled={busy || !eligibleProjects.length || selectedIds.length === eligibleProjects.length} onClick={() => changeSelection(eligibleProjects.map((item) => item.id))}>{t('git:batch.selectAll')}</button>
            <button className="nx-secondary nx-repo-select-none" disabled={busy || !selectedIds.length} onClick={() => changeSelection([])}>{t('git:batch.selectNone')}</button>
          </div>
          <label htmlFor="setup-repository-search">{t('git:batch.search')}</label>
          <input id="setup-repository-search" type="search" disabled={busy} value={repositoryQuery} onChange={(event) => setRepositoryQuery(event.target.value)} />
          <div className="nx-repo-selection-summary"><div className="nx-repo-selection-count" role="status" aria-live="polite">{t('git:batch.selected', { selected: selectedIds.length, total: eligibleProjects.length })}</div>
            {archivedCount > 0 && <label className="nx-repo-archive-toggle"><input id="setup-show-archived" type="checkbox" disabled={busy} checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />{t('git:batch.showArchived', { total: archivedCount })}</label>}
          </div>
          {archivedCount > 0 && <p className="nx-repo-archive-hint">{t('git:batch.archivedHint')}</p>}
          <div className="nx-repo-checklist" role="group" aria-label={t('git:setup.repository')}>
            {visibleProjects.map((item) => {
              const archived = isArchivedRepository(item)
              return <label className={`nx-repo-option ${archived ? 'nx-repo-option-archived' : ''}`} key={item.id}><input type="checkbox" disabled={busy || archived} checked={!archived && selectedSet.has(item.id)} value={item.id} onChange={(event) => changeSelection(event.target.checked ? [...selectedIds, item.id] : selectedIds.filter((id) => id !== item.id))} /><span className="nx-repo-name">{item.fullName}</span><span className={`nx-repo-status ${archived ? 'archived' : 'active'}`}>{t(archived ? 'git:batch.archived' : 'git:batch.active')}</span></label>
            })}
            {!visibleProjects.length && <p>{t(!projects.length ? 'git:batch.empty' : !showArchived && !eligibleProjects.length ? 'git:batch.noActive' : 'git:batch.noMatches')}</p>}
          </div>
          <button className="nx-primary" disabled={busy || !selectedIds.length} onClick={() => void act(operation)}>{t('common:actions.confirm')}</button>
        </>}
        {step === 3 && <button className="nx-primary" disabled={busy} onClick={() => void act(detect)}>{t('git:setup.detect')}</button>}
        {step === 4 && <><p>{t('git:batch.applyTo', { total: selectedIds.length })}</p>{policyEnabled && <p>{t('git:guide.policyLoaded')}</p>}<label className="nx-setup-consent"><input disabled={busy} type="checkbox" checked={trustedExecution} onChange={(event) => { setTrustedExecution(event.target.checked); invalidate(4) }} />{t('git:batch.trustedExecution')}</label><label>{t('git:hosting.strategy')}<select disabled={busy} value={strategy} onChange={(event) => { setStrategy(event.target.value); invalidate(4) }}>{['observe', 'maintain', 'autonomous'].map((value) => <option key={value} value={value}>{t(`git:setup.strategies.${value}`)}</option>)}</select></label><label>{t('git:hosting.interval')}<select disabled={busy} value={interval} onChange={(event) => { setInterval(Number(event.target.value)); invalidate(4) }}>{[15, 30, 60, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes}</option>)}</select></label>{guided && strategy !== 'observe' && !trustedExecution && <p>{t('git:guide.requireTrust')}</p>}<button className="nx-primary" disabled={busy || !canRun} onClick={() => void act(savePolicy)}>{t('common:actions.save')}</button></>}
        {step === 5 && <button className="nx-primary" disabled={busy || !canRun} onClick={() => void act(inspect)}><ShieldCheck size={15} />{t('git:hosting.inspectLight')}</button>}
        {step === 6 && <><p>{t('git:batch.applyTo', { total: selectedIds.length })}</p><p>{t('git:guide.limits')}</p>{schedulerPaused && <div className="nx-guide-instructions"><p>{t('git:guide.resumeRequired')}</p><button className="nx-secondary" disabled={busy} onClick={() => void act(async () => { await api.pauseHosting(false); setSchedulerPaused(false); setSchedulerChecked(true) }, false)}>{t('git:hosting.resume')}</button></div>}<label className="nx-setup-consent"><input disabled={busy} type="checkbox" checked={allowDelivery} onChange={(event) => setAllowDelivery(event.target.checked)} />{t('git:setup.remoteWrites')}</label>{guided && strategy !== 'observe' && !allowDelivery && <p>{t('git:guide.requireDelivery')}</p>}{!guided && <button className="nx-primary" disabled={busy || !canRun} onClick={() => void act(enable)}>{t('git:hosting.enable')}</button>}</>}
        </>}
        {showBatch && <section className="nx-setup-batch" aria-label={t('git:batch.results')}>
          <p role="status" aria-live="polite">{t(`git:batch.phases.${batch.phase}`)} · {t('git:batch.progress', { finished: batch.items.filter((item) => item.status === 'success' || item.status === 'failed').length, total: batch.items.length })}</p>
          <ul>{batch.items.map((item) => <li key={item.id} data-project-id={item.id} data-status={item.status}><span>{projectNames.get(item.id) || item.id}</span><strong>{t(`git:batch.states.${item.status}`)}</strong>{item.error && <small>{item.error}</small>}</li>)}</ul>
          {busy ? <button className="nx-secondary" onClick={() => { stopBatch.current = true }}>{t('git:batch.stop')}</button> : batch.items.some((item) => item.status !== 'success') && <button className="nx-secondary nx-batch-retry" onClick={() => void act(batch.phase === 'issues' ? inspectIssues : operation, batch.phase !== 'issues')}>{t('git:batch.retry')}</button>}
        </section>}
        {busy && <p role="status"><Loader2 size={15} className="spin" />{t('common:states.working')}</p>}{error && <p className="danger-text" role="alert">{error}</p>}{result && <p className="success-text" role="status">{result}</p>}{done.has(step) && !complete && <p className="nx-setup-complete"><CheckCircle2 size={15} />{t('common:states.ready')}</p>}
      </div></div><footer><button className="nx-secondary" disabled={step === 0 || busy || complete} onClick={() => changeStep(step - 1)}><ChevronLeft size={15} />{t('git:setup.previous')}</button>{guided && !complete && <button className="nx-secondary" disabled={busy} onClick={() => setPeek(true)}>{t('git:guide.viewLocation')}</button>}{!complete && <button className="nx-primary nx-setup-next" disabled={busy || (guided ? !done.has(step) && !canRun : step === 6 || !done.has(step))} onClick={() => void (guided ? next() : changeStep(step + 1))}>{guided && step === 6 ? t('git:hosting.enable') : t('git:setup.next')}<ChevronRight size={15} /></button>}</footer>
  </section></div>
}
