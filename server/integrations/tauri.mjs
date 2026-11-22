import { createAdapter } from './base.mjs'

export const tauriAdapter = createAdapter({
  id: 'tauri', name: 'Tauri',
  detect: (files) => files.some((file) => /tauri-plugin-updater|createUpdaterArtifacts|"tauri"\s*:/i.test(file.content || '') || /(^|\/)tauri\.conf\.json$/.test(file.path)),
  inspect: (files) => {
    const configs = files.filter((file) => /tauri\.conf\.json$|Cargo\.toml$/.test(file.path))
    const source = files.filter((file) => /\.(rs|ts|js|json|toml)$/.test(file.path)).map((file) => file.content || '').join('\n')
    const updaterCode = /tauri-plugin-updater|check\(\).*download|UpdaterExt/i.test(source)
    const workflow = files.some((file) => file.path.startsWith('.github/workflows/') && /tauri|updater|release/i.test(file.content || ''))
    const manifest = files.filter((file) => /update\.json$/.test(file.path))
    const signingConfigured = configs.some((file) => /pubkey|createUpdaterArtifacts/i.test(file.content || ''))
    const cargo = files.find((file) => file.path.endsWith('Cargo.toml'))
    return { appRoot: configs.find((file) => file.path.includes('src-tauri'))?.path.replace(/tauri\.conf\.json$/, '') || '', framework: 'tauri', supported: true, evidence: {
      updaterCode, versionDetection: /version\s*=/.test(cargo?.content || ''), downloadInstall: updaterCode,
      workflow, manifest: manifest.map((file) => file.path), signingConfigured,
      signatureCryptographicallyVerified: false, digestConfigured: manifest.length > 0,
      updateSourceHttps: configs.some((file) => /https:\/\//i.test(file.content || '')),
      recovery: /rollback|downgrade/i.test(source), testCommand: 'cargo test', buildCommand: 'cargo build',
      secretsRequired: ['Tauri updater private signing key and password']
    } }
  }
})
