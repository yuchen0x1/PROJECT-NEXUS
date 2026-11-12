import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const base = process.env.NEXUS_URL || 'http://localhost:4317'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await page.goto(base)
  await page.waitForLoadState('networkidle')
  assert.equal(await page.title(), 'PROJECT NEXUS · GitHub control center')
  assert.equal(await page.locator('h1').first().textContent(), 'Control center')
  assert.equal(await page.locator('.nav-item').count(), 16)
  const screenshotDir = path.resolve('docs/screenshots/phase3')
  await fs.mkdir(screenshotDir, { recursive: true })
  await page.screenshot({ path: path.join(screenshotDir, 'overview.png'), fullPage: true })
  await page.getByRole('button', { name: 'Projects' }).click()
  await page.waitForTimeout(200)
  assert.equal(await page.locator('h1').textContent(), 'Projects')
  for (const label of ['Release Center', 'Auto Update', 'Repository Scanner', 'AI Pipeline', 'Adapter Center', 'Update Security', 'Integration History', 'GitHub Connections', 'Security Center', 'Task Center']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.waitForTimeout(200)
    const expectedHeading = label === 'AI Pipeline' ? 'AI Integration Pipeline' : label
    assert.equal(await page.locator('h1').textContent(), expectedHeading)
    const screenshotName = label.toLowerCase().replaceAll(' ', '-')
    if (['repository-scanner', 'ai-pipeline', 'adapter-center', 'update-security', 'integration-history', 'task-center'].includes(screenshotName)) {
      await page.screenshot({ path: path.join(screenshotDir, `${screenshotName}.png`), fullPage: true })
    }
  }
  await page.screenshot({ path: 'test-results/browser-projects.png', fullPage: true })
  console.log('PROJECT NEXUS browser navigation and Phase 3 screenshots passed')
} finally {
  await browser.close()
}
