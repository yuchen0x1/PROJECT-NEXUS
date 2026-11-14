// UI click-through audit for the installed 0.8.6 binary.
// Launches with an isolated temp profile (--nexus-smoke-test), keeps the
// window visible (hidden Electron windows do not paint, which breaks
// screenshots), clicks every visible button per navigation page, and records
// renderer health (white-screen heuristic, console/page errors) per click.
import fs from 'node:fs/promises'
import path from 'node:path'
import { _electron } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const exe = String.raw`C:\Users\lenmo\AppData\Local\Programs\PROJECT NEXUS\PROJECT NEXUS.exe`
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(root, 'test-results', 'ui-audit', ts)
await fs.mkdir(path.join(outDir, 'profile'), { recursive: true })

// Native dialogs (folder pickers, error boxes) cannot be auto-dismissed, and
// these actions would block or mutate state; they are reported as SKIPPED.
const SKIP_WORDS = ['立即更新', '卸载', '删除', '移除', '退出', '清除', '清空', '断开', '开启托管', '停止托管', '关闭托管', '撤销', '注销', '登出', '重启', '添加', '选择', '浏览', '导入', '文件夹', '目录', '安装']
const CLOSE_WORDS = ['关闭', '取消', '稍后继续', '×', '✕']

const results = [], pageErrors = [], consoleErrors = []
let app, page, finished = false

async function report(extra = {}) {
  if (finished) return
  finished = true
  const whites = results.filter((r) => r.status === 'WHITE')
  await fs.writeFile(path.join(outDir, 'audit-report.json'), JSON.stringify({ ts, whites, skipped: results.filter((r) => r.status === 'SKIPPED').map((r) => `${r.page}/${r.button}`), clickFails: results.filter((r) => r.status === 'CLICK_FAIL'), pageErrors, consoleErrors, results, ...extra }, null, 2)).catch(() => {})
  console.log(JSON.stringify({ outDir, total: results.length, whites: whites.length, clickFails: results.filter((r) => r.status === 'CLICK_FAIL').length, pageErrors: pageErrors.length, consoleErrors: consoleErrors.length, ...extra }))
  process.exitCode = whites.length || pageErrors.length || extra.fatal ? 1 : 0
  await app?.close().catch(() => {})
  setTimeout(() => process.exit(process.exitCode || 0), 2000)
}
const watchdog = setTimeout(() => { pageErrors.push({ at: new Date().toISOString(), kind: 'watchdog-timeout' }); report({ fatal: 'watchdog-12min' }) }, 12 * 60 * 1000)

async function shot(name) { await page?.screenshot({ path: path.join(outDir, `${name}.png`) }).catch(() => {}) }
async function health() {
  try {
    const m = await page.evaluate(() => ({ text: document.body.innerText.trim().length, buttons: document.querySelectorAll('button').length, rail: Boolean(document.querySelector('.nx-rail')) }), { timeout: 5000 })
    return { ...m, white: m.text < 5 && !m.rail }
  } catch (error) { return { evalError: String(error.message).slice(0, 200), white: true } }
}
async function dismissOverlays() {
  await page.keyboard.press('Escape').catch(() => {})
  for (const word of CLOSE_WORDS) {
    const btn = page.locator('button:visible', { hasText: word }).first()
    if (await btn.count().catch(() => 0)) { await btn.click({ timeout: 1000 }).catch(() => {}); await page.waitForTimeout(300) }
  }
}
async function clickAll(label) {
  const handles = await page.locator('button:visible, [role="button"]:visible').all().catch(() => [])
  for (const handle of handles) {
    const text = (await handle.innerText().catch(() => '')).trim().slice(0, 40)
    if (!text) continue
    if (SKIP_WORDS.some((word) => text.includes(word))) { results.push({ page: label, button: text, status: 'SKIPPED' }); continue }
    try {
      await handle.click({ timeout: 3000 })
      await page.waitForTimeout(700)
      const state = await health()
      results.push({ page: label, button: text, status: state.white ? 'WHITE' : 'OK', bodyText: state.bodyText, buttons: state.buttons, evalError: state.evalError })
      if (state.white) await shot(`WHITE-${label}-${text}`)
      await dismissOverlays()
    } catch (error) { results.push({ page: label, button: text, status: 'CLICK_FAIL', error: String(error.message).slice(0, 200) }) }
  }
}

try {
  app = await _electron.launch({ executablePath: exe, args: ['--nexus-smoke-test'], env: { ...process.env, NEXUS_DESKTOP_DATA_DIR: path.join(outDir, 'profile') }, timeout: 60000 })
  page = await app.firstWindow()
  page.on('pageerror', (e) => pageErrors.push({ at: new Date().toISOString(), message: String(e?.message || e).slice(0, 400) }))
  page.on('crash', () => pageErrors.push({ at: new Date().toISOString(), kind: 'renderer-crash' }))
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push({ at: new Date().toISOString(), text: m.text().slice(0, 300) }) })
  await page.locator('.nx-rail').waitFor({ timeout: 40000 }).catch(() => {})
  await page.waitForTimeout(2500)
  await shot('00-initial')
  // First-use tutorial opens automatically on a fresh 0.8.6 profile; walk it.
  const tutorialButton = page.locator('button:visible').filter({ hasText: /下一步|开始|继续|稍后/ })
  for (let i = 0; i < 12 && await tutorialButton.first().isVisible().catch(() => false); i++) {
    await clickAll(`tutorial-step-${i}`)
    if (!(await tutorialButton.first().isVisible().catch(() => false))) break
    const label = (await tutorialButton.first().innerText().catch(() => '')).trim()
    await tutorialButton.first().click({ timeout: 2000 }).catch(() => {})
    results.push({ page: `tutorial-step-${i}`, button: label, status: 'OK' })
    await page.waitForTimeout(600)
  }
  await shot('01-after-tutorial')
  const navItems = await page.locator('.nx-rail .nx-nav-item').all()
  for (const item of navItems) {
    const label = (await item.innerText().catch(() => '')).trim().replace(/\s+/g, ' ') || 'unnamed'
    await item.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(1000)
    const state = await health()
    results.push({ page: `NAV:${label}`, button: '(navigation)', status: state.white ? 'WHITE' : 'OK', bodyText: state.bodyText, buttons: state.buttons })
    await shot(`nav-${label}`)
    await clickAll(label)
    await dismissOverlays()
  }
  await shot('99-final')
  await report()
} catch (error) {
  pageErrors.push({ at: new Date().toISOString(), fatal: String(error?.message || error).slice(0, 600) })
  await report({ fatal: String(error?.message || error).slice(0, 300) })
} finally { clearTimeout(watchdog) }
