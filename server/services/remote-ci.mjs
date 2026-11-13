export async function inspectRemoteCI({ request, repository, pullRequest, policy = {}, signal }) {
  const root = `/repos/${repository}`
  const pull = await request(`${root}/pulls/${pullRequest.number}`, { signal })
  if (pull.head?.sha !== pullRequest.headSha) return { passed: false, reason: 'pull request head changed after verification' }
  const sha = encodeURIComponent(pullRequest.headSha)
  // Read both provider mechanisms; a permission failure must block the merge.
  const checks = await request(`${root}/commits/${sha}/check-runs?per_page=100`, { signal })
  const statuses = await request(`${root}/commits/${sha}/status?per_page=100`, { signal })
  if (checks.total_count > 100 || statuses.total_count > 100) return { passed: false, reason: 'CI evidence exceeds the supported page limit; manual review required' }
  const latest = new Map()
  for (const run of checks.check_runs || []) {
    const key = `check:${run.name}`
    if (!latest.has(key) || latest.get(key).id < run.id) latest.set(key, { id: run.id, name: run.name, pending: run.status !== 'completed', passed: run.status === 'completed' && run.conclusion === 'success', url: run.html_url })
  }
  for (const status of statuses.statuses || []) {
    const key = `status:${status.context}`
    if (!latest.has(key) || latest.get(key).id < status.id) latest.set(key, { id: status.id, name: status.context, pending: status.state === 'pending', passed: status.state === 'success', url: status.target_url })
  }
  const results = [...latest.values()]
  const missing = (policy.requiredChecks || []).filter((name) => !results.some((item) => item.name === name && item.passed))
  if (results.some((item) => !item.passed && !item.pending)) return { passed: false, waiting: false, reason: 'remote CI failed', results }
  if (missing.length) return { passed: false, waiting: true, reason: `required CI checks missing or unsuccessful: ${missing.join(', ')}`, results }
  if (!results.length) return { passed: policy.allowNoCI === true, waiting: policy.allowNoCI !== true, reason: policy.allowNoCI ? 'explicit repository policy permits no remote CI' : 'remote CI did not run; explicit no-CI permission is required', results }
  return { passed: results.every((item) => item.passed), waiting: results.some((item) => item.pending), reason: results.every((item) => item.passed) ? 'remote CI passed on the tested head' : 'remote CI pending or failed', results, headSha: pullRequest.headSha, checkedAt: new Date().toISOString() }
}

export async function waitForRemoteCI(args, { timeoutMs = 180000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    args.signal?.throwIfAborted()
    const result = await inspectRemoteCI(args)
    if (result.passed || !result.waiting || Date.now() >= deadline) return result
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); args.signal.removeEventListener('abort', abort); reject(args.signal.reason || new Error('Cancelled')) }
      const timer = setTimeout(() => { args.signal?.removeEventListener('abort', abort); resolve() }, Math.min(intervalMs, Math.max(1, deadline - Date.now())))
      args.signal?.addEventListener('abort', abort, { once: true })
    })
  }
}
