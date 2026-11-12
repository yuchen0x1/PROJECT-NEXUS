import { createAdapter } from './base.mjs'

export const electronAdapter = createAdapter({
  id: 'electron', name: 'Electron',
  detect: (files) => files.some((file) => /electron/i.test(file.content || '') || /(^|\/)electron-builder\.(yml|yaml|json)$/.test(file.path) || /(^|\/)latest(?:-mac)?\.yml$/.test(file.path)),
  inspect: (files) => {
    const packageFile = files.find((file) => file.path.endsWith('package.json'))
    let pkg = {}
    try { pkg = JSON.parse(packageFile?.content || '{}') } catch {}
    const config = [pkg.build, ...files.filter((file) => /electron-builder\.(yml|yaml|json)$/.test(file.path)).map((file) => file.content)].filter(Boolean)
    const all = JSON.stringify(config)
    const updaterCode = files.some((file) => /autoUpdater\.(checkForUpdates|checkForUpdatesAndNotify)|electron-updater/.test(file.content || ''))
    const workflow = files.some((file) => file.path.startsWith('.github/workflows/') && /electron-builder|electron-updater|publish|release/i.test(file.content || ''))
    const manifest = files.filter((file) => /(^|\/)latest(?:-mac)?\.yml$/.test(file.path))
    const signingConfigured = /publisherName|CSC_LINK|CSC_KEY_PASSWORD|signAndEditExecutable/i.test(all) || files.some((file) => /CSC_LINK|CSC_KEY_PASSWORD/.test(file.content || ''))
    const feedUrl = all.match(/https:\/\/[^\s"']+/)?.[0] || null
    return { appRoot: packageFile?.path.replace(/package\.json$/, '') || '', framework: 'electron', supported: true, evidence: {
      updaterCode, versionDetection: Boolean(pkg.version), downloadInstall: updaterCode,
      workflow, manifest: manifest.map((file) => file.path), signingConfigured,
      signatureCryptographicallyVerified: false, digestConfigured: manifest.some((file) => /sha512|sha256/i.test(file.content || '')),
      updateSourceHttps: !feedUrl || feedUrl.startsWith('https://'), feedUrl,
      recovery: /rollback|downgrade/i.test(all), packageScripts: Object.keys(pkg.scripts || {}),
      testCommand: pkg.scripts?.test ? 'npm test' : null, buildCommand: pkg.scripts?.build ? 'npm run build' : null,
      secretsRequired: ['GH_TOKEN or equivalent release credential', ...(signingConfigured ? ['platform signing certificate and password'] : [])]
    } }
  }
})
