import type { ComponentType } from 'react'
import {
  Activity, Bot, Boxes, CircleDot, Code2, GitFork, Hammer, LayoutDashboard, ListChecks,
  PackageCheck, RefreshCw, Rocket, Search, Settings2, ShieldCheck
} from 'lucide-react'

// Stable leaf identifiers. These strings are the durable navigation contract:
// SetupCenter, ProductTour, ProjectOverview, notifications and the command
// palette all dispatch them, so leaves never rename even when centers do.
export type RemotePage =
  | 'Autonomy' | 'Overview' | 'Monitoring'
  | 'Projects' | 'GitHub Connections'
  | 'Build Center'
  | 'Release Center' | 'Auto Update'
  | 'Repository Scanner' | 'AI Pipeline' | 'Adapter Center' | 'AI Operations'
  | 'Task Center' | 'Integration History'
  | 'Hosting' | 'Issues'
  | 'Security Center' | 'Security Findings' | 'Update Security'
  | 'Research'
  | 'Settings'

export type CenterId =
  | 'dashboard' | 'repositories' | 'autopilot' | 'development' | 'security'
  | 'research' | 'release' | 'task' | 'settings'

export type NavIcon = ComponentType<{ size?: number | string; className?: string }>

// Pre-2.0 flat registry, kept in its historical order so existing i18n keys
// (`git:shell.nav.*`) and leaf-based tests keep working unchanged.
export const REMOTE_NAV_PAGES: { page: RemotePage; key: string; icon: NavIcon }[] = [
  { page: 'Autonomy', key: 'autonomy', icon: Rocket },
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
  { page: 'Monitoring', key: 'monitoring', icon: Activity },
  { page: 'AI Operations', key: 'aiOperations', icon: Bot },
  { page: 'Task Center', key: 'taskCenter', icon: ListChecks },
  { page: 'Security Center', key: 'securityCenter', icon: ShieldCheck },
  { page: 'Hosting', key: 'hosting', icon: Rocket },
  { page: 'Issues', key: 'issues', icon: CircleDot },
  { page: 'Security Findings', key: 'securityFindings', icon: ShieldCheck },
  { page: 'Research', key: 'research', icon: Search },
  { page: 'Settings', key: 'serverSettings', icon: Settings2 }
]

// NEXUS 2.0 information architecture: nine centers replace the flat 21-entry
// rail. Centers group leaves; every leaf keeps its original page component,
// API bindings and i18n keys. Mapping is declared once here and consumed by
// the web sidebar, the desktop ActivityBar and the command palette, so the
// three surfaces can never drift apart again.
export type NavCenter = {
  id: CenterId
  /** i18n key under `git:shell.centers.*`. */
  key: string
  icon: NavIcon
  /** Leaf shown when the center is opened. */
  defaultLeaf: RemotePage
  /** Old leaves reachable inside this center, in display order. */
  leaves: RemotePage[]
}

export const NAV_CENTERS: NavCenter[] = [
  { id: 'dashboard', key: 'dashboard', icon: LayoutDashboard, defaultLeaf: 'Overview', leaves: ['Overview', 'Monitoring'] },
  { id: 'repositories', key: 'repositories', icon: Boxes, defaultLeaf: 'Projects', leaves: ['Projects', 'Repository Scanner', 'Issues'] },
  { id: 'autopilot', key: 'autopilot', icon: Rocket, defaultLeaf: 'Autonomy', leaves: ['Autonomy', 'AI Operations', 'Hosting'] },
  { id: 'development', key: 'development', icon: Hammer, defaultLeaf: 'Build Center', leaves: ['Build Center', 'AI Pipeline'] },
  { id: 'security', key: 'security', icon: ShieldCheck, defaultLeaf: 'Security Center', leaves: ['Security Center', 'Security Findings', 'Update Security'] },
  { id: 'research', key: 'research', icon: Search, defaultLeaf: 'Research', leaves: ['Research'] },
  { id: 'release', key: 'release', icon: PackageCheck, defaultLeaf: 'Release Center', leaves: ['Release Center', 'Auto Update'] },
  { id: 'task', key: 'task', icon: ListChecks, defaultLeaf: 'Task Center', leaves: ['Task Center', 'Integration History'] },
  { id: 'settings', key: 'settings', icon: Settings2, defaultLeaf: 'Settings', leaves: ['Settings', 'GitHub Connections', 'Adapter Center'] }
]

export const isRemotePage = (value: unknown): value is RemotePage =>
  REMOTE_NAV_PAGES.some((entry) => entry.page === value)

export const leafMeta = (page: RemotePage) => REMOTE_NAV_PAGES.find((entry) => entry.page === page)

export const centerForLeaf = (page: RemotePage): NavCenter =>
  NAV_CENTERS.find((center) => center.leaves.includes(page)) || NAV_CENTERS[0]
