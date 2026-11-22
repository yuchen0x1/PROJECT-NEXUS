import { describe, expect, it } from 'vitest'
import { runSetupBatch } from '../../src/desktop/setup-batch'

describe('repository setup batches', () => {
  it('bounds concurrency while processing every repository after an isolated failure', async () => {
    let running = 0, peak = 0
    const visited: string[] = []
    const result = await runSetupBatch(['a', 'b', 'c', 'd'], async (id) => {
      running++; peak = Math.max(peak, running); visited.push(id)
      await new Promise((resolve) => setTimeout(resolve, 10))
      running--
      if (id === 'b') throw new Error('No access')
    })
    expect(peak).toBe(2)
    expect(visited.sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(result.map((item) => item.status)).toEqual(['success', 'failed', 'success', 'success'])
    expect(result[1].error).toBe('No access')
  })

  it('retries unfinished items without repeating successful writes, retaining selection order', async () => {
    const visited: string[] = []
    const result = await runSetupBatch(['b', 'a', 'c'], async (id) => { visited.push(id) }, { previous: [{ id: 'a', status: 'success' }, { id: 'b', status: 'failed' }, { id: 'c', status: 'pending' }] })
    expect(visited).toEqual(['b', 'c'])
    expect(result.map((item) => item.id)).toEqual(['b', 'a', 'c'])
    expect(result.every((item) => item.status === 'success')).toBe(true)
  })

  it('stops new work and can resume while keeping requests already completed', async () => {
    let stop = false
    const visited: string[] = []
    const result = await runSetupBatch(['a', 'b', 'c'], async (id) => { visited.push(id); stop = true }, { concurrency: 1, shouldStop: () => stop })
    expect(visited).toEqual(['a'])
    expect(result.map((item) => item.status)).toEqual(['success', 'pending', 'pending'])
    const retry = await runSetupBatch(['a', 'b', 'c'], async (id) => { visited.push(id) }, { previous: result })
    expect(visited).toEqual(['a', 'b', 'c'])
    expect(retry.every((item) => item.status === 'success')).toBe(true)
  })

  it('reports immutable progress snapshots and deduplicates repeated selections', async () => {
    const snapshots: string[][] = []
    const results = await runSetupBatch(['a', 'a', 'b'], async () => {}, { onProgress: (items) => snapshots.push(items.map((item) => item.status)) })
    expect(results).toHaveLength(2)
    expect(snapshots[0]).toEqual(['pending', 'pending'])
    expect(snapshots.at(-1)).toEqual(['success', 'success'])
  })

  it('does not invent success for an empty or cancelled batch', async () => {
    expect(await runSetupBatch([], async () => { throw new Error('must not run') })).toEqual([])
    const result = await runSetupBatch(['a'], async () => { throw new Error('must not run') }, { shouldStop: () => true })
    expect(result[0].status).toBe('pending')
  })
})
