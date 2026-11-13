import crypto from 'node:crypto'
import { getHostingPolicy } from './hosting.mjs'

export function readinessFingerprint({ project, provider, account, credential, epoch }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    project: project.id, repository: project.fullName, policy: getHostingPolicy(project),
    provider: provider ? { id: provider.id, baseUrl: provider.baseUrl, model: provider.model, apiKey: provider.apiKey } : null,
    account, credential, epoch
  })).digest('hex')
}

export function validateReadiness(record, { id, fingerprint, now = Date.now() }) {
  if (!record || !id || record.id !== id || record.fingerprint !== fingerprint || now >= Date.parse(record.expiresAt)) {
    throw Object.assign(new Error('Setup checks expired or configuration changed. Run readiness checks again.'), { code: 'SETUP_READINESS_STALE' })
  }
  return true
}
