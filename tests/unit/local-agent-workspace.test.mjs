import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyLocalAgentOperations,
  createLocalAgentWorkspace,
  listLocalAgentChanges,
  readLocalAgentFiles
} from '../../server/services/local-agent-workspace.mjs'

const temporaryDirectories = []
const projectId = '123e4567-e89b-42d3-a456-426614174000'

async function tempDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-local-agent-'))
  temporaryDirectories.push(directory)
  return directory
}

async function makeProject(root, { files = { 'src/main.ts': 'original source', 'README.md': 'project notes' } } = {}) {
  const projectPath = path.join(root, '测试项目 工程')
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(projectPath, ...relative.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
  return { id: projectId, name: '测试项目 工程', path: projectPath }
}

async function makeWorkspace(root, options = {}) {
  const project = options.project || await makeProject(root, options.projectOptions)
  const dataDir = path.join(root, 'user data')
  const workspace = await createLocalAgentWorkspace({
    dataDir,
    project,
    taskId: options.taskId || 'task-local-001',
    ...(options.limits ? { limits: options.limits } : {})
  })
  return { project, dataDir, workspace }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('local Agent isolated workspaces', () => {
  it('copies only bounded regular project files and keeps the baseline outside the editable source', async () => {
    const root = await tempDirectory()
    const project = await makeProject(root, {
      files: {
        'src/main.ts': 'original source',
        'README.md': 'project notes',
        '.env.local': 'provider=secret',
        'secret.txt': 'private data',
        'credentials/cloud.json': 'credential data',
        'settings/signing.key': 'private key',
        '.git/config': '[remote]',
        'node_modules/example/index.js': 'dependency',
        'dist/app.js': 'build output'
      }
    })
    const outside = path.join(root, 'outside target')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'outside.txt'), 'must not be copied')
    await fs.symlink(outside, path.join(project.path, 'linked-folder'), 'junction')

    const { workspace } = await makeWorkspace(root, { project })
    const copied = path.join(workspace.source, 'src', 'main.ts')
    const manifest = JSON.parse(await fs.readFile(workspace.baselinePath, 'utf8'))

    expect(await fs.readFile(copied, 'utf8')).toBe('original source')
    expect(await fs.readFile(path.join(project.path, 'src', 'main.ts'), 'utf8')).toBe('original source')
    expect(workspace.baselinePath.startsWith(workspace.source + path.sep)).toBe(false)
    expect(workspace.baselineFiles.startsWith(workspace.source + path.sep)).toBe(false)
    expect(manifest.files.map((file) => file.path)).toEqual(['README.md', 'src/main.ts'])
    expect(workspace.stats.skippedSymlinks).toBe(1)
    expect(await listLocalAgentChanges(workspace)).toEqual([])
    await expect(fs.access(path.join(workspace.source, 'linked-folder'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads selected files, applies create/replace only in the copy, and reports bounded before/after changes', async () => {
    const root = await tempDirectory()
    const { project, workspace } = await makeWorkspace(root)
    const read = await readLocalAgentFiles(workspace, ['src/main.ts'])
    expect(read).toEqual([{ path: 'src/main.ts', content: 'original source' }])
    expect((await readLocalAgentFiles(workspace)).map((file) => file.path)).toEqual(['README.md', 'src/main.ts'])

    const applied = await applyLocalAgentOperations(workspace, [
      { action: 'replace', path: 'src/main.ts', content: 'updated source' },
      { action: 'create', path: 'src/new.ts', content: 'new source' }
    ])
    expect(applied).toEqual(['src/main.ts', 'src/new.ts'])
    await fs.rm(path.join(workspace.source, 'README.md'))

    const changes = await listLocalAgentChanges(workspace)
    expect(changes).toEqual([
      { action: 'deleted', path: 'README.md', before: 'project notes', after: null, contentStatus: 'available' },
      { action: 'modified', path: 'src/main.ts', before: 'original source', after: 'updated source', contentStatus: 'available' },
      { action: 'added', path: 'src/new.ts', before: null, after: 'new source', contentStatus: 'available' }
    ])
    expect(await fs.readFile(path.join(project.path, 'src', 'main.ts'), 'utf8')).toBe('original source')
    await expect(fs.access(path.join(project.path, 'src', 'new.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.access(path.join(project.path, 'README.md'))).resolves.toBeUndefined()
  })

  it('rejects traversal, Windows device names, deletes, and symlink escapes', async () => {
    const root = await tempDirectory()
    const { workspace } = await makeWorkspace(root)
    await expect(readLocalAgentFiles(workspace, ['../outside.txt'])).rejects.toThrow(/Unsafe workspace file path/)
    await expect(readLocalAgentFiles(workspace, ['C:\\Windows\\win.ini'])).rejects.toThrow(/relative|invalid/)
    await expect(applyLocalAgentOperations(workspace, [{ action: 'create', path: 'CON.txt', content: 'bad' }])).rejects.toThrow(/Windows-reserved/)
    await expect(applyLocalAgentOperations(workspace, [{ action: 'delete', path: 'README.md' }])).rejects.toThrow(/deletion is not available/)

    const outside = path.join(root, 'outside target')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'outside.txt'), 'outside content')
    await fs.symlink(outside, path.join(workspace.source, 'outside-link'), 'junction')
    await expect(readLocalAgentFiles(workspace, ['outside-link/outside.txt'])).rejects.toThrow(/Symbolic links|authorized root/)
    await expect(applyLocalAgentOperations(workspace, [{ action: 'create', path: 'outside-link/new.txt', content: 'bad' }])).rejects.toThrow(/Symbolic links|authorized root/)
    await expect(fs.access(path.join(outside, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects workspace overlap and invalid project identity before copying', async () => {
    const root = await tempDirectory()
    const project = await makeProject(root)
    await expect(createLocalAgentWorkspace({
      project,
      taskId: 'task-overlap',
      workspaceRoot: path.join(project.path, 'nexus-workspace')
    })).rejects.toThrow(/overlap/)
    await expect(createLocalAgentWorkspace({
      project: { ...project, id: '../escape' },
      taskId: 'task-invalid',
      workspaceRoot: path.join(root, 'workspace')
    })).rejects.toThrow(/id is invalid/)
    await expect(fs.access(path.join(project.path, 'nexus-workspace'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(project.path, 'src', 'main.ts'), 'utf8')).toBe('original source')
  })

  it('fails closed and cleans the task workspace when file, byte, or depth limits are exceeded', async () => {
    const root = await tempDirectory()
    const project = await makeProject(root, { files: { 'src/main.ts': '1234', 'README.md': '5678' } })
    const dataDir = path.join(root, 'limited data')
    const base = { dataDir, project }

    await expect(createLocalAgentWorkspace({ ...base, taskId: 'task-files', limits: { maxFiles: 1 } }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_MAX_FILES' })
    await expect(createLocalAgentWorkspace({ ...base, taskId: 'task-bytes', limits: { maxBytes: 4 } }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_MAX_BYTES' })
    await expect(createLocalAgentWorkspace({ ...base, taskId: 'task-depth', limits: { maxDepth: 0 } }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_MAX_DEPTH' })

    for (const id of ['task-files', 'task-bytes', 'task-depth']) {
      await expect(fs.access(path.join(dataDir, 'agent-workspaces', 'local', projectId, id))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await fs.readFile(path.join(project.path, 'src', 'main.ts'), 'utf8')).toBe('1234')
  })

  it('applies exact, directory, wildcard, nested, and safe file-negation rules to copy, reads, writes, and diffs', async () => {
    const root = await tempDirectory()
    const project = await makeProject(root, {
      files: {
        '.gitignore': 'ignored.txt\nignored-dir/\n*.tmp\n*.log\n**/generated.js\nsrc/**/deep.js\n',
        'ignored.txt': 'must stay private',
        'ignored-dir/hidden.txt': 'must stay private',
        'temporary.tmp': 'must stay private',
        'generated.js': 'must stay private',
        'nested/generated.js': 'must stay private',
        'DEBUG.LOG': 'must stay private on Windows',
        'src/.gitignore': '!keep.log\nproject.data\n',
        'src/keep.log': 'safe negation',
        'src/drop.log': 'still ignored by parent rule',
        'src/deep.js': 'must stay private',
        'src/nested/deep.js': 'must stay private',
        'src/project.data': 'nested rule',
        'src/main.ts': 'included source',
        'other/project.data': 'nested rules do not leak to siblings'
      }
    })

    const { workspace } = await makeWorkspace(root, { project })
    const manifest = JSON.parse(await fs.readFile(workspace.baselinePath, 'utf8'))
    const disclosedPaths = manifest.files.map((file) => file.path)
    expect(disclosedPaths).toEqual(expect.arrayContaining(['.gitignore', 'other/project.data', 'src/.gitignore', 'src/keep.log', 'src/main.ts']))
    expect(disclosedPaths).not.toContain('generated.js')
    expect(disclosedPaths).not.toContain('nested/generated.js')
    expect(disclosedPaths).not.toContain('src/deep.js')
    expect(disclosedPaths).not.toContain('src/nested/deep.js')
    if (process.platform === 'win32') {
      expect(disclosedPaths).not.toContain('DEBUG.LOG')
      await expect(readLocalAgentFiles(workspace, ['DEBUG.LOG'])).rejects.toMatchObject({ code: 'LOCAL_AGENT_GITIGNORE_EXCLUDED' })
    } else {
      expect(disclosedPaths).toContain('DEBUG.LOG')
    }
    await expect(fs.access(path.join(workspace.source, 'ignored.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readLocalAgentFiles(workspace, ['ignored.txt'])).rejects.toMatchObject({ code: 'LOCAL_AGENT_GITIGNORE_EXCLUDED' })
    await expect(readLocalAgentFiles(workspace, ['src/drop.log'])).rejects.toMatchObject({ code: 'LOCAL_AGENT_GITIGNORE_EXCLUDED' })
    await expect(readLocalAgentFiles(workspace, ['src/keep.log'])).resolves.toEqual([{ path: 'src/keep.log', content: 'safe negation' }])

    await expect(applyLocalAgentOperations(workspace, [{ action: 'create', path: 'new.tmp', content: 'blocked' }]))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_GITIGNORE_EXCLUDED' })
    await expect(applyLocalAgentOperations(workspace, [{ action: 'replace', path: 'src/drop.log', content: 'blocked' }]))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_GITIGNORE_EXCLUDED' })
    await expect(applyLocalAgentOperations(workspace, [{ action: 'replace', path: 'src/keep.log', content: 'updated safe file' }]))
      .resolves.toEqual(['src/keep.log'])

    await fs.writeFile(path.join(workspace.source, 'ignored.txt'), 'manually added ignored content', 'utf8')
    const changes = await listLocalAgentChanges(workspace)
    expect(changes).toEqual([
      { action: 'modified', path: 'src/keep.log', before: 'safe negation', after: 'updated safe file', contentStatus: 'available' }
    ])
    expect(JSON.stringify(changes)).not.toContain('manually added ignored content')
  })

  it('rejects unsupported or unsafe .gitignore input and removes the partial workspace', async () => {
    const root = await tempDirectory()
    const dataDir = path.join(root, 'agent data')
    const invalidProject = await makeProject(root, { files: { '.gitignore': '[ab].txt\n', 'a.txt': 'content' } })
    await expect(createLocalAgentWorkspace({ dataDir, project: invalidProject, taskId: 'task-ignore-unsupported' }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_GITIGNORE_UNSUPPORTED' })
    await expect(fs.access(path.join(dataDir, 'agent-workspaces', 'local', projectId, 'task-ignore-unsupported')))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const unsafeProject = await makeProject(root, {
      files: { '.gitignore': 'ignored-dir/\n!ignored-dir/keep.txt\n', 'ignored-dir/keep.txt': 'unsafe reinclude' }
    })
    await expect(createLocalAgentWorkspace({ dataDir, project: unsafeProject, taskId: 'task-ignore-negation' }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_GITIGNORE_UNSAFE_NEGATION' })
    await expect(fs.access(path.join(dataDir, 'agent-workspaces', 'local', projectId, 'task-ignore-negation')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects invalid UTF-8 and enforces the .gitignore byte, file, and rule limits with cleanup', async () => {
    const root = await tempDirectory()
    const dataDir = path.join(root, 'agent data')
    const project = await makeProject(root, { files: { 'visible.txt': 'content' } })
    await fs.writeFile(path.join(project.path, '.gitignore'), Buffer.from([0xff, 0xfe]))
    await expect(createLocalAgentWorkspace({ dataDir, project, taskId: 'task-ignore-utf8' }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_GITIGNORE_UTF8' })

    await fs.writeFile(path.join(project.path, '.gitignore'), 'ignored.txt\n', 'utf8')
    await expect(createLocalAgentWorkspace({ dataDir, project, taskId: 'task-ignore-bytes', limits: { maxGitignoreBytes: 4 } }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_GITIGNORE_LIMIT' })

    await fs.writeFile(path.join(project.path, '.gitignore'), 'one.txt\ntwo.txt\n', 'utf8')
    await expect(createLocalAgentWorkspace({ dataDir, project, taskId: 'task-ignore-rules', limits: { maxGitignoreRules: 1 } }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_GITIGNORE_LIMIT', message: expect.stringContaining('1 rules (maxGitignoreRules)') })

    await fs.writeFile(path.join(project.path, '.gitignore'), '', 'utf8')
    await fs.mkdir(path.join(project.path, 'nested'), { recursive: true })
    await fs.writeFile(path.join(project.path, 'nested', '.gitignore'), '', 'utf8')
    await expect(createLocalAgentWorkspace({ dataDir, project, taskId: 'task-ignore-files', limits: { maxGitignoreFiles: 1 } }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_GITIGNORE_LIMIT', message: expect.stringContaining('more than 1 .gitignore files') })

    for (const id of ['task-ignore-utf8', 'task-ignore-bytes', 'task-ignore-rules', 'task-ignore-files']) {
      await expect(fs.access(path.join(dataDir, 'agent-workspaces', 'local', projectId, id))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('omits diff text when the combined before/after payload would exceed one MiB', async () => {
    const root = await tempDirectory()
    const original = 'a'.repeat(300 * 1024)
    const { workspace } = await makeWorkspace(root, {
      projectOptions: { files: { 'large-a.txt': original, 'large-b.txt': original, 'large-c.txt': original } }
    })
    await applyLocalAgentOperations(workspace, [
      { action: 'replace', path: 'large-a.txt', content: 'b'.repeat(300 * 1024) },
      { action: 'replace', path: 'large-b.txt', content: 'c'.repeat(300 * 1024) },
      { action: 'replace', path: 'large-c.txt', content: 'd'.repeat(300 * 1024) }
    ])
    const changes = await listLocalAgentChanges(workspace)
    expect(changes[0].contentStatus).toBe('available')
    expect(changes[1]).toMatchObject({ action: 'modified', path: 'large-b.txt', before: null, after: null, contentStatus: 'omitted-size-limit' })
    expect(changes[2]).toMatchObject({ action: 'modified', path: 'large-c.txt', before: null, after: null, contentStatus: 'omitted-size-limit' })
  })
})
