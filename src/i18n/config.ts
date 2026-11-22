import i18next, { type i18n as I18nInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { DEFAULT_LANGUAGE, FALLBACK_LANGUAGE, isSupportedLanguage } from './languages'

// The fallback language ships in the initial bundle so every missing key
// always resolves to English instead of a raw key.
import enCommon from '../locales/en-US/common.json'
import enNavigation from '../locales/en-US/navigation.json'
import enWorkstation from '../locales/en-US/workstation.json'
import enProjects from '../locales/en-US/projects.json'
import enEnvironment from '../locales/en-US/environment.json'
import enAgent from '../locales/en-US/agent.json'
import enAutomation from '../locales/en-US/automation.json'
import enTasks from '../locales/en-US/tasks.json'
import enGit from '../locales/en-US/git.json'
import enBuild from '../locales/en-US/build.json'
import enRelease from '../locales/en-US/release.json'
import enSettings from '../locales/en-US/settings.json'
import enNotifications from '../locales/en-US/notifications.json'
import enErrors from '../locales/en-US/errors.json'

export const NAMESPACES = [
  'common', 'navigation', 'workstation', 'projects', 'environment', 'agent',
  'automation', 'tasks', 'git', 'build', 'release', 'settings', 'notifications', 'errors'
] as const

export type Namespace = (typeof NAMESPACES)[number]

const eagerResources = {
  'en-US': {
    common: enCommon,
    navigation: enNavigation,
    workstation: enWorkstation,
    projects: enProjects,
    environment: enEnvironment,
    agent: enAgent,
    automation: enAutomation,
    tasks: enTasks,
    git: enGit,
    build: enBuild,
    release: enRelease,
    settings: enSettings,
    notifications: enNotifications,
    errors: enErrors
  }
}

// Every other language is loaded on demand: Vite turns this glob into one
// lazy chunk per language/namespace file, so switching to a language only
// fetches that language's resources the first time. en-US is excluded
// because it ships in the initial bundle as the fallback language.
const lazyLoaders = import.meta.glob<Record<string, unknown>>(['../locales/*/*.json', '!../locales/en-US/**'])

const loadedLanguages = new Set<string>(['en-US'])

function isEagerLanguage(code: string): boolean {
  return code in eagerResources
}

function loaderKey(language: string, namespace: string): string {
  return `../locales/${language}/${namespace}.json`
}

/** Load all namespace files of a language once and register them with i18next. */
export async function ensureLanguageResources(code: string): Promise<void> {
  if (!isSupportedLanguage(code) || loadedLanguages.has(code)) return
  const entries = await Promise.all(
    NAMESPACES.map(async (namespace) => {
      const load = lazyLoaders[loaderKey(code, namespace)]
      if (!load) return [namespace, null] as const
      const module = await load()
      return [namespace, module.default ?? module] as const
    })
  )
  for (const [namespace, resource] of entries) {
    if (resource) i18next.addResourceBundle(code, namespace, resource, true, true)
  }
  loadedLanguages.add(code)
}

export async function initI18n(initialLanguage: string = DEFAULT_LANGUAGE): Promise<I18nInstance> {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      lng: FALLBACK_LANGUAGE,
      fallbackLng: FALLBACK_LANGUAGE,
      supportedLngs: LANGUAGE_CODES_ARRAY,
      nonExplicitSupportedLngs: false,
      defaultNS: 'common',
      ns: NAMESPACES as unknown as string[],
      resources: eagerResources,
      partialBundledLanguages: true,
      returnNull: false,
      returnEmptyString: false,
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
      saveMissing: import.meta.env.DEV,
      missingKeyHandler: (_languages, namespace, key) => {
        // Development guardrail: untranslated keys surface in the console
        // instead of silently rendering the key path.
        console.warn(`[i18n] missing key "${namespace}:${key}"`)
        return ''
      },
      parseMissingKeyHandler: (_key, defaultValue) => defaultValue ?? ''
    })
  }
  const target = isSupportedLanguage(initialLanguage) ? initialLanguage : DEFAULT_LANGUAGE
  await ensureLanguageResources(target)
  if (i18next.language !== target) await i18next.changeLanguage(target)
  return i18next
}

const LANGUAGE_CODES_ARRAY = [
  'zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'pt-BR', 'ru-RU'
]

/** Resolve an interpolation-friendly Intl locale for the active language. */
export function activeLocale(): string {
  return i18next.language || FALLBACK_LANGUAGE
}
