import { describe, expect, it } from 'vitest'
import { classifySensitivePath, inspectSensitiveFile, looksLikeSecretContent, redactSecretsInText } from '../../server/services/sensitive-files.mjs'

describe('sensitive file policy', () => {
  it('detects credential paths beyond the old filename list', () => {
    expect(classifySensitivePath('config/production.api-key.json').sensitive).toBe(true)
    expect(classifySensitivePath('certs/signing.pfx').reasons).toContain('KEY_OR_CERTIFICATE')
    expect(classifySensitivePath('src/application.ts').sensitive).toBe(false)
  })

  it('detects and redacts credential-like content without flagging env references', () => {
    const secret = 'GITHUB_TOKEN=github_pat_1234567890abcdefghijklmnop'
    expect(looksLikeSecretContent(secret)).toMatchObject({ sensitive: true })
    expect(looksLikeSecretContent('const token = process.env.GITHUB_TOKEN')).toMatchObject({ sensitive: false })
    expect(redactSecretsInText(secret)).not.toContain('github_pat_')
    expect(inspectSensitiveFile({ relativePath: 'README.md', content: secret }).sensitive).toBe(true)
  })
})
