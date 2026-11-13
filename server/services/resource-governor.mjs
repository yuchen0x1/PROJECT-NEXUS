import os from 'node:os'
import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

/** Read-only measurements. Never changes system power, account, ACL or network settings. */
export class ResourceGovernor {
  constructor({ dataDir, minimumFreeBytes = 1024 ** 3, maximumConcurrency = 4, system = os, disk = fs.statfs, processMetrics = () => ({ memory: process.memoryUsage(), usage: process.resourceUsage(), uptimeSeconds: process.uptime() }) }) {
    this.dataDir = dataDir; this.minimumFreeBytes = minimumFreeBytes
    this.maximumConcurrency = maximumConcurrency; this.system = system; this.disk = disk
    this.processMetrics = processMetrics; this.previousCpu = null; this.samples = []
    this.last = null; this.lastAt = 0; this.pending = null
  }
  async sample({ force = false } = {}) {
    if (!force && this.last && performance.now() - this.lastAt < 2000) return structuredClone(this.last)
    if (this.pending) return this.pending
    this.pending = this.measure().finally(() => { this.pending = null })
    return this.pending
  }
  async measure() {
    const cpu = this.system.cpus().reduce((sum, item) => ({ idle: sum.idle + item.times.idle, total: sum.total + Object.values(item.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 })
    const delta = this.previousCpu ? cpu.total - this.previousCpu.total : 0
    const cpuPercent = delta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - this.previousCpu.idle) / delta))) : null
    this.previousCpu = cpu
    const physicalBytes = this.system.totalmem(), freeMemoryBytes = this.system.freemem()
    let diskFreeBytes = null, diskAvailable = true
    try { const stat = await this.disk(this.dataDir); diskFreeBytes = Number(stat.bavail) * Number(stat.bsize) }
    catch { diskAvailable = false }
    const own = this.processMetrics()
    const pressure = freeMemoryBytes < Math.max(512 * 1024 ** 2, physicalBytes * 0.1) || (cpuPercent !== null && cpuPercent > 90)
    const blocked = diskFreeBytes !== null && diskFreeBytes < this.minimumFreeBytes
    const recommended = Math.min(this.maximumConcurrency, Math.max(1, Math.floor((this.system.availableParallelism?.() || this.system.cpus().length) / 2)), Math.max(1, Math.floor(freeMemoryBytes / (512 * 1024 ** 2))))
    const result = { at: new Date().toISOString(), cpuPercent, physicalBytes, freeMemoryBytes, diskFreeBytes, node: { pid: process.pid, rssBytes: own.memory.rss, heapUsedBytes: own.memory.heapUsed, fsReadOperations: own.usage.fsRead, fsWriteOperations: own.usage.fsWrite, uptimeSeconds: own.uptimeSeconds }, allowed: !blocked && diskAvailable, concurrency: pressure ? 1 : recommended, pressure, reason: !diskAvailable ? 'DISK_METRICS_UNAVAILABLE' : blocked ? 'DISK_SPACE_LOW' : pressure ? 'RESOURCE_PRESSURE' : null, network: 'not-probed' }
    this.samples.push(result); this.samples = this.samples.slice(-120)
    this.last = result; this.lastAt = performance.now()
    return structuredClone(result)
  }
  history() { return structuredClone(this.samples) }
}
