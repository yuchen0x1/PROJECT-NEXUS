import assert from 'node:assert/strict'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{
  name: 'repository-sync-timing', configureServer(vite) {
    vite.middlewares.use('/sync-timing', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(await vite.transformIndexHtml('/sync-timing', '<html><body><div id="root"></div><script type="module" src="/tests/fixtures/repository-sync.tsx"></script></body></html>'))
    })
  }
}] })
let browser
try {
  await server.listen(); browser = await chromium.launch({ headless: true })
  const page = await browser.newPage(); const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.clock.install({ time: new Date('2026-11-13T00:00:00Z') })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/sync-timing`)
  await page.waitForLoadState('networkidle')
  await page.clock.runFor(1500)
  assert.equal(await page.evaluate(() => window.__syncFixture.counts().syncs), 1)
  await page.clock.runFor(58_000)
  assert.equal(await page.evaluate(() => window.__syncFixture.counts().syncs), 1)
  await page.clock.runFor(2000)
  assert.equal(await page.evaluate(() => window.__syncFixture.counts().syncs), 2)
  await page.evaluate(() => window.__syncFixture.hide(true))
  const before = await page.evaluate(() => window.__syncFixture.counts())
  await page.clock.runFor(120_000)
  assert.deepEqual(await page.evaluate(() => window.__syncFixture.counts()), before)
  await page.evaluate(() => window.__syncFixture.hide(false))
  await page.clock.runFor(1500)
  assert.equal(await page.evaluate(() => window.__syncFixture.counts().syncs), 3)
  await page.evaluate(() => window.__syncFixture.change({ nextSyncAt: new Date(Date.now() + 120_000).toISOString(), lastErrorCode: 'GITHUB_RATE_LIMITED' }))
  await page.clock.runFor(65_000)
  assert.equal(await page.evaluate(() => window.__syncFixture.counts().syncs), 3)
  await page.clock.runFor(56_000)
  assert.equal(await page.evaluate(() => window.__syncFixture.counts().syncs), 4)
  await page.evaluate(() => Promise.all([window.__syncFixture.sync(), window.__syncFixture.sync()]))
  assert.equal(await page.evaluate(() => window.__syncFixture.counts().syncs), 5)
  await page.evaluate(() => window.__syncFixture.change({ configured: false }))
  await page.clock.runFor(121_000)
  assert.equal(await page.evaluate(() => window.__syncFixture.counts().syncs), 5)
  assert.deepEqual(errors, [])
  console.log('PASS: Renderer timing fixture verifies 60-second cadence, hidden-page pause, resume, retry deadline, shared manual requests and disconnected state using a simulated browser clock.')
} finally { await browser?.close(); await server.close() }
