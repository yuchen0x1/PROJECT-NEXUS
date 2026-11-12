export function repositoryApiPath(fullName) {
  const segments = String(fullName || '').split('/')
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]{1,100}$/.test(segment)) || segments.some((segment) => segment === '.' || segment === '..')) {
    throw Object.assign(new Error('Repository must be an owner/name pair.'), { code: 'INVALID_REPOSITORY' })
  }
  return `/repos/${segments.map(encodeURIComponent).join('/')}`
}

export function repositoryTreePath(fullName, sha, recursive = false) {
  if (!/^[A-Fa-f0-9]{7,64}$/.test(String(sha || ''))) throw new Error('Invalid Git tree SHA.')
  return `${repositoryApiPath(fullName)}/git/trees/${encodeURIComponent(sha)}${recursive ? '?recursive=1' : ''}`
}
