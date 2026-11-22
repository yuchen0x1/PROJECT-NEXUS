import { describe, expect, it } from 'vitest'
import { parseSarif } from '../../server/services/security-tools.mjs'

describe('external security tool integration', () => {
  it('normalizes SARIF findings with a stable id, path and priority', () => {
    const report = parseSarif(JSON.stringify({ runs: [{ tool: { driver: { rules: [{ id: 'js/sql-injection', shortDescription: { text: 'SQL injection' } }] } }, results: [{ ruleId: 'js/sql-injection', level: 'error', message: { text: 'User input reaches a query.' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/app.js' }, region: { startLine: 12 } } }] }] }] }), { tool: 'semgrep' })
    expect(report).toHaveLength(1)
    expect(report[0]).toMatchObject({ tool: 'semgrep', ruleId: 'js/sql-injection', path: 'src/app.js', line: 12, priority: 'P1' })
    expect(report[0].id).toMatch(/^semgrep:/)
  })
})
