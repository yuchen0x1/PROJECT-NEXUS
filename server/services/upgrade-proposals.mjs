import crypto from 'node:crypto'

export function buildUpgradeProposals(report) {
  if (report.analysis?.noActionRequired) return []
  return (report.analysis?.upgradeProposals || []).map((proposal) => {
    const evidence = (proposal.evidence || []).filter((item) => (report.candidates || []).some((candidate) => candidate.fullName === item.repository && candidate.sources?.some((source) => source.path === item.path && source.sha === item.sha && /^[a-f0-9]{40}$/.test(source.sha))))
    const provenance = evidence.map((item) => ({ ...item, license: report.candidates.find((candidate) => candidate.fullName === item.repository)?.license || null }))
    const content = { title: proposal.title, rationale: proposal.rationale, priority: proposal.priority, evidence: provenance }
    return { ...content, id: crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex'), status: evidence.length ? 'Draft' : 'Blocked', blockedReason: evidence.length ? null : 'No verified source references support this proposal.', createdAt: new Date().toISOString(), licenseReview: 'Required', applied: false }
  })
}

export function reviewUpgradeProposal(proposal, { decision, confirm, licenseReviewed, actor }) {
  if (confirm !== true || !['approve', 'reject'].includes(decision)) throw Object.assign(new Error('An explicit review decision is required.'), { code: 'PROPOSAL_REVIEW_REQUIRED' })
  if (proposal.status !== 'Draft') throw Object.assign(new Error('Only evidence-backed draft proposals can be reviewed.'), { code: 'PROPOSAL_NOT_REVIEWABLE' })
  if (decision === 'approve' && licenseReviewed !== true) throw Object.assign(new Error('Review source licenses before approving a proposal.'), { code: 'LICENSE_REVIEW_REQUIRED' })
  Object.assign(proposal, { status: decision === 'approve' ? 'Approved' : 'Rejected', licenseReview: licenseReviewed ? 'ReviewedByUser' : 'Required', reviewedAt: new Date().toISOString(), reviewedBy: actor })
  // Approval makes a proposal reviewable input to an existing task; it never executes code.
  return proposal
}
