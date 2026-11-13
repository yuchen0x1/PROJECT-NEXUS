// Keep an active task's reference valid while polling or reclassification updates metadata.
export function upsertIssueActivity(store, entry, limit = 200) {
  const existing = store.activity.find((item) => item.number === entry.number)
  const saved = existing ? Object.assign(existing, entry, { seenAt: existing.seenAt }) : entry
  if (!existing) store.activity.unshift(saved)
  store.activity.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
  store.activity = store.activity.slice(0, limit)
  return saved
}
