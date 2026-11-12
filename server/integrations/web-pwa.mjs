import { createAdapter } from './base.mjs'

export const webPwaAdapter = createAdapter({
  id: 'web-pwa', name: 'Web / PWA',
  detect: (files) => files.some((file) => /(^|\/)(package\.json|manifest\.webmanifest|manifest\.json|service-worker\.js|sw\.js)$/.test(file.path) || /serviceWorker|vite-plugin-pwa|workbox/i.test(file.content || '')),
  inspect: (files) => {
    const packageFile = files.find((file) => file.path.endsWith('package.json'))
    let pkg = {}
    try { pkg = JSON.parse(packageFile?.content || '{}') } catch {}
    const source = files.map((file) => file.content || '').join('\n')
    const pwa = files.some((file) => /manifest\.webmanifest$|service-worker\.js$|sw\.js$/.test(file.path) || /vite-plugin-pwa|workbox/i.test(file.content || ''))
    const updaterCode = /registerSW|skipWaiting|clientsClaim|serviceWorker\.register/i.test(source)
    const workflow = files.some((file) => file.path.startsWith('.github/workflows/') && /deploy|pages|cloudflare|vercel|netlify/i.test(file.content || ''))
    const pwaManifest = files.some((file) => /manifest\.webmanifest$|manifest\.json$/.test(file.path))
    return { appRoot: packageFile?.path.replace(/package\.json$/, '') || '', framework: pwa ? 'web-pwa' : 'web', supported: true, evidence: {
      packageName: pkg.name || null, updaterCode, versionDetection: Boolean(pkg.version),
      downloadInstall: pwa && updaterCode, workflow, pwaManifest,
      manifest: pwaManifest ? files.filter((file) => /manifest\.webmanifest$|manifest\.json$/.test(file.path)).map((file) => file.path) : [],
      signingConfigured: false, signatureCryptographicallyVerified: false,
      digestConfigured: /immutable|contenthash|chunkhash/i.test(source), updateSourceHttps: true,
      recovery: /rollback|revert/i.test(source), testCommand: pkg.scripts?.test ? 'npm test' : null,
      buildCommand: pkg.scripts?.build ? 'npm run build' : null,
      secretsRequired: workflow ? ['Deployment provider token in CI secrets'] : []
    } }
  }
})
