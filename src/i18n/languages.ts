// Registry of languages shipped with PROJECT NEXUS.
// `code` is a valid BCP 47 tag and is used directly with Intl.* APIs.
// `nativeName` is always written in that language so users can find it
// without knowing the current UI language.
export type LanguageDefinition = {
  code: string
  nativeName: string
  englishName: string
  /** Translation completeness reviewed for this release. */
  coverage: 'complete' | 'review'
}

export const LANGUAGES: readonly LanguageDefinition[] = Object.freeze([
  { code: 'zh-CN', nativeName: '简体中文', englishName: 'Simplified Chinese', coverage: 'complete' },
  { code: 'zh-TW', nativeName: '繁體中文', englishName: 'Traditional Chinese', coverage: 'complete' },
  { code: 'en-US', nativeName: 'English', englishName: 'English (United States)', coverage: 'complete' },
  { code: 'ja-JP', nativeName: '日本語', englishName: 'Japanese', coverage: 'complete' },
  { code: 'ko-KR', nativeName: '한국어', englishName: 'Korean', coverage: 'complete' },
  { code: 'fr-FR', nativeName: 'Français', englishName: 'French', coverage: 'complete' },
  { code: 'de-DE', nativeName: 'Deutsch', englishName: 'German', coverage: 'complete' },
  { code: 'es-ES', nativeName: 'Español', englishName: 'Spanish', coverage: 'complete' },
  { code: 'pt-BR', nativeName: 'Português (Brasil)', englishName: 'Portuguese (Brazil)', coverage: 'complete' },
  { code: 'ru-RU', nativeName: 'Русский', englishName: 'Russian', coverage: 'complete' }
])

export const DEFAULT_LANGUAGE = 'en-US'
export const FALLBACK_LANGUAGE = 'en-US'

export const LANGUAGE_CODES = LANGUAGES.map((language) => language.code)

export function isSupportedLanguage(code: unknown): code is string {
  return typeof code === 'string' && LANGUAGE_CODES.includes(code)
}

const BASE_LANGUAGE_MAP: Record<string, string> = {}
for (const language of LANGUAGES) BASE_LANGUAGE_MAP[language.code.split('-')[0]] = language.code
Object.freeze(BASE_LANGUAGE_MAP)

// Windows may report close variants (zh-Hans-CN, pt-PT, nb-NO …). Map the
// common ones onto a shipped language instead of falling straight back to en-US.
const VARIANT_LANGUAGE_MAP: Record<string, string> = {
  'zh-hans': 'zh-CN',
  'zh-hant': 'zh-TW',
  'zh-hk': 'zh-TW',
  'zh-mo': 'zh-TW',
  'pt-pt': 'pt-BR'
}

/**
 * Resolve a raw locale tag (for example from Electron `app.getLocale()`)
 * onto one of the supported language codes, or the fallback language.
 * Pure function so it can be unit tested.
 */
export function resolveLanguage(rawLocale: string | null | undefined): string {
  if (!rawLocale) return FALLBACK_LANGUAGE
  const normalized = String(rawLocale).trim().toLowerCase().replace(/_/g, '-')
  if (!normalized) return FALLBACK_LANGUAGE
  if (LANGUAGE_CODES.includes(normalized)) return normalized
  if (Object.prototype.hasOwnProperty.call(VARIANT_LANGUAGE_MAP, normalized)) return VARIANT_LANGUAGE_MAP[normalized]
  const parts = normalized.split('-')
  // Script subtags decide between Simplified and Traditional Chinese
  // regardless of the region that follows (zh-Hant-MO → zh-TW).
  if (parts.includes('hans')) return 'zh-CN'
  if (parts.includes('hant')) return 'zh-TW'
  const [language, region] = parts
  if (region) {
    const candidate = `${language}-${region.toUpperCase()}`
    if (LANGUAGE_CODES.includes(candidate)) return candidate
  }
  if (Object.prototype.hasOwnProperty.call(VARIANT_LANGUAGE_MAP, language)) return VARIANT_LANGUAGE_MAP[language]
  if (Object.prototype.hasOwnProperty.call(BASE_LANGUAGE_MAP, language)) return BASE_LANGUAGE_MAP[language]
  return FALLBACK_LANGUAGE
}
