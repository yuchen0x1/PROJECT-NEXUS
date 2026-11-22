export type SetupBatchItem = { id: string; status: 'pending' | 'running' | 'success' | 'failed'; error?: string }

/** Run a bounded batch, keeping successful work when a failed item is retried. */
export async function runSetupBatch(ids: string[], operation: (id: string) => Promise<void>, options: {
  previous?: SetupBatchItem[]
  concurrency?: number
  shouldStop?: () => boolean
  onProgress?: (items: SetupBatchItem[]) => void
} = {}): Promise<SetupBatchItem[]> {
  const succeeded = new Set(options.previous?.filter((item) => item.status === 'success').map((item) => item.id))
  const items: SetupBatchItem[] = [...new Set(ids)].map((id) => ({ id, status: succeeded.has(id) ? 'success' : 'pending' }))
  const publish = () => options.onProgress?.(items.map((item) => ({ ...item })))
  let cursor = 0
  publish()
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, Math.min(4, options.concurrency || 2))) }, async () => {
    while (cursor < items.length && !options.shouldStop?.()) {
      const item = items[cursor++]
      if (item.status === 'success') continue
      item.status = 'running'; publish()
      try { await operation(item.id); item.status = 'success' }
      catch (cause) { item.status = 'failed'; item.error = cause instanceof Error ? cause.message : 'Operation failed' }
      publish()
    }
  }))
  return items
}
