import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const LOCAL_AGENT_TASKS_FILE = 'local-agent-tasks.json'
export const LOCAL_AGENT_TASK_SCHEMA_VERSION = 1
export const MAX_LOCAL_AGENT_TASKS = 100
export const MAX_LOCAL_AGENT_TASK_EVENTS = 200

export const LOCAL_AGENT_TASK_STATUSES = Object.freeze([
  'Queued', 'Running', 'Paused', 'Interrupted', 'Succeeded', 'Failed', 'Blocked', 'TimedOut', 'Cancelled'
])

const statusSet = new Set(LOCAL_AGENT_TASK_STATUSES)
const transitions = new Map([
  ['Queued', new Set(['Running', 'Interrupted', 'Blocked', 'Cancelled'])],
  ['Running', new Set(['Paused', 'Interrupted', 'Succeeded', 'Failed', 'Blocked', 'TimedOut', 'Cancelled'])],
  ['Paused', new Set(['Running', 'Interrupted', 'Blocked', 'Cancelled'])],
  ['Interrupted', new Set(['Queued', 'Running', 'Blocked', 'Cancelled'])],
  ['Succeeded', new Set()],
  ['Failed', new Set(['Queued'])],
  ['Blocked', new Set(['Queued'])],
  ['TimedOut', new Set(['Queued'])],
  ['Cancelled', new Set(['Queued'])]
])

const fileQueues = new Map()

function taskError(code, message) {
  return Object.assign(new Error(message), { code })
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function jsonClone(value, label) {
  let serialized
  try { serialized = JSON.stringify(value) }
  catch (error) { throw taskError('LOCAL_AGENT_TASK_INVALID', `${label} must contain only JSON-compatible values: ${error.message}`) }
  if (typeof serialized !== 'string') throw taskError('LOCAL_AGENT_TASK_INVALID', `${label} must be JSON-compatible.`)
  try { return JSON.parse(serialized) }
  catch (error) { throw taskError('LOCAL_AGENT_TASK_INVALID', `${label} must be JSON-compatible: ${error.message}`) }
}

function resolveTasksFile(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw taskError('LOCAL_AGENT_TASKS_INVALID_DATA_DIR', 'dataDir must be an absolute directory path.')
  }
  return path.join(path.resolve(dataDir), LOCAL_AGENT_TASKS_FILE)
}

function validateTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) {
    throw taskError('LOCAL_AGENT_TASK_INVALID_ID', 'Task ID must be 1-128 safe ASCII letters, digits, dots, underscores, or hyphens.')
  }
  return taskId
}

function validateStatus(status) {
  if (typeof status !== 'string' || !statusSet.has(status)) {
    throw taskError('LOCAL_AGENT_TASK_INVALID_STATUS', `Task status must be one of: ${LOCAL_AGENT_TASK_STATUSES.join(', ')}.`)
  }
  return status
}

function now() {
  return new Date().toISOString()
}

function makeEvent({ type, detail, status, metadata, fromStatus } = {}) {
  const event = {
    at: now(),
    type: String(type || 'updated').slice(0, 80),
    status,
    detail: String(detail || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1_000)
  }
  if (fromStatus) event.fromStatus = fromStatus
  if (metadata !== undefined) {
    if (!isPlainObject(metadata)) throw taskError('LOCAL_AGENT_TASK_INVALID', 'Event metadata must be a plain object.')
    event.metadata = jsonClone(metadata, 'Event metadata')
  }
  return event
}

function appendEvent(task, event) {
  task.events = [...task.events, event].slice(-MAX_LOCAL_AGENT_TASK_EVENTS)
}

function makeDocument(tasks = []) {
  return { schemaVersion: LOCAL_AGENT_TASK_SCHEMA_VERSION, tasks }
}

async function assertRegularFileOrMissing(file) {
  const stat = await fs.lstat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (stat?.isSymbolicLink() || (stat && !stat.isFile())) {
    throw taskError('LOCAL_AGENT_TASKS_INVALID_FILE', 'Task store must be a regular file, not a symbolic link or directory.')
  }
}

async function writeDocument(file, document) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await assertRegularFileOrMissing(file)
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(document, null, 2), { encoding: 'utf8', flag: 'wx' })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function normalizeTask(source, seenIds) {
  if (!isPlainObject(source)) throw taskError('LOCAL_AGENT_TASKS_INVALID', 'Every persisted task must be a JSON object.')
  const task = jsonClone(source, 'Persisted task')
  validateTaskId(task.id)
  if (seenIds.has(task.id)) throw taskError('LOCAL_AGENT_TASKS_INVALID', `Duplicate task ID: ${task.id}`)
  seenIds.add(task.id)
  validateStatus(task.status)
  if (task.events !== undefined && !Array.isArray(task.events)) {
    throw taskError('LOCAL_AGENT_TASKS_INVALID', `Task ${task.id} events must be an array.`)
  }
  task.events = (task.events || []).slice(-MAX_LOCAL_AGENT_TASK_EVENTS)
  if (typeof task.createdAt !== 'string' || !task.createdAt) task.createdAt = now()
  if (typeof task.updatedAt !== 'string' || !task.updatedAt) task.updatedAt = task.createdAt
  return task
}

async function loadDocument(file, { recoverRunning = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await assertRegularFileOrMissing(file)
  let content
  try { content = await fs.readFile(file, 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    const document = makeDocument()
    await writeDocument(file, document)
    return document
  }

  let parsed
  try { parsed = JSON.parse(content) }
  catch (error) {
    throw taskError('LOCAL_AGENT_TASKS_INVALID', `Task store is not valid JSON; refusing to replace it: ${error.message}`)
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== LOCAL_AGENT_TASK_SCHEMA_VERSION || !Array.isArray(parsed.tasks)) {
    throw taskError('LOCAL_AGENT_TASKS_INVALID', 'Task store must use schemaVersion 1 and contain a tasks array.')
  }
  if (parsed.tasks.length > MAX_LOCAL_AGENT_TASKS) {
    throw taskError('LOCAL_AGENT_TASK_LIMIT', `Task store exceeds the ${MAX_LOCAL_AGENT_TASKS}-record limit.`)
  }

  const seenIds = new Set()
  let changed = false
  const tasks = parsed.tasks.map((source) => {
    const task = normalizeTask(source, seenIds)
    if ((source.events || []).length > MAX_LOCAL_AGENT_TASK_EVENTS) changed = true
    if (recoverRunning && task.status === 'Running') {
      task.status = 'Interrupted'
      task.error = 'Task was running when the application stopped.'
      task.updatedAt = now()
      appendEvent(task, makeEvent({ type: 'interrupted', status: 'Interrupted', fromStatus: 'Running', detail: task.error }))
      changed = true
    }
    return task
  })
  const document = makeDocument(tasks)
  if (changed) await writeDocument(file, document)
  return document
}

async function withFileQueue(file, operation) {
  const resolved = path.resolve(file)
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const previous = fileQueues.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  const queued = previous.catch(() => {}).then(() => current)
  fileQueues.set(key, queued)
  await previous.catch(() => {})
  try { return await operation() }
  finally {
    release()
    if (fileQueues.get(key) === queued) fileQueues.delete(key)
  }
}

export async function recoverLocalAgentTaskStore({ dataDir } = {}) {
  const file = resolveTasksFile(dataDir)
  return await withFileQueue(file, async () => {
    const document = await loadDocument(file, { recoverRunning: true })
    return jsonClone(document.tasks, 'Recovered task list')
  })
}

export async function createLocalAgentTask({ dataDir, task = {} } = {}) {
  const file = resolveTasksFile(dataDir)
  return await withFileQueue(file, async () => {
    if (!isPlainObject(task)) throw taskError('LOCAL_AGENT_TASK_INVALID', 'Task must be a plain object.')
    const input = jsonClone(task, 'Task')
    const taskId = validateTaskId(Object.hasOwn(input, 'id') ? input.id : `local_agent_${crypto.randomUUID()}`)
    const status = input.status === undefined ? 'Queued' : validateStatus(input.status)
    if (status !== 'Queued') throw taskError('LOCAL_AGENT_TASK_INVALID_STATUS', 'New tasks must start in Queued status.')
    for (const key of ['events', 'createdAt', 'updatedAt', 'schemaVersion']) {
      if (Object.hasOwn(input, key)) throw taskError('LOCAL_AGENT_TASK_INVALID', `${key} is managed by the task store.`)
    }

    const document = await loadDocument(file)
    if (document.tasks.length >= MAX_LOCAL_AGENT_TASKS) {
      throw taskError('LOCAL_AGENT_TASK_LIMIT', `The task store is limited to ${MAX_LOCAL_AGENT_TASKS} records.`)
    }
    if (document.tasks.some((item) => item.id === taskId)) {
      throw taskError('LOCAL_AGENT_TASK_DUPLICATE_ID', `Task ID already exists: ${taskId}`)
    }

    const timestamp = now()
    const created = {
      ...input,
      id: taskId,
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
      events: [makeEvent({ type: 'created', status, detail: 'Task created.' })]
    }
    document.tasks.push(created)
    await writeDocument(file, document)
    return jsonClone(created, 'Task')
  })
}

export async function getLocalAgentTask({ dataDir, taskId } = {}) {
  const file = resolveTasksFile(dataDir)
  const id = validateTaskId(taskId)
  return await withFileQueue(file, async () => {
    const document = await loadDocument(file)
    const task = document.tasks.find((item) => item.id === id)
    return task ? jsonClone(task, 'Task') : null
  })
}

export async function listLocalAgentTasks({ dataDir } = {}) {
  const file = resolveTasksFile(dataDir)
  return await withFileQueue(file, async () => {
    const document = await loadDocument(file)
    return jsonClone([...document.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), 'Task list')
  })
}

export async function updateLocalAgentTask({ dataDir, taskId, patch = {}, event } = {}) {
  const file = resolveTasksFile(dataDir)
  const id = validateTaskId(taskId)
  if (!isPlainObject(patch)) throw taskError('LOCAL_AGENT_TASK_INVALID', 'Task patch must be a plain object.')
  const changes = jsonClone(patch, 'Task patch')
  for (const key of ['id', 'events', 'createdAt', 'updatedAt', 'schemaVersion']) {
    if (Object.hasOwn(changes, key)) throw taskError('LOCAL_AGENT_TASK_INVALID', `${key} is managed by the task store.`)
  }

  return await withFileQueue(file, async () => {
    const document = await loadDocument(file)
    const task = document.tasks.find((item) => item.id === id)
    if (!task) return null

    const previousStatus = task.status
    const nextStatus = Object.hasOwn(changes, 'status') ? validateStatus(changes.status) : previousStatus
    if (nextStatus !== previousStatus && !transitions.get(previousStatus).has(nextStatus)) {
      throw taskError('LOCAL_AGENT_TASK_INVALID_TRANSITION', `Task status cannot move from ${previousStatus} to ${nextStatus}.`)
    }
    Object.assign(task, changes, { updatedAt: now() })
    if (event !== undefined) {
      const input = typeof event === 'string' ? { detail: event } : event
      if (!isPlainObject(input)) throw taskError('LOCAL_AGENT_TASK_INVALID', 'Task event must be a string or plain object.')
      appendEvent(task, makeEvent({ ...input, status: task.status }))
    } else if (nextStatus !== previousStatus) {
      appendEvent(task, makeEvent({
        type: 'status_changed',
        status: nextStatus,
        fromStatus: previousStatus,
        detail: `Task status changed from ${previousStatus} to ${nextStatus}.`
      }))
    }
    await writeDocument(file, document)
    return jsonClone(task, 'Task')
  })
}
