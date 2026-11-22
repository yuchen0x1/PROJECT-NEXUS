import { INTEGRATION_STATUS } from '../integrations/base.mjs'

const scoreWeights = {
  updaterCode: 15,
  versionDetection: 10,
  downloadInstall: 15,
  releasePipeline: 15,
  manifestAssets: 10,
  signingConfigured: 10,
  digestConfigured: 5,
  channels: 5,
  recovery: 5,
  secureTransport: 5,
  testsConfigured: 5
}

export function assessComponent(component, { pipelinePresent = false } = {}) {
  const evidence = component.evidence || {}
  const checks = {
    updaterCode: Boolean(evidence.updaterCode),
    versionDetection: Boolean(evidence.versionDetection),
    downloadInstall: Boolean(evidence.downloadInstall),
    releasePipeline: Boolean(evidence.workflow || pipelinePresent),
    manifestAssets: Boolean(evidence.manifest?.length || evidence.pwaManifest),
    signingConfigured: Boolean(evidence.signingConfigured),
    digestConfigured: Boolean(evidence.digestConfigured),
    channels: Boolean(evidence.channels),
    recovery: Boolean(evidence.recovery),
    secureTransport: evidence.updateSourceHttps === true,
    testsConfigured: Boolean(evidence.testCommand)
  }
  const score = Object.entries(scoreWeights).reduce((sum, [key, weight]) => sum + (checks[key] ? weight : 0), 0)
  const missing = Object.keys(checks).filter((key) => !checks[key])
  const applicableUnsupported = ['web', 'web-pwa', 'python-library-or-service'].includes(component.framework)
  let status
  if (!component.supported && applicableUnsupported) status = INTEGRATION_STATUS.UNSUPPORTED
  else if (checks.updaterCode && !checks.releasePipeline) status = INTEGRATION_STATUS.PIPELINE_MISSING
  else if (checks.updaterCode && !checks.signingConfigured && !['web', 'web-pwa'].includes(component.framework)) status = INTEGRATION_STATUS.SIGNING_MISSING
  else if (checks.updaterCode && !checks.manifestAssets) status = INTEGRATION_STATUS.MANIFEST_MISSING
  else if (score === 0) status = INTEGRATION_STATUS.NOT_IMPLEMENTED
  else if (score >= 70) status = INTEGRATION_STATUS.READY_FOR_TEST
  else if (checks.updaterCode) status = INTEGRATION_STATUS.CODE_ONLY
  else status = INTEGRATION_STATUS.PARTIAL
  const recommendation = recommend(component.framework)
  return {
    score, status, checks, missing, recommendation,
    verified: false,
    signingConfigured: checks.signingConfigured,
    signatureCryptographicallyVerified: false,
    digestCryptographicallyVerified: false,
    verificationNote: 'Repository text and configuration do not prove a cryptographically valid signature or installed update. VERIFIED requires old-client discovery, asset verification, installation, and successful startup evidence.'
  }
}

export function assessComponents(components) {
  if (!components.length) return {
    score: 0, status: INTEGRATION_STATUS.NOT_IMPLEMENTED, components: [], missing: Object.keys(scoreWeights), recommendation: recommend('unknown'), verified: false
  }
  const results = components.map((component) => ({ component, assessment: assessComponent(component) }))
  const best = results.reduce((left, right) => right.assessment.score > left.assessment.score ? right : left)
  const statuses = results.map((item) => item.assessment.status)
  const status = statuses.includes(INTEGRATION_STATUS.READY_FOR_TEST) ? INTEGRATION_STATUS.READY_FOR_TEST : best.assessment.status
  return { score: Math.max(...results.map((item) => item.assessment.score)), status, components: results, missing: [...new Set(results.flatMap((item) => item.assessment.missing))], recommendation: best.assessment.recommendation, verified: false }
}

export function recommend(framework) {
  const options = {
    electron: { adapter: 'electron', solution: 'electron-updater with electron-builder GitHub Releases provider', reason: 'Uses Electron ecosystem update metadata, differential blockmaps, and platform signing hooks.' },
    tauri: { adapter: 'tauri', solution: 'Tauri official updater plugin', reason: 'Uses framework-native signed update metadata and public-key verification.' },
    'python-desktop': { adapter: 'python', solution: 'Installer-specific signed manifest and staged updater', reason: 'Python packagers do not provide one universal safe in-place updater; the installer strategy must be selected per target OS.' },
    dotnet: { adapter: 'dotnet', solution: 'Velopack or the project’s existing MSIX/ClickOnce deployment model', reason: 'Keeps update mechanics aligned with the application’s Windows packaging and signing model.' },
    'web-pwa': { adapter: 'web-pwa', solution: 'HTTPS deployment with versioned assets and Service Worker update lifecycle', reason: 'Web clients should update through deployment and browser-managed service worker lifecycle.' },
    web: { adapter: 'web-pwa', solution: 'CI deployment with immutable/versioned assets and rollback', reason: 'Web applications update through deployment; app-store or desktop updater logic is not appropriate.' },
    unknown: { adapter: 'custom', solution: 'Inspect application boundaries before selecting an updater', reason: 'No supported application component was identified from the available repository evidence.' }
  }
  return options[framework] || options.unknown
}

export { scoreWeights }
