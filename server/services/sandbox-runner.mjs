import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { assertManagedWorkspace } from './agent-workspace.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sandboxWorkspaceRoot = path.resolve(process.env.NEXUS_AGENT_WORKSPACE_ROOT || path.join(process.env.NEXUS_DATA_DIR || path.join(projectRoot, 'data'), 'agent-workspaces'))

const images = {
  electron: 'node:22-alpine',
  'web-pwa': 'node:22-alpine',
  'python-desktop': 'python:3.12-alpine',
  dotnet: 'mcr.microsoft.com/dotnet/sdk:8.0',
  tauri: null
}

export function commandForFramework(framework) {
  if (framework === 'electron' || framework === 'web-pwa') return ['sh', '-lc', 'npm ci --offline && node -e "const p=require(\'./package.json\'); if(p.scripts?.test){require(\'node:child_process\').execFileSync(\'npm\',[\'test\'],{stdio:\'inherit\'})} else console.log(\'NEXUS_TESTS_NOT_FOUND\'); if(p.scripts?.build){require(\'node:child_process\').execFileSync(\'npm\',[\'run\',\'build\'],{stdio:\'inherit\'})} else console.log(\'NEXUS_BUILD_NOT_FOUND\')"']
  if (framework === 'python-desktop') return ['sh', '-lc', 'python -m compileall -q . && if find . -type f \( -name "test_*.py" -o -name "*_test.py" \) | grep -q .; then pytest -q; else echo NEXUS_TESTS_NOT_FOUND; fi']
  if (framework === 'dotnet') return ['sh', '-lc', 'dotnet test --no-restore']
  return null
}

export async function runSandboxed({ workspace, framework, timeoutMs = 600_000, signal }) {
  let safeWorkspace
  try {
    safeWorkspace = await assertManagedWorkspace(workspace)
    const root = await fs.realpath(sandboxWorkspaceRoot)
    const realWorkspace = await fs.realpath(safeWorkspace)
    if (realWorkspace === root || !realWorkspace.startsWith(`${root}${path.sep}`)) throw new Error('Sandbox workspace must be inside the managed repository workspace root.')
  } catch (error) {
    return { status: 'BLOCKED', error: error.message }
  }
  const image = images[framework]
  const command = commandForFramework(framework)
  if (!image || !command) return Promise.resolve({ status: 'BLOCKED', error: `No isolated build runner is configured for ${framework}.` })
  return new Promise((resolve) => {
    const containerName = `nexus-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
    const args = ['run', '--name', containerName, '--rm', '--network=none', '--memory=2g', '--cpus=2', '--pids-limit=256', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=10001:10001', '--mount', `type=bind,source=${safeWorkspace},target=/workspace`, '-w', '/workspace', image, ...command]
    const child = spawn('docker', args, { windowsHide: true, shell: false, env: { PATH: process.env.PATH || '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } })
    let output = ''
    const append = (chunk) => { output = (output + chunk.toString()).slice(-100_000) }
    child.stdout.on('data', append); child.stderr.on('data', append)
    let timedOut = false
    let cancelled = false
    const stopContainer = () => {
      child.kill()
      const stopper = spawn('docker', ['stop', '--time', '2', containerName], { windowsHide: true, shell: false, env: { PATH: process.env.PATH || '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } })
      stopper.on('error', () => {})
    }
    const timer = setTimeout(() => {
      timedOut = true
      stopContainer()
    }, timeoutMs)
    const abort = () => { cancelled = true; stopContainer() }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ status: 'BLOCKED', error: error.message, output }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      const missingEvidence = output.includes('NEXUS_TESTS_NOT_FOUND') || output.includes('NEXUS_BUILD_NOT_FOUND')
      resolve({ status: cancelled ? 'CANCELLED' : timedOut ? 'FAILED' : code !== 0 ? 'FAILED' : missingEvidence ? 'PARTIAL' : 'PASS', exitCode: code, timedOut, output })
    })
  })
}
