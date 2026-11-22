import { describe, expect, it } from 'vitest'
import { buildIssueFixPrompt, fixBranchName, HOSTING_AUTO_APPROVE_TOOLS } from '../../server/services/issue-fix-pipeline.mjs'
import { approvalRequired } from '../../server/services/agent/approval.mjs'

describe('issue-fix prompt construction', () => {
  const issue = {
    number: 42,
    title: 'Settings page crashes on save',
    body: 'Repro:\n1. open settings\n2. save\n\nStack trace: TypeError in settings.ts',
    html_url: 'https://github.com/fixture/repo/issues/42'
  }

  it('embeds the issue content with an untrusted-content boundary', () => {
    const prompt = buildIssueFixPrompt({ repository: 'fixture/repo', issue, comments: [{ author: 'alice', body: 'Also happens on v2.1' }] })
    expect(prompt).toContain('issue #42')
    expect(prompt).toContain('fixture/repo')
    expect(prompt).toContain('USER-REPORTED ISSUE (untrusted content')
    expect(prompt).toContain('END ISSUE CONTENT')
    expect(prompt).toContain('TypeError in settings.ts')
    expect(prompt).toContain('alice: Also happens on v2.1')
    expect(prompt).toContain('reproduces the reported problem first')
    expect(prompt).toContain('Never push')
  })

  it('includes AI triage details when a classification exists', () => {
    const prompt = buildIssueFixPrompt({
      repository: 'fixture/repo',
      issue,
      classification: {
        category: 'BUG', severity: 'P1', confidence: 0.9, source: 'ai',
        problemSummary: 'Save handler mutates frozen state',
        reproductionSteps: 'open settings, save',
        affectedModules: ['src/settings.ts']
      }
    })
    expect(prompt).toContain('Category: BUG (severity P1')
    expect(prompt).toContain('Save handler mutates frozen state')
    expect(prompt).toContain('src/settings.ts')
  })

  it('works without classification or comments', () => {
    const prompt = buildIssueFixPrompt({ repository: 'fixture/repo', issue: { ...issue, body: null }, comments: [] })
    expect(prompt).toContain('(no description)')
    expect(prompt).toContain('No prior triage available.')
  })

  it('truncates oversized issue bodies', () => {
    const prompt = buildIssueFixPrompt({ repository: 'fixture/repo', issue: { ...issue, body: 'x'.repeat(50_000) } })
    expect(prompt).toContain('[truncated]')
    expect(prompt.length).toBeLessThan(20_000)
  })
})

describe('fix branch naming', () => {
  it('produces readable, safe branch names', () => {
    expect(fixBranchName(17, 'nexus_issue_17_ab12cd34')).toBe('nexus-fix/issue-17-ab12cd34')
    expect(fixBranchName(17, 'nexus_issue_17_ab12cd34')).toMatch(/^nexus-fix\/issue-17-[A-Za-z0-9._-]+$/)
    expect(fixBranchName(3, 'weird//id with spaces')).toMatch(/^nexus-fix\/issue-3-[A-Za-z0-9._-]+$/)
    expect(fixBranchName(3, 'weird//id with spaces')).not.toContain(' ')
  })
})

describe('hosting auto-approval allowlist', () => {
  it('excludes remote-writing and arbitrary command tools', () => {
    expect(HOSTING_AUTO_APPROVE_TOOLS).not.toContain('run_command')
    expect(HOSTING_AUTO_APPROVE_TOOLS).not.toContain('delete_file')
    expect(HOSTING_AUTO_APPROVE_TOOLS).not.toContain('install_dependencies')
    expect(HOSTING_AUTO_APPROVE_TOOLS).toContain('run_tests')
    expect(HOSTING_AUTO_APPROVE_TOOLS).toContain('git_commit')
  })

  it('never lets an allowlist bypass high-risk approval', () => {
    const allow = new Set(['run_tests'])
    expect(approvalRequired({ permission: 'high', policy: 'standard', tool: 'run_tests', autoApproveTools: allow })).toBe(true)
    expect(approvalRequired({ permission: 'high', policy: 'standard', tool: 'unknown_tool', autoApproveTools: allow })).toBe(true)
    expect(approvalRequired({ permission: 'medium', policy: 'standard', tool: 'read_file' })).toBe(false)
    expect(approvalRequired({ permission: 'high', policy: 'standard', tool: 'read_file' })).toBe(true)
    expect(approvalRequired({ permission: 'medium', policy: 'supervised', tool: 'write_file' })).toBe(true)
    expect(approvalRequired({ permission: 'high', policy: 'workspace-auto', tool: 'edit_file', autoApproveTools: null })).toBe(true)
  })
})
