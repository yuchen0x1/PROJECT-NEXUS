export const INTEGRATION_STATUS = Object.freeze({
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  CODE_ONLY: 'CODE_ONLY',
  PIPELINE_MISSING: 'PIPELINE_MISSING',
  SIGNING_MISSING: 'SIGNING_MISSING',
  MANIFEST_MISSING: 'MANIFEST_MISSING',
  CONFIG_INVALID: 'CONFIG_INVALID',
  PARTIAL: 'PARTIAL',
  READY_FOR_TEST: 'READY_FOR_TEST',
  VERIFIED: 'VERIFIED',
  BLOCKED: 'BLOCKED',
  UNSUPPORTED: 'UNSUPPORTED'
})

export const adapterCapabilities = Object.freeze([
  'technology-detection', 'update-mechanism-evidence', 'pipeline-evidence',
  'manifest-evidence', 'signing-configuration-evidence', 'security-findings',
  'test-entrypoint', 'build-entrypoint', 'result-report'
])

export function evidenceFor(files, patterns) {
  return files.filter((file) => patterns.some((pattern) => pattern.test(file.path) || pattern.test(file.content || '')))
}

export function createAdapter({ id, name, detect, inspect }) {
  return Object.freeze({ id, name, detect, inspect, capabilities: adapterCapabilities })
}
