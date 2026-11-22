import { createRoot } from 'react-dom/client'
import { RepositorySyncCoordinator, REPOSITORY_SYNC_EVENT, syncRepositoriesAndWait } from '../../src/repository-sync'

let syncs = 0, reads = 0, hidden = false
const state = { configured: true, running: false, lastSuccessAt: null, nextSyncAt: null, lastErrorCode: null, intervalMs: 60_000 }
window.__syncFixture = {
  state,
  counts: () => ({ syncs, reads }),
  sync: syncRepositoriesAndWait,
  hide(value) { hidden = value; document.dispatchEvent(new Event('visibilitychange')) },
  change(patch) { Object.assign(state, patch); window.dispatchEvent(new Event(REPOSITORY_SYNC_EVENT)) }
}
Object.defineProperty(document, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
window.nexusDesktop = { requestApi: async ({ url }) => {
  if (url === '/api/repository-sync') { reads++; return { status: 200, body: { ...state } } }
  if (url === '/api/tasks/sync-repositories') {
    syncs++
    state.lastSuccessAt = new Date().toISOString(); state.nextSyncAt = new Date(Date.now() + 60_000).toISOString()
    return { status: 202, body: { task: { id: `sync-${syncs}` } } }
  }
  if (url === '/api/tasks') return { status: 200, body: { tasks: [{ id: `sync-${syncs}`, status: 'Success' }] } }
  throw new Error('Unexpected fixture API request')
} }
createRoot(document.getElementById('root')!).render(<RepositorySyncCoordinator><p>Repository sync timing fixture</p></RepositorySyncCoordinator>)
