import type { DesktopBridge } from './types'

declare global {
  interface Window { nexusDesktop?: DesktopBridge }
}

export {}
