import { activeLocale } from './config'

// Central formatting service. Business components must not build their own
// date/number strings; everything goes through these helpers so each UI
// language gets correct regional formats.

export type DateStyle = 'short' | 'medium' | 'long'

const formatterCache = new Map<string, unknown>()

function getCached<T>(kind: string, signature: string, factory: () => T): T {
  const key = `${activeLocale()}:${kind}:${signature}`
  if (!formatterCache.has(key)) formatterCache.set(key, factory())
  return formatterCache.get(key) as T
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { year: 'numeric', month: 'short', day: 'numeric' },
  medium: { year: 'numeric', month: 'long', day: 'numeric' },
  long: { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }
}

/** "Nov 13, 2026" / "2026年11月13日" / "13. Nov. 2026" */
export function formatDate(value: string | number | Date | null | undefined, style: DateStyle = 'short'): string {
  const date = toDate(value)
  if (!date) return '—'
  return getCached('date', style, () => new Intl.DateTimeFormat(activeLocale(), DATE_OPTIONS[style])).format(date)
}

/** Locale time without seconds, e.g. "14:32" / "下午2:32". */
export function formatTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value)
  if (!date) return '—'
  return getCached('time', 'hm', () => new Intl.DateTimeFormat(activeLocale(), { hour: '2-digit', minute: '2-digit' })).format(date)
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value)
  if (!date) return '—'
  return `${formatDate(date)} ${formatTime(date)}`
}

/** "3 minutes ago" / "3分钟前" via Intl.RelativeTimeFormat. */
export function formatRelative(value: string | number | Date | null | undefined): string {
  const date = toDate(value)
  if (!date) return '—'
  const relative = getCached('relative', 'auto', () => new Intl.RelativeTimeFormat(activeLocale(), { numeric: 'auto' }))
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000)
  const absolute = Math.abs(diffSeconds)
  if (absolute < 45) return relative.format(Math.round(diffSeconds), 'second')
  if (absolute < 2700) return relative.format(Math.round(diffSeconds / 60), 'minute')
  if (absolute < 64_800) return relative.format(Math.round(diffSeconds / 3600), 'hour')
  if (absolute < 2_592_000) return relative.format(Math.round(diffSeconds / 86_400), 'day')
  if (absolute < 31_536_000) return relative.format(Math.round(diffSeconds / 2_592_000), 'month')
  return relative.format(Math.round(diffSeconds / 31_536_000), 'year')
}

/** Short date plus time used for feed rows. */
export function formatStamp(value: string | number | Date | null | undefined): string {
  const date = toDate(value)
  if (!date) return '—'
  return `${formatDate(date)} ${formatTime(date)}`
}

export function formatNumber(value: number | null | undefined, options?: Intl.NumberFormatOptions): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return getCached('number', JSON.stringify(options ?? {}), () => new Intl.NumberFormat(activeLocale(), options)).format(value)
}

/** Decimal token counts with locale separators, e.g. "1 234" / "1,234". */
export function formatTokens(value: number | null | undefined): string {
  return formatNumber(value)
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${formatNumber(bytes)} ${BYTE_UNITS[0]}`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit += 1 }
  return `${formatNumber(value, { maximumFractionDigits: 1 })} ${BYTE_UNITS[unit]}`
}

/** Money is stored in USD; the currency stays USD while separators follow the locale. */
export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return getCached('currency', 'usd', () => new Intl.NumberFormat(activeLocale(), {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4
  })).format(value)
}

export function formatPercent(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return getCached('percent', String(fractionDigits), () => new Intl.NumberFormat(activeLocale(), { style: 'percent', maximumFractionDigits: fractionDigits })).format(value / 100)
}
