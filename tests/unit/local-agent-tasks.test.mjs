import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createLocalAgentTask,
  getLocalAgentTask,
  listLocalAgentTasks,
  LOCAL_AGENT_TASKS_FILE,
  MAX_LOCAL_AGENT_TASKS,
  MAX_LOCAL_AGENT_TASK_EVENTS,
  recoverLocalAgentTaskStore,
  updateLocalAgentTask
} from '../../server/services/local-agent-tasks.mjs'

const temporaryDirectories = []

async function tempDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-local-agent-tasks-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('local Agent task JSON persistence', () => {
  it('creates the versioned store and supports create, get, list, and update', async () => {
    const dataDir = await tempDirectory()
    const created = await createLocalAgentTask({ dataDir, task: { id: 'task_1', projectId: 'project_1', prompt: 'Inspect the build.' } })

    expect(created).toMatchObject({ id: 'task_1', projectId: 'project_1', status: 'Queued' })
    expect(created.events).toHaveLength(1)
    expect(await getLocalAgentTask({ dataDir, taskId: 'task_1' })).toEqual(created)
    expect(await getLocalAgentTask({ dataDir, taskId: 'missing' })).toBeNull()
    expect(await listLocalAgentTasks({ dataDir })).toEqual([created])
    expect(JSON.parse(await fs.readFile(path.join(dataDir, LOCAL_AGENT_TASKS_FILE), 'utf8')).schemaVersion).toBe(1)

    const started = await updateLocalAgentTask({ dataDir, taskId: 'task_1', patch: { status: 'Running', phase: 'context' } })
    expect(started).toMatchObject({ status: 'Running', phase: 'context' })
    expect(started.events.at(-1)).toMatchObject({ type: 'status_changed', fromStatus: 'Queued', status: 'Running' })
  })

  it('requires an absolute data directory and validates IDs and status transitions', async () => {
    const dataDir = await tempDirectory()
    await expect(listLocalAgentTasks({ dataDir: 'relative-data' })).rejects.toMatchObject({ code: 'LOCAL_AGENT_TASKS_INVALID_DATA_DIR' })
    await expect(createLocalAgentTask({ dataDir, task: { id: '../escape' } })).rejects.toMatchObject({ code: 'LOCAL_AGENT_TASK_INVALID_ID' })
    await expect(createLocalAgentTask({ dataDir, task: { status: 'Running' } })).rejects.toMatchObject({ code: 'LOCAL_AGENT_TASK_INVALID_STATUS' })

    await createLocalAgentTask({ dataDir, task: { id: 'task_1' } })
    await expect(updateLocalAgentTask({ dataDir, taskId: 'task_1', patch: { status: 'Succeeded' } }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_TASK_INVALID_TRANSITION' })
    await expect(updateLocalAgentTask({ dataDir, taskId: 'bad/id', patch: { phase: 'plan' } }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_TASK_INVALID_ID' })
    expect(await updateLocalAgentTask({ dataDir, taskId: 'missing', patch: { phase: 'plan' } })).toBeNull()
  })

  it('recovers persisted Running tasks as Interrupted and records the recovery event', async () => {
    const dataDir = await tempDirectory()
    await createLocalAgentTask({ dataDir, task: { id: 'task_running' } })
    await updateLocalAgentTask({ dataDir, taskId: 'task_running', patch: { status: 'Running' } })

    const loaded = await recoverLocalAgentTaskStore({ dataDir })
    expect(loaded[0].status).toBe('Interrupted')
    expect(loaded[0].events.at(-1)).toMatchObject({
      type: 'interrupted', status: 'Interrupted', fromStatus: 'Running'
    })
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, LOCAL_AGENT_TASKS_FILE), 'utf8'))
    expect(saved.tasks[0].status).toBe('Interrupted')
    expect(saved.tasks[0].events.at(-1).type).toBe('interrupted')
  })

  it('keeps task and event counts bounded without discarding recent task records', async () => {
    const dataDir = await tempDirectory()
    const created = await Promise.all(Array.from({ length: MAX_LOCAL_AGENT_TASKS }, (_, index) =>
      createLocalAgentTask({ dataDir, task: { id: `task_${index}` } })
    ))
    expect(created).toHaveLength(MAX_LOCAL_AGENT_TASKS)
    await expect(createLocalAgentTask({ dataDir, task: { id: 'task_overflow' } }))
      .rejects.toMatchObject({ code: 'LOCAL_AGENT_TASK_LIMIT' })

    for (let index = 0; index <= MAX_LOCAL_AGENT_TASK_EVENTS; index += 1) {
      await updateLocalAgentTask({ dataDir, taskId: 'task_0', event: `progress ${index}` })
    }
    const task = await getLocalAgentTask({ dataDir, taskId: 'task_0' })
    expect(task.events).toHaveLength(MAX_LOCAL_AGENT_TASK_EVENTS)
    expect(task.events.at(-1).detail).toBe(`progress ${MAX_LOCAL_AGENT_TASK_EVENTS}`)
  })

  it('refuses malformed stores without replacing the original file and cleans up temp files', async () => {
    const dataDir = await tempDirectory()
    const file = path.join(dataDir, LOCAL_AGENT_TASKS_FILE)
    await fs.writeFile(file, '{broken', 'utf8')
    await expect(listLocalAgentTasks({ dataDir })).rejects.toMatchObject({ code: 'LOCAL_AGENT_TASKS_INVALID' })
    expect(await fs.readFile(file, 'utf8')).toBe('{broken')

    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, tasks: [] }), 'utf8')
    await createLocalAgentTask({ dataDir, task: { id: 'task_1' } })
    expect((await fs.readdir(dataDir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
