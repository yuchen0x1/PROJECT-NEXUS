// One policy for secrets, credentials and private data. Path rules are a
// first signal; content rules catch renamed keys and accidental exports.
// This module is deliberately dependency-free so tools, workspaces, diffs,
// API responses and logs can share exactly the same decision.

import path from 'node:path'

const SECRET_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.p7b', '.p7c', '.cer', '.crt', '.der',
  '.keystore', '.jks', '.kdbx', '.ovpn', '.ppk'
])

const SECRET_FILES = new Set([
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'id_rsa', 'id_dsa',
  'id_ecdsa', 'id_ed25519', 'known_hosts', 'authorized_keys',
  'credentials.json', 'provider-keys.json', 'github-credentials.json',
  '.htpasswd', '.pgpass'
])

const SECRET_DIRECTORIES = new Set([
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.config/gcloud'
])

const SECRET_NAME_PATTERN = /(?:^|[._-])(?:secret|secrets|credential|credentials|private|password|passwd|token|apikey|api-key|access-key|auth)(?:[._-]|$)/i
const GENERIC_WORDS = /^(?:token|secret|credential|password|config|private|key)$/i

// A value must look like an actual credential, not an English sentence or a
// type annotation. This keeps documentation and tests from being flaged.
export function looksLikeSecretContent(text = '') {
  const value = String(text)
  if (value.length > 2_000_000) return { sensitive: false, reasons: [] }
  const checks = [
    { code: 'GITHUB_TOKEN', regex: /\b(?:gh[pousr]_[A-Za-z0-9_.-]{15,}|github_pat_[A-Za-z0-9_.-]{20,})\b/ },
    { code: 'OPENAI_KEY', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
    { code: 'PRIVATE_KEY', regex: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
    { code: 'AWS_KEY', regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { code: 'SLACK_TOKEN', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    { code: 'CONNECTION_STRING', regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]{6,}@/i },
    { code: 'ASSIGNED_SECRET', regex: /(?:^|[\r\n])[ \t]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|PRIVATE[_-]?KEY)\s*[:=]\s*["']?([^\s"'#,;}]+)/i },
    { code: 'BEARER_TOKEN', regex: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i }
  ]
  const reasons = []
  for (const check of checks) {
    const match = value.match(check.regex)
    if (!match) continue
    if (check.code === 'ASSIGNED_SECRET' && GENERIC_WORDS.test(String(match[1] || '').trim())) continue
    if (check.code === 'ASSIGNED_SECRET' && /^(?:process\.env|os\.environ|import\.meta\.env|\$\{|<|\.\.\.|your[_-])/i.test(String(match[1] || ''))) continue
    reasons.push(check.code)
  }
  return { sensitive: reasons.length > 0, reasons: [...new Set(reasons)] }
}

function segmentsOf(relativePath = '') {
  return String(relativePath).replace(/\\/g, '/').split('/').filter(Boolean)
}

export function classifySensitivePath(relativePath = '', { absolute = false } = {}) {
  const normalized = String(relativePath).replace(/\\/g, '/')
  const segments = segmentsOf(normalized)
  const lowerSegments = segments.map((segment) => segment.toLowerCase())
  const basename = lowerSegments.at(-1) || ''
  const extension = path.posix.extname(basename)
  const reasons = []
  if (lowerSegments.some((segment) => segment === '.git')) reasons.push('VCS_DIRECTORY')
  if (lowerSegments.some((segment, index) => SECRET_DIRECTORIES.has(segment) || (index > 0 && SECRET_DIRECTORIES.has(`${lowerSegments[index - 1]}/${segment}`)))) reasons.push('CREDENTIAL_DIRECTORY')
  if (basename.startsWith('.env') || basename === 'env') reasons.push('ENV_FILE')
  if (SECRET_FILES.has(basename)) reasons.push('CREDENTIAL_FILE')
  if (SECRET_EXTENSIONS.has(extension)) reasons.push('KEY_OR_CERTIFICATE')
  if (basename === 'state.json' || basename === 'autonomy.db' || basename.endsWith('.db') && /(?:state|user|private|account|session)/i.test(basename)) reasons.push('USER_STATE_DATABASE')
  if (SECRET_NAME_PATTERN.test(basename)) reasons.push('SENSITIVE_NAME')
  if (absolute && /(?:^|[\\/])users[\\/][^\\/]+[\\/](?:appdata|\.config|\.ssh|documents and settings)(?:[\\/]|$)/i.test(normalized)) reasons.push('USER_CONFIGURATION')
  return { sensitive: reasons.length > 0, reasons: [...new Set(reasons)], basename }
}

export function inspectSensitiveFile({ relativePath = '', content = '', absolute = false } = {}) {
  const byPath = classifySensitivePath(relativePath, { absolute })
  const byContent = typeof content === 'string' ? looksLikeSecretContent(content) : { sensitive: false, reasons: [] }
  return {
    sensitive: byPath.sensitive || byContent.sensitive,
    reasons: [...new Set([...byPath.reasons, ...byContent.reasons])],
    pathReasons: byPath.reasons,
    contentReasons: byContent.reasons
  }
}

export function redactSecretsInText(text = '') {
  let output = String(text)
  const patterns = [
    /\b(?:gh[pousr]_[A-Za-z0-9_.-]{15,}|github_pat_[A-Za-z0-9_.-]{20,})\b/g,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /(\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD|PRIVATE[_-]?KEY)\s*[:=]\s*["']?)([^\s"'#,;}]+)/gi,
    /(\bAuthorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi
  ]
  for (const pattern of patterns) {
    output = output.replace(pattern, (match, prefix) => typeof prefix === 'string' ? `${prefix}[REDACTED_BY_NEXUS]` : '[REDACTED_BY_NEXUS]')
  }
  return output
}

export const SENSITIVE_POLICY = Object.freeze({
  extensions: [...SECRET_EXTENSIONS],
  files: [...SECRET_FILES],
  directories: [...SECRET_DIRECTORIES]
})
