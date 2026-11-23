import { describe, expect, it } from 'vitest'
import {
  centerForLeaf,
  isRemotePage,
  NAV_CENTERS,
  REMOTE_NAV_PAGES
} from '../../src/nav/centers'

describe('PROJECT NEXUS 2.0 navigation registry', () => {
  it('defines exactly nine centers and preserves all 21 legacy leaves', () => {
    expect(NAV_CENTERS).toHaveLength(9)
    expect(REMOTE_NAV_PAGES).toHaveLength(21)

    const leaves = NAV_CENTERS.flatMap((center) => center.leaves)
    expect(new Set(leaves).size).toBe(21)
    expect(new Set(leaves)).toEqual(new Set(REMOTE_NAV_PAGES.map(({ page }) => page)))
  })

  it('keeps every default leaf inside its center', () => {
    for (const center of NAV_CENTERS) {
      expect(center.leaves).toContain(center.defaultLeaf)
      expect(centerForLeaf(center.defaultLeaf)).toBe(center)
    }
  })

  it('validates the complete legacy page contract', () => {
    for (const { page } of REMOTE_NAV_PAGES) {
      expect(isRemotePage(page)).toBe(true)
      expect(centerForLeaf(page).leaves).toContain(page)
    }

    expect(isRemotePage(null)).toBe(false)
    expect(isRemotePage('not-a-page')).toBe(false)
    expect(isRemotePage(42)).toBe(false)
  })
})
