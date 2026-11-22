import { describe, expect, it } from 'vitest'
import { adapters, inspectComponents } from '../../server/integrations/registry.mjs'
import { assessComponent } from '../../server/services/update-assessor.mjs'
import { commandForFramework } from '../../server/services/sandbox-runner.mjs'

describe('update adapters and evidence scoring', () => {
  it('registers the five target adapter families with test and security inspection capabilities', () => {
    expect(adapters.map((adapter) => adapter.id)).toEqual(['electron', 'tauri', 'python', 'dotnet', 'web-pwa'])
    for (const adapter of adapters) {
      expect(adapter.capabilities).toContain('security-findings')
      expect(adapter.capabilities).toContain('test-entrypoint')
    }
  })

  it('does not treat a signing-related text token as cryptographic signature verification', () => {
    const component = {
      framework: 'electron', supported: true,
      evidence: { updaterCode: true, workflow: true, manifest: ['latest.yml'], signingConfigured: true, signatureCryptographicallyVerified: false }
    }
    const assessment = assessComponent(component)
    expect(assessment.checks.signingConfigured).toBe(true)
    expect(assessment.signatureCryptographicallyVerified).toBe(false)
    expect(assessment.verified).toBe(false)
  })

  it('detects a repository containing multiple runtime components', () => {
    const components = inspectComponents([
      { path: 'desktop/package.json', content: '{"dependencies":{"electron":"^30"}}' },
      { path: 'desktop/src/main.js', content: 'autoUpdater.checkForUpdates()' },
      { path: 'web/manifest.webmanifest', content: '{}' },
      { path: 'web/sw.js', content: 'self.addEventListener("install", () => {})' },
      { path: 'src-tauri/tauri.conf.json', content: '{"bundle":{"createUpdaterArtifacts":true}}' },
      { path: 'src-tauri/Cargo.toml', content: 'tauri-plugin-updater = "2"' },
      { path: 'windows/App.csproj', content: '<Project />' },
      { path: 'python/pyproject.toml', content: '[project]\nname="tool"' },
      { path: 'python/main.py', content: 'import PySide6' }
    ])
    expect(components.map((item) => item.adapter)).toEqual(expect.arrayContaining(['electron', 'tauri', 'python', 'dotnet', 'web-pwa']))
  })

  it('never suppresses Python test failures in the sandbox command', () => {
    expect(commandForFramework('python-desktop').join(' ')).not.toContain('|| true')
    expect(commandForFramework('unknown')).toBeNull()
  })
})
