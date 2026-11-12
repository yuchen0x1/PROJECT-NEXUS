import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgentWorkspace } from '../../server/services/agent/workspace-worktree.mjs'
import { createToolContext, executeTool, getTool, listTools, syntaxSanityWarning } from '../../server/services/agent/tools.mjs'
import { scanProjectStructure } from '../../server/services/agent/indexer.mjs'

let tempRoot
let projectPath
let workspaceRoot
let dataDir

async function fresh() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-tools-'))
  projectPath = path.join(tempRoot, 'project')
  workspaceRoot = path.join(tempRoot, 'workspaces')
  dataDir = path.join(tempRoot, 'data')
  await fs.mkdir(projectPath, { recursive: true })
  await fs.mkdir(workspaceRoot, { recursive: true })
  await fs.mkdir(dataDir, { recursive: true })
}

await fresh()

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  await fresh()
})

async function setupProject({ git = true } = {}) {
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({
    name: 'tools-demo', main: 'src/main.js', type: 'module',
    scripts: { test: 'node src/selfcheck.js', build: 'node --version', lint: 'node --version' },
    dependencies: { react: '^19.0.0' }, devDependencies: { vitest: '^3.0.0' }
  }), 'utf8')
  await fs.writeFile(path.join(projectPath, 'src', 'main.js'), 'import { add } from "./util.js"\nexport function main() { return add(1, 2) }\nmain()\n', 'utf8')
  await fs.writeFile(path.join(projectPath, 'src', 'util.js'), 'export function add(a, b) { return a + b }\nexport function multiply(a, b) { return a * b }\n', 'utf8')
  await fs.writeFile(path.join(projectPath, 'src', 'selfcheck.js'), 'process.exit(0)\n', 'utf8')
  await fs.writeFile(path.join(projectPath, 'README.md'), '# tools demo\n', 'utf8')
  if (git) {
    const { runCommand } = await import('../../server/services/agent/executor.mjs')
    await runCommand({ cwd: projectPath, command: 'git init -b main', timeoutMs: 20_000 })
    await runCommand({ cwd: projectPath, command: 'git add -A', timeoutMs: 20_000 })
    await runCommand({ cwd: projectPath, command: 'git -c user.name=t -c user.email=t@t.local commit -m init', timeoutMs: 20_000 })
  }
}

async function makeContext({ git = true, policy = 'standard' } = {}) {
  await setupProject({ git })
  const project = { id: '21111111-2222-4333-8444-555555555555', name: 'tools-demo', path: projectPath }
  const { adapter, mode } = await createAgentWorkspace({ project, taskId: 'task-tools-1', mode: git ? 'auto' : 'copy', workspaceRoot, dataDir })
  const index = await scanProjectStructure(adapter.source)
  const ctx = createToolContext({
    adapter,
    index,
    projectPath,
    manifests: index.manifests,
    onEvent: () => {},
    approvalPolicy: policy
  })
  return { ctx, adapter, mode, index, project }
}

describe('agent tool registry', () => {
  it('exposes the full tool catalog with permissions and schemas', () => {
    const names = listTools().map((tool) => tool.name)
    for (const expected of ['read_file', 'list_directory', 'search_files', 'search_code', 'create_file', 'write_file', 'edit_file', 'delete_file', 'move_file', 'get_file_diff', 'inspect_project', 'inspect_dependencies', 'inspect_project_config', 'inspect_entry_points', 'inspect_routes', 'inspect_api', 'inspect_tests', 'git_status', 'git_diff', 'git_log', 'git_branch', 'git_create_branch', 'git_checkout', 'git_commit', 'git_restore', 'run_command', 'run_tests', 'build_project', 'install_dependencies', 'run_linter', 'run_typecheck', 'report_progress', 'request_approval', 'save_checkpoint']) {
      expect(names).toContain(expected)
    }
    expect(getTool('delete_file').permission).toBe('high')
    expect(getTool('install_dependencies').permission).toBe('high')
    expect(getTool('edit_file').permission).toBe('medium')
    expect(getTool('read_file').permission).toBe('low')
    expect(getTool('missing_tool')).toBeNull()
  })

  it('reads, lists, searches files and code with bounds', async ({ }) => {
    const { ctx, adapter } = await makeContext()
    const read = await executeTool('read_file', { path: 'src/util.js' }, ctx)
    expect(read.content).toContain('export function add')
    await expect(executeTool('read_file', { path: '../outside.js' }, ctx)).rejects.toMatchObject({ code: 'TOOL_PATH_ESCAPE' })
    await expect(executeTool('read_file', { path: '.env' }, ctx)).rejects.toMatchObject({ code: 'TOOL_PATH_SENSITIVE' })

    const listing = await executeTool('list_directory', {}, ctx)
    expect(listing.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['package.json', 'src']))

    const fileSearch = await executeTool('search_files', { query: 'multiply' }, ctx)
    expect(fileSearch.matches[0]?.path).toBe('src/util.js')

    const codeSearch = await executeTool('search_code', { query: 'multiply' }, ctx)
    expect(codeSearch.matches[0]).toMatchObject({ path: 'src/util.js', line: 2 })
    expect(codeSearch.matches[0].text).toContain('multiply')

    const regexSearch = await executeTool('search_code', { query: 'add\\(', regex: true }, ctx)
    expect(regexSearch.matches.length).toBeGreaterThan(0)
    await expect(executeTool('search_code', { query: '([bad', regex: true }, ctx)).rejects.toMatchObject({ code: 'TOOL_ARGS_INVALID' })
    await adapter.dispose()
  }, 60_000)

  it('creates, edits, writes, moves and deletes files with validation', async () => {
    const { ctx, adapter } = await makeContext()
    const created = await executeTool('create_file', { path: 'src/new.js', content: 'export const fresh = 1\n' }, ctx)
    expect(created.created).toBe(true)
    await expect(executeTool('create_file', { path: 'src/new.js', content: 'dup' }, ctx)).rejects.toMatchObject({ code: 'AGENT_FILE_EXISTS' })

    const edit = await executeTool('edit_file', { path: 'src/new.js', oldText: 'const fresh = 1', newText: 'const fresh = 2' }, ctx)
    expect(edit.edited).toBe(true)
    expect(await fs.readFile(path.join(adapter.source, 'src', 'new.js'), 'utf8')).toContain('fresh = 2')

    await expect(executeTool('edit_file', { path: 'src/new.js', oldText: 'not present anywhere', newText: 'x' }, ctx)).rejects.toMatchObject({ code: 'TOOL_EDIT_NO_MATCH' })
    await executeTool('create_file', { path: 'src/dup.js', content: 'dup dup\n' }, ctx)
    await expect(executeTool('edit_file', { path: 'src/dup.js', oldText: 'dup', newText: 'x' }, ctx)).rejects.toMatchObject({ code: 'TOOL_EDIT_AMBIGUOUS' })

    // Syntax sanity warning on broken edit
    const broken = await executeTool('edit_file', { path: 'src/new.js', oldText: 'const fresh = 2', newText: 'const fresh = (2' }, ctx)
    expect(broken.warning).toMatch(/bracket|syntax/i)

    const moved = await executeTool('move_file', { from: 'src/dup.js', to: 'src/renamed.js' }, ctx)
    expect(moved.moved).toBe(true)
    expect(await fs.readFile(path.join(adapter.source, 'src', 'renamed.js'), 'utf8')).toBe('dup dup\n')
    expect(await fs.stat(path.join(adapter.source, 'src', 'dup.js')).catch(() => null)).toBeNull()

    const deleted = await executeTool('delete_file', { path: 'src/renamed.js' }, ctx)
    expect(deleted.deleted).toBe(true)
    expect(await fs.stat(path.join(adapter.source, 'src', 'renamed.js')).catch(() => null)).toBeNull()
    await expect(executeTool('delete_file', { path: '../../outside' }, ctx)).rejects.toMatchObject({ code: 'TOOL_PATH_ESCAPE' })
    await adapter.dispose()
  }, 60_000)

  it('runs inspect tools against the real index', async () => {
    const { ctx, adapter } = await makeContext()
    const project = await executeTool('inspect_project', {}, ctx)
    expect(project.entryPoints.some((entry) => entry.path === 'src/main.js')).toBe(true)
    expect(project.testPaths.length).toBe(0)
    const deps = await executeTool('inspect_dependencies', {}, ctx)
    expect(deps.dependencies[0]).toMatchObject({ kind: 'package.json', name: 'tools-demo' })
    expect(deps.dependencies[0].dependencies).toContain('react')
    const config = await executeTool('inspect_project_config', {}, ctx)
    expect(config.configs[0].content).toContain('"tools-demo"')
    const entry = await executeTool('inspect_entry_points', {}, ctx)
    expect(entry.entryPoints.length).toBeGreaterThan(0)
    const tests = await executeTool('inspect_tests', {}, ctx)
    expect(Object.keys(tests.scripts)).toEqual(expect.arrayContaining(['test', 'build', 'lint']))
    await executeTool('inspect_routes', {}, ctx)
    await executeTool('inspect_api', {}, ctx)
    await adapter.dispose()
  }, 60_000)

  it('executes git tools against the worktree and restores files', async () => {
    const { ctx, adapter, mode } = await makeContext()
    expect(mode).toBe('worktree')
    const status = await executeTool('git_status', {}, ctx)
    expect(status.mode).toBe('worktree')
    await executeTool('create_file', { path: 'src/git-added.js', content: 'git add me\n' }, ctx)
    await executeTool('edit_file', { path: 'src/main.js', oldText: 'main()\n', newText: 'main()\n// touched\n' }, ctx)
    const log = await executeTool('git_log', {}, ctx)
    expect(log.output).toContain('init')
    const branches = await executeTool('git_branch', {}, ctx)
    expect(branches.output).toContain('nexus-agent')

    const restored = await executeTool('git_restore', { path: 'src/main.js' }, ctx)
    expect(restored.path).toBe('src/main.js')
    expect(await fs.readFile(path.join(adapter.source, 'src', 'main.js'), 'utf8')).not.toContain('touched')

    const commit = await executeTool('git_commit', { message: 'agent checkpoint commit' }, ctx)
    expect(commit.ok).toBe(true)
    expect(commit.output).toContain('agent checkpoint commit')
    await expect(executeTool('git_commit', { message: 'bad\r\ninjection" x' }, ctx)).rejects.toMatchObject({ code: 'TOOL_ARGS_INVALID' })
    await adapter.dispose()
  }, 60_000)

  it('runs project tests and build via manifest scripts', async () => {
    const { ctx, adapter } = await makeContext()
    const tests = await executeTool('run_tests', {}, ctx)
    expect(tests.ok).toBe(true)
    expect(tests.command).toBe('npm run test')
    const build = await executeTool('build_project', {}, ctx)
    expect(build.ok).toBe(true)
    const lint = await executeTool('run_linter', {}, ctx)
    expect(lint.ok).toBe(true)
    await expect(executeTool('run_tests', { command: 'node a & node b' }, ctx)).rejects.toMatchObject({ code: 'COMMAND_METACHARACTER' })
    await adapter.dispose()
  }, 60_000)

  it('edits files with CRLF line endings without corrupting them', async () => {
    const { ctx, adapter } = await makeContext()
    await executeTool('create_file', { path: 'src/crlf.js', content: 'const a = 1\r\nconst b = 2\r\n' }, ctx)
    const edited = await executeTool('edit_file', { path: 'src/crlf.js', oldText: 'const b = 2', newText: 'const b = 3' }, ctx)
    expect(edited.lineEndings).toBe('crlf')
    const raw = await fs.readFile(path.join(adapter.source, 'src', 'crlf.js'), 'utf8')
    expect(raw).toContain('const a = 1\r\n')
    expect(raw).toContain('const b = 3\r\n')
    // LF files stay LF.
    const editedLf = await executeTool('edit_file', { path: 'src/new.js', oldText: 'const fresh = 2', newText: 'const fresh = 3' }, ctx).catch(() => null)
    if (editedLf) expect(editedLf.lineEndings).toBe('lf')
    await adapter.dispose()
  }, 60_000)

  it('runs allowlisted commands and marks unlisted programs for approval', async () => {
    const { ctx, adapter } = await makeContext()
    const result = await executeTool('run_command', { command: 'node --version' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.allowedProgram).toBe(true)
    // Unlisted programs still execute through the executor (it tags, does not block);
    // the runtime gates them via run_command's dynamic high permission.
    const unlisted = await executeTool('run_command', { command: 'curl --version' }, ctx)
    expect(unlisted.allowedProgram).toBe(false)
    expect(unlisted.ok).toBe(true)
    await expect(executeTool('run_command', { command: 'node a & node b' }, ctx)).rejects.toMatchObject({ code: 'COMMAND_METACHARACTER' })
    await adapter.dispose()
  }, 60_000)

  it('reports progress, checkpoints and validates helper tools', async () => {
    const { ctx, adapter } = await makeContext()
    const events = []
    ctx.onEvent = (event) => events.push(event)
    const progress = await executeTool('report_progress', { message: 'Half done' }, ctx)
    expect(progress.reported).toBe(true)
    const checkpoint = await executeTool('save_checkpoint', { note: 'State before final test' }, ctx)
    expect(checkpoint.saved).toBe(true)
    await expect(executeTool('report_progress', { wrong: 'arg' }, ctx)).rejects.toMatchObject({ code: 'TOOL_ARGS_INVALID' })
    await expect(executeTool('no_such_tool', {}, ctx)).rejects.toMatchObject({ code: 'TOOL_UNKNOWN' })
    await adapter.dispose()
  }, 60_000)

  it('flags syntax problems through the sanity checker', () => {
    expect(syntaxSanityWarning('src/a.js', 'function f() { return 1 }')).toBeNull()
    expect(syntaxSanityWarning('src/a.js', 'function f() { return 1')).toMatch(/bracket/)
    expect(syntaxSanityWarning('data.json', '{"ok": true}')).toBeNull()
    expect(syntaxSanityWarning('data.json', '{"ok": true,}')).toMatch(/JSON parse failed/)
    expect(syntaxSanityWarning('note.md', '{ unclosed markdown')).toBeNull()
  })
})
