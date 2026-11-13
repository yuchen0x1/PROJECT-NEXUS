import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppUpdater } from '../../desktop/auto-update.mjs'

const instances = []
afterEach(() => { for (const instance of instances.splice(0)) instance.dispose(); vi.useRealTimers() })
function setup(options = {}) {
  const updater = new EventEmitter()
  updater.setFeedURL = vi.fn()
  updater.checkForUpdates = vi.fn(async () => { updater.emit('update-available', { version: '0.8.1' }) })
  updater.downloadUpdate = vi.fn(async () => { updater.emit('download-progress', { percent: 42 }); updater.emit('update-downloaded') })
  updater.quitAndInstall = vi.fn()
  const prepareInstall = vi.fn(async () => {})
  const recoverInstall = vi.fn(async () => {})
  const onState = vi.fn()
  const controller = createAppUpdater({ updater, currentVersion: '0.8.0', enabled: true, prepareInstall, recoverInstall, onState, ...options })
  instances.push(controller)
  return { updater, controller, prepareInstall, recoverInstall, onState }
}

describe('NEXUS desktop updater', () => {
  it('uses the official feed and requires a click before downloading or installing', async () => {
    const { updater, controller } = setup()
    await controller.check()
    expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: 'github', owner: 'yuchen0x1', repo: 'PROJECT-NEXUS' })
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
    expect(controller.getStatus()).toMatchObject({ phase: 'available', version: '0.8.1' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('downloads once, saves state before installing, and requests silent installation with relaunch', async () => {
    const { updater, controller, prepareInstall, onState } = setup()
    await controller.check()
    updater.quitAndInstall.mockImplementation(() => expect(prepareInstall).toHaveBeenCalledOnce())
    controller.update(); controller.update()
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true))
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(onState.mock.calls.map(([state]) => state.phase)).toContain('downloading')
    expect(onState.mock.calls.map(([state]) => state.percent)).toContain(42)
    expect(controller.getStatus().phase).toBe('installing')
  })

  it('does not permit installation before discovering an update', async () => {
    const { updater, controller } = setup()
    controller.update()
    await Promise.resolve()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('keeps development and smoke sessions offline', async () => {
    vi.useFakeTimers()
    const { updater, controller } = setup({ enabled: false })
    controller.start(); await controller.check(); controller.update()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(controller.getStatus().phase).toBe('disabled')
    expect(updater.setFeedURL).not.toHaveBeenCalled()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checks after startup and periodically, preserving an offered update', async () => {
    vi.useFakeTimers()
    const { updater, controller } = setup()
    controller.start()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    updater.emit('update-not-available')
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('deduplicates checks and recovers after a network or missing-manifest failure', async () => {
    const { updater, controller } = setup()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('404 latest.yml secret-url'))
    await Promise.all([controller.check(), controller.check()])
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(controller.getStatus()).toMatchObject({ phase: 'error', retry: 'check', errorCode: 'check' })
    expect(JSON.stringify(controller.getStatus())).not.toContain('secret-url')
    await controller.check()
    expect(controller.getStatus().phase).toBe('available')
  })

  it('never installs after download integrity verification fails and permits retry', async () => {
    const { updater, controller, prepareInstall } = setup()
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.emit('error', new Error('sha512 mismatch'))
      throw new Error('sha512 mismatch')
    })
    await controller.check(); controller.update()
    await vi.waitFor(() => expect(controller.getStatus().phase).toBe('error'))
    expect(prepareInstall).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(controller.getStatus().retry).toBe('update')
    controller.update()
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledOnce())
  })

  it('does not install when the downloader did not emit verified completion', async () => {
    const { updater, controller } = setup()
    updater.downloadUpdate.mockResolvedValueOnce([])
    await controller.check(); controller.update()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(controller.getStatus()).toMatchObject({ phase: 'error', errorCode: 'download' })
  })

  it('restores the service after a synchronous installer error and reuses the verified download on retry', async () => {
    const { updater, controller, recoverInstall } = setup()
    updater.quitAndInstall.mockImplementationOnce(() => { updater.emit('error', new Error('installer spawn failed')) })
    await controller.check(); controller.update()
    await vi.waitFor(() => expect(controller.getStatus()).toMatchObject({ phase: 'error', errorCode: 'install', retry: 'update' }))
    expect(recoverInstall).toHaveBeenCalledOnce()
    controller.update()
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledTimes(2))
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('recovers from a preparation failure before handing off to the installer', async () => {
    const { updater, controller, recoverInstall } = setup({ prepareInstall: async () => { throw new Error('shutdown failed') } })
    await controller.check(); controller.update()
    await vi.waitFor(() => expect(controller.getStatus().errorCode).toBe('install'))
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(recoverInstall).toHaveBeenCalledOnce()
  })

  it('blocks queued updater quits and duplicate actions while the service recovers', async () => {
    let finishRecovery
    const { updater, controller } = setup({ recoverInstall: () => new Promise((resolve) => { finishRecovery = resolve }) })
    updater.quitAndInstall.mockImplementationOnce(() => updater.emit('error', new Error('spawn failed')))
    await controller.check(); controller.update()
    await vi.waitFor(() => expect(typeof finishRecovery).toBe('function'))
    expect(controller.isRecovering()).toBe(true)
    controller.update(); await controller.check()
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    finishRecovery()
    await vi.waitFor(() => expect(controller.getStatus().phase).toBe('error'))
    expect(controller.isRecovering()).toBe(false)
  })
})
