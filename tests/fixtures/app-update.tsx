import { createRoot } from 'react-dom/client'
import { initI18n } from '../../src/i18n/config'
import AppUpdate from '../../src/desktop/AppUpdate'
import { useTranslation } from 'react-i18next'
import manifest from '../../package.json'
import '../../src/theme.css'
import '../../src/styles.css'
import '../../src/desktop/workstation.css'

// Renderer-only fixture. It cannot download an installer or quit an application.
let state = { revision: 0, phase: 'idle', currentVersion: manifest.version, version: null, percent: 0, errorCode: null, retry: 'check', releaseNotes: '', releaseDate: null }
const listeners = new Set()
window.__updateFixture = {
  installs: 0,
  setLanguage: (language) => initI18n(language),
  emit(patch) { state = { ...state, ...patch, revision: state.revision + 1 }; for (const listener of listeners) listener({ ...state }) }
}
window.nexusDesktop = {
  getAppUpdate: async () => ({ ...state }),
  onAppUpdate: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  checkAppUpdate: async () => { window.__updateFixture.emit({ phase: 'available', version: '0.8.10', retry: 'update', releaseNotes: '修复布局并增加更新日志。', releaseDate: '2026-11-13T12:00:00Z' }); return { ...state } },
  installAppUpdate: async () => { window.__updateFixture.installs++; window.__updateFixture.emit({ phase: 'downloading', percent: 0 }); return { ...state } }
}
await initI18n('zh-CN')
const settings = !new URLSearchParams(location.search).has('global')
function UpdateShellFixture() {
  const { t } = useTranslation()
  return <div className="nx-shell">
    <aside className="nx-rail"><div className="nx-brand"><div><strong>NEXUS</strong><span>Windows</span></div></div></aside>
    <div className="nx-main-column">
      <header className="nx-topbar"><div className="nx-location"><strong>{t('settings:page.title')}</strong></div></header>
      <div className="nx-app-update-slot"><AppUpdate settings={settings} /></div>
      <div className="nx-content-grid"><main className="nx-workarea">
        <div className="nx-page-heading"><div><p className="nx-overline">NEXUS</p><h1>{t('settings:page.title')}</h1><p className="nx-subtitle">{t('settings:page.subtitle')}</p></div></div>
        <div className="nx-settings-page">{['appearance', 'agent', 'startup', 'about'].map((section) => <section className="nx-settings-section" key={section}><div className="nx-settings-section-head"><h2>{t(`settings:sections.${section}`)}</h2></div>{[0, 1, 2].map((row) => <div className="nx-setting-block" key={row}><div className="nx-setting-copy"><strong>{t('settings:appearance.languageLabel')}</strong><span>{t('settings:appearance.languageHint')}</span></div></div>)}</section>)}</div>
      </main></div>
      {!settings && <footer className="nx-log-drawer"><button className="nx-log-trigger">NEXUS</button></footer>}
    </div>
  </div>
}
createRoot(document.getElementById('root')!).render(<UpdateShellFixture />)
