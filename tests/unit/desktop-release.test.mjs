import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { publishDesktopRelease, readDesktopAssets, selectDesktopRelease } from '../../scripts/publish-desktop-release.mjs'

const tag = 'v0.9.5'
const sha = 'a'.repeat(40)
const title = `${tag} · Verified installer`
const notes = 'Candidate notes.'
const installer = 'PROJECT-NEXUS-0.9.5-win-x64-setup.exe'
const assets = [installer, `${installer}.blockmap`, 'latest.yml', 'SHA256SUMS.txt'].map((name, i) => ({
  name, size: i + 10, digest: `sha256:${String(i).repeat(64)}`,
}))
const input = { tag, sha, title, notes, assets }
const draft = { id: 42, tag_name: tag, name: title, body: notes, target_commitish: sha, draft: true, prerelease: false }
const stable = version => ({ tag_name: version, draft: false, prerelease: false })
const uploaded = asset => ({ ...asset, state: 'uploaded' })

function fakeGithub({ existing = false, remoteAssets = [] } = {}) {
  const releases = [stable('v0.9.4'), ...(existing ? [draft] : [])]
  const remote = [...remoteAssets]
  let live = draft
  const publish = () => {
    live = { ...draft, draft: false }
    const index = releases.indexOf(draft)
    if (index !== -1) releases[index] = live
    return live
  }
  return {
    tagCommit: vi.fn(() => sha),
    releases: vi.fn(() => releases),
    release: vi.fn(() => live),
    latestRelease: vi.fn(() => live),
    assets: vi.fn(() => remote),
    createDraft: vi.fn(() => { releases.push(draft); return draft }),
    upload: vi.fn((_id, asset) => { remote.push(uploaded(asset)) }),
    publish: vi.fn(publish),
  }
}

it('stages and publishes exactly four assets after GitHub confirms each digest', async () => {
  const github = fakeGithub()
  await expect(publishDesktopRelease(github, input)).resolves.toMatchObject({ id: draft.id, draft: false })
  expect(github.createDraft).toHaveBeenCalledOnce()
  expect(github.upload.mock.calls).toEqual(assets.map(asset => [draft.id, asset]))
  expect(github.publish).toHaveBeenCalledWith(draft.id)
  expect(github.assets.mock.invocationCallOrder.at(-2)).toBeLessThan(github.publish.mock.invocationCallOrder[0])
  expect(github.assets.mock.invocationCallOrder.at(-1)).toBeGreaterThan(github.publish.mock.invocationCallOrder[0])
})

it('resumes partial drafts without recreating the release or uploading identical assets twice', async () => {
  const github = fakeGithub()
  github.upload.mockImplementationOnce(() => { throw new Error('connection interrupted') })
  await expect(publishDesktopRelease(github, input)).rejects.toThrow('connection interrupted')
  expect(github.publish).not.toHaveBeenCalled()
  await expect(publishDesktopRelease(github, input)).resolves.toMatchObject({ draft: false })
  expect(github.createDraft).toHaveBeenCalledOnce()
  const partial = fakeGithub({ existing: true, remoteAssets: [uploaded(assets[0])] })
  await publishDesktopRelease(partial, input)
  expect(partial.createDraft).not.toHaveBeenCalled()
  expect(partial.upload.mock.calls).toEqual(assets.slice(1).map(asset => [draft.id, asset]))
})

it.each([
  { ...uploaded(assets[0]), digest: null },
  { ...uploaded(assets[0]), size: 0, state: 'starter' },
  uploaded({ ...assets[0], name: 'unverified.exe' }),
])('never overwrites or publishes a draft containing an unverified asset', async asset => {
  const github = fakeGithub({ existing: true, remoteAssets: [asset] })
  await expect(publishDesktopRelease(github, input)).rejects.toThrow('mismatched draft asset')
  expect(github.upload).not.toHaveBeenCalled()
  expect(github.publish).not.toHaveBeenCalled()
})

it('rejects existing public releases (even with no assets), non-increasing versions, and prerelease collisions', () => {
  expect(() => selectDesktopRelease([stable(tag)], tag)).toThrow('existing release')
  expect(() => selectDesktopRelease([stable('v0.10.0')], tag)).toThrow('not newer')
  expect(() => selectDesktopRelease([{ ...draft, prerelease: true }], tag)).toThrow('existing release')
  expect(() => selectDesktopRelease([], 'v00.9.5')).toThrow('stable desktop release tag')
  expect(selectDesktopRelease([{ ...stable('v1.0.0'), prerelease: true }, draft], tag)).toEqual(draft)
})

it('refuses to publish if the tag moves, the draft changes, or an upload cannot be confirmed', async () => {
  const moved = fakeGithub({ existing: true })
  moved.tagCommit.mockReturnValueOnce(sha).mockReturnValueOnce('b'.repeat(40))
  await expect(publishDesktopRelease(moved, input)).rejects.toThrow('does not match')
  expect(moved.publish).not.toHaveBeenCalled()
  const changed = fakeGithub({ existing: true })
  changed.releases.mockReturnValueOnce([draft]).mockReturnValueOnce([{ ...draft, body: 'Different notes' }])
  await expect(publishDesktopRelease(changed, input)).rejects.toThrow('draft changed')
  expect(changed.publish).not.toHaveBeenCalled()
  const missing = fakeGithub({ existing: true })
  missing.upload.mockImplementation(() => {})
  await expect(publishDesktopRelease(missing, input)).rejects.toThrow('missing verified release assets')
  expect(missing.publish).not.toHaveBeenCalled()
})

it('reconciles a lost publish response and retry by verifying the remote release, without a second write', async () => {
  const github = fakeGithub({ existing: true, remoteAssets: assets.map(uploaded) })
  const publish = github.publish.getMockImplementation()
  github.publish.mockImplementationOnce(() => {
    publish()
    throw new Error('response was lost')
  })
  const published = { ...draft, draft: false }
  await expect(publishDesktopRelease(github, input)).resolves.toEqual({ ...published, channel: 'latest' })
  await expect(publishDesktopRelease(github, input)).resolves.toEqual({ ...published, channel: 'latest' })
  expect(github.publish).toHaveBeenCalledOnce()
  expect(github.upload).not.toHaveBeenCalled()
  const incomplete = fakeGithub()
  incomplete.releases.mockReturnValue([published])
  incomplete.release.mockReturnValue(published)
  await expect(publishDesktopRelease(incomplete, input)).rejects.toThrow('missing verified assets')
  expect(incomplete.publish).not.toHaveBeenCalled()
})

it('checks the tag just before publication and refuses to report success if it moves during publication', async () => {
  for (const changeDuringPublish of [false, true]) {
    const github = fakeGithub({ existing: true, remoteAssets: assets.map(uploaded) })
    if (changeDuringPublish) {
      const publish = github.publish.getMockImplementation()
      github.publish.mockImplementationOnce(() => {
        github.tagCommit.mockReturnValue('b'.repeat(40))
        return publish()
      })
    } else {
      github.assets.mockImplementationOnce(() => assets.map(uploaded)).mockImplementationOnce(() => {
        github.tagCommit.mockReturnValue('b'.repeat(40))
        return assets.map(uploaded)
      })
    }
    await expect(publishDesktopRelease(github, input)).rejects.toThrow('does not match the verified commit')
    expect(github.publish).toHaveBeenCalledTimes(changeDuringPublish ? 1 : 0)
  }
})

it('reads release metadata independently and confirms that public artifacts are served to stable updaters', async () => {
  const verifiedAssets = { existing: true, remoteAssets: assets.map(uploaded) }
  const edited = fakeGithub(verifiedAssets)
  edited.release.mockReturnValue({ ...draft, draft: false, body: 'Changed notes' })
  await expect(publishDesktopRelease(edited, input)).rejects.toThrow('Publication could not be confirmed')
  const differentLatest = fakeGithub(verifiedAssets)
  differentLatest.latestRelease.mockReturnValue({ ...stable('v0.9.6'), id: 43 })
  await expect(publishDesktopRelease(differentLatest, input)).rejects.toThrow('is not serving v0.9.5 as the latest')
  await expect(publishDesktopRelease(differentLatest, input)).resolves.toMatchObject({ channel: 'historical' })
  expect(differentLatest.publish).toHaveBeenCalledOnce()
})

it('checks the local installer checksum and does not pick up stale matching files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-release-'))
  try {
    await Promise.all(assets.map(asset => writeFile(path.join(directory, asset.name), asset.name)))
    await writeFile(path.join(directory, 'stale.exe'), 'not for this version')
    await expect(readDesktopAssets(directory, tag)).rejects.toThrow('does not match SHA256SUMS')
    const digest = createHash('sha256').update(installer).digest('hex')
    await writeFile(path.join(directory, 'SHA256SUMS.txt'), `${digest}  ${installer}\n`)
    expect((await readDesktopAssets(directory, tag)).map(asset => asset.name)).toEqual(assets.map(asset => asset.name))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
