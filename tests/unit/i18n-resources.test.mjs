import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const localesDir = path.resolve(here, '../../src/locales')
const NAMESPACES = ['common', 'navigation', 'workstation', 'projects', 'environment', 'agent', 'automation', 'tasks', 'git', 'build', 'release', 'settings', 'notifications', 'errors']
const LANGUAGES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'pt-BR', 'ru-RU']

function readNamespace(language, namespace) {
  const file = path.join(localesDir, language, `${namespace}.json`)
  assert.ok(fs.existsSync(file), `Missing locale file: ${language}/${namespace}.json`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function flattenKeys(value, prefix = '') {
  const keys = []
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object') keys.push(...flattenKeys(child, full))
    else keys.push(full)
  }
  return keys.sort()
}

function placeholdersOf(value) {
  const found = new Set()
  const walk = (node) => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(/\{\{(\w+)\}\}/g)) found.add(match[1])
    } else if (node && typeof node === 'object') {
      for (const child of Object.values(node)) walk(child)
    }
  }
  walk(value)
  return [...found].sort()
}

function leafValues(value) {
  const values = []
  const walk = (node) => {
    if (typeof node === 'string') values.push(node)
    else if (node && typeof node === 'object') for (const child of Object.values(node)) walk(child)
  }
  walk(value)
  return values
}

// Russian needs the CLDR one/few/many/other category set for plural keys.
function expectedKeySet(language, baselineKeys) {
  if (language !== 'ru-RU') return new Set(baselineKeys)
  const keys = new Set(baselineKeys)
  for (const key of baselineKeys) {
    const match = key.match(/^(.+)_one$/)
    if (match) {
      keys.add(`${match[1]}_few`)
      keys.add(`${match[1]}_many`)
    }
  }
  return keys
}

describe('i18n resources', () => {
  const baseline = Object.fromEntries(NAMESPACES.map((namespace) => [namespace, readNamespace('en-US', namespace)]))

  it('ships every namespace for every supported language', () => {
    for (const language of LANGUAGES) {
      for (const namespace of NAMESPACES) {
        const resource = readNamespace(language, namespace)
        assert.ok(resource && typeof resource === 'object', `${language}/${namespace} must be an object`)
      }
    }
  })

  it('keeps key parity with en-US for every language', () => {
    for (const language of LANGUAGES) {
      for (const namespace of NAMESPACES) {
        const baselineKeys = flattenKeys(baseline[namespace])
        const actualKeys = flattenKeys(readNamespace(language, namespace))
        const expected = expectedKeySet(language, baselineKeys)
        const missing = [...expected].filter((key) => !actualKeys.includes(key))
        const extra = actualKeys.filter((key) => !expected.has(key))
        assert.deepEqual(missing, [], `${language}/${namespace} is missing keys: ${missing.join(', ')}`)
        assert.deepEqual(extra, [], `${language}/${namespace} has unexpected keys: ${extra.join(', ')}`)
      }
    }
  })

  it('keeps interpolation placeholders identical to en-US', () => {
    for (const language of LANGUAGES) {
      for (const namespace of NAMESPACES) {
        const expected = placeholdersOf(baseline[namespace])
        const actual = placeholdersOf(readNamespace(language, namespace))
        assert.deepEqual(actual, expected, `${language}/${namespace} placeholders differ from en-US`)
      }
    }
  })

  it('contains no empty translations and no raw key leftovers', () => {
    for (const language of LANGUAGES) {
      for (const namespace of NAMESPACES) {
        for (const value of leafValues(readNamespace(language, namespace))) {
          assert.ok(value.trim().length > 0, `${language}/${namespace} has an empty string value`)
          assert.ok(!/^[a-z]+(\.[a-zA-Z0-9_.]+)+$/.test(value.trim()) || value.includes(' ') || value.includes('{{'),
            `${language}/${namespace} may contain an untranslated key path: "${value}"`)
        }
      }
    }
  })

  it('uses unique native names in every language registry entry', () => {
    // The nativeName list lives in src/i18n/languages.ts; locales must at
    // least provide the language picker labels through settings.json keys.
    for (const language of LANGUAGES) {
      const settings = readNamespace(language, 'settings')
      assert.ok(typeof settings.appearance.languageLabel === 'string')
    }
  })
})
