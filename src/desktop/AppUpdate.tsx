import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, RefreshCw, X } from 'lucide-react'
import type { AppUpdateState } from './types'
import './app-update.css'

export default function AppUpdate({ settings }: { settings: boolean }) {
  const { t } = useTranslation()
  const [state, setState] = useState<AppUpdateState | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [bridgeError, setBridgeError] = useState(false)
  useEffect(() => {
    const bridge = window.nexusDesktop!
    let mounted = true
    const accept = (next: AppUpdateState) => {
      if (mounted) { setState((old) => !old || next.revision >= old.revision ? next : old); setBridgeError(false) }
    }
    const unsubscribe = bridge.onAppUpdate(accept)
    void bridge.getAppUpdate().then(accept).catch(() => { if (mounted) setBridgeError(true) })
    return () => { mounted = false; unsubscribe() }
  }, [])

  const phase = state?.phase ?? 'idle'
  const busy = ['checking', 'downloading', 'installing'].includes(phase)
  const offered = ['available', 'downloaded'].includes(phase) || (phase === 'error' && state?.retry === 'update')
  const visible = settings || ['downloading', 'installing', 'downloaded', 'error'].includes(phase) || (phase === 'available' && dismissed !== state?.version)
  if (!visible) return null
  const action = async () => {
    setBridgeError(false)
    try {
      const bridge = window.nexusDesktop!
      const next = await (offered ? bridge.installAppUpdate() : bridge.checkAppUpdate())
      setState((old) => !old || next.revision >= old.revision ? next : old)
    } catch { setBridgeError(true) }
  }
  return <section className="nx-app-update" aria-label={t('settings:appUpdate.title')} data-testid="app-update">
    <Download size={18} aria-hidden="true" />
    <div className="nx-app-update-copy">
      <strong>{t('settings:appUpdate.title')}{state?.currentVersion ? ` · v${state.currentVersion}` : ''}</strong>
      <p role="status" aria-live="polite">{bridgeError ? t('settings:appUpdate.errors.bridge') : t(`settings:appUpdate.states.${phase}`, { version: state?.version, percent: Math.round(state?.percent || 0) })}</p>
      {phase === 'error' && <p role="alert">{t(`settings:appUpdate.errors.${state?.errorCode || 'check'}`)}</p>}
      {(offered || ['downloading', 'installing'].includes(phase)) && <small>{t('settings:appUpdate.restartHint')}</small>}
      {phase === 'downloading' && <progress max={100} value={state?.percent || 0} aria-label={t('settings:appUpdate.progress')} />}
    </div>
    <button className={offered ? 'nx-primary' : 'nx-secondary'} disabled={busy || phase === 'disabled' || !state} onClick={() => void action()}>
      {busy && <RefreshCw size={14} aria-hidden="true" />}{t(`settings:appUpdate.${busy ? 'working' : offered ? 'updateNow' : 'check'}`)}
    </button>
    {!settings && phase === 'available' && <button className="nx-icon-button" aria-label={t('settings:appUpdate.later')} title={t('settings:appUpdate.later')} onClick={() => setDismissed(state?.version || '')}><X size={16} /></button>}
  </section>
}
