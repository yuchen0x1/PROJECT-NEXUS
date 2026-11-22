import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2 } from 'lucide-react'
import type { ProviderModelsResult } from './types'

export default function ProviderModelPicker({ kind, baseUrl, apiKey, providerId, value, onChange, disabled }: {
  kind: string; baseUrl: string; apiKey: string; providerId?: string
  value: string; onChange: (model: string) => void; disabled: boolean
}) {
  const { t } = useTranslation()
  const id = useId()
  const [result, setResult] = useState<ProviderModelsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const revision = useRef(0)
  const requestRunning = useRef(false)
  const selection = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    revision.current++
    setResult(null)
    setLoading(false)
    requestRunning.current = false
    return () => { revision.current++ }
  }, [kind, baseUrl, apiKey, providerId])
  useLayoutEffect(() => {
    if (!result?.ok || !result.models.length) return
    // Wait until React has mounted the select. A pre-commit animation frame
    // can run before the ref exists when a packaged window is busy.
    selection.current?.scrollIntoView({ block: 'center' })
    selection.current?.focus({ preventScroll: true })
  }, [result])

  const fetchModels = async () => {
    if (requestRunning.current) return
    requestRunning.current = true
    const current = ++revision.current
    setLoading(true); setResult(null)
    let response: ProviderModelsResult
    try {
      response = window.nexusDesktop?.fetchProviderModels
        ? await window.nexusDesktop.fetchProviderModels({ kind, baseUrl, apiKey, providerId })
        : { ok: false, models: [], truncated: false, errorCode: 'desktop-required' }
    } catch { response = { ok: false, models: [], truncated: false, errorCode: 'network-error' } }
    if (current !== revision.current) return
    requestRunning.current = false
    setLoading(false); setResult(response)
  }
  const knownErrors = ['invalid-kind', 'invalid-url', 'invalid-key', 'key-required', 'key-unavailable', 'unsupported', 'unauthorized', 'rate-limit', 'http-error', 'response-too-large', 'invalid-response', 'timeout', 'network-error', 'desktop-required']
  const errorCode = knownErrors.includes(result?.errorCode || '') ? result?.errorCode : 'network-error'
  return <div className="nx-model-picker">
    <label htmlFor={id}>{t('agent:providers.form.model')}</label>
    <div className="nx-model-picker-row">
      <input id={id} disabled={disabled} value={value} maxLength={200} autoComplete="off" aria-describedby={`${id}-status`} onChange={(event) => onChange(event.target.value)} />
      <button type="button" className="nx-secondary nx-model-fetch" disabled={disabled || loading || !baseUrl.trim()} onClick={() => void fetchModels()}>
        {loading ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}{t(loading ? 'agent:providers.discovery.loading' : 'agent:providers.discovery.fetch')}
      </button>
    </div>
    {result?.ok && result.models.length > 0 && <select ref={selection} className="nx-model-select" aria-label={t('agent:providers.discovery.select')} disabled={disabled} value={result.models.some((item) => item.id === value) ? value : ''} onChange={(event) => { if (event.target.value) onChange(event.target.value) }}>
      <option value="" disabled>{t('agent:providers.discovery.select')}</option>
      {result.models.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
    </select>}
    <div id={`${id}-status`} className={`nx-model-status${result && !result.ok ? ' nx-model-error' : ''}`} role="status" aria-live="polite">
      {loading ? t('agent:providers.discovery.loading') : result ? result.ok ? result.models.length ? <>{t('agent:providers.discovery.loaded', { total: result.models.length })}{result.truncated && ` ${t('agent:providers.discovery.truncated')}`}</> : t('agent:providers.discovery.empty') : t(`agent:providers.discovery.errors.${errorCode}`) : t('agent:providers.discovery.hint')}
    </div>
  </div>
}
