import { createAdapter } from './base.mjs'

export const dotnetAdapter = createAdapter({
  id: 'dotnet', name: '.NET',
  detect: (files) => files.some((file) => /\.(csproj|sln)$/.test(file.path)),
  inspect: (files) => {
    const manifests = files.filter((file) => /\.(csproj|sln)$/.test(file.path))
    const source = files.filter((file) => /\.(cs|csproj|props|targets|ya?ml|json)$/.test(file.path)).map((file) => file.content || '').join('\n')
    const updaterCode = /Velopack|Squirrel|ClickOnce|MSIX|Package.appxmanifest|CheckForUpdates/i.test(source)
    const workflow = files.some((file) => file.path.startsWith('.github/workflows/') && /dotnet|msbuild|publish/i.test(file.content || ''))
    const signingConfigured = /SignTool|signtool|PackageCertificate|signing/i.test(source)
    const versionDetection = /<Version>[^<]+<\/Version>|<VersionPrefix>[^<]+<\/VersionPrefix>|AssemblyVersion/i.test(source)
    const hasTests = files.some((file) => /tests?.*\.csproj$/i.test(file.path))
    return { appRoot: manifests.find((file) => file.path.endsWith('.csproj'))?.path.replace(/[^/]+$/, '') || '', framework: 'dotnet', supported: true, evidence: {
      manifests: manifests.map((file) => file.path), updaterCode, versionDetection, downloadInstall: updaterCode,
      workflow, signingConfigured, signatureCryptographicallyVerified: false, digestConfigured: false,
      updateSourceHttps: /https:\/\//i.test(source), recovery: /rollback|downgrade/i.test(source),
      testCommand: hasTests ? 'dotnet test' : null, buildCommand: 'dotnet build',
      secretsRequired: signingConfigured ? ['Code-signing certificate and password in CI secrets'] : []
    } }
  }
})
