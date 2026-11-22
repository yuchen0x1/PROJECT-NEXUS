export type OverviewPoint = { x: number; y: number }
export type OverviewNode = OverviewPoint & { id: string; kind: 'account' | 'service' | 'repository'; width: number; height: number }

export const OVERVIEW_SERVICE_POSITIONS: Record<string, OverviewPoint> = {
  ai: { x: -255, y: -15 }, inspection: { x: -150, y: -175 }, analysis: { x: 120, y: -180 },
  execution: { x: 265, y: -15 }, verification: { x: 175, y: 155 }, delivery: { x: -70, y: 195 }, research: { x: -265, y: 155 }
}

/** Stable concentric ellipses, with measured rectangle overlap checks. */
export function layoutOverview(ids: string[]): { nodes: OverviewNode[]; width: number; height: number } {
  const nodes: OverviewNode[] = [{ id: 'account', kind: 'account', x: 0, y: 0, width: 152, height: 152 }]
  for (const [id, point] of Object.entries(OVERVIEW_SERVICE_POSITIONS)) nodes.push({ id: `service:${id}`, kind: 'service', ...point, width: 150, height: 56 })
  let cursor = 0, ring = 0
  while (cursor < ids.length) {
    const rx = 480 + ring * 205, ry = 335 + ring * 120
    const candidates: OverviewNode[] = []
    for (let step = 0; step < 360; step += 3) {
      const angle = (step - 90 + (ring % 2 ? 8 : 0)) * Math.PI / 180
      const point = { x: Math.round(Math.cos(angle) * rx), y: Math.round(Math.sin(angle) * ry) }
      const overlaps = [...nodes, ...candidates].some((other) => Math.abs(point.x - other.x) < (184 + other.width) / 2 + 18 && Math.abs(point.y - other.y) < (58 + other.height) / 2 + 16)
      if (!overlaps) candidates.push({ id: 'candidate', kind: 'repository', ...point, width: 184, height: 58 })
    }
    const count = Math.min(ids.length - cursor, candidates.length)
    // Spread short lists around the full orbit instead of packing one corner.
    for (let index = 0; index < count; index++) nodes.push({ ...candidates[Math.floor(index * candidates.length / count)], id: `repository:${ids[cursor + index]}` })
    cursor += count; ring++
  }
  const width = Math.max(760, ...nodes.map((node) => (Math.abs(node.x) + node.width / 2 + 40) * 2))
  const height = Math.max(560, ...nodes.map((node) => (Math.abs(node.y) + node.height / 2 + 40) * 2))
  return { nodes, width, height }
}

export function fitOverview(world: { width: number; height: number }, viewport: { width: number; height: number }) {
  return Math.max(0.08, Math.min(1.1, (viewport.width - 40) / world.width, (viewport.height - 40) / world.height))
}
