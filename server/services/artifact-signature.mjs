import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execute = promisify(execFile)
export async function verifyArtifactSignature(file) {
  if (process.platform !== 'win32' || !/\.(exe|msi|dll)$/i.test(file)) return { valid: false, status: 'Unsupported' }
  const windows = process.env.SystemRoot || 'C:\\Windows'
  const { stdout } = await execute(path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$s = Get-AuthenticodeSignature -LiteralPath $env:NEXUS_ARTIFACT_PATH; @{ status = [string]$s.Status; publisher = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress'
  ], { windowsHide: true, timeout: 30000, maxBuffer: 16000, env: { SystemRoot: windows, WINDIR: windows, PATH: process.env.PATH || '', NEXUS_ARTIFACT_PATH: file } })
  const result = JSON.parse(stdout.trim())
  return { ...result, valid: result.status === 'Valid' }
}
