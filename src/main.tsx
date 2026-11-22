import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import RendererErrorBoundary from './desktop/RendererErrorBoundary'
import { SettingsProvider } from './i18n/settings'
import { RepositorySyncCoordinator } from './repository-sync'
import './theme.css'
import './styles.css'

// Keep the first paint small. The web console and the Electron workstation
// share infrastructure but are mutually exclusive at runtime, so loading
// both statically made every launch pay for the other surface's code.
const App = lazy(() => import('./App'))
const Workstation = lazy(() => import('./desktop/Workstation'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RendererErrorBoundary>
      <SettingsProvider>
        <RepositorySyncCoordinator>
          <Suspense fallback={<div className="app-loading" role="status">Loading PROJECT NEXUS…</div>}>
            {window.nexusDesktop ? <Workstation /> : <App />}
          </Suspense>
        </RepositorySyncCoordinator>
      </SettingsProvider>
    </RendererErrorBoundary>
  </StrictMode>
)
