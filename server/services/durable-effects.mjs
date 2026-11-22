import crypto from 'node:crypto'

export function effectKey(endpoint, options = {}) {
  return crypto.createHash('sha256').update(JSON.stringify([options.method || 'POST', endpoint, options.body || null])).digest('hex')
}

// save() is the owning store's serialized, atomic durability barrier.
export async function durableEffect({ job, endpoint, options = {}, save, perform, guard = () => {} }) {
  job.operations ||= []
  const key = effectKey(endpoint, options)
  const existing = job.operations.find((entry) => entry.key === key)
  if (existing?.status === 'Confirmed') return structuredClone(existing.receipt)
  if (existing) throw Object.assign(new Error('An earlier remote write needs reconciliation before retry.'), { code: 'REMOTE_EFFECT_UNCERTAIN' })
  await guard()
  const entry = { key, endpoint, method: options.method || 'POST', body: options.body || null, verifiedHeadSha: job.checkpoint?.delivery?.commitSha || null, status: 'Prepared', preparedAt: new Date().toISOString() }
  // Contains app-generated delivery text only; credentials are never included.
  job.operations.push(entry)
  await save()
  await guard()
  try {
    const receipt = await perform()
    entry.status = 'Confirmed'
    entry.receipt = structuredClone(receipt ?? null)
    entry.confirmedAt = new Date().toISOString()
    await save()
    return receipt
  } catch (error) {
    entry.status = 'Uncertain'
    entry.errorCode = error.code || (error.status ? `HTTP_${error.status}` : 'REMOTE_RESULT_UNKNOWN')
    await save()
    throw error
  }
}

export async function reconcileEffect(entry, request) {
  const body = typeof entry.body === 'string' ? JSON.parse(entry.body) : entry.body || {}
  let receipt = null
  if (entry.endpoint.startsWith('git:')) {
    receipt = await request(`/repos/${entry.repository}/git/ref/heads/${entry.branch}`)
    if (receipt.object?.sha !== entry.commitSha) return false
  } else if (entry.endpoint.startsWith('upload:')) {
    const assets = await request(`/repos/${entry.repository}/releases/${entry.releaseId}/assets?per_page=100`)
    receipt = assets.find((asset) => asset.name === entry.name && asset.size === entry.size && asset.digest === `sha256:${entry.sha256}`)
  } else if (/\/pulls$/.test(entry.endpoint)) {
    const [owner] = entry.endpoint.split('/').slice(2, 3)
    const pulls = await request(`${entry.endpoint}?state=all&head=${encodeURIComponent(`${owner}:${body.head}`)}&base=${encodeURIComponent(body.base)}&per_page=100`)
    receipt = pulls.find((pull) => pull.head?.ref === body.head && pull.base?.ref === body.base)
    if (receipt && entry.verifiedHeadSha && receipt.head?.sha !== entry.verifiedHeadSha) return false
  } else if (/\/merge$/.test(entry.endpoint)) {
    const pull = await request(entry.endpoint.replace(/\/merge$/, ''))
    if (pull.merged !== true || pull.head?.sha !== body.sha) return false
    receipt = { merged: true, sha: pull.merge_commit_sha }
  } else if (/\/releases$/.test(entry.endpoint)) {
    receipt = await request(`${entry.endpoint}/tags/${encodeURIComponent(body.tag_name)}`)
    if (receipt.tag_name !== body.tag_name) return false
    if (body.target_commitish && receipt.target_commitish !== body.target_commitish) return false
  } else if (/\/releases\/\d+$/.test(entry.endpoint)) {
    receipt = await request(entry.endpoint)
    if (body.draft === false && (receipt.draft !== false || !receipt.published_at)) return false
  } else if (/\/comments$/.test(entry.endpoint)) {
    const comments = await request(`${entry.endpoint}?per_page=100`)
    receipt = comments.find((comment) => comment.body === body.body)
  } else if (/\/issues\/\d+$/.test(entry.endpoint) && body.state) {
    receipt = await request(entry.endpoint)
    if (receipt.state !== body.state) return false
  }
  if (!receipt) return false
  entry.receipt = receipt
  entry.status = 'Confirmed'
  entry.confirmedAt = new Date().toISOString()
  entry.reconciled = true
  return true
}
