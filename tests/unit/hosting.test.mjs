import { describe, expect, it } from 'vitest'
import {
  HOSTING_STRATEGIES, HOSTING_INSPECTION_DEPTHS, HOSTING_MIN_INTERVAL_MINUTES, HOSTING_MAX_INTERVAL_MINUTES,
  defaultHostingPolicy, normalizeHostingPolicy, applyStrategyPreset, getHostingPolicy,
  hostingStatus, nextInspectionDueAt, recordHostingRun, summarizeFindings
} from '../../server/services/hosting.mjs'

describe('hosting policy', () => {
  it('defaults to a disabled observe policy at a 30 minute interval', () => {
    const policy = defaultHostingPolicy()
    expect(policy).toMatchObject({ enabled: false, strategy: 'observe', intervalMinutes: 30, autoPush: false, autoMerge: false, autoPublish: false, requireApprovalForHighRisk: true })
    expect(normalizeHostingPolicy(null)).toEqual(policy)
  })

  it('presets delivery gates when a strategy is applied', () => {
    const maintain = applyStrategyPreset(normalizeHostingPolicy({ strategy: 'maintain' }), 'maintain')
    expect(maintain).toMatchObject({ strategy: 'maintain', autoPush: true, autoPullRequest: true, autoMerge: false, autoPublish: false })
    const autonomous = applyStrategyPreset(normalizeHostingPolicy({}), 'autonomous')
    expect(autonomous).toMatchObject({ strategy: 'autonomous', autoPush: true, autoPullRequest: true, autoMerge: true, autoPublish: true })
    const observe = applyStrategyPreset(normalizeHostingPolicy({ autoPush: true }), 'observe')
    expect(observe).toMatchObject({ strategy: 'observe', autoPush: false, autoPublish: false })
  })

  it('keeps explicit user flags when normalizing unknown values', () => {
    const policy = normalizeHostingPolicy({
      enabled: true, strategy: 'not-a-strategy', intervalMinutes: 99999,
      autoPush: true, autoPublish: true, closeIssueAfterRelease: false, requireApprovalForHighRisk: false
    })
    expect(policy.strategy).toBe('observe')
    expect(policy.intervalMinutes).toBe(30)
    expect(policy.enabled).toBe(true)
    expect(policy.autoPush).toBe(true)
    expect(policy.closeIssueAfterRelease).toBe(false)
    expect(policy.requireApprovalForHighRisk).toBe(false)
  })

  it('clamps the inspection interval to the allowed range', () => {
    expect(normalizeHostingPolicy({ intervalMinutes: 15 }).intervalMinutes).toBe(15)
    expect(normalizeHostingPolicy({ intervalMinutes: 120 }).intervalMinutes).toBe(120)
    expect(normalizeHostingPolicy({ intervalMinutes: 4 }).intervalMinutes).toBe(30)
    expect(normalizeHostingPolicy({ intervalMinutes: 1441 }).intervalMinutes).toBe(30)
    expect(normalizeHostingPolicy({ intervalMinutes: '45' }).intervalMinutes).toBe(45)
  })

  it('exposes the spec presets and inspection depths', () => {
    expect(HOSTING_STRATEGIES).toEqual(['observe', 'maintain', 'autonomous'])
    expect(HOSTING_INSPECTION_DEPTHS).toEqual(['light', 'full'])
    expect(HOSTING_MIN_INTERVAL_MINUTES).toBeLessThanOrEqual(15)
    expect(HOSTING_MAX_INTERVAL_MINUTES).toBeGreaterThanOrEqual(120)
  })
})

describe('hosting status and scheduling helpers', () => {
  it('derives status from project records', () => {
    const project = {
      hosting: { enabled: true, strategy: 'maintain', intervalMinutes: 60, lastInspectionAt: '2026-11-13T08:00:00.000Z', lastOutcome: { status: 'Success' }, currentTaskId: 'nexus_agent_1' },
      localWorkspace: { status: 'ready', cachePath: '/tmp/cache' }
    }
    const status = hostingStatus(project)
    expect(status.enabled).toBe(true)
    expect(status.lastInspectionAt).toBe('2026-11-13T08:00:00.000Z')
    expect(status.currentTaskId).toBe('nexus_agent_1')
    expect(status.workspace.status).toBe('ready')
  })

  it('computes the next inspection due time from the last inspection', () => {
    const policy = { enabled: true, intervalMinutes: 30 }
    const project = { hosting: { lastInspectionAt: '2026-11-13T08:00:00.000Z' } }
    expect(nextInspectionDueAt(policy, project)).toBe('2026-11-13T08:30:00.000Z')
    expect(nextInspectionDueAt({ enabled: false, intervalMinutes: 30 }, project)).toBeNull()
  })

  it('records hosting runs with a bounded history', () => {
    const state = { hostingRuns: [] }
    for (let index = 0; index < 1200; index += 1) recordHostingRun(state, { id: `run_${index}` })
    expect(state.hostingRuns.length).toBe(1000)
    expect(state.hostingRuns[0].id).toBe('run_1199')
    expect(state.hostingRuns[999].id).toBe('run_200')
  })

  it('summarizes findings by priority', () => {
    const summary = summarizeFindings([
      { priority: 'P0' }, { priority: 'P2' }, { priority: 'P2' }, { priority: 'P4' }
    ])
    expect(summary).toEqual({ total: 4, byPriority: { P0: 1, P1: 0, P2: 2, P3: 0, P4: 1 } })
  })
})

describe('getHostingPolicy', () => {
  it('always returns a complete policy even for empty projects', () => {
    const policy = getHostingPolicy({})
    expect(policy).toEqual(defaultHostingPolicy())
    expect(getHostingPolicy(undefined)).toEqual(defaultHostingPolicy())
    expect(getHostingPolicy({ hosting: { enabled: true, intervalMinutes: 15 } })).toMatchObject({ enabled: true, intervalMinutes: 15, strategy: 'observe' })
  })
})
