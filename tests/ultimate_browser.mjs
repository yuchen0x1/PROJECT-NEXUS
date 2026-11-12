import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const base = 'http://127.0.0.1:5173'
const output = path.resolve('docs/screenshots/ultimate')
await fs.mkdir(output, { recursive: true })

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await page.goto(base)
  await page.waitForLoadState('networkidle')
  assert.equal(await page.locator('h1').first().textContent(), 'Control center')
  await page.screenshot({ path: path.join(output, 'overview.png'), fullPage: true })

  await page.getByRole('button', { name: 'AI Operations', exact: true }).click()
  await page.waitForTimeout(150)
  await page.waitForLoadState('networkidle')
  assert.equal(await page.locator('h1').textContent(), 'AI Operations')
  assert.equal(await page.getByText('Provider registry', { exact: true }).count(), 1)
  await page.screenshot({ path: path.join(output, 'ai-operations.png'), fullPage: true })

  await page.getByRole('button', { name: 'Security Center', exact: true }).click()
  await page.waitForTimeout(150)
  await page.waitForLoadState('networkidle')
  assert.equal(await page.locator('h1').textContent(), 'Security Center')
  assert.equal(await page.getByText('Role model', { exact: true }).count(), 1)
  await page.screenshot({ path: path.join(output, 'security-center.png'), fullPage: true })
} finally {
  await browser.close()
}

console.log('PROJECT NEXUS Ultimate browser screenshots passed')
