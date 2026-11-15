import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Workstation from './desktop/Workstation'
import RendererErrorBoundary from './desktop/RendererErrorBoundary'
import { SettingsProvider } from './i18n/settings'
import { RepositorySyncCoordinator } from './repository-sync'
import './theme.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RendererErrorBoundary>
      <SettingsProvider>
        <RepositorySyncCoordinator>{window.nexusDesktop ? <Workstation /> : <App />}</RepositorySyncCoordinator>
      </SettingsProvider>
    </RendererErrorBoundary>
  </StrictMode>
)
