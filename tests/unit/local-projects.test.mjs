import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listLocalProjects, registerLocalProject, scanLocalProject, unregisterLocalProject } from '../../server/services/local-projects.mjs'

const temporaryDirectories = []

async function tempDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-local-projects-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('local project registry', () => {
  it('registers only a selected real folder and prevents duplicate entries', async () => {
    const root = await tempDirectory()
    const dataDir = path.join(root, 'user-data')
    const projectPath = path.join(root, 'Chinese project path with spaces')
    await fs.mkdir(projectPath)
    const first = await registerLocalProject({ dataDir, folderPath: projectPath })
    const duplicate = await registerLocalProject({ dataDir, folderPath: projectPath })

    expect(first.added).toBe(true)
    expect(first.project.path).toBe(await fs.realpath(projectPath))
    expect(duplicate.added).toBe(false)
    expect((await listLocalProjects({ dataDir })).map((project) => project.id)).toEqual([first.project.id])
  })

  it('scans project markers within bounds without reading source contents', async () => {
    const root = await tempDirectory()
    const dataDir = path.join(root, 'user-data')
    const projectPath = path.join(root, 'sample project')
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true })
    await fs.mkdir(path.join(projectPath, 'node_modules', 'hidden-package'), { recursive: true })
    await fs.writeFile(path.join(projectPath, 'package.json'), '{not read by marker scan}')
    await fs.writeFile(path.join(projectPath, 'src', 'pyproject.toml'), 'arbitrary source metadata')
    await fs.writeFile(path.join(projectPath, 'node_modules', 'hidden-package', 'package.json'), '{}')
    const { project } = await registerLocalProject({ dataDir, folderPath: projectPath })

    const report = await scanLocalProject({ dataDir, projectId: project.id })
    expect(report.technologies).toContain('Node.js')
    expect(report.technologies).toContain('Python')
    expect(report.markers).not.toContain('node_modules/hidden-package/package.json')
    expect(report.warnings).toEqual([])
    expect((await listLocalProjects({ dataDir }))[0].lastScan).toMatchObject({ projectId: project.id })
  })

  it('removes only the local reference, never the selected folder', async () => {
    const root = await tempDirectory()
    const dataDir = path.join(root, 'user-data')
    const projectPath = path.join(root, 'keep these files')
    await fs.mkdir(projectPath)
    await fs.writeFile(path.join(projectPath, 'important.txt'), 'keep')
    const { project } = await registerLocalProject({ dataDir, folderPath: projectPath })

    expect(await unregisterLocalProject({ dataDir, projectId: project.id })).toEqual({ removed: true })
    expect(await listLocalProjects({ dataDir })).toEqual([])
    expect(await fs.readFile(path.join(projectPath, 'important.txt'), 'utf8')).toBe('keep')
  })

  it('refuses to replace a malformed local registry', async () => {
    const root = await tempDirectory()
    await fs.writeFile(path.join(root, 'local-projects.json'), '{bad', 'utf8')
    await expect(listLocalProjects({ dataDir: root })).rejects.toMatchObject({ code: 'LOCAL_REGISTRY_INVALID' })
    expect(await fs.readFile(path.join(root, 'local-projects.json'), 'utf8')).toBe('{bad')
  })
})
