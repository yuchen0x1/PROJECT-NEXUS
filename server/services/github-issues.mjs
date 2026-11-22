import { repositoryApiPath } from './github-paths.mjs'
import { fetchAllPages } from './github-pagination.mjs'

// PHASE 2: GitHub Issues API surface. Every function takes a `request`
// callable with the signature `(endpoint, options) => body` so callers can
// inject the legacy-token fetcher or an installation-token fetcher.

function issuesApiPath(fullName) {
  return `${repositoryApiPath(fullName)}/issues`
}

function requireIssueNumber(number) {
  const value = Number(number)
  if (!Number.isInteger(value) || value <= 0) throw Object.assign(new Error('A positive issue number is required.'), { code: 'ISSUE_NUMBER_INVALID' })
  return value
}

// GitHub returns pull requests on the issues endpoint; strip them by the
// presence of the `pull_request` key.
export function isRealIssue(issue) {
  return Boolean(issue && issue.number && !issue.pull_request)
}

export function sanitizeIssueText(value, maxLength = 8000) {
  const text = String(value || '').replace(/\r\n/g, '\n')
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n… [truncated]` : text
}

export function issuePublicSummary(issue) {
  if (!issue) return null
  return {
    number: issue.number,
    title: issue.title || '',
    state: issue.state || 'open',
    author: issue.user?.login || null,
    labels: (issue.labels || []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean).slice(0, 12),
    createdAt: issue.created_at || null,
    updatedAt: issue.updated_at || null,
    htmlUrl: issue.html_url || null
  }
}

export async function listRepositoryIssues(request, fullName, { state = 'open', since = null, perPage = 100, maxPages = 5, signal } = {}) {
  const endpoint = `${issuesApiPath(fullName)}?state=${encodeURIComponent(state)}&sort=updated&direction=desc&per_page=${perPage}${since ? `&since=${encodeURIComponent(since)}` : ''}`
  const { items, pages, truncated } = await fetchAllPages((page) => request(page, { returnPageMetadata: true, signal }), endpoint, { perPage, maxPages })
  return { issues: items.filter(isRealIssue), pages, truncated }
}

export async function getIssue(request, fullName, number, { signal } = {}) {
  return request(`${issuesApiPath(fullName)}/${requireIssueNumber(number)}`, { signal })
}

export async function listIssueComments(request, fullName, number, { perPage = 50, maxPages = 4, signal } = {}) {
  const endpoint = `${issuesApiPath(fullName)}/${requireIssueNumber(number)}/comments?per_page=${perPage}`
  const { items } = await fetchAllPages((page) => request(page, { returnPageMetadata: true, signal }), endpoint, { perPage, maxPages })
  return items.map((comment) => ({
    id: comment.id,
    author: comment.user?.login || null,
    association: comment.author_association || null,
    body: sanitizeIssueText(comment.body, 4000),
    createdAt: comment.created_at || null,
    htmlUrl: comment.html_url || null
  }))
}

export async function createIssueComment(request, fullName, number, body, { signal } = {}) {
  const text = sanitizeIssueText(body, 20000)
  if (!text.trim()) throw Object.assign(new Error('An issue comment body is required.'), { code: 'ISSUE_COMMENT_EMPTY' })
  return request(`${issuesApiPath(fullName)}/${requireIssueNumber(number)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: text }),
    signal
  })
}

export async function updateIssueState(request, fullName, number, { state, notPlanned = false, labels, signal } = {}) {
  if (!['open', 'closed'].includes(state)) throw Object.assign(new Error('Issue state must be open or closed.'), { code: 'ISSUE_STATE_INVALID' })
  const body = { state }
  if (state === 'closed' && notPlanned) body.state_reason = 'not_planned'
  if (Array.isArray(labels)) body.labels = labels.slice(0, 20)
  return request(`${issuesApiPath(fullName)}/${requireIssueNumber(number)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
}

export async function addIssueLabels(request, fullName, number, labels, { signal } = {}) {
  const clean = (Array.isArray(labels) ? labels : []).map((label) => String(label).slice(0, 60)).filter(Boolean).slice(0, 20)
  if (!clean.length) throw Object.assign(new Error('At least one label is required.'), { code: 'ISSUE_LABELS_EMPTY' })
  return request(`${issuesApiPath(fullName)}/${requireIssueNumber(number)}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels: clean }),
    signal
  })
}
