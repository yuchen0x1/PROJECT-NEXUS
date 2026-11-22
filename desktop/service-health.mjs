export function createRestartBudget({ limit = 5, windowMs = 10 * 60_000, clock = Date.now } = {}) {
  let failures = []
  return {
    next() {
      const now = clock()
      failures = failures.filter((at) => now - at < windowMs)
      if (failures.length >= limit) return null
      failures.push(now)
      return { attempt: failures.length, delay: Math.min(30_000, 2_000 * 2 ** (failures.length - 1)) }
    }
  }
}
