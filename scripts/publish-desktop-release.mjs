import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const stable = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const commitSha = /^[a-f0-9]{40}$/

function versionParts(tag) {
  return stable.exec(tag)?.slice(1).map(BigInt)
}

function isNewer(a, b) {
  const difference = a.findIndex((part, i) => part !== b[i])
  return difference !== -1 && a[difference] > b[difference]
}

export function selectDesktopRelease(releases, tag) {
  const target = versionParts(tag)
  if (!target) throw new Error('Expected a stable desktop release tag (vX.Y.Z).')
  let draft
  for (const release of releases) {
    if (release.tag_name === tag) {
      if (release.draft !== true || release.prerelease !== false || draft) {
        throw new Error(`Refusing to modify existing release ${tag}.`)
      }
      draft = release
    }
    if (release.draft === false && release.prerelease === false) {
      const published = versionParts(release.tag_name)
      if (!published) continue
      if (!isNewer(target, published)) {
        throw new Error(`Version ${tag} is not newer than published ${release.tag_name}.`)
      }
    }
  }
  return draft
}

export async function readDesktopAssets(directory, tag) {
  if (!versionParts(tag)) throw new Error('Expected a stable desktop release tag (vX.Y.Z).')
  const installer = `PROJECT-NEXUS-${tag.slice(1)}-win-x64-setup.exe`
  const names = [installer, `${installer}.blockmap`, 'latest.yml', 'SHA256SUMS.txt']
  const assets = []
  for (const name of names) {
    const file = path.resolve(directory, name)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty release asset: ${name}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    assets.push({ name, file, size: stat.size, digest: `sha256:${hash.digest('hex')}` })
  }
  if (await readFile(assets[3].file, 'utf8') !== `${assets[0].digest.slice(7)}  ${installer}\n`) {
    throw new Error('Installer does not match SHA256SUMS.txt.')
  }
  return assets
}

function missingAssets(remote, expected) {
  const pending = new Map(expected.map(asset => [asset.name, asset]))
  for (const asset of remote) {
    const local = pending.get(asset.name)
    if (!local || asset.state !== 'uploaded' || asset.size !== local.size || asset.digest !== local.digest) {
      throw new Error(`Unexpected, incomplete, or mismatched draft asset: ${asset.name}. No assets were overwritten.`)
    }
    pending.delete(asset.name)
  }
  return [...pending.values()]
}

export async function publishDesktopRelease(github, { tag, sha, title, notes, notesFile, assets }) {
  if (!commitSha.test(sha)) throw new Error('Expected an exact release commit SHA.')
  async function assertTag() {
    if (await github.tagCommit(tag) !== sha) throw new Error(`Remote tag ${tag} does not match the verified commit.`)
  }
  async function currentDraft() {
    await assertTag()
    return selectDesktopRelease(await github.releases(), tag)
  }
  function matches(candidate) {
    return candidate?.name === title && candidate.body?.trim() === notes.trim()
  }
  async function verifyPublished(id, { allowHistorical = false } = {}) {
    const release = await github.release(id)
    if (!release || release.id !== id || release.tag_name !== tag || release.draft !== false || release.prerelease !== false || !matches(release)) {
      throw new Error('Publication could not be confirmed. Check GitHub before retrying.')
    }
    if (missingAssets(await github.assets(id), assets).length) throw new Error('Published release is missing verified assets.')
    const latest = await github.latestRelease()
    await assertTag()
    if (latest?.id === id && latest.tag_name === tag) return { ...release, channel: 'latest' }
    const latestVersion = versionParts(latest?.tag_name)
    if (allowHistorical && latestVersion && isNewer(latestVersion, versionParts(tag))) return { ...release, channel: 'historical' }
    throw new Error(`GitHub is not serving ${tag} as the latest release. Check the update channel without overwriting any release.`)
  }
  await assertTag()
  const releases = await github.releases()
  const publicRelease = releases.find(release => release.tag_name === tag && release.draft === false)
  if (publicRelease) return verifyPublished(publicRelease.id, { allowHistorical: true })
  let draft = selectDesktopRelease(releases, tag)
  if (!draft) {
    const created = await github.createDraft({ tag, title, notesFile, sha })
    draft = await currentDraft()
    if (!draft || draft.id !== created.id) throw new Error('Could not confirm the new draft.')
  }
  if (!matches(draft)) throw new Error('Existing draft commit or release notes do not match the verified draft.')
  for (const asset of missingAssets(await github.assets(draft.id), assets)) {
    await github.upload(draft.id, asset)
  }
  const ready = await currentDraft()
  if (!ready || ready.id !== draft.id || !matches(ready)) throw new Error('The verified draft changed before publication.')
  if (missingAssets(await github.assets(ready.id), assets).length) throw new Error('Draft is missing verified release assets.')
  await assertTag()
  let publishError
  try {
    await github.publish(ready.id)
  } catch (error) {
    publishError = error
  }
  try {
    // The PATCH response is not an independent view and can be lost after acceptance.
    return await verifyPublished(ready.id)
  } catch (error) {
    if (publishError) throw new AggregateError([publishError, error], `Could not confirm publication: ${error.message}`)
    throw error
  }
}

function githubCli(repository) {
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repository || '')) throw new Error('Expected GITHUB_REPOSITORY.')
  function gh(...args) {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024, timeout: 60_000 })
  }
  function api(endpoint, ...args) {
    return JSON.parse(gh('api', `repos/${repository}/${endpoint}`, ...args))
  }
  return {
    async tagCommit(tag) {
      if (!versionParts(tag)) throw new Error('Expected a stable desktop release tag (vX.Y.Z).')
      let item = api(`git/ref/tags/${tag}`).object
      for (let i = 0; i < 10 && item?.type === 'tag' && commitSha.test(item.sha); i++) item = api(`git/tags/${item.sha}`).object
      return item?.type === 'commit' ? item.sha : undefined
    },
    releases: () => api('releases?per_page=100', '--paginate', '--slurp').flat(),
    release: id => api(`releases/${id}`),
    latestRelease: () => api('releases/latest'),
    assets: id => api(`releases/${id}/assets?per_page=100`, '--paginate', '--slurp').flat(),
    createDraft: ({ tag, title, notesFile, sha }) => api('releases', '--method', 'POST', '-f', `tag_name=${tag}`, '-f', `target_commitish=${sha}`, '-f', `name=${title}`, '-F', 'draft=true', '-F', 'prerelease=false', '-f', 'make_latest=false', '-F', `body=@${notesFile}`),
    async upload(id, asset) {
      const url = new URL(`https://uploads.github.com/repos/${repository}/releases/${id}/assets`)
      url.searchParams.set('name', asset.name)
      const response = await fetch(url, {
        method: 'POST', redirect: 'error', duplex: 'half',
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(asset.size),
        },
        body: createReadStream(asset.file),
        signal: AbortSignal.timeout(5 * 60 * 1000),
      })
      await response.body?.cancel()
      if (!response.ok) throw new Error(`Upload of ${asset.name} returned HTTP ${response.status}; draft was not published.`)
    },
    publish: id => api(`releases/${id}`, '--method', 'PATCH', '-F', 'draft=false', '-f', 'make_latest=true'),
  }
}

async function main() {
  const [tag, sha, directory, notesPath, notesFile] = process.argv.slice(2)
  if (!tag || !sha || !directory || !notesPath || !notesFile) throw new Error('Usage: publish-desktop-release.mjs TAG SHA ASSET_DIR NOTES_PATH TEMP_NOTES_PATH')
  const assets = await readDesktopAssets(directory, tag)
  const [heading, ...body] = (await readFile(notesPath, 'utf8')).replace(/\r\n/g, '\n').split('\n')
  const prefix = `# ${tag} · `
  if (!heading.startsWith(prefix) || !heading.slice(prefix.length).trim() || !body.join('\n').trim()) {
    throw new Error(`Release notes must start with: ${prefix}Title and have a non-empty body.`)
  }
  if (!commitSha.test(sha)) throw new Error('Expected an exact release commit SHA.')
  // GitHub ignores target_commitish when the tag already exists. Bind draft recovery to the source in the notes.
  const notes = `${body.join('\n').trim()}\n\n<!-- project-nexus:desktop-source=${sha} -->\n`
  await writeFile(notesFile, notes, 'utf8')
  const release = await publishDesktopRelease(githubCli(process.env.GITHUB_REPOSITORY), {
    tag, sha, title: heading.slice(2), notes, notesFile, assets,
  })
  console.log(`Verified ${tag} (${release.channel}): ${release.html_url}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
