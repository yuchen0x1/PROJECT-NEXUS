import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'desktop', 'assets', 'app.ico')
const size = 32
const scale = 4
const supersample = size * scale
const pixels = new Uint8Array(supersample * supersample * 4)

const background = [32, 40, 38, 255]
const accent = [212, 182, 122, 255]
function roundedRectDistance(x, y, width, height, radius) {
  const qx = Math.abs(x - width / 2) - (width / 2 - radius)
  const qy = Math.abs(y - height / 2) - (height / 2 - radius)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}
function lineDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared))
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}
function blend(target, color, alpha) {
  const factor = Math.max(0, Math.min(1, alpha))
  for (let channel = 0; channel < 3; channel += 1) target[channel] = Math.round(target[channel] * (1 - factor) + color[channel] * factor)
  target[3] = 255
}

for (let py = 0; py < supersample; py += 1) {
  for (let px = 0; px < supersample; px += 1) {
    const x = (px + 0.5) / scale; const y = (py + 0.5) / scale
    const rounded = roundedRectDistance(x, y, size, size, 6)
    const isN = Math.min(
      lineDistance(x, y, 9, 23, 9, 9),
      lineDistance(x, y, 9, 9, 23, 23),
      lineDistance(x, y, 23, 23, 23, 9)
    ) <= 1.8
    const color = isN ? accent : background
    const alpha = Math.max(0, Math.min(1, 0.5 - rounded * scale))
    if (alpha <= 0) continue
    const offset = (py * supersample + px) * 4
    pixels[offset] = Math.round(color[0] * alpha)
    pixels[offset + 1] = Math.round(color[1] * alpha)
    pixels[offset + 2] = Math.round(color[2] * alpha)
    pixels[offset + 3] = Math.round(255 * alpha)
  }
}

const bgra = Buffer.alloc(size * size * 4)
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const sum = [0, 0, 0, 0]
    for (let sy = 0; sy < scale; sy += 1) {
      for (let sx = 0; sx < scale; sx += 1) {
        const offset = (((y * scale + sy) * supersample) + x * scale + sx) * 4
        for (let channel = 0; channel < 4; channel += 1) sum[channel] += pixels[offset + channel]
      }
    }
    const alpha = sum[3] / (scale * scale)
    const destination = ((size - y - 1) * size + x) * 4
    bgra[destination] = alpha ? Math.round(sum[2] / (scale * scale) * 255 / alpha) : 0
    bgra[destination + 1] = alpha ? Math.round(sum[1] / (scale * scale) * 255 / alpha) : 0
    bgra[destination + 2] = alpha ? Math.round(sum[0] / (scale * scale) * 255 / alpha) : 0
    bgra[destination + 3] = Math.round(alpha)
  }
}

const maskStride = Math.ceil(size / 32) * 4
const mask = Buffer.alloc(maskStride * size)
const dib = Buffer.alloc(40)
dib.writeUInt32LE(40, 0)
dib.writeInt32LE(size, 4)
dib.writeInt32LE(size * 2, 8)
dib.writeUInt16LE(1, 12)
dib.writeUInt16LE(32, 14)
dib.writeUInt32LE(0, 16)
dib.writeUInt32LE(bgra.length, 20)

const image = Buffer.concat([dib, bgra, mask])
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)
const entry = Buffer.alloc(16)
entry.writeUInt8(size, 0)
entry.writeUInt8(size, 1)
entry.writeUInt16LE(1, 4)
entry.writeUInt16LE(32, 6)
entry.writeUInt32LE(image.length, 8)
entry.writeUInt32LE(22, 12)

await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, Buffer.concat([header, entry, image]))
process.stdout.write(`Generated ${path.relative(root, output)} (${image.length + 22} bytes).\n`)
