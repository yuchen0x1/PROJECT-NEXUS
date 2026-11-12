import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Workstation from './desktop/Workstation'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{window.nexusDesktop ? <Workstation /> : <App />}</StrictMode>
)
