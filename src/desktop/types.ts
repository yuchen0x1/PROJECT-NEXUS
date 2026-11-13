export type LocalProject = {
  id: string
  name: string
  path: string
  addedAt: string
  available: boolean
  availability: 'AVAILABLE' | 'MISSING' | 'PATH_CHANGED'
  lastScan: {
    projectId: string
    scannedAt: string
    visitedEntries: number
    truncated: boolean
    markers: string[]
    technologies: string[]
    warnings: string[]
  } | null
}

export type EnvironmentTool = {
  id: string
  label: string
  executable: string
  versionArgs: string[] | null
  group: string
  status: 'AVAILABLE' | 'MISSING' | 'TIMEOUT' | 'VERSION_ERROR' | 'SHIM_FOUND' | 'PATH_FOUND'
  paths: string[]
  version: string | null
  conflict: boolean
  diagnostic?: string | null
}

export type EnvironmentReport = {
  platform: string
  scannedAt: string
  status: string
  available?: number
  total?: number
  tools: EnvironmentTool[]
  message?: string
}

export type WorkstationInfo = {
  version: string
  platform: string
  arch: string
  osRelease: string
  dataPath: string
  logsPath: string
  cachePath: string
  autoStart: boolean
}

export type ProjectRegistration = { project: LocalProject; added: boolean }

export type ThemePreference = 'dark' | 'light' | 'system'

export type AgentReplyLanguageMode = 'ui' | 'input' | (string & {})

export type UserPreferences = {
  /** null on first launch: the startup language is derived from the system locale. */
  language: string | null
  theme: ThemePreference
  reduceMotion: boolean
  agentReplyLanguage: AgentReplyLanguageMode
}

export type DesktopSettingsPayload = {
  preferences: UserPreferences
  systemLocale: string
  /** Files used by the main process so the UI can show where settings live. */
  settingsPath: string
}

export type LocalizedDialogText = {
  title?: string
  message: string
  detail?: string
  confirm: string
  cancel: string
}

export type DesktopBridge = {
  getAppUpdate: () => Promise<AppUpdateState>
  checkAppUpdate: () => Promise<AppUpdateState>
  installAppUpdate: () => Promise<AppUpdateState>
  onAppUpdate: (callback: (state: AppUpdateState) => void) => () => void
  getMetrics: () => Promise<DesktopMetrics>
  fetchProviderModels: (draft: { kind: string; baseUrl: string; apiKey?: string; providerId?: string }) => Promise<ProviderModelsResult>
  openGitHubTokenPage: () => Promise<void>
  connectGitHub: (token: string) => Promise<{ connected: boolean; account: { login: string; avatarUrl: string } }>
  requestApi: (request: { url: string; method?: string; body?: string }) => Promise<{ status: number; body: Record<string, unknown> }>
  getInfo: () => Promise<WorkstationInfo>
  detectEnvironment: () => Promise<EnvironmentReport>
  listProjects: () => Promise<LocalProject[]>
  addProject: (dialogTitle?: string) => Promise<ProjectRegistration | null>
  removeProject: (projectId: string, projectName: string, dialog?: LocalizedDialogText) => Promise<{ removed: boolean }>
  scanProject: (projectId: string) => Promise<NonNullable<LocalProject['lastScan']>>
  setProviderKey: (providerId: string, apiKey: string) => Promise<{ providerId: string; saved: boolean; sync: { synced: boolean } }>
  deleteProviderKey: (providerId: string) => Promise<{ providerId: string; deleted: boolean; sync: { synced: boolean } }>
  getProviderKeyStatus: () => Promise<{ providerIds: string[]; encryptionAvailable: boolean }>
  setAutoStart: (enabled: boolean) => Promise<{ enabled: boolean }>
  getSettings: () => Promise<DesktopSettingsPayload>
  updateSettings: (partial: Partial<Omit<UserPreferences, 'language'>> & { language?: string | null }) => Promise<UserPreferences>
}

export type AppUpdateState = {
  revision: number
  phase: 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'
  currentVersion: string
  version: string | null
  percent: number
  errorCode: 'check' | 'download' | 'install' | null
  retry: 'check' | 'update'
}

export type DesktopMetrics = { at: string; processes: { pid: number; type: string; cpuPercent: number; workingSetBytes: number; peakWorkingSetBytes: number; creationTime: number }[]; servicePid: number | null }

export type ProviderModelsResult = {
  ok: boolean
  models: { id: string }[]
  truncated: boolean
  errorCode?: string
  httpStatus?: number
}
