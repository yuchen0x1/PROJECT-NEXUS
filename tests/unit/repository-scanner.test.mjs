import { describe, expect, it } from 'vitest'
import { scanRepository } from '../../server/services/repository-scanner.mjs'

const project = { id: 'repo_1', githubId: 1, fullName: 'acme/sample-app', defaultBranch: 'main' }

function blob(path, content, sha) {
  return { path, type: 'blob', size: Buffer.byteLength(content), sha }
}

describe('commit-pinned update evidence scanner', () => {
  it('reads relevant source files, detects an updater, and does not claim a verified update', async () => {
    const contents = new Map([
      ['111aaa1', JSON.stringify({ name: 'sample', version: '1.2.3', scripts: { test: 'vitest', build: 'vite build' }, devDependencies: { 'electron-builder': '^25.0.0' } })],
      ['222bbb2', "const { autoUpdater } = require('electron-updater'); autoUpdater.checkForUpdatesAndNotify();"],
      ['333ccc3', 'version: 1.2.3\nsha512: abcdef\n']
    ])
    const calls = []
    const github = async (_repo, endpoint) => {
      calls.push(endpoint)
      if (endpoint.endsWith('/git/ref/heads/main')) return { object: { sha: 'abcdef123456' } }
      if (endpoint.endsWith('/git/commits/abcdef123456')) return { tree: { sha: 'fedcba123456' } }
      if (endpoint.includes('/git/trees/fedcba123456?recursive=1')) return { truncated: false, tree: [
        blob('package.json', contents.get('111aaa1'), '111aaa1'),
        blob('src/main.js', contents.get('222bbb2'), '222bbb2'),
        blob('latest.yml', contents.get('333ccc3'), '333ccc3')
      ] }
      const sha = endpoint.split('/').at(-1)
      return { encoding: 'base64', content: Buffer.from(contents.get(sha)).toString('base64') }
    }
    const report = await scanRepository(project, github)
    expect(report.repository).toBe('acme/sample-app')
    expect(report.commitSha).toBe('abcdef123456')
    expect(report.components.map((item) => item.adapter)).toContain('electron')
    expect(report.assessment.verified).toBe(false)
    expect(report.readiness.signatureCryptographicallyVerified).toBe(false)
    expect(report.readiness.oldClientUpdateVerified).toBe(false)
    expect(report.readiness.codeSupportsUpdates).toBe(true)
    expect(calls.some((value) => value.startsWith('/repos/acme/sample-app/'))).toBe(true)
    expect(calls.some((value) => value.startsWith('/repos/acme%2Fsample-app/'))).toBe(false)
  })

  it('stops promptly when its cancellation signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(scanRepository(project, async () => ({}), { signal: controller.signal })).rejects.toMatchObject({ code: 'JOB_CANCELLED' })
  })

  it('reports Android and iOS evidence as explicitly unsupported platforms', async () => {
    const contents = new Map([
      ['android-manifest', '<manifest package="com.example.app" />'],
      ['android-gradle', 'plugins { id("com.android.application") }'],
      ['ios-project', 'PBXProject objectVersion = 56;']
    ])
    const github = async (_repo, endpoint) => {
      if (endpoint.endsWith('/git/ref/heads/main')) return { object: { sha: '1234567890abcdef' } }
      if (endpoint.endsWith('/git/commits/1234567890abcdef')) return { tree: { sha: 'abcdef1234567890' } }
      if (endpoint.includes('/git/trees/abcdef1234567890?recursive=1')) return { truncated: false, tree: [
        blob('app/src/main/AndroidManifest.xml', contents.get('android-manifest'), 'android-manifest'),
        blob('app/build.gradle', contents.get('android-gradle'), 'android-gradle'),
        blob('Mobile.xcodeproj/project.pbxproj', contents.get('ios-project'), 'ios-project')
      ] }
      const sha = endpoint.split('/').at(-1)
      return { encoding: 'base64', content: Buffer.from(contents.get(sha)).toString('base64') }
    }
    const report = await scanRepository(project, github)
    expect(report.detectedPlatforms).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'Android', supported: false, status: 'UNSUPPORTED' }),
      expect.objectContaining({ platform: 'iOS', supported: false, status: 'UNSUPPORTED' })
    ]))
  })

  it('clears the recursive tree truncation flag when the bounded fallback completes', async () => {
    const github = async (_repo, endpoint) => {
      if (endpoint.endsWith('/git/ref/heads/main')) return { object: { sha: '1234567890abcdef' } }
      if (endpoint.endsWith('/git/commits/1234567890abcdef')) return { tree: { sha: 'abcdef1234567890' } }
      if (endpoint.includes('/git/trees/abcdef1234567890?recursive=1')) return { truncated: true, tree: [] }
      if (endpoint.endsWith('/git/trees/abcdef1234567890')) return { tree: [blob('README.md', 'A complete fallback tree.', 'readme-sha')] }
      return { encoding: 'base64', content: Buffer.from('A complete fallback tree.').toString('base64') }
    }
    const report = await scanRepository(project, github)
    expect(report.truncated).toBe(false)
    expect(report.selectedPaths).toContain('README.md')
  })
})
