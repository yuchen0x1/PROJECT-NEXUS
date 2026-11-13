export type Project = {
  repositoryAvailable?: boolean
  id: string
  name: string
  fullName: string
  owner: string
  description: string
  url: string
  defaultBranch: string
  visibility: string
  language: string
  stars: number
  forks: number
  openIssues: number
  updatedAt?: string
  pushedAt?: string
  archived?: boolean
  repoMeta?: { archived?: boolean } | null
  group: string
  stack: string[]
  latestRelease?: { tag_name?: string; published_at?: string } | null
}

export type OverviewStatus = 'idle' | 'queued' | 'running' | 'blocked' | 'failed' | 'success' | 'cancelled'
export type OverviewStage = 'inspection' | 'analysis' | 'execution' | 'verification' | 'delivery' | 'research'
export type OverviewTask = {
  id: string; source: string; taskId: string; localTaskId?: string | null; projectId: string | null
  label: string; status: OverviewStatus; stage: OverviewStage; providerId: string | null
  at: string; error: string | null; executionStatus?: string; deliveryStatus?: string
}
export type ProjectOverviewSnapshot = {
  updatedAt: string; paused: boolean; warnings: string[]
  account: { login: string | null; configured: boolean }
  repositories: { id: string; name: string; fullName: string; owner: string; enabled: boolean; strategy: string; intervalMinutes: number; openIssues: number; status: OverviewStatus; stage: OverviewStage | null; latestTaskId: string | null; lastInspectionAt: string | null }[]
  providers: { id: string; name: string; model: string; kind: string; configured: boolean }[]
  tasks: OverviewTask[]
  events: { id: string; taskId: string; projectId: string | null; at: string; stage: OverviewStage; status: OverviewStatus; detail: string }[]
  eventsScope: string | null; eventsTruncated: boolean
  services: { id: OverviewStage; running: number; total: number }[]
  stats: { repositories: number; enabled: number; running: number; queued: number; attention: number }
}

export type Task = {
  result?: { imported?: number; unavailable?: number; truncated?: boolean }
  errorCode?: string
  id: string
  type: string
  label: string
  status: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
  logs?: string[]
}

export type UpdateConfig = {
  id: string
  projectId: string
  projectName: string
  framework: string
  evidence: string[]
  currentVersion: string | null
  latestVersion: string | null
  channel: string
  updateUrl: string | null
  manifestUrl: string | null
  security: { status: string; checks: { key: string; status: string; detail: string }[] }
  completeness: number
  checkedAt: string
}

export type IntegrationComponent = {
  adapter: string
  name: string
  appRoot: string
  framework: string
  supported: boolean
  evidence: Record<string, unknown> & { updaterCode?: boolean; workflow?: boolean; manifest?: string[]; signingConfigured?: boolean }
}

export type IntegrationReport = {
  id: string
  projectId: string
  repository: string
  commitSha: string
  defaultBranch: string
  scannedAt: string
  truncated: boolean
  scannedFileCount: number
  detectedPlatforms?: { platform: string; supported: boolean; status: string; evidencePaths: string[] }[]
  selectedPaths: string[]
  readErrors: { path: string; message: string }[]
  components: IntegrationComponent[]
  assessment: {
    score: number
    status: string
    verified: boolean
    missing: string[]
    recommendation: { adapter: string; solution: string; reason: string }
    components: { component: IntegrationComponent; assessment: { score: number; status: string; checks: Record<string, boolean>; missing: string[]; verified: boolean; recommendation: { adapter: string; solution: string; reason: string } } }[]
  }
  readiness: {
    codeSupportsUpdates: boolean
    ciBuildsUpdateArtifacts: boolean
    releaseConfigurationPresent: boolean
    updateManifestInRepository: boolean
    signingConfigured: boolean
    signatureCryptographicallyVerified: boolean
    oldClientUpdateVerified: boolean
  }
}

export type IntegrationJob = {
  id: string
  type: 'scan' | 'agent'
  projectId: string
  repository: string
  reportId?: string
  taskId: string
  status: string
  currentStep: string
  progress: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  logs: string[]
  error?: string
  branch?: string
  currentBranch?: string
  modifiedFiles?: string[]
  tests?: { status: string; exitCode?: number | null; timedOut?: boolean; error?: string; output?: string }
  diff?: string
  patch?: string
  workspaceStatus?: string
  pullRequest?: { number: number; url: string; draft: boolean }
  run?: { id: string | null; phase: string; attempt: number; maxAttempts: number; checkpoint?: { phase: string; at: string }; events?: { at: string; phase: string; status: string; detail: string }[] }
}

export type IntegrationAdapter = { id: string; name: string; capabilities: string[] }

export type HostingPolicy = {
  enabled: boolean
  strategy: 'observe' | 'maintain' | 'autonomous' | string
  intervalMinutes: number
  autoPush: boolean
  autoPullRequest: boolean
  autoMerge: boolean
  autoPublish: boolean
  closeIssueAfterRelease: boolean
  allowNoCI?: boolean
  requiredChecks?: string[]
  allowUnsignedArtifacts?: boolean
  executionMode?: 'blocked' | 'trusted-local'
  requireApprovalForHighRisk: boolean
  updatedAt: string | null
}

export type HostingProject = {
  id: string
  fullName: string
  name: string
  owner: string
  defaultBranch: string
  installationId: string | null
  hosting: {
    enabled: boolean
    strategy: string
    intervalMinutes: number
    lastInspectionAt: string | null
    lastLightScanAt: string | null
    lastFullScanAt: string | null
    lastOutcome: Record<string, unknown> | null
    currentTaskId: string | null
    workspace: Record<string, unknown> | null
  }
  policy: HostingPolicy
  repoMeta: Record<string, unknown> | null
  githubConfigured: boolean
}

export type HostingRun = {
  id: string
  projectId: string
  repository: string
  depth: string
  status: string
  findings: { key: string; priority: string; summary: string; detail?: string | null }[]
  startedAt: string
  finishedAt: string | null
  error: string | null
  triggeredBy?: string
  integrationJobId?: string
  securityStatus?: string
}

export type IssueClassification = {
  category: string
  severity: string
  confidence: number
  source: string
  suggestedAction?: string | null
  problemSummary?: string | null
  reproductionSteps?: string | null
  actualBehavior?: string | null
  expectedBehavior?: string | null
  errorLogExcerpt?: string | null
  affectedVersions?: string | null
  affectedModules?: string[] | null
}

export type IssueActivity = {
  projectId: string
  repository: string
  number: number
  title: string
  state: string
  htmlUrl: string | null
  labels: string[]
  updatedAt: string | null
  seenAt: string
  source: string
  classification: IssueClassification
  triggerFix: boolean
  fixTaskId?: string | null
  fixState?: string | null
  fixSummary?: {
    changedPaths?: string[]
    branch?: string | null
    pullRequest?: { number: number; url: string; draft?: boolean } | null
    issueCommented?: boolean
    verification?: string | null
    skippedReason?: string | null
    merged?: { merged: boolean; reason?: string | null } | null
    released?: { published: boolean; tag?: string | null; releaseUrl?: string | null; assets?: number; reason?: string | null } | null
    issueClosed?: { closed: boolean; reason?: string | null } | null
    error?: string
  }
}

export type SecurityFinding = {
  id: string
  projectId: string
  repository: string
  scanId: string
  key: string
  priority: string
  summary: string
  detail: string | null
  path?: string | null
  recordedAt: string
}

export type ResearchCandidate = {
  fullName: string
  url: string
  stars: number
  license: string | { spdx: string | null; name: string | null } | null
  pushedAt: string | null
  recentCommits: { sha?: string | null; message?: string; date?: string | null }[]
  releases: number | { tagName?: string | null; name?: string | null; publishedAt?: string | null }[]
  description: string
  forks?: number
  openIssues?: number
  rootEntries?: string[]
  readmeExcerpt?: string
}

export type ResearchAnalysis = {
  source: string
  candidates: { repository: string; summary: string; notableFeatures: string[]; worthAdopting: { feature: string; rationale: string; licenseSafe: boolean; effort: string }[]; risksObserved: string[] }[]
  gapAnalysis: { dimension: string; self: string; peer: string; recommendation: string }[]
  upgradeProposals: { title: string; priority: string; rationale: string; effort: string; licenseNotes: string }[]
  noActionRequired: boolean
  metricComparison?: Record<string, unknown>[]
}

export type UpgradeProposal = { id: string; title: string; rationale: string; priority: string; status: string; blockedReason?: string; evidence: { repository: string; path: string; sha: string }[]; applied: boolean }

export type ResearchReport = {
  upgradeProposals?: UpgradeProposal[]
  id: string
  projectId: string
  repository: string
  query: string
  candidates: ResearchCandidate[]
  analysis: ResearchAnalysis
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null
  costUsd: number | null
  status: string
  createdAt: string
}


export type AIProviderSummary = {
  id: string
  kind: string
  configured: boolean
  host: string | null
  models: string[]
  model: string | null
  capabilities: string[]
  priority: number
  default: boolean
  routedTasks: string[]
  pricingConfigured: boolean
}

export type LocalAgentTask = {
  id: string
  type: string
  label: string
  projectId: string
  projectName: string
  providerId: string | null
  prompt: string
  status: string
  phase: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  events: { at: string; type: string; status?: string; fromStatus?: string; detail: string; metadata?: Record<string, unknown> }[]
  plan: { description: string; status: string }[] | null
  approvals: { id: string; tool: string; risk: string; reason: string; action: string; argsSummary: string; status: 'pending' | 'approved' | 'denied' | 'expired'; createdAt: string; resolvedAt: string | null; resolvedBy: string | null }[]
  pendingApprovalId: string | null
  disclosedPaths: string[]
  changedFiles: string[]
  changeCount: number
  toolCallCount: number
  iterations: number | null
  provider: { id: string; kind: string; host: string | null; model: string } | null
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null
  costUsd: number | null
  attempts: number | null
  rationale: string | null
  runtimeResult: {
    status: string
    iterations: number
    repairAttempts: number
    providerCalls: number
    usage: { inputTokens: number; outputTokens: number; totalTokens: number }
    costUsd: number | null
    verification: AgentVerification | null
    review: AgentReview | null
    finalMessage: string
    runtimeVersion: string
    timedOut: boolean
    tokenExhausted: boolean
  } | null
  verification: AgentVerification | null
  review: AgentReview | null
  workspaceMode: 'auto' | 'worktree' | 'copy' | null
  approvalPolicy: string | null
  fallbackReason: string | null
  workspaceReady: boolean
  workspaceStats: { entries: number; files: number; bytes: number; skippedSymlinks: number } | null
  sourceDisclosureConfirmedAt: string | null
}

export type AgentVerification = {
  attempted: boolean
  passed: boolean
  summary: string
  results: { label: string; script: string | null; attempted: boolean; ok?: boolean; exitCode?: number | null; stdoutTail?: string; stderrTail?: string; durationMs?: number }[]
}

export type AgentReview = {
  findings: { severity: string; path: string; line: number | null; issue: string; suggestion: string }[]
  overall: string
  verdict: 'approve' | 'request_changes' | string
  note?: string
}

export type AgentProvider = {
  id: string
  name: string
  kind: string
  baseUrl: string
  host: string | null
  model: string
  models: string[]
  contextWindow: number | null
  maxOutputTokens: number | null
  temperature: number
  timeoutMs: number
  priority: number
  capabilities: string[]
  pricing: { inputPer1M?: number; outputPer1M?: number }
  routing: Record<string, string>
  enabled: boolean
  source: string
  configured: boolean
  hasApiKey: boolean
}

export type AgentInsights = {
  projectId: string
  projectName: string
  cached: boolean
  reindexed: number
  changedFiles: string[]
  stats: { entries: number; files: number; totalBytes: number; symbolFiles: number; truncated: boolean }
  languages: Record<string, number>
  manifests: { path: string; kind: string; name: string | null; scripts: Record<string, string> | null; dependencies: string[] | null }[]
  entryPoints: { path: string; reason: string }[]
  testPaths: string[]
  routeCandidates: string[]
  apiCandidates: string[]
  topSymbols: { path: string; symbols: { kind: string; name: string; line: number }[] }[]
}

export type LocalAgentChange = { action: 'added' | 'modified' | 'deleted'; path: string; before: string | null; after: string | null; contentStatus: string }

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const desktop = typeof window === 'undefined' ? undefined : window.nexusDesktop
  let status: number
  let body: any
  if (desktop) {
    const response = await desktop.requestApi({ url, method: init?.method || 'GET', body: typeof init?.body === 'string' ? init.body : undefined })
    status = response.status
    body = response.body
  } else {
    const headers = new Headers(init?.headers)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const response = await fetch(url, { ...init, headers })
    status = response.status
    body = await response.json().catch(() => ({}))
  }
  if (status < 200 || status >= 300) throw Object.assign(new Error(body.message || `Request failed (${status})`), { status, body })
  return body
}

export const api = {
  repositorySyncStatus: () => request<{ configured: boolean; running: boolean; lastSuccessAt: string | null; nextSyncAt: string | null; lastErrorCode: string | null; intervalMs: number }>('/api/repository-sync'),
  projectOverview: (projectId = '') => request<ProjectOverviewSnapshot>(`/api/project-overview${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  setRemoteWrites: (enabled: boolean) => request<{ enabled: boolean }>('/api/settings/remote-writes', { method: 'PUT', body: JSON.stringify({ enabled, confirm: true }) }),
  reconcileHostedJob: (jobId: string) => request<{ job: { reconciliation: string } }>(`/api/hosting/jobs/${encodeURIComponent(jobId)}/reconcile`, { method: 'POST', body: '{}' }),
  hostedJobs: () => request<{ jobs: { id: string; projectId: string; repository: string; issueNumber: number; status: string; priority: string; createdAt: string; executionStatus?: string; deliveryStatus?: string; missing?: string[]; reconciliation?: string; releasePlan?: { status: string; adapter: string; tag: string; blockedReason?: string }; operations?: { key: string; endpoint: string; status: string }[]; error?: string; events: { type: string; detail: string; at: string }[] }[]; queued: number; running: number; concurrency: number }>('/api/hosting/jobs'),
  overview: () => request<{ metrics: Record<string, number>; projects: Project[]; tasks: Task[]; activity: { id: string; message: string; at: string }[]; githubConfigured: boolean }>('/api/overview'),
  githubStatus: () => request<{ configured: boolean; owner: string | null; apiUrl: string; permissions: string[] }>('/api/github/status'),
  projects: (query = '') => request<{ projects: Project[]; total: number }>(`/api/projects?query=${encodeURIComponent(query)}`),
  syncRepositories: (automatic = false) => request<{ task?: Task; skipped?: boolean; reason?: string }>('/api/tasks/sync-repositories', { method: 'POST', body: JSON.stringify({ automatic }) }),
  scanProject: (id: string) => request<{ project: Project }>(`/api/projects/${id}/scan`, { method: 'POST', body: '{}' }),
  integrationScan: (id: string) => request<{ project: Project; job: IntegrationJob; task: Task; reused: boolean }>(`/api/projects/${id}/integration-scan`, { method: 'POST', body: '{}' }),
  integrationScanAll: (projectIds: string[] = []) => request<{ jobs: { job: IntegrationJob; task: Task; reused: boolean }[]; blocked: { projectId: string; fullName: string; status: string; reason: string }[] }>('/api/integrations/scans', { method: 'POST', body: JSON.stringify({ projectIds }) }),
  integrationAdapters: () => request<{ adapters: IntegrationAdapter[]; ai: { configured: boolean; baseUrl: string | null; model: string | null }; remoteWritesEnabled: boolean; supportedWorkflows: Record<string, boolean> }>('/api/integrations/adapters'),
  aiProviders: () => request<{ providers: AIProviderSummary[]; configured: boolean; defaultProviderId: string | null; defaultModel: string | null }>('/api/ai/providers'),
  localAgentConfig: () => request<{ configured: boolean; defaultProviderId: string | null; providers: AgentProvider[]; legacyProviders: AIProviderSummary[]; approvalPolicies: string[]; taskTypes: string[]; limits: { maxPromptBytes: number; maxContextFiles: number; maxContextBytes: number; maxIterations: number; maxRepairAttempts: number }; capabilities: Record<string, unknown> }>('/api/local-agent/config'),
  localAgentTasks: () => request<{ tasks: LocalAgentTask[] }>('/api/local-agent/tasks'),
  localAgentTask: (id: string) => request<{ task: LocalAgentTask; changes: LocalAgentChange[]; changesError: string | null }>(`/api/local-agent/tasks/${encodeURIComponent(id)}`),
  createLocalAgentTask: (payload: { projectId: string; prompt: string; providerId?: string | null; confirmSourceDisclosure: boolean; taskType?: string; approvalPolicy?: string; workspaceMode?: string }) => request<{ task: LocalAgentTask }>('/api/local-agent/tasks', { method: 'POST', body: JSON.stringify(payload) }),
  cancelLocalAgentTask: (id: string) => request<{ task: LocalAgentTask; cancellationRequested?: boolean }>(`/api/local-agent/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  retryLocalAgentTask: (id: string, confirmSourceDisclosure: boolean) => request<{ task: LocalAgentTask }>(`/api/local-agent/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({ confirmSourceDisclosure }) }),
  resolveAgentApproval: (taskId: string, approvalId: string, decision: 'approved' | 'denied') => request<{ task: LocalAgentTask }>(`/api/local-agent/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}/resolve`, { method: 'POST', body: JSON.stringify({ decision }) }),
  rollbackAgentTask: (id: string) => request<{ rolledBack: boolean; mode: string; workspace: string }>(`/api/local-agent/tasks/${encodeURIComponent(id)}/rollback`, { method: 'POST', body: '{}' }),
  applyAgentTask: (id: string, confirm: boolean) => request<{ applied: boolean; note?: string; appliedPaths?: string[]; backupRoot?: string; code?: string; message?: string }>(`/api/local-agent/tasks/${encodeURIComponent(id)}/apply`, { method: 'POST', body: JSON.stringify({ confirm }) }),
  agentProviders: () => request<{ providers: AgentProvider[]; defaultProviderId: string | null }>('/api/local-agent/providers'),
  createAgentProvider: (provider: Partial<AgentProvider> & { id?: string; name: string; kind: string; baseUrl: string; model: string }) => request<{ provider: AgentProvider }>('/api/local-agent/providers', { method: 'POST', body: JSON.stringify(provider) }),
  updateAgentProvider: (id: string, patch: Partial<AgentProvider>) => request<{ provider: AgentProvider }>(`/api/local-agent/providers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAgentProvider: (id: string) => request<{ deleted: boolean }>(`/api/local-agent/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testAgentProvider: (id: string) => request<{ ok: boolean; latencyMs: number; replyPreview?: string; error?: string; model?: string }>(`/api/local-agent/providers/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' }),
  agentProjectInsights: (projectId: string) => request<AgentInsights>(`/api/local-agent/projects/${encodeURIComponent(projectId)}/insights`, { method: 'POST', body: '{}' }),
  aiDiagnose: (prompt: string, context?: unknown, providerId?: string) => request<{ ok: boolean; diagnosis: string; provider: { id: string; kind: string; host: string | null }; model: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number }; costUsd: number | null; attempts: number }>('/api/ai/diagnose', { method: 'POST', body: JSON.stringify({ prompt, context, providerId }) }),
  integrationReports: (projectId = '') => request<{ reports: IntegrationReport[]; total: number }>(`/api/integrations/reports${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  integrationReport: (id: string) => request<{ report: IntegrationReport }>(`/api/integrations/reports/${encodeURIComponent(id)}`),
  integrationJobs: (projectId = '') => request<{ jobs: IntegrationJob[]; total: number }>(`/api/integrations/jobs${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  integrationJob: (id: string) => request<{ job: IntegrationJob; task: Task; report: IntegrationReport | null }>(`/api/integrations/jobs/${encodeURIComponent(id)}`),
  cancelIntegrationJob: (id: string) => request<{ job: IntegrationJob }>(`/api/integrations/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  retryIntegrationJob: (id: string, confirmSourceDisclosure = false) => request<{ job: IntegrationJob; task: Task; reused?: boolean }>(`/api/integrations/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({ confirmSourceDisclosure }) }),
  prepareIntegration: (reportId: string, confirmSourceDisclosure: boolean) => request<{ job: IntegrationJob; task: Task; blocked?: boolean }>(`/api/integrations/jobs`, { method: 'POST', body: JSON.stringify({ reportId, confirmSourceDisclosure }) }),
  createIntegrationPullRequest: (job: IntegrationJob, confirm: boolean) => request<{ job: IntegrationJob; pullRequest: NonNullable<IntegrationJob['pullRequest']> }>(`/api/integrations/jobs/${encodeURIComponent(job.id)}/pull-request`, { method: 'POST', body: JSON.stringify({ confirm, confirmRepository: job.repository, confirmBranch: job.currentBranch || job.branch }) }),
  integrationSecurity: () => request<{ summary: Record<string, number | string | null>; configuration: Record<string, boolean | string>; findings: { projectId: string; repository: string; framework: string; check: string; status: string; reportId: string }[] }>('/api/integrations/security'),
  integrationSchedule: () => request<{ schedules: { id: string; enabled: boolean; intervalHours: number; nextRunAt: string | null; lastRunAt?: string }[] }>('/api/integrations/schedule'),
  updateIntegrationSchedule: (payload: { enabled: boolean; intervalHours: number }) => request<{ schedule: { id: string; enabled: boolean; intervalHours: number; nextRunAt: string | null } }>('/api/integrations/schedule', { method: 'PUT', body: JSON.stringify(payload) }),
  workflows: (id: string) => request<{ workflows: { id: number; name: string; path: string; state: string }[] }>(`/api/projects/${id}/workflows`),
  runs: (id: string) => request<{ runs: { id: number; name: string; status: string; conclusion: string | null; created_at: string; html_url: string }[] }>(`/api/projects/${id}/runs`),
  build: (id: string, workflowId: number, ref: string) => request<{ task: Task }>(`/api/projects/${id}/build`, { method: 'POST', body: JSON.stringify({ workflowId, ref }) }),
  releases: (projectId = '') => request<{ releases: { id: number; name: string; tag_name: string; draft: boolean; prerelease: boolean; published_at: string | null; html_url: string; projectName: string }[]; blocked?: boolean; message?: string }>(`/api/releases${projectId ? `?projectId=${projectId}` : ''}`),
  createRelease: (projectId: string, payload: { tagName: string; name?: string; body?: string; targetCommitish?: string; prerelease?: boolean }) => request<{ task: Task }>(`/api/projects/${projectId}/releases`, { method: 'POST', body: JSON.stringify(payload) }),
  publishRelease: (projectId: string, releaseId: number) => request<{ task: Task }>(`/api/projects/${projectId}/releases/${releaseId}/publish`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  autoUpdate: (projectId = '') => request<{ configs: UpdateConfig[]; total: number }>(`/api/auto-update${projectId ? `?projectId=${projectId}` : ''}`),
  updateCheck: (projectId: string) => request<{ task: Task }>(`/api/projects/${projectId}/update-check`, { method: 'POST', body: '{}' }),
  updateCheckAll: (projectIds: string[] = []) => request<{ task: Task }>('/api/tasks/update-check-all', { method: 'POST', body: JSON.stringify({ projectIds }) }),
  appConfig: () => request<{ configured: boolean; appId: string | null; clientId: string | null; privateKeyConfigured: boolean; webhookSecretConfigured: boolean; installations: { installationId: string; accountLogin: string | null; repositorySelection: string | null; permissions: Record<string, string>; tokenConfigured: boolean }[] }>('/api/github/app/config'),
  appInstallUrl: () => request<{ url: string; callback: string }>('/api/github/app/install-url'),
  auditLogs: () => request<{ logs: { id: string; actor: string; action: string; target: string; result: string; risk: string; at: string }[] }>('/api/audit-logs'),
  tasks: () => request<{ tasks: Task[] }>('/api/tasks'),
  settings: () => request<{ github: { configured: boolean; owner: string | null; apiUrl: string }; ai: { configured: boolean; baseUrl: string | null; model: string | null }; tasks: { concurrency: number; notifications: boolean } }>('/api/settings'),
  hostingOverview: () => request<{ projects: HostingProject[]; enabledCount: number; runs: HostingRun[]; scheduler: { dueNow: number; strategies: string[]; paused: boolean } }>('/api/hosting/overview'),
  hostingRuns: (projectId = '') => request<{ runs: HostingRun[]; total: number }>(`/api/hosting/runs${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  hostingProject: (projectId: string) => request<{ project: HostingProject; runs: HostingRun[] }>(`/api/projects/${encodeURIComponent(projectId)}/hosting`),
  updateHostingPolicy: (projectId: string, patch: Partial<HostingPolicy> & { applyPreset?: boolean }) => request<{ project: HostingProject }>(`/api/projects/${encodeURIComponent(projectId)}/hosting`, { method: 'PUT', body: JSON.stringify(patch) }),
  hostingReadiness: (projectId: string) => request<{ readinessId: string; expiresAt: string }>(`/api/projects/${encodeURIComponent(projectId)}/hosting/readiness`, { method: 'POST', body: '{}' }),
  enableHosting: async (projectId: string, readinessId?: string) => {
    const ready = readinessId ? { readinessId } : await api.hostingReadiness(projectId)
    return request<{ project: HostingProject }>(`/api/projects/${encodeURIComponent(projectId)}/hosting/enable`, { method: 'POST', body: JSON.stringify(ready) })
  },
  disableHosting: (projectId: string) => request<{ project: HostingProject }>(`/api/projects/${encodeURIComponent(projectId)}/hosting/disable`, { method: 'POST', body: '{}' }),
  inspectHosting: (projectId: string, depth: 'light' | 'full') => request<{ project: HostingProject; run: HostingRun }>(`/api/projects/${encodeURIComponent(projectId)}/hosting/inspect`, { method: 'POST', body: JSON.stringify({ depth }) }),
  pauseHosting: (paused: boolean) => request<{ paused: boolean }>('/api/hosting/pause', { method: 'POST', body: JSON.stringify({ paused }) }),
  issueActivity: (options: { actionable?: boolean; limit?: number } = {}) => request<{ issues: IssueActivity[]; total: number }>(`/api/issues/activity?${new URLSearchParams({ ...(options.actionable ? { actionable: 'true' } : {}), ...(options.limit ? { limit: String(options.limit) } : {}) }).toString()}`),
  projectIssues: (projectId: string, options: { actionable?: boolean; category?: string } = {}) => request<{ issues: Omit<IssueActivity, 'projectId' | 'repository'>[]; total: number; lastSyncedAt: string | null; categories: string[] }>(`/api/projects/${encodeURIComponent(projectId)}/issues?${new URLSearchParams({ ...(options.actionable ? { actionable: 'true' } : {}), ...(options.category ? { category: options.category } : {}) }).toString()}`),
  syncProjectIssues: (projectId: string) => request<{ scanned: number; classified: number; newlyActionable: number }>(`/api/projects/${encodeURIComponent(projectId)}/issues/sync`, { method: 'POST', body: '{}' }),
  classifyIssue: (projectId: string, number: number) => request<{ issue: Record<string, unknown>; classification: IssueClassification; entry: IssueActivity; commentsCount: number }>(`/api/projects/${encodeURIComponent(projectId)}/issues/${number}/classify`, { method: 'POST', body: '{}' }),
  fixIssue: (projectId: string, number: number, classification?: IssueClassification | null) => request<{ queued: boolean; issueNumber: number; repository: string }>(`/api/projects/${encodeURIComponent(projectId)}/issues/${number}/fix`, { method: 'POST', body: JSON.stringify({ classification: classification || null }) }),
  securityFindings: (options: { projectId?: string; priority?: string; limit?: number } = {}) => request<{ findings: SecurityFinding[]; total: number }>(`/api/security/findings?${new URLSearchParams({ ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.priority ? { priority: options.priority } : {}), ...(options.limit ? { limit: String(options.limit) } : {}) }).toString()}`),
  securityScan: (projectId: string) => request<{ scan: { scannedAt: string; status: string; counts: Record<string, number>; dependencyAuditRan: boolean; findings: { key: string; priority: string; summary: string; detail: string | null; path?: string | null }[] }; summary: Record<string, unknown> }>(`/api/projects/${encodeURIComponent(projectId)}/security-scan`, { method: 'POST', body: '{}' }),
  researchReports: (projectId = '') => request<{ reports: ResearchReport[]; total: number }>(`/api/research/reports${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  researchReport: (reportId: string) => request<{ report: ResearchReport }>(`/api/research/reports/${encodeURIComponent(reportId)}`),
  reviewUpgradeProposal: (reportId: string, proposalId: string, decision: 'approve' | 'reject', licenseReviewed: boolean) => request<{ proposal: UpgradeProposal }>(`/api/research/reports/${encodeURIComponent(reportId)}/proposals/${encodeURIComponent(proposalId)}/review`, { method: 'POST', body: JSON.stringify({ decision, confirm: true, licenseReviewed }) }),
  runResearch: (projectId: string) => request<{ report: ResearchReport }>(`/api/projects/${encodeURIComponent(projectId)}/research`, { method: 'POST', body: '{}' })
}
