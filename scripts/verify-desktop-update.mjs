import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const yaml = createRequire(require.resolve('electron-updater'))('js-yaml')
const root = path.resolve(import.meta.dirname, '..')
const output = path.resolve(root, process.argv[2] || 'release')
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const manifest = yaml.load(await fs.readFile(path.join(output, 'latest.yml'), 'utf8'))
assert.equal(manifest.version, pkg.version, 'Update manifest must match the application version')
const expectedName = `PROJECT-NEXUS-${pkg.version}-win-x64-setup.exe`
assert.equal(manifest.path, expectedName)
const file = manifest.files?.find((item) => item.url === expectedName)
assert.ok(file, 'Manifest must include the Windows x64 installer')
const installer = await fs.readFile(path.join(output, expectedName))
const sha512 = crypto.createHash('sha512').update(installer).digest('base64')
assert.equal(file.sha512, sha512, 'Installer SHA512 must match the manifest')
assert.equal(manifest.sha512, sha512)
assert.equal(file.size, installer.length)
assert.ok((await fs.stat(path.join(output, `${expectedName}.blockmap`))).size > 0)
const feed = yaml.load(await fs.readFile(path.join(output, 'win-unpacked/resources/app-update.yml'), 'utf8'))
assert.deepEqual([feed.provider, feed.owner, feed.repo], ['github', 'yuchen0x1', 'PROJECT-NEXUS'])
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), `${crypto.createHash('sha256').update(installer).digest('hex')}  ${expectedName}\n`)
console.log(`PASS: ${pkg.version} installer, blockmap, SHA512 manifest and packaged GitHub update feed match.`)
console.log('PARTIAL: Packaging checks do not verify an old client installing and launching this version.')
