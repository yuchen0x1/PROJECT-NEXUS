import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Workstation from './desktop/Workstation'
import { SettingsProvider } from './i18n/settings'
import './theme.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      {window.nexusDesktop ? <Workstation /> : <App />}
    </SettingsProvider>
  </StrictMode>
)
