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
async function assertLayout(page) {
  const layout = await page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height }
    }
    return { update: box('.nx-app-update'), heading: box('.nx-app-update-heading'), status: box('.nx-app-update-copy [role="status"]'), copy: box('.nx-app-update-copy'), actions: box('.nx-app-update-actions'), page: box('.nx-page-heading'), content: box('.nx-content-grid'), viewport: innerHeight }
  })
  assert.ok(layout.update.bottom <= layout.page.top, 'Update card must end before the page heading starts.')
  assert.ok(layout.heading.bottom <= layout.status.top + 1, 'Version/title and status must occupy separate lines.')
  assert.ok(layout.heading.top >= layout.update.top && layout.status.bottom <= layout.update.bottom, 'All update text must stay inside the card.')
  const overlap = layout.copy.left < layout.actions.right && layout.copy.right > layout.actions.left && layout.copy.top < layout.actions.bottom && layout.copy.bottom > layout.actions.top
  assert.equal(overlap, false, 'Update text and action buttons must not overlap.')
  assert.ok(layout.content.height >= 140 && layout.content.bottom <= layout.viewport + 1, 'The page must retain usable, bounded scroll space.')
}
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}/update-ui-fixture`
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(origin)
  await page.waitForLoadState('networkidle')
  await assertLayout(page)
  const historyButton = page.getByRole('button', { name: '更新日志', exact: true })
  await historyButton.focus()
  await page.keyboard.press('Enter')
  const history = page.getByRole('region', { name: '更新日志', exact: true })
  await history.waitFor()
  assert.equal(await historyButton.getAttribute('aria-expanded'), 'true')
  await history.getByText('当前版本', { exact: true }).waitFor()
  const bundledVersions = await history.locator('[data-release-version]').evaluateAll((items) => items.map((item) => item.dataset.releaseVersion))
  assert.deepEqual(bundledVersions, ['0.8.5', '0.8.4', '0.8.3', '0.8.2', '0.8.0', '0.7.0', '0.3.0', '0.2.1', '0.1.0'])
  await assertLayout(page)
  await historyButton.click()
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByText('发现新版本 0.8.10。', { exact: true }).waitFor()
  await historyButton.click()
  await history.getByText('修复布局并增加更新日志。', { exact: true }).waitFor()
  assert.equal(await history.locator('[data-release-version]').first().getAttribute('data-release-version'), '0.8.10')
  await historyButton.click()
  await page.getByRole('button', { name: '立即更新', exact: true }).click()
  await page.getByRole('progressbar', { name: '下载进度' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '请稍候…', exact: true }).isDisabled(), true)
  await page.evaluate(() => window.__updateFixture.emit({ percent: 63 }))
  await page.getByText('正在下载 0.8.10 · 63%', { exact: true }).waitFor()
  await assertLayout(page)
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'test-results/app-update-progress.png') })
  await page.evaluate(() => window.__updateFixture.emit({ phase: 'error', errorCode: 'download', retry: 'update' }))
  await page.getByRole('alert').filter({ hasText: '下载或校验失败' }).waitFor()
  await assertLayout(page)
  await page.getByRole('button', { name: '立即更新', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__updateFixture.installs), 2)
  await page.evaluate(() => window.__updateFixture.emit({ phase: 'installing' }))
  await page.getByText('正在保存状态并安装，完成后自动打开 NEXUS。', { exact: true }).waitFor()
  await assertLayout(page)
  assert.equal(await page.getByRole('button', { name: '请稍候…', exact: true }).isDisabled(), true)
  await page.goto(`${origin}?global`)
  await page.waitForLoadState('networkidle')
  assert.equal(await page.getByTestId('app-update').count(), 0)
  const initialContentHeight = await page.locator('.nx-content-grid').evaluate((element) => element.getBoundingClientRect().height)
  assert.ok(initialContentHeight > 550, 'An absent update card must leave its row empty.')
  await page.evaluate(() => window.__updateFixture.emit({ phase: 'available', version: '0.8.10', retry: 'update' }))
  await assertLayout(page)
  await page.getByRole('button', { name: '稍后', exact: true }).click()
  assert.equal(await page.getByTestId('app-update').count(), 0)
  await page.evaluate(() => window.__updateFixture.emit({ phase: 'available', version: '0.10.0', retry: 'update' }))
  await page.getByText('发现新版本 0.10.0。', { exact: true }).waitFor()
  await assertLayout(page)
  await page.screenshot({ path: path.join(root, 'test-results/app-update-available.png') })
  await page.goto(origin)
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
    window.__updateFixture.emit({ phase: 'up-to-date' })
  })
  await page.setViewportSize({ width: 1560, height: 1000 })
  await page.getByText('当前已是最新版本。', { exact: true }).waitFor()
  await assertLayout(page)
  await page.screenshot({ path: path.join(root, 'test-results/app-update-layout-light.png') })
  await page.getByRole('button', { name: '更新日志', exact: true }).click()
  await page.screenshot({ path: path.join(root, 'test-results/app-update-history-light.png') })
  for (const [width, height, zoom, language, theme] of [
    [980, 720, 1, 'de-DE', 'dark'], [1280, 800, 1, 'ru-RU', 'light'],
    [1920, 1080, 1.5, 'zh-CN', 'light'], [1440, 900, 1.25, 'en-US', 'dark']
  ]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(async ({ zoom, language, theme }) => {
      document.documentElement.dataset.theme = theme
      document.documentElement.style.zoom = String(zoom)
      await window.__updateFixture.setLanguage(language)
      window.__updateFixture.emit({ phase: 'error', errorCode: 'download', retry: 'update', version: '0.10.0', releaseNotes: '<img src=x onerror=alert(1)>\n' + 'A'.repeat(4000) })
    }, { zoom, language, theme })
    await page.waitForFunction(() => document.querySelector('[role="alert"]'))
    await assertLayout(page)
    assert.equal(await page.locator('.nx-app-update-history img, .nx-app-update-history script').count(), 0)
    const versions = await page.locator('[data-release-version]').evaluateAll((items) => items.map((item) => item.dataset.releaseVersion))
    assert.equal(versions[0], '0.10.0')
    assert.equal(new Set(versions).size, versions.length)
    await page.screenshot({ path: path.join(root, `test-results/app-update-layout-${language}-${Math.round(zoom * 100)}.png`) })
  }
  assert.deepEqual(errors, [])
  console.log('PASS: Full shell layout, collapsed/expanded release history, numeric version order, keyboard toggle, remote plain text, all updater phases, 980–1920 widths and 100/125/150% zoom. No browser errors.')
  console.log('PARTIAL: Renderer fixture does not execute a native installer.')
} finally {
  await browser?.close()
  await server.close()
}
