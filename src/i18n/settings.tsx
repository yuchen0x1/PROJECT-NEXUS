import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { ensureLanguageResources, initI18n } from './config'
import { DEFAULT_LANGUAGE, isSupportedLanguage, resolveLanguage } from './languages'
import type { AgentReplyLanguageMode, OnboardingStage, ThemePreference, UserPreferences } from '../desktop/types'

const STORAGE_KEY = 'nexus.user-preferences'

export const DEFAULT_PREFERENCES: UserPreferences = {
  language: null,
  theme: 'dark',
  reduceMotion: false,
  agentReplyLanguage: 'ui',
  onboardingStage: 'setup'
}

const browserBridge = () => (typeof window !== 'undefined' ? window.nexusDesktop : undefined)

function readLocalPreferences(): { preferences: Partial<UserPreferences> } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? { preferences: JSON.parse(raw) } : { preferences: {} }
  } catch {
    return { preferences: {} }
  }
}

function writeLocalPreferences(preferences: UserPreferences): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)) } catch { /* storage may be unavailable */ }
}

function sanitizePreferences(input: unknown): UserPreferences {
  const source = (input && typeof input === 'object' ? input : {}) as Partial<UserPreferences>
  const theme: ThemePreference = ['dark', 'light', 'system'].includes(source.theme as ThemePreference) ? source.theme as ThemePreference : 'dark'
  const agentReplyLanguage: AgentReplyLanguageMode =
    source.agentReplyLanguage === 'ui' || source.agentReplyLanguage === 'input' || isSupportedLanguage(source.agentReplyLanguage)
      ? source.agentReplyLanguage
      : 'ui'
  return {
    language: isSupportedLanguage(source.language) ? source.language : null,
    theme,
    reduceMotion: typeof source.reduceMotion === 'boolean' ? source.reduceMotion : false,
    agentReplyLanguage,
    onboardingStage: source.onboardingStage === 'tour' || source.onboardingStage === 'complete' ? source.onboardingStage : 'setup'
  }
}

export function resolveStartupLanguage(saved: string | null | undefined, systemLocale: string | null | undefined): string {
  if (isSupportedLanguage(saved)) return saved
  // First launch (or corrupted value): follow Windows, fall back to English.
  return resolveLanguage(systemLocale)
}

const systemDarkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

type SettingsContextValue = {
  preferences: UserPreferences
  /** Resolved theme after applying `system` against the OS setting. */
  resolvedTheme: 'dark' | 'light'
  systemLocale: string
  ready: boolean
  setLanguage: (code: string) => Promise<void>
  setTheme: (theme: ThemePreference) => Promise<void>
  setReduceMotion: (value: boolean) => Promise<void>
  setAgentReplyLanguage: (value: AgentReplyLanguageMode) => Promise<void>
  setOnboardingStage: (stage: OnboardingStage) => Promise<void>
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('useSettings must be used inside <SettingsProvider>.')
  return value
}

function applyDocumentTheme(resolved: 'dark' | 'light', preference: ThemePreference, reduceMotion: boolean, language: string) {
  const root = document.documentElement
  root.dataset.theme = resolved
  root.dataset.themePreference = preference
  root.dataset.motion = reduceMotion ? 'reduced' : 'full'
  root.style.colorScheme = resolved
  root.lang = language
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<UserPreferences | null>(null)
  const [systemLocale, setSystemLocale] = useState<string>('')
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>('dark')
  const [ready, setReady] = useState(false)
  const systemDark = useRef<MediaQueryList | null>(null)
  const preferencesRef = useRef<UserPreferences>(DEFAULT_PREFERENCES)
  preferencesRef.current = preferences ?? DEFAULT_PREFERENCES

  // Bootstrap: load persisted preferences, initialize i18next with the
  // startup language, then render the application.
  useEffect(() => {
    let active = true
    void (async () => {
      const bridge = browserBridge()
      let stored: Partial<UserPreferences> = {}
      let locale = ''
      if (bridge) {
        const payload = await bridge.getSettings().catch(() => null)
        if (payload) {
          stored = payload.preferences || {}
          locale = payload.systemLocale || ''
        }
      } else {
        stored = readLocalPreferences().preferences
        locale = typeof navigator !== 'undefined' ? navigator.language : ''
      }
      if (!active) return
      const sanitized = sanitizePreferences(stored)
      const language = resolveStartupLanguage(sanitized.language, locale)
      setSystemLocale(locale)
      await initI18n(language)
      if (!active) return
      const next: UserPreferences = { ...sanitized, language }
      setPreferences(next)
      setReady(true)
    })()
    return () => { active = false }
  }, [])

  const theme = preferences?.theme ?? 'dark'
  const reduceMotion = preferences?.reduceMotion ?? false
  const language = preferences?.language ?? DEFAULT_LANGUAGE

  // Apply theme attributes whenever theme/motion/language change.
  useEffect(() => {
    if (!preferences) return
    const media = systemDark.current ?? systemDarkQuery()
    systemDark.current = media
    const compute = (): 'dark' | 'light' => (theme === 'system' ? (media.matches ? 'dark' : 'light') : theme)
    const resolved = compute()
    setResolvedTheme(resolved)
    applyDocumentTheme(resolved, theme, reduceMotion, language)
    if (theme !== 'system') return
    const listener = () => {
      const next = compute()
      setResolvedTheme(next)
      applyDocumentTheme(next, theme, reduceMotion, language)
    }
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [preferences, theme, reduceMotion, language])

  const persist = useCallback(async (partial: Partial<UserPreferences> & { language?: string | null }) => {
    const bridge = browserBridge()
    if (bridge) {
      const saved = await bridge.updateSettings(partial)
      return sanitizePreferences(saved)
    }
    const merged = sanitizePreferences({ ...preferencesRef.current, ...partial })
    writeLocalPreferences(merged)
    return merged
  }, [])

  const setLanguage = useCallback(async (code: string) => {
    if (!isSupportedLanguage(code)) return
    await ensureLanguageResources(code)
    await i18next.changeLanguage(code)
    const merged = await persist({ language: code })
    setPreferences((value) => ({ ...(value ?? DEFAULT_PREFERENCES), ...merged, language: code }))
  }, [persist])

  const setTheme = useCallback(async (next: ThemePreference) => {
    const merged = await persist({ theme: next })
    setPreferences((value) => ({ ...(value ?? DEFAULT_PREFERENCES), ...merged }))
  }, [persist])

  const setReduceMotion = useCallback(async (value: boolean) => {
    const merged = await persist({ reduceMotion: value })
    setPreferences((next) => ({ ...(next ?? DEFAULT_PREFERENCES), ...merged }))
  }, [persist])

  const setAgentReplyLanguage = useCallback(async (value: AgentReplyLanguageMode) => {
    const merged = await persist({ agentReplyLanguage: value })
    setPreferences((next) => ({ ...(next ?? DEFAULT_PREFERENCES), ...merged }))
  }, [persist])

  const setOnboardingStage = useCallback(async (stage: OnboardingStage) => {
    const merged = await persist({ onboardingStage: stage })
    setPreferences((next) => ({ ...(next ?? DEFAULT_PREFERENCES), ...merged }))
  }, [persist])

  const value = useMemo<SettingsContextValue | null>(() => preferences ? {
    preferences,
    resolvedTheme,
    systemLocale,
    ready,
    setLanguage,
    setTheme,
    setReduceMotion,
    setAgentReplyLanguage,
    setOnboardingStage
  } : null, [preferences, resolvedTheme, systemLocale, ready, setLanguage, setTheme, setReduceMotion, setAgentReplyLanguage, setOnboardingStage])

  if (!value) return null
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

/** Convenience hook for components that only need the current language code. */
export function useCurrentLanguage(): string {
  const { i18n } = useTranslation()
  return i18n.language || DEFAULT_LANGUAGE
}
