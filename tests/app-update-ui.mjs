import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{
  name: 'update-ui-fixture',
  configureServer(vite) {
    vite.middlewares.use('/update-ui-fixture', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end(await vite.transformIndexHtml('/update-ui-fixture', '<html><body><div id="root"></div><script type="module" src="/tests/fixtures/app-update.tsx"></script></body></html>'))
    })
  }
}] })
let browser
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}/update-ui-fixture`
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(origin)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByText('发现新版本 0.8.1。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '立即更新', exact: true }).click()
  await page.getByRole('progressbar', { name: '下载进度' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '请稍候…', exact: true }).isDisabled(), true)
  await page.evaluate(() => window.__updateFixture.emit({ percent: 63 }))
  await page.getByText('正在下载 0.8.1 · 63%', { exact: true }).waitFor()
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'test-results/app-update-progress.png') })
  await page.evaluate(() => window.__updateFixture.emit({ phase: 'error', errorCode: 'download', retry: 'update' }))
  await page.getByRole('alert').filter({ hasText: '下载或校验失败' }).waitFor()
  await page.getByRole('button', { name: '立即更新', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__updateFixture.installs), 2)
  await page.evaluate(() => window.__updateFixture.emit({ phase: 'installing' }))
  await page.getByText('正在保存状态并安装，完成后自动打开 NEXUS。', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '请稍候…', exact: true }).isDisabled(), true)
  await page.goto(`${origin}?global`)
  await page.waitForLoadState('networkidle')
  assert.equal(await page.getByTestId('app-update').count(), 0)
  await page.evaluate(() => window.__updateFixture.emit({ phase: 'available', version: '0.8.1', retry: 'update' }))
  await page.getByRole('button', { name: '稍后', exact: true }).click()
  assert.equal(await page.getByTestId('app-update').count(), 0)
  await page.evaluate(() => window.__updateFixture.emit({ phase: 'available', version: '0.8.2', retry: 'update' }))
  await page.getByText('发现新版本 0.8.2。', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(root, 'test-results/app-update-available.png') })
  assert.deepEqual(errors, [])
  console.log('PASS: Rendered Chinese update check, offer, progress, retry, installing and later/new-version states. No browser errors.')
  console.log('PARTIAL: Renderer fixture does not execute a native installer.')
} finally {
  await browser?.close()
  await server.close()
}
