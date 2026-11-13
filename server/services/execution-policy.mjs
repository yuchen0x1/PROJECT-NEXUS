import { AsyncLocalStorage } from 'node:async_hooks'

const context = new AsyncLocalStorage()
export function withExecutionPolicy(policy, operation) { return context.run(policy, operation) }
export function assertExecutionAllowed() { context.getStore()?.assertAllowed() }
export function assertTrustedRepository(project) {
  if (project?.hosting?.executionMode !== 'trusted-local') throw Object.assign(new Error('Repository scripts are blocked. Explicitly authorize trusted local execution for this repository; an OS sandbox is not configured.'), { code: 'REPOSITORY_EXECUTION_NOT_TRUSTED' })
}
