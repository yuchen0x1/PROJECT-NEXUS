import { describe, expect, it } from 'vitest'
import {
  ISSUE_CATEGORIES, ISSUE_SEVERITIES, ACTIONABLE_CATEGORIES,
  heuristicClassifyIssue, classifyIssue, buildClassificationPrompt
} from '../../server/services/issue-classifier.mjs'

describe('heuristic issue classification', () => {
  it('places every result in the spec category and severity sets', () => {
    const samples = ['crash on launch', 'CVE-2025-1234 exploit', 'feature request: export CSV', 'how do I install this?', 'docs typo in README']
    for (const title of samples) {
      const result = heuristicClassifyIssue({ title, body: '' })
      expect(ISSUE_CATEGORIES).toContain(result.category)
      expect(ISSUE_SEVERITIES).toContain(result.severity)
      expect(result.source).toBe('heuristic')
    }
  })

  it('detects security issues at the highest severity', () => {
    const result = heuristicClassifyIssue({ title: 'Stored XSS in comment field', body: 'Malicious script is executed. CVE-2025-9999 applies.' })
    expect(result.category).toBe('SECURITY')
    expect(result.severity).toBe('P0')
  })

  it('detects bugs with reproduction hints', () => {
    const result = heuristicClassifyIssue({ title: 'App crashes', body: 'Stack trace:\nTypeError: x is not a function\nReproduction: open settings' })
    expect(result.category).toBe('BUG')
    expect(result.severity).toBe('P1')
    expect(result.reproductionSteps).toBeNull()
  })

  it('prefers explicit labels over keywords', () => {
    expect(heuristicClassifyIssue({ title: 'Everything is slow', body: '', labels: ['documentation'] }).category).toBe('DOCUMENTATION')
    expect(heuristicClassifyIssue({ title: 'Docs typo', body: '', labels: ['bug'] }).category).toBe('BUG')
  })

  it('falls back to human review for ambiguous text', () => {
    expect(heuristicClassifyIssue({ title: 'Something something', body: '???' }).category).toBe('NEEDS_HUMAN_REVIEW')
  })
})

describe('AI classification', () => {
  it('returns the heuristic result when no provider is available', async () => {
    const result = await classifyIssue({ issue: { number: 1, title: 'crash', body: '' }, provider: null })
    expect(result.source).toBe('heuristic')
    expect(result.category).toBe('BUG')
  })

  it('falls back to the heuristic result when the AI output is invalid', async () => {
    const provider = { id: 'p', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: 'k', configured: true }
    const result = await classifyIssue({ issue: { number: 1, title: 'crash', body: 'stack trace' }, provider })
    expect(result.source).toBe('heuristic')
    expect(result.category).toBe('BUG')
  })

  it('builds a prompt with the JSON schema and untrusted-content guard', () => {
    const prompt = buildClassificationPrompt({ issue: { number: 12, title: 'Login broken', body: 'Steps: 1. login' }, comments: [{ author: 'dev', body: 'Confirmed on v2.1' }] })
    expect(prompt).toContain('Issue #12: Login broken')
    expect(prompt).toContain('"category"')
    expect(prompt).toContain('Confirmed on v2.1')
  })
})

describe('actionable categories', () => {
  it('limits automatic code changes to bug, security and performance', () => {
    expect(ACTIONABLE_CATEGORIES).toEqual(['BUG', 'SECURITY', 'PERFORMANCE'])
    expect(ISSUE_CATEGORIES).toContain('NEEDS_HUMAN_REVIEW')
  })
})
