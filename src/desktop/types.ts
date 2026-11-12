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

export type DesktopBridge = {
  requestApi: (request: { url: string; method?: string; body?: string }) => Promise<{ status: number; body: Record<string, unknown> }>
  getInfo: () => Promise<WorkstationInfo>
  detectEnvironment: () => Promise<EnvironmentReport>
  listProjects: () => Promise<LocalProject[]>
  addProject: () => Promise<ProjectRegistration | null>
  removeProject: (projectId: string, projectName: string) => Promise<{ removed: boolean }>
  scanProject: (projectId: string) => Promise<NonNullable<LocalProject['lastScan']>>
  setAutoStart: (enabled: boolean) => Promise<{ enabled: boolean }>
}
