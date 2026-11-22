import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { resolveLanguage } from '../../src/i18n/languages'

describe('startup language detection', () => {
  it('maps Windows locale tags onto supported languages', () => {
    assert.equal(resolveLanguage('zh-CN'), 'zh-CN')
    assert.equal(resolveLanguage('zh-TW'), 'zh-TW')
    assert.equal(resolveLanguage('en-US'), 'en-US')
    assert.equal(resolveLanguage('ja-JP'), 'ja-JP')
    assert.equal(resolveLanguage('ko-KR'), 'ko-KR')
    assert.equal(resolveLanguage('fr-FR'), 'fr-FR')
    assert.equal(resolveLanguage('de-DE'), 'de-DE')
    assert.equal(resolveLanguage('es-ES'), 'es-ES')
    assert.equal(resolveLanguage('pt-BR'), 'pt-BR')
    assert.equal(resolveLanguage('ru-RU'), 'ru-RU')
  })

  it('resolves language-only and variant tags', () => {
    assert.equal(resolveLanguage('de'), 'de-DE')
    assert.equal(resolveLanguage('fr'), 'fr-FR')
    assert.equal(resolveLanguage('ru'), 'ru-RU')
    assert.equal(resolveLanguage('zh-Hans-CN'), 'zh-CN')
    assert.equal(resolveLanguage('zh_Hant'), 'zh-TW')
    assert.equal(resolveLanguage('zh-HK'), 'zh-TW')
    assert.equal(resolveLanguage('en-GB'), 'en-US')
    assert.equal(resolveLanguage('es-MX'), 'es-ES')
    assert.equal(resolveLanguage('pt-PT'), 'pt-BR')
    assert.equal(resolveLanguage('de-AT'), 'de-DE')
  })

  it('falls back to English for unsupported or malformed locales', () => {
    assert.equal(resolveLanguage('xx-YY'), 'en-US')
    assert.equal(resolveLanguage(''), 'en-US')
    assert.equal(resolveLanguage(null), 'en-US')
    assert.equal(resolveLanguage(undefined), 'en-US')
    assert.equal(resolveLanguage('   '), 'en-US')
  })
})
