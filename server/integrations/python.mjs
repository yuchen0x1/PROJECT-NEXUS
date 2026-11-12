import { createAdapter } from './base.mjs'

export const pythonAdapter = createAdapter({
  id: 'python', name: 'Python desktop',
  detect: (files) => files.some((file) => /(^|\/)(pyproject\.toml|requirements\.txt|setup\.py)$/.test(file.path)),
  inspect: (files) => {
    const packaging = files.filter((file) => /pyproject\.toml$|requirements\.txt$|setup\.py$/.test(file.path))
    const source = files.filter((file) => /\.(py|toml|ya?ml|json)$/.test(file.path)).map((file) => file.content || '').join('\n')
    const desktop = /PySide|PyQt|tkinter|wxPython|kivy|PyInstaller|Nuitka/i.test(source)
    const updaterCode = /update manifest|self.?update|auto.?update|update_checker/i.test(source)
    const workflow = files.some((file) => file.path.startsWith('.github/workflows/') && /PyInstaller|Nuitka|pyinstaller|nuitka/i.test(file.content || ''))
    const manifest = files.filter((file) => /update(?:r)?\.(json|ya?ml)$|manifest\.json$/.test(file.path))
    const signingConfigured = /ed25519|signature|public.?key|sigstore/i.test(source)
    const pyproject = files.find((file) => file.path.endsWith('pyproject.toml'))?.content || ''
    const hasTests = files.some((file) => /(^|\/)(tests?\/|test_[^/]+\.py$|[^/]+_test\.py$)/i.test(file.path))
    return { appRoot: packaging[0]?.path.replace(/(pyproject\.toml|requirements\.txt|setup\.py)$/, '') || '', framework: desktop ? 'python-desktop' : 'python-library-or-service', supported: desktop, evidence: {
      packaging: packaging.map((file) => file.path), updaterCode,
      versionDetection: /^version\s*=\s*["']/m.test(pyproject), downloadInstall: updaterCode,
      workflow, manifest: manifest.map((file) => file.path), signingConfigured,
      signatureCryptographicallyVerified: false, digestConfigured: manifest.length > 0,
      updateSourceHttps: /https:\/\//i.test(source), recovery: /rollback|downgrade/i.test(source),
      testCommand: hasTests ? 'pytest -q' : null, buildCommand: 'python -m compileall -q .',
      secretsRequired: signingConfigured ? ['Updater signing key stored in CI secret manager'] : []
    } }
  }
})
