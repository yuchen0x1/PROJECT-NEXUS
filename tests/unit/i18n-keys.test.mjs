import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const localesDir = path.join(root, 'src', 'locales')
const NAMESPACES = ['common', 'navigation', 'workstation', 'projects', 'environment', 'agent', 'automation', 'tasks', 'git', 'build', 'release', 'settings', 'notifications', 'errors']

function loadNamespace(namespace) {
  return JSON.parse(fs.readFileSync(path.join(localesDir, 'en-US', `${namespace}.json`), 'utf8'))
}

function hasKey(resource, dottedKey) {
  let node = resource
  for (const part of dottedKey.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false
    node = node[part]
  }
  return typeof node === 'string'
}

function* sourceFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      yield* sourceFiles(full)
    } else if (/\.(tsx?|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield full
    }
  }
}

describe('i18n key usage', () => {
  const resources = Object.fromEntries(NAMESPACES.map((namespace) => [namespace, loadNamespace(namespace)]))

  it('resolves every literal t("namespace:key") in the renderer sources', () => {
    const problems = []
    const srcDir = path.join(root, 'src')
    for (const file of sourceFiles(srcDir)) {
      const content = fs.readFileSync(file, 'utf8')
      // Literal keys: t('ns:key'), t("ns:key")
      for (const match of content.matchAll(/\bt\(\s*['"]([a-z]+):([a-zA-Z0-9_.-]+)['"]/g)) {
        const [, namespace, key] = match
        if (!NAMESPACES.includes(namespace)) { problems.push(`${file}: unknown namespace "${namespace}"`); continue }
        // i18next resolves plural suffixes automatically, so a call like
        // t('ns:files', {count}) maps onto ns:files_one / ns:files_other.
        const resolved = hasKey(resources[namespace], key)
          || hasKey(resources[namespace], `${key}_one`)
        if (!resolved) problems.push(`${path.relative(root, file)}: missing en-US key "${namespace}:${key}"`)
      }
      // Template keys: t(`ns:prefix.${expr}`) — verify the prefix exists at least once.
      for (const match of content.matchAll(/\bt\(\s*`([a-z]+):([a-zA-Z0-9_.-]+)\.\$\{/g)) {
        const [, namespace, prefix] = match
        const flat = []
        const walk = (node, path) => {
          for (const [key, child] of Object.entries(node)) {
            const full = path ? `${path}.${key}` : key
            if (child && typeof child === 'object') walk(child, full)
            else flat.push(full)
          }
        }
        walk(resources[namespace], '')
        if (!flat.some((key) => key.startsWith(`${prefix}.`))) {
          problems.push(`${path.relative(root, file)}: no en-US keys under "${namespace}:${prefix}.*"`)
        }
      }
    }
    assert.deepEqual(problems, [], `Missing translation keys:\n${problems.join('\n')}`)
  })

  it('every t() call passes through the react-i18next hook', () => {
    // Guard against components importing the raw i18next instance and losing
    // re-render on language change. A file that calls t( must import
    // useTranslation (or receive t via the i18next singleton in i18n/).
    const offenders = []
    for (const file of sourceFiles(path.join(root, 'src'))) {
      if (file.includes(`${path.sep}i18n${path.sep}`)) continue
      const content = fs.readFileSync(file, 'utf8')
      if (/\bt\(/.test(content) && !content.includes('useTranslation')) offenders.push(path.relative(root, file))
    }
    assert.deepEqual(offenders, [], `Files calling t() without useTranslation: ${offenders.join(', ')}`)
  })
})
