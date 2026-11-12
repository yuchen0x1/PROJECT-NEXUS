import { describe, it, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { initI18n } from '../../src/i18n/config'
import { formatDate, formatTime, formatRelative, formatNumber, formatTokens, formatBytes, formatCurrency, formatStamp } from '../../src/i18n/format'
import i18next from 'i18next'

const SAMPLE = new Date('2026-11-13T09:30:00Z')

async function withLanguage(language, run) {
  await i18next.changeLanguage(language)
  try { await run() } finally { /* language restored by next test */ }
}

describe('formatting service', () => {
  beforeAll(async () => {
    await initI18n('en-US')
  })

  afterAll(async () => {
    await i18next.changeLanguage('en-US')
  })

  it('formats dates per locale (en-US)', async () => {
    await withLanguage('en-US', () => {
      assert.equal(formatDate(SAMPLE), 'Nov 13, 2026')
      assert.equal(formatDate(SAMPLE, 'medium'), 'November 13, 2026')
    })
  })

  it('formats dates per locale (zh-CN, ja-JP, de-DE)', async () => {
    await withLanguage('zh-CN', () => {
      const text = formatDate(SAMPLE)
      assert.ok(text.includes('2026') && text.includes('11') && text.includes('13'), `zh-CN date: ${text}`)
      assert.ok(text.includes('年') && text.includes('月') && text.includes('日'), `zh-CN date: ${text}`)
    })
    await withLanguage('ja-JP', () => {
      const text = formatDate(SAMPLE)
      assert.ok(text.includes('2026'), `ja-JP date: ${text}`)
    })
    await withLanguage('de-DE', () => {
      const text = formatDate(SAMPLE)
      assert.ok(text.includes('2026') && text.includes('13'), `de-DE date: ${text}`)
    })
  })

  it('formats times without seconds', async () => {
    await withLanguage('en-US', () => {
      const text = formatTime(SAMPLE)
      assert.ok(/\d{1,2}:\d{2}/.test(text), `time: ${text}`)
    })
  })

  it('produces relative times for recent instants', async () => {
    await withLanguage('en-US', () => {
      const now = new Date()
      assert.ok(formatRelative(new Date(now.getTime() - 30_000)).includes('second') || formatRelative(new Date(now.getTime() - 30_000)).includes('sec'), `relative: ${formatRelative(new Date(now.getTime() - 30_000))}`)
      const minutes = formatRelative(new Date(now.getTime() - 5 * 60_000))
      assert.ok(minutes.includes('5'), `relative minutes: ${minutes}`)
    })
    await withLanguage('zh-CN', () => {
      const now = new Date()
      assert.ok(formatRelative(new Date(now.getTime() - 5 * 60_000)).includes('分钟'), `zh relative: ${formatRelative(new Date(now.getTime() - 5 * 60_000))}`)
    })
  })

  it('groups digits with locale separators', async () => {
    await withLanguage('en-US', () => assert.equal(formatNumber(1234567), '1,234,567'))
    await withLanguage('de-DE', () => assert.equal(formatNumber(1234567), '1.234.567'))
    await withLanguage('ru-RU', () => {
      const text = formatNumber(1234567)
      assert.ok(text.includes('1') && text.includes('234') && text.includes('567'), `ru number: ${text}`)
    })
    await withLanguage('en-US', () => assert.equal(formatTokens(85), '85'))
  })

  it('formats byte sizes with locale numbers', async () => {
    await withLanguage('en-US', () => {
      assert.equal(formatBytes(512), '512 B')
      assert.equal(formatBytes(2048), '2 KiB')
      assert.equal(formatBytes(1536), '1.5 KiB')
      assert.equal(formatBytes(null), '—')
    })
  })

  it('keeps USD currency with locale separators', async () => {
    await withLanguage('en-US', () => assert.ok(formatCurrency(0.0123).includes('0.0123'), `usd: ${formatCurrency(0.0123)}`))
    await withLanguage('de-DE', () => assert.ok(formatCurrency(12.5).includes('12,5'), `de usd: ${formatCurrency(12.5)}`))
  })

  it('renders an em-dash placeholder for missing values in every locale', async () => {
    for (const language of ['en-US', 'zh-CN', 'de-DE', 'ru-RU']) {
      await withLanguage(language, () => {
        assert.equal(formatDate(null), '—')
        assert.equal(formatTime(undefined), '—')
        assert.equal(formatStamp('not-a-date'), '—')
        assert.equal(formatNumber(Number.NaN), '—')
      })
    }
  })
})
