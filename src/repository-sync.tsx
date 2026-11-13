import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { api } from './api'

export const REPOSITORY_SYNC_EVENT = 'nexus:repository-sync'
let pending: Promise<Awaited<ReturnType<typeof api.syncRepositories>>> | null = null

export function syncRepositoriesAndWait(automatic = false) {
  if (pending) return pending
  pending = (async () => {
    const response = await api.syncRepositories(automatic)
    if (!response.task) return response
    window.dispatchEvent(new Event(REPOSITORY_SYNC_EVENT))
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      const task = (await api.tasks()).tasks.find((item) => item.id === response.task!.id)
      if (task?.status === 'Success') {
        window.dispatchEvent(new Event(REPOSITORY_SYNC_EVENT))
        return { ...response, task }
      }
      if (task && ['Failed', 'Blocked', 'Cancelled'].includes(task.status)) throw new Error(task.error || 'Repository sync failed.')
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
    throw new Error('Repository sync is still running. Check the task center.')
  })().finally(() => { pending = null; window.dispatchEvent(new Event(REPOSITORY_SYNC_EVENT)) })
  return pending
}

// One coordinator for the desktop or web root, even while individual pages
// mount/unmount. Fast task polling reads only the local API, not GitHub.
export function RepositorySyncCoordinator({ children }: { children: ReactNode }) {
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>, running = false
    const schedule = (delay: number) => { clearTimeout(timer); if (!stopped) timer = setTimeout(() => void tick(), Math.max(1000, delay)) }
    const tick = async () => {
      if (stopped || running || document.visibilityState === 'hidden') return
      running = true
      try {
        let status = await api.repositorySyncStatus()
        if (status.configured && (!status.nextSyncAt || Date.parse(status.nextSyncAt) <= Date.now())) {
          await syncRepositoriesAndWait(true)
          status = await api.repositorySyncStatus()
        }
        schedule(status.configured ? Math.max(1000, (Date.parse(status.nextSyncAt || '') || Date.now() + 60_000) - Date.now()) : 60_000)
      } catch { schedule(60_000) }
      finally { running = false }
    }
    const resume = () => { clearTimeout(timer); if (document.visibilityState !== 'hidden') schedule(1000) }
    window.addEventListener(REPOSITORY_SYNC_EVENT, resume)
    document.addEventListener('visibilitychange', resume)
    schedule(1000)
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener(REPOSITORY_SYNC_EVENT, resume); document.removeEventListener('visibilitychange', resume) }
  }, [])
  return children
}
