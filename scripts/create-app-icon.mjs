import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Preserve the supplied artwork byte-for-byte. This sync command cannot
// regenerate the retired placeholder icon over the official icon suite.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'assets', 'branding', 'PROJECT-NEXUS.ico')
const output = path.join(root, 'desktop', 'assets', 'app.ico')
const bytes = await fs.readFile(source)
const sizes = [16, 32, 48, 64, 128, 256]
if (bytes.length < 6 + sizes.length * 16 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1 || bytes.readUInt16LE(4) !== sizes.length) throw new Error('The official Windows icon must contain all six supplied sizes.')
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16
  const width = bytes[entry] || 256, height = bytes[entry + 1] || 256
  const length = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12)
  if (width !== size || height !== size || bytes.readUInt16LE(entry + 6) !== 32 || offset < 6 + sizes.length * 16 || offset + length > bytes.length) throw new Error(`Invalid ${size}px icon frame.`)
  const png = await fs.readFile(path.join(root, 'assets', 'branding', `PROJECT-NEXUS-icon-${size}.png`))
  if (!bytes.subarray(offset, offset + length).equals(png)) throw new Error(`The ${size}px ICO frame does not match the supplied PNG.`)
}
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.copyFile(source, output)
console.log(JSON.stringify({ source: path.relative(root, source), output: path.relative(root, output), sizes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }))
