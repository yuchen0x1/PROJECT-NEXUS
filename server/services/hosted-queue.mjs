import crypto from 'node:crypto'

const ACTIVE = new Set(['Queued', 'Running', 'Interrupted'])

export function queueHostedJob(state, { projectId, repository, issueNumber, priority = 'P2', source = 'manual' }) {
  state.hostedJobs ||= []
  const existing = state.hostedJobs.find((job) => job.repository === repository && job.issueNumber === issueNumber && (ACTIVE.has(job.status) || (job.status === 'Blocked' && (job.operations?.length || job.executionStatus === 'Succeeded'))))
  if (existing) return { job: existing, reused: true }
  if (state.hostedJobs.filter((job) => job.status === 'Queued').length >= 64) throw Object.assign(new Error('Hosted task queue is full.'), { code: 'HOSTED_QUEUE_FULL' })
  const job = { id: `hosted_${crypto.randomUUID()}`, projectId, repository, issueNumber, priority: /^P[0-4]$/.test(priority) ? priority : 'P2', source, status: 'Queued', createdAt: new Date().toISOString(), events: [] }
  state.hostedJobs.push(job)
  return { job, reused: false }
}

export function nextHostedJobIndex(pending, activeRepositories) {
  let selected = -1
  pending.forEach((item, index) => {
    if (activeRepositories.has(item.repoKey)) return
    if (selected < 0 || (item.job?.priority || 'P2') < (pending[selected].job?.priority || 'P2')) selected = index
  })
  return selected
}

export function recoverHostedJobs(state) {
  state.hostedJobs ||= []
  for (const job of state.hostedJobs) {
    if (job.status === 'Running') {
      // A crash may occur after GitHub accepted a write but before its receipt
      // was saved. Retain the evidence and require reconciliation, never replay.
      job.status = 'Interrupted'
      job.error = 'Review workspace and GitHub receipts before retrying interrupted delivery.'
    }
  }
  return state.hostedJobs.filter((job) => job.status === 'Queued')
}
