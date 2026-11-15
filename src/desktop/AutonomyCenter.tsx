import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity, AlertTriangle, Bot, CheckCircle2, ChevronRight, CircleDot, Cpu,
  Database, ExternalLink, FileText, FolderGit2, GitBranch, GitPullRequest,
  Layers, Loader2, Pause, Play, Radio, RefreshCw, Search, ShieldAlert,
  ShieldCheck, Square, Terminal, Users, Zap
} from 'lucide-react'
import { request } from '../api'
import './autonomy.css'

type Overview = {
  repositoriesManaged: number
  repositoriesHealthy: number
  newProblems: number
  pendingFixes: number
  aiTasksRunning: number
  problemsFixed: number
  awaitingVerification: number
  securityRisks: number
  peerUpdates: number
  lastRelease: { version: string; repository: string; createdAt: string } | null
  recentActivity: { id: string; repository: string; mode: string; events: number; verdict: string; at: string }[]
  desktopClients: { id: string; name: string; installed: boolean; running: boolean; uia: boolean; checkedAt: string }[]
  control: {
    enabled: boolean; paused: boolean; automationMode: string; maxConcurrent: number; remoteWritesEnabled?: boolean
    monitorConfigured: boolean; lastTickAt: string | null; storeBackend: string
    tasks: { queued: number; running: number; awaitingHuman: number; accepted: number }
    sessions: { active: number; handoff: number }
  }
  generatedAt: string
}

type Repo = {
  id: string; fullName: string; localPath: string; defaultBranch: string
  pollIntervalMs: number; monitorItems: string[]; agentAdapterId: string | null
  agentProjectRef: string; autoFix: boolean; autoMerge: boolean; autoRelease: boolean
  automationMode: string; webhookEnabled: boolean; enabled: boolean; createdAt: string
}

type Adapter = {
  id: string; name: string; installed: boolean; running: boolean; launcher: string | null
  version: string | null; uia: { available: boolean; reason: string } | null
  loginState?: string; projectRefs?: string[]
  uiEvidence?: { hasComposer?: boolean; hasSendControl?: boolean; projectControl?: { name?: string } | null }
  capabilities: Record<string, { level: string; evidence: string }> | null
  checkedAt: string
}

type Task = {
  id: string; repoId?: string; repository: string; kind: string; priority: string; status: string
  attempts: number; createdAt: string; updatedAt: string; error: string | null
  workspace?: { path: string; branch: string; baseSha: string; isolated?: boolean; worktree?: boolean } | null
  verification?: { verdict: string } | null
  delivery?: { status?: string; pullRequest?: { number: number; url: string }; commit?: { sha?: string } } | null
}

type Finding = { id: string; repository: string; kind: string; severity: string; priority: string; title: string; status: string; createdAt: string }
type Session = { id: string; taskId: string; repository: string; adapterId: string; state: string; handoff: boolean; sentAt: string | null; packageFile: string | null }
type Peer = { id: string; fullName: string; stack: string | null; stars: number; license: string | null; pushedAt: string }
type Proposal = { id: string; featureName: string; sourceProject: string; sourceLicence: string | null; licenceCompatible: boolean; recommended: boolean; priority: string; risk: string; status: string }
type AuditEntry = { id: string; at: string; actor: string; action: string; target: string }
type Readiness = { overall: string; mode: string; blockingCodes: string[]; conditions: string[]; checks: { id: string; state: string; detail: string }[] }
type WindowProbe = { count: number; windows: { name: string; processId: number }[]; error?: string; ok?: boolean }

type Tab = 'overview' | 'repositories' | 'clients' | 'tasks' | 'research' | 'audit'

const LABELS = {
  zh: {
    eyebrow: 'AUTONOMY RUNTIME V2', title: '自动运维指挥中心',
    subtitle: '独立于页面的 24/7 仓库监控、桌面 AI 客户端调度与独立验收',
    running: '运行中', paused: '已暂停', stopped: '已停止', offline: '未连接',
    start: '启动自动运维', pause: '暂停', resume: '恢复', stop: '停止当前任务',
    scan: '立即扫描', research: '立即研究', run: '执行待处理任务',
    metrics: ['管理仓库', '正常运行', '新问题', '待修复任务', 'AI 执行中', '已修复', '待验收', '安全风险', '同类项目', '最近版本', '执行记录', '客户端状态'],
    tabs: { overview: '总览', repositories: '仓库监控', clients: '桌面客户端', tasks: '任务与执行', research: '智能研究', audit: '审计日志' },
    controlTitle: '全局自动运维开关', backend: '存储后端', mode: '自动化等级', concurrency: '并发上限',
    monitors: '监控', lastTick: '最近调度', refresh: '刷新', loading: '正在读取真实运行数据…',
    empty: '暂无记录。执行扫描或添加仓库后，这里会显示真实数据。',
    error: '读取失败', addRepo: '添加仓库', repoPlaceholder: 'owner/repo', localPath: '本地项目目录',
    projectRef: '客户端项目标识', adapter: 'AI 执行客户端', interval: '监控周期',
    chooseFolder: '选择文件夹', automation: '仓库执行策略', autoFix: '允许自动修复', autoMerge: '允许自动合并', autoRelease: '允许自动发布',
    safeSetup: '建议：自动修复 + 30 分钟；合并和发布仍需单独确认。', configureRepair: '设为 30 分钟自动修复',
    remoteWrites: '允许远程写入（推送 / PR / 合并 / Release）', oneTask: '同一仓库和同一客户端有活动任务时，NEXUS 会等待，不会重复发送。',
    add: '添加', remove: '移除', sync: '立即同步', probe: '重新探测客户端', windows: '识别窗口',
    launch: '启动客户端', capability: '能力检测表', verified: '已验证', partial: '部分支持', unsupported: '不支持',
    installed: '已安装', notInstalled: '未安装', active: '运行中', inactive: '未运行', uiaOn: 'UIA 可用', uiaOff: 'UIA 不可用',
    login: '登录', project: '项目', composer: '输入框', sendControl: '发送控件', visible: '可见', missing: '未暴露',
    tasksTitle: '任务队列与执行监控', noTasks: '当前没有任务。', status: '状态', priority: '优先级',
    attempts: '尝试次数', cancel: '取消', takeover: '人工接管', retry: '重试', details: '详情',
    openPr: '创建草稿 PR', prOpened: '草稿 PR 已创建',
    findings: '问题记录', peers: '同类项目', proposals: '升级建议', license: '许可证', compatible: '兼容',
    review: '需人工复核', recommended: '建议实施', notRecommended: '不建议',
    readiness: '执行就绪诊断', overall: '总体状态', blocking: '硬阻断', conditions: '非阻断条件',
    auditTitle: '执行与审计日志', actor: '主体', action: '操作', target: '对象', time: '时间',
    sessions: 'AI 执行会话', handoff: '等待人工接管', automated: '自动执行',
    humanNote: 'UIA 不可用时，NEXUS 生成完整任务包并等待人工粘贴；结果仍由 Git diff 与测试独立验收。',
    modeObserve: '观察', modeRepair: '自动修复', modeAutonomous: '高度自动化'
  },
  en: {
    eyebrow: 'AUTONOMY RUNTIME V2', title: 'Autonomous Operations Command Center',
    subtitle: 'Page-independent 24/7 repository monitoring, desktop AI client orchestration and independent acceptance',
    running: 'Running', paused: 'Paused', stopped: 'Stopped', offline: 'Offline',
    start: 'Start autonomy', pause: 'Pause', resume: 'Resume', stop: 'Stop current task',
    scan: 'Scan now', research: 'Research now', run: 'Run pending tasks',
    metrics: ['Repositories', 'Healthy', 'New problems', 'Pending fixes', 'AI running', 'Fixed', 'Awaiting verify', 'Security risks', 'Peer projects', 'Last release', 'Recent runs', 'Client status'],
    tabs: { overview: 'Overview', repositories: 'Monitoring', clients: 'Desktop clients', tasks: 'Tasks & runs', research: 'Intelligence', audit: 'Audit log' },
    controlTitle: 'Global autonomy switch', backend: 'Store backend', mode: 'Automation level', concurrency: 'Concurrency',
    monitors: 'Monitor', lastTick: 'Last tick', refresh: 'Refresh', loading: 'Reading real runtime data…',
    empty: 'No records yet. Run a scan or add a repository to see real data.',
    error: 'Load failed', addRepo: 'Add repository', repoPlaceholder: 'owner/repo', localPath: 'Local project path',
    projectRef: 'Client project reference', adapter: 'AI execution client', interval: 'Poll interval',
    chooseFolder: 'Choose folder', automation: 'Repository execution policy', autoFix: 'Allow auto repair', autoMerge: 'Allow auto merge', autoRelease: 'Allow auto release',
    safeSetup: 'Recommended: auto repair every 30 minutes; merge and release remain separately gated.', configureRepair: 'Set 30-minute auto repair',
    remoteWrites: 'Allow remote writes (push / PR / merge / release)', oneTask: 'When a repository or client already has an active task, NEXUS waits instead of sending a duplicate.',
    add: 'Add', remove: 'Remove', sync: 'Sync now', probe: 'Probe clients', windows: 'Identify windows',
    launch: 'Launch client', capability: 'Capability matrix', verified: 'Verified', partial: 'Partial', unsupported: 'Unsupported',
    installed: 'Installed', notInstalled: 'Not installed', active: 'Running', inactive: 'Not running', uiaOn: 'UIA available', uiaOff: 'UIA unavailable',
    login: 'Login', project: 'Project', composer: 'Composer', sendControl: 'Send control', visible: 'visible', missing: 'not exposed',
    tasksTitle: 'Task queue and execution monitor', noTasks: 'No tasks yet.', status: 'Status', priority: 'Priority',
    attempts: 'Attempts', cancel: 'Cancel', takeover: 'Take over', retry: 'Retry', details: 'Details',
    openPr: 'Open draft PR', prOpened: 'Draft PR opened',
    findings: 'Findings', peers: 'Peer projects', proposals: 'Upgrade proposals', license: 'License', compatible: 'Compatible',
    review: 'Legal review', recommended: 'Recommended', notRecommended: 'Not recommended',
    readiness: 'Execution readiness', overall: 'Overall', blocking: 'Hard blockers', conditions: 'Non-blocking conditions',
    auditTitle: 'Execution and audit log', actor: 'Actor', action: 'Action', target: 'Target', time: 'Time',
    sessions: 'AI execution sessions', handoff: 'Awaiting human handoff', automated: 'Automated',
    humanNote: 'When UIA is unavailable, NEXUS prepares a complete task package for manual paste; results are still verified independently via git diff and tests.',
    modeObserve: 'Observe', modeRepair: 'Auto repair', modeAutonomous: 'Highly autonomous'
  }
}

function useText() {
  const { i18n } = useTranslation()
  return i18n.language.toLowerCase().startsWith('zh') ? LABELS.zh : LABELS.en
}

function Stamp({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="ax-muted">—</span>
  const date = new Date(value)
  return <span>{Number.isNaN(date.getTime()) ? value : date.toLocaleString()}</span>
}

function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`ax-pill ax-pill-${tone}`}>{children}</span>
}

export default function AutonomyCenter({ onToast }: { onToast?: (message: string) => void } = {}) {
  const text = useText()
  const [tab, setTab] = useState<Tab>('overview')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [repos, setRepos] = useState<Repo[]>([])
  const [adapters, setAdapters] = useState<Adapter[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [findings, setFindings] = useState<Finding[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [peers, setPeers] = useState<Peer[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [windows, setWindows] = useState<Record<string, WindowProbe>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [newRepo, setNewRepo] = useState({ fullName: '', localPath: '', agentProjectRef: '', agentAdapterId: 'chatgpt-desktop', pollIntervalMs: 1800000, automationMode: 'repair', autoFix: true, autoMerge: false, autoRelease: false })

  const notify = useCallback((message: string) => { onToast?.(message) }, [onToast])

  const load = useCallback(async () => {
    try {
      setError('')
      const [ov, rp, ad, tk, fd, ss, pr, pp, au, rd] = await Promise.all([
        request<Overview>('/api/autonomy/overview'),
        request<{ repositories: Repo[] }>('/api/autonomy/repositories'),
        request<{ adapters: Adapter[] }>('/api/autonomy/adapters'),
        request<{ items: Task[] }>('/api/autonomy/tasks?limit=60'),
        request<{ items: Finding[] }>('/api/autonomy/findings?limit=40'),
        request<{ items: Session[] }>('/api/autonomy/sessions?limit=40'),
        request<{ peers: Peer[] }>('/api/autonomy/peers'),
        request<{ items: Proposal[] }>('/api/autonomy/proposals?limit=40'),
        request<{ items: AuditEntry[] }>('/api/autonomy/audit?limit=60'),
        request<Readiness>('/api/autonomy/readiness?mode=desktop')
      ])
      setOverview(ov); setRepos(rp.repositories || []); setAdapters(ad.adapters || [])
      setTasks(tk.items || []); setFindings(fd.items || []); setSessions(ss.items || [])
      setPeers(pr.peers || []); setProposals(pp.items || []); setAudit(au.items || []); setReadiness(rd)
      return true
    } catch (cause) {
      setError(String((cause as Error).message || cause))
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 15_000)
    return () => window.clearInterval(timer)
  }, [load])

  const act = useCallback(async (action: string, payload: unknown = {}, label = action) => {
    setBusy(action)
    notify(`${label}：正在处理…`)
    try {
      await request(`/api/autonomy/control/${action}`, { method: 'POST', body: JSON.stringify(payload) })
      await load()
      notify(`${label}：已完成`)
    } catch (cause) {
      notify(`${label}：失败：${String((cause as Error).message || cause)}`)
    } finally {
      setBusy('')
    }
  }, [load, notify])

  const saveSettings = useCallback(async (patch: Record<string, unknown>) => {
    setBusy('settings')
    notify('设置：正在保存…')
    try {
      await request('/api/autonomy/control/settings', { method: 'POST', body: JSON.stringify(patch) })
      await load()
      notify('设置：已完成')
    } catch (cause) { notify(`设置：失败：${String((cause as Error).message || cause)}`) } finally { setBusy('') }
  }, [load, notify])

  const taskAction = useCallback(async (id: string, action: string) => {
    const actionLabels: Record<string, string> = { cancel: '取消任务', takeover: '接管任务', retry: '重试任务' }
    const label = actionLabels[action] || action
    setBusy(`${action}:${id}`)
    notify(`${label}：正在处理…`)
    try {
      await request(`/api/autonomy/tasks/${id}/${action}`, { method: 'POST', body: '{}' })
      await load()
      notify(`${label}：已完成`)
    } catch (cause) {
      notify(`${label}：失败：${String((cause as Error).message || cause)}`)
    } finally { setBusy('') }
  }, [load, notify])

  const openTaskPullRequest = useCallback(async (task: Task) => {
    if (!task.repoId || !task.workspace?.branch) return notify('创建草稿 PR：任务缺少隔离工作区信息')
    setBusy(`pr:${task.id}`)
    notify('创建草稿 PR：正在提交隔离分支并创建 PR…')
    try {
      const result = await request<{ pullRequest: { number: number; url: string } }>(`/api/autonomy/delivery/${encodeURIComponent(task.repoId)}/tasks/${encodeURIComponent(task.id)}/pull-request`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true, confirmRepository: task.repository, confirmBranch: task.workspace.branch })
      })
      await load()
      notify(`${text.prOpened} #${result.pullRequest.number}`)
    } catch (cause) {
      notify(`创建草稿 PR：失败：${String((cause as Error).message || cause)}`)
    } finally { setBusy('') }
  }, [load, notify, text.prOpened])

  const addRepository = useCallback(async () => {
    if (!/^[^/\s]+\/[^/\s]+$/.test(newRepo.fullName)) { notify('添加仓库：请填写 owner/repo'); return }
    setBusy('add-repo')
    notify('添加仓库：正在处理…')
    try {
      await request('/api/autonomy/repositories', { method: 'POST', body: JSON.stringify(newRepo) })
      setNewRepo({ fullName: '', localPath: '', agentProjectRef: '', agentAdapterId: 'chatgpt-desktop', pollIntervalMs: 1800000, automationMode: 'repair', autoFix: true, autoMerge: false, autoRelease: false })
      await load()
      notify('添加仓库：已完成')
    } catch (cause) { notify(`添加仓库：失败：${String((cause as Error).message || cause)}`) } finally { setBusy('') }
  }, [newRepo, load, notify])

  const chooseLocalFolder = useCallback(async () => {
    notify('选择文件夹：正在打开…')
    try {
      const result = await window.nexusDesktop?.addProject?.(text.chooseFolder)
      if (result?.project?.path) {
        setNewRepo((current) => ({ ...current, localPath: result.project.path }))
        notify('选择文件夹：已完成')
      } else notify('选择文件夹：已取消')
    } catch (cause) { notify(`选择文件夹：失败：${String((cause as Error).message || cause)}`) }
  }, [notify, text.chooseFolder])

  const configureRepair = useCallback(async (repo: Repo) => {
    setBusy(`configure:${repo.id}`)
    notify(`${repo.fullName}：正在设置 30 分钟自动修复…`)
    try {
      await request(`/api/autonomy/repositories/${repo.id}`, { method: 'PATCH', body: JSON.stringify({ automationMode: 'repair', pollIntervalMs: 1800000, autoFix: true, autoMerge: false, autoRelease: false }) })
      await load()
      notify(`${repo.fullName}：已完成 30 分钟自动修复设置`)
    } catch (cause) { notify(`${repo.fullName}：失败：${String((cause as Error).message || cause)}`) } finally { setBusy('') }
  }, [load, notify])

  const syncRepository = useCallback(async (repo: Repo) => {
    setBusy(`sync:${repo.id}`)
    notify(`${repo.fullName} 同步：正在处理…`)
    try {
      await request(`/api/autonomy/repositories/${repo.id}/sync`, { method: 'POST', body: '{}' })
      await load()
      notify(`${repo.fullName} 同步：已完成`)
    } catch (cause) { notify(`${repo.fullName} 同步：失败：${String((cause as Error).message || cause)}`) } finally { setBusy('') }
  }, [load, notify])

  const removeRepository = useCallback(async (repo: Repo) => {
    setBusy(`remove:${repo.id}`)
    notify(`${repo.fullName} 移除：正在处理…`)
    try {
      await request(`/api/autonomy/repositories/${repo.id}`, { method: 'DELETE' })
      await load()
      notify(`${repo.fullName} 移除：已完成`)
    } catch (cause) { notify(`${repo.fullName} 移除：失败：${String((cause as Error).message || cause)}`) } finally { setBusy('') }
  }, [load, notify])

  const probeAdapters = useCallback(async () => {
    setBusy('probe-adapters')
    notify('客户端探测：正在处理…')
    try {
      await request('/api/autonomy/adapters/probe', { method: 'POST', body: '{}' })
      await load()
      notify('客户端探测：已完成')
    } catch (cause) { notify(`客户端探测：失败：${String((cause as Error).message || cause)}`) } finally { setBusy('') }
  }, [load, notify])

  const launchAdapter = useCallback(async (adapter: Adapter) => {
    setBusy(`launch:${adapter.id}`)
    notify(`${adapter.name} 启动：正在处理…`)
    try {
      await request(`/api/autonomy/adapters/${adapter.id}/launch`, { method: 'POST', body: '{}' })
      await load()
      notify(`${adapter.name} 启动：已完成`)
    } catch (cause) { notify(`${adapter.name} 启动：失败：${String((cause as Error).message || cause)}`) } finally { setBusy('') }
  }, [load, notify])

  const probeWindows = useCallback(async (adapterId: string) => {
    setBusy(`windows:${adapterId}`)
    notify('识别窗口：正在处理…')
    try {
      const result = await request<{ ok?: boolean; code?: string; count?: number; windows?: { name: string; processId: number }[] }>('/api/autonomy/adapters/windows', { method: 'POST', body: JSON.stringify({ adapterId }) })
      setWindows((current) => ({ ...current, [adapterId]: {
        ok: result.ok !== false,
        count: Number(result.count) || 0,
        windows: Array.isArray(result.windows) ? result.windows : [],
        error: result.ok === false ? String(result.code || 'WINDOW_DISCOVERY_FAILED') : undefined
      } }))
      await request('/api/autonomy/adapters/probe', { method: 'POST', body: '{}' })
      await load()
      if (result.ok === false) notify(`识别窗口：失败：${String(result.code || 'WINDOW_DISCOVERY_FAILED')}`)
      else notify(`识别窗口：已完成（发现 ${Number(result.count) || 0} 个窗口）`)
    } catch (cause) { notify(`识别窗口：失败：${String((cause as Error).message || cause)}`) } finally { setBusy('') }
  }, [load, notify])

  const refreshData = useCallback(async () => {
    notify('刷新：正在读取…')
    const completed = await load()
    notify(completed ? '刷新：已完成' : '刷新：失败，请查看页面提示')
  }, [load, notify])

  const metricValues = useMemo(() => {
    if (!overview) return []
    return [
      overview.repositoriesManaged, overview.repositoriesHealthy, overview.newProblems,
      overview.pendingFixes, overview.aiTasksRunning, overview.problemsFixed,
      overview.awaitingVerification, overview.securityRisks, overview.peerUpdates,
      overview.lastRelease ? overview.lastRelease.version : '—',
      overview.recentActivity.length,
      overview.desktopClients.filter((client) => client.running).length
    ]
  }, [overview])

  const metricIcons = [FolderGit2, CheckCircle2, AlertTriangle, Layers, Bot, CircleDot, ShieldCheck, ShieldAlert, Search, GitPullRequest, Activity, Cpu]
  const metricTones = ['cyan', 'green', 'amber', 'blue', 'blue', 'green', 'cyan', 'red', 'purple', 'blue', 'cyan', 'green']
  const control = overview?.control
  const systemState = !control?.enabled ? text.stopped : control.paused ? text.paused : text.running

  return <div className="ax-root">
    <div className="ax-header">
      <div>
        <div className="ax-eyebrow"><span className="ax-dot" />{text.eyebrow}</div>
        <h1>{text.title}</h1>
        <p>{text.subtitle}</p>
      </div>
      <div className="ax-header-actions">
        <button className="ax-ghost" onClick={() => void refreshData()} disabled={loading || Boolean(busy)}><RefreshCw size={15} className={loading ? 'ax-spin' : ''} />{text.refresh}</button>
        <div className={`ax-state ax-state-${control?.paused ? 'paused' : 'running'}`}><span />{systemState}</div>
      </div>
    </div>

    <section className="ax-control">
      <div className="ax-control-head">
        <div><Radio size={16} /><strong>{text.controlTitle}</strong></div>
        <div className="ax-control-meta">
          <span><Database size={13} />{text.backend}: {control?.storeBackend || '—'}</span>
          <span><ShieldCheck size={13} />{text.mode}: {control?.automationMode === 'observe' ? text.modeObserve : control?.automationMode === 'repair' ? text.modeRepair : text.modeAutonomous}</span>
          <span><Cpu size={13} />{text.concurrency}: {control?.maxConcurrent ?? '—'}</span>
          <span><Activity size={13} />{text.lastTick}: <Stamp value={control?.lastTickAt} /></span>
        </div>
      </div>
      <div className="ax-control-settings">
        <label>{text.mode}
          <select value={control?.automationMode || 'observe'} onChange={(event) => void saveSettings({ automationMode: event.target.value })} disabled={Boolean(busy)}>
            <option value="observe">{text.modeObserve}</option><option value="repair">{text.modeRepair}</option><option value="autonomous">{text.modeAutonomous}</option>
          </select>
        </label>
        <label>{text.concurrency}
          <select value={control?.maxConcurrent || 1} onChange={(event) => void saveSettings({ maxConcurrent: Number(event.target.value) })} disabled={Boolean(busy)}>
            <option value={1}>1（推荐）</option><option value={2}>2</option><option value={3}>3</option>
          </select>
        </label>
        <label className="ax-check"><input type="checkbox" checked={Boolean(control?.remoteWritesEnabled)} onChange={(event) => void saveSettings({ remoteWritesEnabled: event.target.checked })} disabled={Boolean(busy)} />{text.remoteWrites}</label>
      </div>
      <div className="ax-control-buttons">
        <button className="ax-primary" disabled={Boolean(busy)} onClick={() => void act(control?.paused ? 'resume' : 'start', {}, control?.paused ? text.resume : text.start)}>
          <Play size={15} />{control?.paused ? text.resume : text.start}
        </button>
        <button className="ax-ghost" disabled={Boolean(busy)} onClick={() => void act('pause', {}, text.pause)}><Pause size={15} />{text.pause}</button>
        <button className="ax-ghost" disabled={Boolean(busy)} onClick={() => void act('scan-now', {}, text.scan)}><RefreshCw size={15} />{text.scan}</button>
        <button className="ax-ghost" disabled={Boolean(busy)} onClick={() => void act('research-now', {}, text.research)}><Search size={15} />{text.research}</button>
        <button className="ax-ghost" disabled={Boolean(busy)} onClick={() => void act('run-now', {}, text.run)}><Zap size={15} />{text.run}</button>
        <button className="ax-danger" disabled={Boolean(busy)} onClick={() => void act('stop', {}, text.stop)}><Square size={15} />{text.stop}</button>
      </div>
    </section>

    {error && <div className="ax-error"><AlertTriangle size={16} />{text.error}: {error}</div>}
    {loading && !overview && <div className="ax-loading"><Loader2 size={18} className="ax-spin" />{text.loading}</div>}

    {overview && <>
      <section className="ax-metrics">
        {metricValues.map((value, index) => {
          const Icon = metricIcons[index]
          return <div className={`ax-metric ax-tone-${metricTones[index]}`} key={index}>
            <div className="ax-metric-top"><Icon size={16} /><span>{text.metrics[index]}</span></div>
            <div className="ax-metric-value">{value}</div>
          </div>
        })}
      </section>

      <nav className="ax-tabs">
        {(Object.keys(text.tabs) as Tab[]).map((key) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{text.tabs[key]}</button>)}
      </nav>

      {tab === 'overview' && <div className="ax-grid-2">
        <section className="ax-panel">
          <div className="ax-panel-head"><div><span className="ax-kicker">READINESS</span><h2>{text.readiness}</h2></div><Pill tone={readiness?.overall === 'READY' ? 'green' : readiness?.overall === 'BLOCKED' ? 'red' : 'amber'}>{readiness?.overall || '—'}</Pill></div>
          {readiness?.checks?.map((item) => <div className="ax-row" key={item.id}><div className="ax-row-main"><strong>{item.id}</strong><Pill tone={item.state.includes('ready') || item.state === 'complete' || item.state === 'present' || item.state === 'not_required' ? 'green' : 'amber'}>{item.state}</Pill></div><p>{item.detail}</p></div>)}
          {readiness?.blockingCodes?.length ? <div className="ax-note ax-note-red">{text.blocking}: {readiness.blockingCodes.join(', ')}</div> : null}
          {readiness?.conditions?.length ? <div className="ax-note">{text.conditions}: {readiness.conditions.join(', ')}</div> : null}
        </section>
        <section className="ax-panel">
          <div className="ax-panel-head"><div><span className="ax-kicker">LIVE ACTIVITY</span><h2>{text.metrics[10]}</h2></div><Activity size={16} /></div>
          {overview.recentActivity.length ? overview.recentActivity.slice(0, 8).map((run) => <div className="ax-row" key={run.id}>
            <div className="ax-row-main"><strong>{run.repository}</strong><Pill tone={run.verdict === 'PASS' ? 'green' : 'amber'}>{run.verdict}</Pill></div>
            <p>{run.mode} · {run.events} events · <Stamp value={run.at} /></p>
          </div>) : <div className="ax-empty">{text.empty}</div>}
          <div className="ax-note"><ShieldCheck size={14} />{text.humanNote}</div>
        </section>
      </div>}

      {tab === 'repositories' && <div className="ax-grid-2">
        <section className="ax-panel">
          <div className="ax-panel-head"><div><span className="ax-kicker">CONFIGURE</span><h2>{text.addRepo}</h2></div><FolderGit2 size={16} /></div>
          <div className="ax-form">
            <input value={newRepo.fullName} onChange={(event) => setNewRepo({ ...newRepo, fullName: event.target.value })} placeholder={text.repoPlaceholder} aria-label={text.repoPlaceholder} />
            <div className="ax-input-action"><input value={newRepo.localPath} onChange={(event) => setNewRepo({ ...newRepo, localPath: event.target.value })} placeholder={text.localPath} aria-label={text.localPath} /><button type="button" className="ax-ghost" onClick={() => void chooseLocalFolder()} disabled={!window.nexusDesktop?.addProject}>{text.chooseFolder}</button></div>
            <input value={newRepo.agentProjectRef} onChange={(event) => setNewRepo({ ...newRepo, agentProjectRef: event.target.value })} placeholder={text.projectRef} aria-label={text.projectRef} />
            <select value={newRepo.agentAdapterId} onChange={(event) => setNewRepo({ ...newRepo, agentAdapterId: event.target.value })} aria-label={text.adapter}>
              {adapters.map((adapter) => <option value={adapter.id} key={adapter.id}>{adapter.name}</option>)}
              {!adapters.length && <><option value="chatgpt-desktop">ChatGPT Desktop</option><option value="workbuddy-desktop">WorkBuddy</option></>}
            </select>
            <select value={newRepo.pollIntervalMs} onChange={(event) => setNewRepo({ ...newRepo, pollIntervalMs: Number(event.target.value) })} aria-label={text.interval}>
              <option value={300000}>5 min</option><option value={900000}>15 min</option><option value={1800000}>30 min</option><option value={3600000}>1 hour</option>
            </select>
            <select value={newRepo.automationMode} onChange={(event) => setNewRepo({ ...newRepo, automationMode: event.target.value })} aria-label={text.automation}>
              <option value="observe">{text.modeObserve}</option><option value="repair">{text.modeRepair}</option><option value="autonomous">{text.modeAutonomous}</option>
            </select>
            <label className="ax-check"><input type="checkbox" checked={newRepo.autoFix} onChange={(event) => setNewRepo({ ...newRepo, autoFix: event.target.checked })} />{text.autoFix}</label>
            <label className="ax-check"><input type="checkbox" checked={newRepo.autoMerge} onChange={(event) => setNewRepo({ ...newRepo, autoMerge: event.target.checked })} />{text.autoMerge}</label>
            <label className="ax-check"><input type="checkbox" checked={newRepo.autoRelease} onChange={(event) => setNewRepo({ ...newRepo, autoRelease: event.target.checked })} />{text.autoRelease}</label>
            <button className="ax-primary" onClick={() => void addRepository()} disabled={Boolean(busy)}><ChevronRight size={15} />{text.add}</button>
          </div>
          <div className="ax-note">{text.safeSetup}</div>
          <div className="ax-note"><ShieldCheck size={14} />{text.oneTask}</div>
        </section>
        <section className="ax-panel">
          <div className="ax-panel-head"><div><span className="ax-kicker">MONITORING</span><h2>{text.monitors}</h2></div><span className="ax-count">{repos.length}</span></div>
          {repos.length ? repos.map((repo) => <div className="ax-row" key={repo.id}>
            <div className="ax-row-main"><strong>{repo.fullName}</strong><Pill tone={repo.enabled ? 'green' : 'amber'}>{repo.automationMode}</Pill></div>
            <p><GitBranch size={12} />{repo.defaultBranch} · {repo.monitorItems?.length || 0} resources · {Math.round(repo.pollIntervalMs / 60000)} min</p>
            <p className="ax-mono">{repo.localPath || '—'}</p>
            <div className="ax-row-actions">
              <button onClick={() => void configureRepair(repo)} disabled={Boolean(busy)}>{text.configureRepair}</button>
              <button onClick={() => void syncRepository(repo)} disabled={Boolean(busy)}>{text.sync}</button>
              <button onClick={() => void removeRepository(repo)} disabled={Boolean(busy)}>{text.remove}</button>
            </div>
          </div>) : <div className="ax-empty">{text.empty}</div>}
        </section>
        <section className="ax-panel ax-span-2">
          <div className="ax-panel-head"><div><span className="ax-kicker">FINDINGS</span><h2>{text.findings}</h2></div><span className="ax-count">{findings.length}</span></div>
          {findings.length ? <div className="ax-table"><div className="ax-tr ax-th"><span>{text.priority}</span><span>{text.status}</span><span>Repository</span><span>Title</span></div>
            {findings.slice(0, 25).map((finding) => <div className="ax-tr" key={finding.id}><span><Pill tone={finding.priority === 'P0' ? 'red' : 'amber'}>{finding.priority}</Pill></span><span>{finding.status}</span><span className="ax-mono">{finding.repository}</span><span>{finding.title}</span></div>)}
          </div> : <div className="ax-empty">{text.empty}</div>}
        </section>
      </div>}

      {tab === 'clients' && <div className="ax-grid-2">
        <section className="ax-panel ax-span-2">
          <div className="ax-panel-head"><div><span className="ax-kicker">DESKTOP AGENT ADAPTERS</span><h2>{text.capability}</h2></div>
            <button className="ax-ghost" onClick={() => void probeAdapters()} disabled={Boolean(busy)}><RefreshCw size={14} />{text.probe}</button></div>
          {adapters.length ? adapters.map((adapter) => <div className="ax-client" key={adapter.id}>
            <div className="ax-client-head">
              <div className="ax-client-icon"><Bot size={18} /></div>
              <div><strong>{adapter.name}</strong><p className="ax-mono">{adapter.launcher || '—'}</p></div>
              <div className="ax-client-badges">
                <Pill tone={adapter.installed ? 'green' : 'red'}>{adapter.installed ? text.installed : text.notInstalled}</Pill>
                <Pill tone={adapter.running ? 'green' : 'amber'}>{adapter.running ? text.active : text.inactive}</Pill>
                <Pill tone={adapter.uia?.available ? 'green' : 'amber'}>{adapter.uia?.available ? text.uiaOn : text.uiaOff}</Pill>
              </div>
            </div>
            <div className="ax-cap-grid">
              {Object.entries(adapter.capabilities || {}).map(([key, value]) => <div className="ax-cap" key={key} title={value.evidence}>
                <span>{key}</span><Pill tone={value.level === 'verified' ? 'green' : value.level === 'partial' ? 'amber' : 'red'}>{value.level === 'verified' ? text.verified : value.level === 'partial' ? text.partial : text.unsupported}</Pill>
              </div>)}
            </div>
            <div className="ax-note">
              {text.login}: {adapter.loginState || 'UNKNOWN'} · {text.project}: {adapter.projectRefs?.join(', ') || '—'} ·
              {' '}{text.composer}: {adapter.uiEvidence?.hasComposer ? text.visible : text.missing} ·
              {' '}{text.sendControl}: {adapter.uiEvidence?.hasSendControl ? text.visible : text.missing}
            </div>
            <div className="ax-row-actions">
              <button onClick={() => void probeWindows(adapter.id)} disabled={Boolean(busy)}><ExternalLink size={13} />{text.windows}</button>
              <button onClick={() => void launchAdapter(adapter)} disabled={Boolean(busy)}><Play size={13} />{text.launch}</button>
            </div>
            {windows[adapter.id] && <div className={`ax-note${windows[adapter.id].error ? ' ax-note-red' : ''}`}>
              {windows[adapter.id].error ? `识别失败：${windows[adapter.id].error}` : `${windows[adapter.id].count} window(s): ${windows[adapter.id].windows.map((item) => `${item.name} (pid ${item.processId})`).join(', ') || '—'}`}
            </div>}
          </div>) : <div className="ax-empty">{text.empty}</div>}
        </section>
      </div>}

      {tab === 'tasks' && <div className="ax-grid-2">
        <section className="ax-panel ax-span-2">
          <div className="ax-panel-head"><div><span className="ax-kicker">SCHEDULER</span><h2>{text.tasksTitle}</h2></div><span className="ax-count">{tasks.length}</span></div>
          {tasks.length ? <div className="ax-table ax-table-wide"><div className="ax-tr ax-th"><span>ID</span><span>Repository</span><span>{text.priority}</span><span>{text.status}</span><span>{text.attempts}</span><span>Actions</span></div>
            {tasks.map((task) => <div className="ax-tr" key={task.id}>
              <span className="ax-mono">{task.id.slice(0, 14)}</span><span>{task.repository}</span>
              <span><Pill tone={task.priority === 'P0' ? 'red' : task.priority === 'P1' ? 'amber' : 'blue'}>{task.priority}</Pill></span>
              <span><Pill tone={task.status === 'ACCEPTED' ? 'green' : task.status === 'AWAITING_HUMAN' ? 'amber' : task.status.includes('FAIL') ? 'red' : 'blue'}>{task.status}</Pill></span>
              <span>{task.attempts}</span>
              <span className="ax-inline-actions">
                {task.delivery?.pullRequest ? <a href={task.delivery.pullRequest.url} target="_blank" rel="noreferrer" className="ax-action-link"><GitPullRequest size={13} /> PR #{task.delivery.pullRequest.number}</a> : <button disabled={Boolean(busy) || task.status !== 'ACCEPTED' || task.verification?.verdict !== 'PASS' || !task.workspace?.isolated} onClick={() => void openTaskPullRequest(task)} title={task.status !== 'ACCEPTED' ? '任务必须先通过独立验收' : task.verification?.verdict !== 'PASS' ? '独立验证必须通过' : !task.workspace?.isolated ? '必须使用隔离 worktree' : undefined}><GitPullRequest size={13} />{text.openPr}</button>}
                <button onClick={() => void taskAction(task.id, 'cancel')}>{text.cancel}</button>
                <button onClick={() => void taskAction(task.id, 'takeover')}>{text.takeover}</button>
                <button onClick={() => void taskAction(task.id, 'retry')}>{text.retry}</button>
              </span>
            </div>)}
          </div> : <div className="ax-empty">{text.noTasks}</div>}
        </section>
        <section className="ax-panel ax-span-2">
          <div className="ax-panel-head"><div><span className="ax-kicker">AGENT SESSIONS</span><h2>{text.sessions}</h2></div><span className="ax-count">{sessions.length}</span></div>
          {sessions.length ? sessions.map((session) => <div className="ax-row" key={session.id}>
            <div className="ax-row-main"><strong className="ax-mono">{session.id.slice(0, 20)}</strong><Pill tone={session.handoff ? 'amber' : 'blue'}>{session.handoff ? text.handoff : session.state}</Pill></div>
            <p>{session.adapterId} · {session.repository} · <Stamp value={session.sentAt} /></p>
            {session.packageFile && <p className="ax-mono"><FileText size={12} />{session.packageFile}</p>}
          </div>) : <div className="ax-empty">{text.empty}</div>}
        </section>
      </div>}

      {tab === 'research' && <div className="ax-grid-2">
        <section className="ax-panel">
          <div className="ax-panel-head"><div><span className="ax-kicker">PEER INTELLIGENCE</span><h2>{text.peers}</h2></div><span className="ax-count">{peers.length}</span></div>
          {peers.length ? peers.slice(0, 20).map((peer) => <div className="ax-row" key={peer.id}><div className="ax-row-main"><strong>{peer.fullName}</strong><Pill tone={peer.license ? 'blue' : 'amber'}>{peer.license || 'unknown'}</Pill></div><p>{peer.stack || '—'} · ★ {peer.stars} · <Stamp value={peer.pushedAt} /></p></div>) : <div className="ax-empty">{text.empty}</div>}
        </section>
        <section className="ax-panel">
          <div className="ax-panel-head"><div><span className="ax-kicker">PORTING ANALYSIS</span><h2>{text.proposals}</h2></div><span className="ax-count">{proposals.length}</span></div>
          {proposals.length ? proposals.slice(0, 20).map((proposal) => <div className="ax-row" key={proposal.id}>
            <div className="ax-row-main"><strong>{proposal.featureName}</strong><Pill tone={proposal.recommended ? 'green' : 'amber'}>{proposal.recommended ? text.recommended : text.notRecommended}</Pill></div>
            <p>{proposal.sourceProject} · {text.license}: {proposal.sourceLicence || '—'} · {proposal.licenceCompatible ? text.compatible : text.review} · {proposal.priority} / {proposal.risk}</p>
          </div>) : <div className="ax-empty">{text.empty}</div>}
        </section>
      </div>}

      {tab === 'audit' && <section className="ax-panel">
        <div className="ax-panel-head"><div><span className="ax-kicker">APPEND-ONLY</span><h2>{text.auditTitle}</h2></div><span className="ax-count">{audit.length}</span></div>
        {audit.length ? <div className="ax-table"><div className="ax-tr ax-th"><span>{text.time}</span><span>{text.actor}</span><span>{text.action}</span><span>{text.target}</span></div>
          {audit.map((entry) => <div className="ax-tr" key={entry.id}><span><Stamp value={entry.at} /></span><span>{entry.actor}</span><span className="ax-mono">{entry.action}</span><span>{entry.target}</span></div>)}
        </div> : <div className="ax-empty">{text.empty}</div>}
      </section>}
    </>}

    <footer className="ax-footer"><Terminal size={13} /><span>PROJECT NEXUS · Autonomy Runtime V2 · {control?.storeBackend || '—'} · {text.monitors}: {control?.monitorConfigured ? 'GitHub connected' : text.offline}</span><Users size={13} /></footer>
  </div>
}
