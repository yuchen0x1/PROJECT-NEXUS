import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildProjectIndex, scanProjectStructure, searchProjectIndex } from '../../server/services/agent/indexer.mjs'
import { buildTaskContextBundle, readContextFileContent, selectTaskContext } from '../../server/services/agent/context.mjs'

let root

beforeEach()

async function beforeEach() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-index-'))
}

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-index-'))
})

async function writeTree(tree) {
  for (const [relative, content] of Object.entries(tree)) {
    const target = path.join(root, ...relative.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  }
}

const demoTree = {
  'package.json': JSON.stringify({
    name: 'demo-app', main: 'src/main.js', type: 'module',
    scripts: { test: 'vitest run', build: 'vite build' },
    dependencies: { react: '^19.0.0' }, devDependencies: { vitest: '^3.0.0' }
  }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
  'src/main.js': 'import { startServer } from "./server.js"\nexport function bootstrap() { return startServer() }\nbootstrap()\n',
  'src/server.js': 'import { createHandler } from "./routes.js"\nexport function startServer() { return createHandler() }\n',
  'src/routes.js': 'export function createHandler() { return "handler" }\nexport function notCovered() { return 1 }\n',
  'src/utils/formatDate.js': 'export function formatDate(value) { return String(value) }\n',
  'src/components/App.tsx': 'export default function App() { return null }\n',
  'src/components/App.test.tsx': 'import { App } from "./App.tsx"\n',
  'src/style.css': 'body { color: red }\n',
  'src/logo.png': 'not-a-real-png',
  'node_modules/dep/index.js': 'module.exports = 1\n',
  'dist/bundle.js': 'bundled()',
  'src/large/generated.js': 'x'.repeat(1_200_000)
}

describe('project indexer', () => {
  it('inventories files, extracts symbols and imports, detects manifests, entries and tests', async () => {
    await writeTree(demoTree)
    const index = await scanProjectStructure(root)
    const paths = index.files.map((file) => file.path)
    expect(paths).toContain('src/main.js')
    expect(paths).not.toContain('node_modules/dep/index.js')
    expect(paths).not.toContain('dist/bundle.js')
    expect(paths).not.toContain('src/logo.png')
    expect(paths).not.toContain('src/large/generated.js')

    expect(index.symbols['src/main.js']).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'function', name: 'bootstrap' })
    ]))
    expect(index.imports['src/main.js']).toContain('./server.js')
    expect(index.imports['src/server.js']).toContain('./routes.js')

    const packageManifest = index.manifests.find((manifest) => manifest.kind === 'package.json')
    expect(packageManifest).toMatchObject({ name: 'demo-app', main: 'src/main.js', type: 'module' })
    expect(packageManifest.scripts).toMatchObject({ test: 'vitest run', build: 'vite build' })
    expect(packageManifest.dependencies).toEqual(['react'])

    expect(index.entryPoints.some((entry) => entry.path === 'src/main.js')).toBe(true)
    expect(index.testPaths).toContain('src/components/App.test.tsx')
    expect(index.routeCandidates).toContain('src/routes.js')
    expect(index.stats.files).toBeGreaterThan(5)
  })

  it('supports incremental reindexing and reports changed files only', async () => {
    await writeTree(demoTree)
    const cacheFile = path.join(root, '..', `${path.basename(root)}.index-cache.json`)
    const first = await buildProjectIndex({ root, cacheFile })
    expect(first.cached).toBe(false)
    expect(first.reindexed).toBe(first.index.files.length)

    const second = await buildProjectIndex({ root, cacheFile })
    expect(second.cached).toBe(true)
    expect(second.changed).toEqual([])
    expect(second.reindexed).toBe(0)

    await new Promise((resolve) => setTimeout(resolve, 20))
    await fs.writeFile(path.join(root, 'src/routes.js'), 'export function createHandler() { return "handler2" }\n', 'utf8')
    const third = await buildProjectIndex({ root, cacheFile })
    expect(third.changed).toEqual(['src/routes.js'])
    expect(third.reindexed).toBe(1)
    expect(third.index.imports['src/server.js']).toContain('./routes.js')
    await fs.rm(cacheFile, { force: true })
  })

  it('searches the index by path and symbol with scoring', async () => {
    await writeTree(demoTree)
    const index = await scanProjectStructure(root)
    const formatHits = searchProjectIndex(index, 'formatDate')
    expect(formatHits[0]?.path).toBe('src/utils/formatDate.js')
    const routeHits = searchProjectIndex(index, 'routes').map((hit) => hit.path)
    expect(routeHits).toContain('src/routes.js')
    expect(searchProjectIndex(index, '')).toEqual([])
  })

  it('refuses a relative root', async () => {
    await expect(scanProjectStructure('relative/path')).rejects.toMatchObject({ code: 'PROJECT_INDEX_INVALID_ROOT' })
  })
})

describe('task context selection', () => {
  it('selects manifests, keyword matches, symbols and import neighbors under a budget', async () => {
    await writeTree(demoTree)
    const index = await scanProjectStructure(root)
    const selection = selectTaskContext({ index, prompt: 'fix the createHandler routes handler in routes.js', budgetBytes: 100_000, maxFiles: 10 })
    const selectedPaths = selection.files.map((file) => file.path)
    expect(selectedPaths).toContain('package.json')
    expect(selectedPaths).toContain('src/routes.js')
    expect(selectedPaths).toContain('src/server.js')
    expect(selectedPaths.length).toBeLessThanOrEqual(10)
    expect(selection.budgetBytes).toBe(100_000)
  })

  it('reads context files with redaction and truncation', async () => {
    await writeTree({
      'src/small.js': 'const token = "sk-123456789012345678901234567890";\nexport const value = 1\n',
      'src/big.js': `// ${'x'.repeat(40_000)}\nexport const big = true\n// ${'y'.repeat(4_000)}`
    })
    const small = await readContextFileContent(root, 'src/small.js')
    expect(small.content).toContain('[REDACTED TOKEN]')
    expect(small.content).not.toContain('sk-123456789012345678901234567890')
    expect(small.truncated).toBe(false)

    const big = await readContextFileContent(root, 'src/big.js')
    expect(big.truncated).toBe(true)
    expect(big.content).toContain('file truncated for context window')

    await expect(readContextFileContent(root, '../outside.js')).rejects.toMatchObject({ code: 'CONTEXT_PATH_INVALID' })
    await expect(readContextFileContent(root, 'src/missing.js')).rejects.toMatchObject({ code: 'CONTEXT_FILE_MISSING' })
  })

  it('builds a redacted context bundle from the index', async () => {
    await writeTree({
      ...demoTree,
      'src/secret.env': 'API_KEY=ghp_123456789012345678901234567890'
    })
    const index = await scanProjectStructure(root)
    const bundle = await buildTaskContextBundle({ sourceRoot: root, index, prompt: 'review the bootstrap flow and App component', budgetBytes: 60_000 })
    expect(bundle.disclosedPaths.length).toBeGreaterThan(0)
    expect(bundle.disclosedPaths.every((filePath) => filePath !== 'src/secret.env')).toBe(true)
    expect(JSON.stringify(bundle)).not.toContain('ghp_123456789012345678901234567890')
    const joined = bundle.files.map((file) => file.content || '').join('\n')
    expect(joined).toContain('bootstrap')
    for (const file of bundle.files) {
      if (file.content === null) expect(file.reason || file.error).toBeTruthy()
    }
  })
})
