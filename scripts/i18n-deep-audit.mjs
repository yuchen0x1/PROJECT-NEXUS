#!/usr/bin/env node
// PHASE 5.1 deep i18n audit. Reads every locale file, checks structure,
// placeholders, plural forms, empty values and machine-translation signals,
// then scans the renderer for hardcoded UI strings that bypass i18n.
// Writes docs/PHASE5_1_I18N_AUDIT.md. Exit 1 when A-class problems exist.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localesDir = path.join(root, 'src', 'locales')
const srcDir = path.join(root, 'src')
const outPath = path.join(root, 'docs', 'PHASE5_1_I18N_AUDIT.md')
const NAMESPACES = ['common', 'navigation', 'workstation', 'projects', 'environment', 'agent', 'automation', 'tasks', 'git', 'build', 'release', 'settings', 'notifications', 'errors']
const LANGUAGES = fs.readdirSync(localesDir).filter((e) => fs.statSync(path.join(localesDir, e)).isDirectory()).sort()
const BASELINE = 'en-US'

function flatten(value, prefix = '', into = []) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object') flatten(child, full, into)
    else into.push([full, child])
  }
  return into
}

function placeholders(text) {
  return [...String(text).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
}

function readNs(language, namespace) {
  return JSON.parse(fs.readFileSync(path.join(localesDir, language, `${namespace}.json`), 'utf8'))
}

const baseline = {}
for (const ns of NAMESPACES) baseline[ns] = flatten(readNs(BASELINE, ns))
const baselineKeys = new Map()
for (const ns of NAMESPACES) for (const [k] of baseline[ns]) baselineKeys.set(`${ns}:${k}`, true)

const problems = []
const perLanguage = {}

for (const language of LANGUAGES) {
  const stats = { keys: 0, translated: 0, missing: 0, extra: 0, empty: 0, placeholderIssues: [], pluralIssues: [], suspicious: [] }
  for (const ns of NAMESPACES) {
    let resource
    try { resource = readNs(language, ns) } catch (error) {
      problems.push(`P1 ${language}/${ns}.json cannot be parsed: ${error.message}`)
      continue
    }
    const entries = flatten(resource)
    const keySet = new Set(entries.map(([k]) => k))
    const baselineSet = new Set(baseline[ns].map(([k]) => k))
    for (const [key] of baseline[ns]) if (!keySet.has(key)) { stats.missing += 1; problems.push(`P1 ${language}/${ns}: missing key "${key}"`) }
    for (const [key] of entries) if (!baselineSet.has(key)) { stats.extra += 1; if (language !== 'ru-RU' || !/_(few|many)$/.test(key)) problems.push(`P2 ${language}/${ns}: extra key "${key}"`) }
    stats.keys += baselineSet.size
    const baselineMap = new Map(baseline[ns])
    for (const [key, value] of entries) {
      if (typeof value !== 'string') continue
      stats.translated += 1
      if (value.trim() === '') { stats.empty += 1; problems.push(`P1 ${language}/${ns}: empty value at "${key}"`) }
      // ru plural variants (_few/_many) have no en-US counterpart; compare
      // their placeholders against the baseline _other variant of the stem.
      let expectedSource = baselineMap.get(key)
      if (expectedSource === undefined) {
        const stemMatch = key.match(/^(.+)_few$/) || key.match(/^(.+)_many$/)
        if (stemMatch) expectedSource = baselineMap.get(`${stemMatch[1]}_other`)
      }
      const expected = placeholders(expectedSource ?? '')
      const actual = placeholders(value)
      if (JSON.stringify(expected) !== JSON.stringify(actual)) stats.placeholderIssues.push(`"${key}" expected [${expected}] got [${actual}]`)
      // Raw-key leftovers like "projects.row.scan" — every dot segment must
      // contain a letter, so version strings such as "v1.2.3" do not match.
      if (/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(value.trim())) stats.suspicious.push(`untranslated key path at "${key}": "${value}"`)
    }
    // Plural category check: ru needs one/few/many/other, others need one/other.
    const pluralStems = new Set()
    for (const [key] of baseline[ns]) { const m = key.match(/^(.+)_one$/); if (m) pluralStems.add(m[1]) }
    for (const stem of pluralStems) {
      if (language === 'ru-RU') {
        for (const suffix of ['_one', '_few', '_many', '_other']) {
          if (!keySet.has(`${stem}${suffix}`)) stats.pluralIssues.push(`missing ${stem}${suffix}`)
        }
      } else if (!keySet.has(`${stem}_other`)) stats.pluralIssues.push(`missing ${stem}_other`)
    }
  }
  perLanguage[language] = stats
}

// ---- Hardcoded-UI-string scan of the renderer (A-class text must use i18n) ----
const hardcoded = []
const allowed = [
  /className|data-|aria-[a-z]+|role=|http|\.json|\.png|@|import |from '|require\(/,
]
function scanFile(file) {
  const rel = path.relative(root, file)
  const content = fs.readFileSync(file, 'utf8')
  const lines = content.split('\n')
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    // JSX text nodes: >Text< (outside of t() calls) with a letter, not raw data.
    const jsxText = [...trimmed.matchAll(/>\s*([A-Z][a-zA-Z]{2,}(?:\s+[a-zA-Z][a-zA-Z]{1,})*)\s*</g)]
    for (const match of jsxText) {
      const text = match[1]
      if (allowed.some((r) => r.test(text))) continue
      // Skip TypeScript generics like "=> Promise<" — the '>' is part of '=>'.
      if (match.index > 0 && trimmed[match.index - 1] === '=') continue
      if (trimmed.includes(`t(`) && trimmed.includes(text)) continue
      hardcoded.push(`${rel}:${index + 1} JSX text: "${text}"`)
    }
    // String literals passed to aria-label/title/placeholder directly.
    const attrLiterals = [...trimmed.matchAll(/(?:aria-label|title|placeholder|alt)=\{?["']([A-Z][^"']{3,})["']/g)]
    for (const match of attrLiterals) {
      hardcoded.push(`${rel}:${index + 1} attribute literal: "${match[1]}"`)
    }
  })
}
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') yield* walk(full) }
    else if (/\.(tsx?|css)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield full
  }
}
for (const file of walk(srcDir)) {
  if (file.includes(`${path.sep}locales${path.sep}`) || file.includes(`${path.sep}i18n${path.sep}`)) continue
  scanFile(file)
}

// ---- CSS hardcoded-color scan (outside theme.css) ----
const cssColors = []
function scanCss(file) {
  const rel = path.relative(root, file)
  const content = fs.readFileSync(file, 'utf8')
  const hexes = content.match(/#[0-9a-fA-F]{3,8}\b/g) || []
  const rgbas = content.match(/rgba?\([^)]*\)/g) || []
  const unique = [...new Set([...hexes, ...rgbas])].filter((c) => !c.startsWith('var('))
  if (unique.length) cssColors.push(`${rel}: ${unique.join(', ')}`)
}
for (const file of walk(srcDir)) if (file.endsWith('.css')) scanCss(file)

// ---- report ----
const lines = [
  '# PHASE 5.1 — i18n Deep Audit', '',
  `Generated by \`scripts/i18n-deep-audit.mjs\` (script reads the actual resource files; nothing hand-filled). Baseline: en-US, ${baselineKeys.size} keys across ${NAMESPACES.length} namespaces.`, '',
  '## Per-language statistics', '',
  '| Language | Baseline keys | Translated values | Missing | Extra | Empty | Placeholder issues | Plural issues | Suspicious | Coverage |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
]
for (const [language, s] of Object.entries(perLanguage)) {
  const coverage = s.keys === 0 ? '—' : `${Math.round(((s.keys - s.missing) / s.keys) * 1000) / 10}%`
  lines.push(`| ${language} | ${s.keys} | ${s.translated} | ${s.missing} | ${s.extra} | ${s.empty} | ${s.placeholderIssues.length} | ${s.pluralIssues.length} | ${s.suspicious.length} | ${coverage} |`)
  for (const issue of s.placeholderIssues) problems.push(`P1 ${language} placeholder mismatch: ${issue}`)
  for (const issue of s.pluralIssues) problems.push(`P1 ${language} plural: ${issue}`)
  for (const issue of s.suspicious) problems.push(`P2 ${language} ${issue}`)
}
lines.push('', '## Hardcoded A-class UI strings found by the scanner', '')
if (hardcoded.length) { lines.push(...hardcoded.map((h) => `- ${h}`)) } else lines.push('- none found')
lines.push('', '## Hardcoded colors outside theme.css', '')
if (cssColors.length) lines.push(...cssColors.map((c) => `- ${c}`)); else lines.push('- none found')
lines.push('', '## Problems', '')
lines.push(problems.length ? problems.map((p) => `- ${p}`) : ['- none found'])
fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
console.log(`Wrote ${path.relative(root, outPath)}`)
console.log(`languages: ${LANGUAGES.length}, problems: ${problems.length}, hardcoded strings: ${hardcoded.length}, css color findings: ${cssColors.length}`)
const p0p1 = problems.filter((p) => p.startsWith('P0') || p.startsWith('P1')).length
if (p0p1 > 0 || hardcoded.length > 0) process.exitCode = 1
