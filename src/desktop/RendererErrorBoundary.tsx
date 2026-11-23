import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

// Strings are inline rather than loaded from i18n on purpose: this boundary
// must still render when the i18n stack itself is what crashed. Both shipped
// UI languages are provided and the current document language picks one.
const COPY = {
  zh: { heading: 'PROJECT NEXUS 遇到界面错误', detail: '刚才的操作没有成功，后台任务和已保存的数据不会因此被标记为成功。', reload: '重新加载工作台' },
  en: { heading: 'PROJECT NEXUS hit a UI error', detail: 'The last action did not complete. Background tasks and saved data are not marked as successful because of this.', reload: 'Reload workbench' }
}

/** Keep a renderer exception visible and recoverable instead of showing a blank window. */
export default class RendererErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[PROJECT NEXUS renderer error]', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    const language = typeof document !== 'undefined' && document.documentElement.lang?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    const copy = COPY[language]
    return <main style={{ minHeight: '100vh', padding: 32, background: 'var(--bg, #f5f7fa)', color: 'var(--text, #172033)', fontFamily: 'Segoe UI, sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>{copy.heading}</h1>
      <p>{copy.detail}</p>
      <pre style={{ whiteSpace: 'pre-wrap', padding: 16, borderRadius: 8, background: 'var(--nx-danger-soft, #fff1f1)', color: 'var(--danger, #8b1e1e)' }}>{this.state.error.message}</pre>
      <button type="button" onClick={() => window.location.reload()} style={{ padding: '9px 14px', borderRadius: 6, border: '1px solid var(--line, #9aa7b8)', background: 'var(--panel, #fff)', color: 'inherit', cursor: 'pointer' }}>{copy.reload}</button>
    </main>
  }
}
