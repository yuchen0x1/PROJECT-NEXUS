import { createRoot } from 'react-dom/client'
import { initI18n } from '../../src/i18n/config'
import AppUpdate from '../../src/desktop/AppUpdate'
import '../../src/theme.css'
import '../../src/desktop/workstation.css'

// Renderer-only fixture. It cannot download an installer or quit an application.
let state = { revision: 0, phase: 'idle', currentVersion: '0.8.0', version: null, percent: 0, errorCode: null, retry: 'check' }
const listeners = new Set()
window.__updateFixture = {
  installs: 0,
  emit(patch) { state = { ...state, ...patch, revision: state.revision + 1 }; for (const listener of listeners) listener({ ...state }) }
}
window.nexusDesktop = {
  getAppUpdate: async () => ({ ...state }),
  onAppUpdate: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  checkAppUpdate: async () => { window.__updateFixture.emit({ phase: 'available', version: '0.8.1', retry: 'update' }); return { ...state } },
  installAppUpdate: async () => { window.__updateFixture.installs++; window.__updateFixture.emit({ phase: 'downloading', percent: 0 }); return { ...state } }
}
await initI18n('zh-CN')
createRoot(document.getElementById('root')!).render(<AppUpdate settings={location.search !== '?global'} />)
