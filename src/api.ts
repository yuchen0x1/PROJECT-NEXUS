export type Project = {
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
  group: string
  stack: string[]
  latestRelease?: { tag_name?: string; published_at?: string } | null
}

export type Task = {
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
  type: 'local-agent'
  label: string
  projectId: string
  projectName: string
  providerId: string | null
  prompt: string
  status: string
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  events: { at: string; type: string; status?: string; detail: string; metadata?: Record<string, unknown> }[]
  disclosedPaths: string[]
  changedFiles: string[]
  provider: { id: string; kind: string; host: string | null; model: string } | null
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null
  costUsd: number | null
  attempts: number | null
  rationale: string | null
  workspaceReady: boolean
  workspaceStats: { entries: number; files: number; bytes: number; skippedSymlinks: number } | null
  sourceDisclosureConfirmedAt: string | null
}

export type LocalAgentChange = { action: 'added' | 'modified' | 'deleted'; path: string; before: string | null; after: string | null; contentStatus: string }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
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
  overview: () => request<{ metrics: Record<string, number>; projects: Project[]; tasks: Task[]; activity: { id: string; message: string; at: string }[]; githubConfigured: boolean }>('/api/overview'),
  githubStatus: () => request<{ configured: boolean; owner: string | null; apiUrl: string; permissions: string[] }>('/api/github/status'),
  projects: (query = '') => request<{ projects: Project[]; total: number }>(`/api/projects?query=${encodeURIComponent(query)}`),
  syncRepositories: () => request<{ task: Task }>('/api/tasks/sync-repositories', { method: 'POST', body: '{}' }),
  scanProject: (id: string) => request<{ project: Project }>(`/api/projects/${id}/scan`, { method: 'POST', body: '{}' }),
  integrationScan: (id: string) => request<{ project: Project; job: IntegrationJob; task: Task; reused: boolean }>(`/api/projects/${id}/integration-scan`, { method: 'POST', body: '{}' }),
  integrationScanAll: (projectIds: string[] = []) => request<{ jobs: { job: IntegrationJob; task: Task; reused: boolean }[]; blocked: { projectId: string; fullName: string; status: string; reason: string }[] }>('/api/integrations/scans', { method: 'POST', body: JSON.stringify({ projectIds }) }),
  integrationAdapters: () => request<{ adapters: IntegrationAdapter[]; ai: { configured: boolean; baseUrl: string | null; model: string | null }; remoteWritesEnabled: boolean; supportedWorkflows: Record<string, boolean> }>('/api/integrations/adapters'),
  aiProviders: () => request<{ providers: AIProviderSummary[]; configured: boolean; defaultProviderId: string | null; defaultModel: string | null }>('/api/ai/providers'),
  localAgentConfig: () => request<{ configured: boolean; defaultProviderId: string | null; providers: AIProviderSummary[]; limits: { maxPromptBytes: number; maxContextFiles: number; maxProviderSourceBytesAfterRedaction: number; maxOperationCount: number; operations: string[] }; capabilities: { isolatedWorkspace: boolean; originalProjectWrites: boolean; commandExecution: boolean; buildAndTest: boolean; gitApply: boolean } }>('/api/local-agent/config'),
  localAgentTasks: () => request<{ tasks: LocalAgentTask[] }>('/api/local-agent/tasks'),
  localAgentTask: (id: string) => request<{ task: LocalAgentTask; changes: LocalAgentChange[]; changesError: string | null }>(`/api/local-agent/tasks/${encodeURIComponent(id)}`),
  createLocalAgentTask: (payload: { projectId: string; prompt: string; providerId?: string | null; confirmSourceDisclosure: boolean }) => request<{ task: LocalAgentTask }>('/api/local-agent/tasks', { method: 'POST', body: JSON.stringify(payload) }),
  cancelLocalAgentTask: (id: string) => request<{ task: LocalAgentTask; cancellationRequested?: boolean }>(`/api/local-agent/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  retryLocalAgentTask: (id: string, confirmSourceDisclosure: boolean) => request<{ task: LocalAgentTask }>(`/api/local-agent/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({ confirmSourceDisclosure }) }),
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
  settings: () => request<{ github: { configured: boolean; owner: string | null; apiUrl: string }; ai: { configured: boolean; baseUrl: string | null; model: string | null }; tasks: { concurrency: number; notifications: boolean } }>('/api/settings')
}
