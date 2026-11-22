#!/usr/bin/env node
// Translation coverage report. Compares every language against the en-US
// baseline and writes docs/PHASE5_TRANSLATION_COVERAGE.md.
// Usage: node scripts/i18n-coverage.mjs [--strict]   (--strict exits 1 below 100%)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localesDir = path.join(root, 'src', 'locales')
const outFile = path.join(root, 'docs', 'PHASE5_TRANSLATION_COVERAGE.md')
const strict = process.argv.includes('--strict')
const NAMESPACES = ['common', 'navigation', 'workstation', 'projects', 'environment', 'agent', 'automation', 'tasks', 'git', 'build', 'release', 'settings', 'notifications', 'errors']
const LANGUAGES = fs.readdirSync(localesDir).filter((entry) => fs.statSync(path.join(localesDir, entry)).isDirectory()).sort()

function flatten(value, prefix = '', into = []) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object') flatten(child, full, into)
    else into.push(full)
  }
  return into
}

function readNamespace(language, namespace) {
  return JSON.parse(fs.readFileSync(path.join(localesDir, language, `${namespace}.json`), 'utf8'))
}

const baselineKeys = {}
for (const namespace of NAMESPACES) baselineKeys[namespace] = flatten(readNamespace('en-US', namespace))
const baselineTotal = NAMESPACES.reduce((sum, namespace) => sum + baselineKeys[namespace].length, 0)

const rows = []
let worst = 100
for (const language of LANGUAGES) {
  let present = 0
  const missingByNamespace = {}
  for (const namespace of NAMESPACES) {
    const keys = flatten(readNamespace(language, namespace))
    const keySet = new Set(keys)
    const missing = baselineKeys[namespace].filter((key) => !keySet.has(key))
    missingByNamespace[namespace] = missing
    present += baselineKeys[namespace].length - missing.length
  }
  const coverage = baselineTotal === 0 ? 100 : Math.round((present / baselineTotal) * 1000) / 10
  worst = Math.min(worst, coverage)
  rows.push({ language, coverage, missingByNamespace })
}

const generatedAt = new Date().toISOString().slice(0, 10)
const lines = [
  '# PHASE 5 — Translation Coverage',
  '',
  `Generated ${generatedAt} by \`scripts/i18n-coverage.mjs\`. The baseline is the en-US locale set (${baselineTotal} keys across ${NAMESPACES.length} namespaces). ru-RU additionally carries CLDR plural variants (_few/_many) next to the baseline keys.`,
  '',
  '| Language | Coverage | Missing keys |',
  '| --- | --- | --- |'
]
for (const { language, coverage, missingByNamespace } of rows) {
  const missingTotal = Object.values(missingByNamespace).reduce((sum, list) => sum + list.length, 0)
  const detail = missingTotal === 0
    ? '—'
    : Object.entries(missingByNamespace).filter(([, list]) => list.length)
      .map(([namespace, list]) => `${namespace}: ${list.slice(0, 5).join(', ')}${list.length > 5 ? ` … (+${list.length - 5})` : ''}`)
      .join('<br>')
  lines.push(`| ${language} | ${coverage}% | ${detail} |`)
}
lines.push('')
lines.push('All shipped languages are expected at 100%; the unit test `tests/unit/i18n-resources.test.mjs` enforces key parity on every run.')
fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8')
console.log(`Wrote ${path.relative(root, outFile)}`)
for (const { language, coverage } of rows) console.log(`  ${language}: ${coverage}%`)
if (strict && worst < 100) {
  console.error('Coverage below 100%.')
  process.exit(1)
}
