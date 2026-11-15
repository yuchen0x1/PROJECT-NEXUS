import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

/** Keep a renderer exception visible and recoverable instead of showing a blank window. */
export default class RendererErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[PROJECT NEXUS renderer error]', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return <main style={{ minHeight: '100vh', padding: 32, background: '#f5f7fa', color: '#172033', fontFamily: 'Segoe UI, sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>PROJECT NEXUS 遇到界面错误</h1>
      <p>刚才的操作没有成功，后台任务和已保存的数据不会因此被标记为成功。</p>
      <pre style={{ whiteSpace: 'pre-wrap', padding: 16, borderRadius: 8, background: '#fff1f1', color: '#8b1e1e' }}>{this.state.error.message}</pre>
      <button type="button" onClick={() => window.location.reload()} style={{ padding: '9px 14px', borderRadius: 6, border: '1px solid #9aa7b8', background: '#fff', cursor: 'pointer' }}>重新加载工作台</button>
    </main>
  }
}
