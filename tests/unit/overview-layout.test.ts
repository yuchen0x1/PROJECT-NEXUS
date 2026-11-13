import { describe, expect, it } from 'vitest'
import { fitOverview, layoutOverview } from '../../src/desktop/overview-layout'

describe('account and repository map layout', () => {
  it.each([0, 1, 26, 150])('places %i repositories without overlapping nodes and keeps the account centered', (total) => {
    const ids = Array.from({ length: total }, (_, i) => `repository-${i}`)
    const layout = layoutOverview(ids)
    expect(layout.nodes.filter((node) => node.kind === 'repository')).toHaveLength(total)
    expect(layout.nodes.find((node) => node.kind === 'account')).toMatchObject({ x: 0, y: 0 })
    for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i], b = layout.nodes[j]
      expect(Math.abs(a.x - b.x) >= (a.width + b.width) / 2 || Math.abs(a.y - b.y) >= (a.height + b.height) / 2).toBe(true)
    }
    expect(layoutOverview(ids)).toEqual(layout)
    expect(fitOverview(layout, { width: 900, height: 500 })).toBeGreaterThanOrEqual(0.08)
  })
})
