// Unified Agent Adapter registry (master directive PART 6.5). Every local AI
// coding tool integrates as an adapter that reports its own detection and
// capabilities honestly — nothing is hardcoded to Codex, and missing
// capabilities are displayed as missing, never faked.
//
// Adding a future adapter (ACP agents, other desktop tools): register an
// object with { id, name, kind, detect() } below; the status API and UI pick
// it up automatically.

import { detectCodexInstall } from './codex-app-server.mjs'
import { detectCodexDesktop } from './desktop-assist.mjs'

const registry = new Map()

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('An adapter must be an object.')
  if (!/^[a-z][a-z0-9-]{1,48}$/.test(String(adapter.id || ''))) throw new Error('Adapter id must be kebab-case.')
  if (typeof adapter.detect !== 'function') throw new Error(`Adapter ${adapter.id} must implement detect().`)
  if (typeof adapter.name !== 'string' || !adapter.name) throw new Error(`Adapter ${adapter.id} must have a name.`)
}

export function registerAgentAdapter(adapter) {
  validateAdapter(adapter)
  registry.set(adapter.id, adapter)
  return adapter
}

export function listAgentAdapterIds() {
  return [...registry.keys()]
}

function normalizeCapabilities(capabilities) {
  const clean = {}
  for (const [key, value] of Object.entries(capabilities || {})) {
    // Booleans stay booleans; string descriptors (like mode) pass through.
    clean[String(key).slice(0, 60)] = typeof value === 'boolean' ? value : String(value).slice(0, 40)
  }
  return clean
}

export async function detectAgentAdapters({ env = process.env } = {}) {
  const results = []
  for (const adapter of registry.values()) {
    try {
      const detection = await adapter.detect({ env })
      results.push({
        id: adapter.id,
        name: adapter.name,
        kind: adapter.kind || 'local-agent',
        channel: adapter.channel || 'native',
        ...detection,
        capabilities: normalizeCapabilities(detection?.capabilities || adapter.capabilities)
      })
    } catch (error) {
      results.push({
        id: adapter.id,
        name: adapter.name,
        kind: adapter.kind || 'local-agent',
        channel: adapter.channel || 'native',
        installed: false,
        error: String(error.message || error).slice(0, 300),
        capabilities: normalizeCapabilities(adapter.capabilities)
      })
    }
  }
  return results
}

// ---- Built-in adapters ----------------------------------------------------

// Channel A (native): the official Codex App Server runs agent sessions with
// isolated workspaces, streamed events and independent NEXUS acceptance.
registerAgentAdapter({
  id: 'codex-app-server',
  name: 'Codex (App Server)',
  kind: 'local-agent',
  channel: 'native',
  capabilities: {
    nativeAgentSessions: true,
    isolatedWorkspace: true,
    liveEvents: true,
    buildTestVerification: true,
    approvalRequestsDeclined: true,
    desktopWindowControl: false
  },
  detect: async ({ env }) => {
    const detection = await detectCodexInstall({ env })
    return {
      installed: Boolean(detection.installed),
      version: detection.version || null,
      launcher: detection.launcher || null,
      error: detection.error || null,
      capabilities: null // registry-level capabilities apply
    }
  }
})

// Channel B (assist): detects the installed Codex desktop application so the
// user can start it and jump to a task workspace. Assist-only by design —
// no task injection, no window automation, no screen reading.
registerAgentAdapter({
  id: 'codex-desktop-assist',
  name: 'Codex Desktop (assist)',
  kind: 'desktop-assist',
  channel: 'desktop-assist',
  capabilities: null // capabilities come from the detection itself
  ,
  detect: async ({ env }) => {
    const detection = await detectCodexDesktop({ env })
    return {
      installed: Boolean(detection.installed),
      supported: detection.supported !== false,
      running: Boolean(detection.running),
      version: detection.version || null,
      appName: detection.appName || null,
      installLocation: detection.installLocation || null,
      launcherExe: detection.launcherExe || null,
      capabilities: detection.capabilities
    }
  }
})
