const DEFAULT_PER_PAGE = 100
const DEFAULT_MAX_PAGES = 20

export function githubNextLink(linkHeader, apiUrl = 'https://api.github.com') {
  if (!linkHeader) return null
  const links = []
  let current = ''
  let quoted = false
  let angled = false
  for (const character of linkHeader) {
    if (character === '"' && !angled) quoted = !quoted
    if (character === '<' && !quoted) angled = true
    if (character === '>' && !quoted) angled = false
    if (character === ',' && !quoted && !angled) {
      links.push(current.trim())
      current = ''
    } else current += character
  }
  if (current.trim()) links.push(current.trim())
  const next = links.find((value) => /;\s*rel\s*=\s*"?next"?(?:\s*;|$)/i.test(value))
  const target = next?.match(/<([^>]+)>/)?.[1]
  if (!target) return null
  const base = new URL(apiUrl)
  const url = new URL(target, base)
  if (url.origin !== base.origin || url.username || url.password) throw new Error('GitHub pagination link points outside the configured API origin.')
  return url.toString()
}

function setPage(endpoint, page, perPage) {
  const url = new URL(endpoint, 'https://api.github.com')
  url.searchParams.set('per_page', String(perPage))
  url.searchParams.set('page', String(page))
  return `${url.pathname}${url.search}`
}

export async function fetchAllPages(request, endpoint, { perPage = DEFAULT_PER_PAGE, maxPages = DEFAULT_MAX_PAGES, collection = null } = {}) {
  const items = []
  let pages = 0
  let nextEndpoint = setPage(endpoint, 1, perPage)
  const visited = new Set()
  for (let page = 1; page <= maxPages; page += 1) {
    if (visited.has(nextEndpoint)) throw Object.assign(new Error('GitHub pagination returned a repeated next link.'), { code: 'GITHUB_PAGINATION_LOOP' })
    visited.add(nextEndpoint)
    const response = await request(nextEndpoint)
    const body = response && typeof response === 'object' && 'data' in response ? response.data : response
    const values = collection ? body?.[collection] : body
    if (!Array.isArray(values)) throw Object.assign(new Error(`GitHub page ${page} did not return an array${collection ? ` at ${collection}` : ''}.`), { code: 'GITHUB_RESPONSE_INVALID' })
    items.push(...values)
    pages = page
    if (response?.next) {
      nextEndpoint = response.next
      continue
    }
    if (values.length < perPage) return { items, pages, truncated: false }
    nextEndpoint = setPage(endpoint, page + 1, perPage)
  }
  return { items, pages, truncated: true }
}
