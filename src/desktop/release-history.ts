import { useTranslation } from 'react-i18next'
import type { AppUpdateState } from './types'

const bundledVersions = ['0.8.4', '0.8.3', '0.8.2', '0.8.0', '0.7.0', '0.3.0', '0.2.1', '0.1.0']
type ReleaseEntry = { version: string; date: string | null; title: string; notes: string }

// The production update channel accepts stable versions only. Compare numeric
// components so 0.10.0 and 0.8.10 sort ahead of 0.8.3.
export function useReleaseHistory(state: AppUpdateState | null): ReleaseEntry[] {
  const { t } = useTranslation()
  const entries = new Map<string, ReleaseEntry>(bundledVersions.map((version) => {
    const key = `settings:appUpdate.history.releases.v${version.replaceAll('.', '_')}`
    return [version, { version, date: '2026-11-13', title: t(`${key}.title`), notes: t(`${key}.summary`) }]
  }))
  for (const version of [state?.currentVersion, state?.version]) {
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) continue
    const known = entries.get(version)
    entries.set(version, {
      version,
      date: version === state?.version ? state.releaseDate?.slice(0, 10) || known?.date || null : known?.date || null,
      title: known?.title || t('settings:appUpdate.title'),
      notes: (version === state?.version ? state.releaseNotes : '') || known?.notes || t('settings:appUpdate.history.missingNotes')
    })
  }
  return [...entries.values()].sort((a, b) => {
    const left = a.version.split('.').map(Number), right = b.version.split('.').map(Number)
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2]
  })
}
