// Verify the installed WebView2 at actual device scale factors. Authentication
// is established by the native shell; no bypass, injected app state or mock APIs.
import { chromium } from '@playwright/test'
import ts from 'typescript'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const [port, scaleText, directory] = process.argv.slice(2)
const scale = Number(scaleText)
const source = await readFile(new URL('../e2e/overflow.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { horizontalOffenders } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
await mkdir(directory, { recursive: true })
let browser
for (let attempt = 0; attempt < 60; attempt++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break }
  catch { await new Promise((r) => setTimeout(r, 500)) }
}
if (!browser) throw Error('Installed WebView2 debug endpoint did not become ready')
let page
try {
  const deadline = Date.now() + 30000
  while (!page && Date.now() < deadline) {
    const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => /^http:\/\/127\.0\.0\.1:/.test(p.url()))
    if (pages.length === 1) page = pages[0]
    else if (pages.length > 1) throw Error('More than one native main page')
    else await new Promise((r) => setTimeout(r, 250))
  }
  if (!page) throw Error('Native main page missing')
  await page.locator('[data-workbench-app]').waitFor()
  await page.waitForFunction(() => document.querySelector('[data-wb-project-create]') || document.querySelector('[data-wb-library-inspect]'))
  const rootDialog = page.locator('[data-dialog="workbench-root"]')
  if (await rootDialog.count()) {
    await page.locator('[data-wb-library-inspect]').click()
    await page.locator('[data-wb-library-overview]').waitFor()
    await page.locator('[data-wb-path-confirm]').click()
    await rootDialog.waitFor({ state: 'detached' })
  }
  await page.locator('[data-workbench-preferences-ready]').waitFor()
  if (await page.locator('[data-workbench-app].is-sidebar-collapsed').count()) {
    await page.locator('[data-wb-sidebar-toggle]').click()
    await page.locator('[data-workbench-app]:not(.is-sidebar-collapsed)').waitFor()
  }
  const actualScale = await page.evaluate(() => devicePixelRatio)
  if (Math.abs(actualScale - scale) > 0.02) throw Error(`Expected native scale ${scale}, got ${actualScale}`)
  const results = []
  async function inspect(name, root = '[data-workbench-app]') {
    const offenders = await horizontalOffenders(page, root)
    await page.screenshot({ path: resolve(directory, `${name}.png`) })
    results.push({ name, offenders })
    if (offenders.length) throw Error(`${name}: ${offenders.join('; ')}`)
  }
  await inspect('home')
  await page.locator('[data-wb-sidebar-toggle]').click()
  await page.locator('[data-workbench-app].is-sidebar-collapsed').waitFor()
  await inspect('home-collapsed')
  await page.locator('[data-wb-sidebar-toggle]').click()
  await page.locator('[data-workbench-app]:not(.is-sidebar-collapsed)').waitFor()
  await page.locator('[data-wb-settings]').click()
  await page.locator('[data-wb-installation-check]').filter({ hasText: '安装登记与正在运行的程序一致' }).waitFor()
  await inspect('settings', '[data-dialog="workbench-settings"]')
  await page.locator('[data-wb-density] button').click()
  await page.locator('[data-ui-select-option="standard"]').click()
  await page.locator('[data-wb-density] button').click()
  const compactSaved = page.waitForResponse((r) => r.url().endsWith('/preferences') && r.request().method() === 'PATCH' && r.request().postDataJSON().density === 'compact')
  await page.locator('[data-ui-select-option="compact"]').click()
  if (!(await compactSaved).ok()) throw Error('Density preference did not persist')
  await page.keyboard.press('Escape')
  await page.reload()
  await page.locator('[data-workbench-app][data-density="compact"]').waitFor()
  await inspect('home-compact')
  // Fixture creation goes through authenticated public workbench routes. The
  // code edit/run/save/history/graphical operations themselves use real UI.
  const projectDirectory = resolve(directory, `project-${Date.now()}`)
  await mkdir(projectDirectory, { recursive: true })
  const plot = await page.evaluate(async ({factor, projectDirectory}) => {
    const json = async (path, body) => {
      const r = await fetch(`/api/workbench${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw Error(`${path}: ${r.status} ${await r.text()}`)
      return r.json()
    }
    const p = await json('/projects', { name: `Native scale ${factor}`, path: projectDirectory })
    return json(`/projects/${p.id}/plots`, { name: `Layout ${factor}` })
  }, {factor: scale, projectDirectory})
  await page.reload()
  await page.locator('[data-wb-project-search]').fill(projectDirectory)
  if (await page.locator('[data-wb-project-card]').count() !== 1) throw Error('Project path search is incorrect')
  await page.locator('[data-wb-project-view="list"]').click()
  await inspect('home-list')
  await page.locator('[data-wb-project-search]').fill('')
  await page.locator(`[data-wb-project-nav="${plot.project_id}"]`).click()
  await page.locator(`[data-wb-plot-card="${plot.id}"] [data-wb-plot-open]`).click()
  await page.locator('[data-wb-code-toggle]').click()
  await page.locator('[data-wb-code]').fill('import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([1,2,3], [2,4,3])\nax.set_xlabel("Sample")\nfig.tight_layout()')
  await page.locator('[data-wb-draft-status]').filter({ hasText: '草稿已保存到本机' }).waitFor()
  await inspect('code-editor')
  await page.locator('[data-wb-code-toggle]').click()
  await inspect('canvas-focused')
  await page.locator('[data-wb-run]').click()
  await page.locator('[data-wb-save]:enabled').waitFor({ timeout: 90000 })
  await page.locator('[data-wb-save]').click()
  await page.locator('[data-wb-history-open]:enabled').waitFor()
  await page.locator('[data-wb-history-open]').click()
  await page.locator('[data-wb-history-version="1"]').click()
  await inspect('history', '[data-dialog="workbench-history"]')
  await page.keyboard.press('Escape')
  await page.locator('[data-wb-open-tavotto]').click()
  await page.locator('[data-wb-tavotto]').waitFor({ timeout: 90000 })
  // Canvas object layers deliberately have zero-size origins and allow world
  // geometry to overflow during pan/zoom. The canonical HTML overflow ruler
  // applies to toolbar/inspector controls; the clipped viewport has a separate
  // positive containment check, not a second horizontal-overflow algorithm.
  await inspect('graphical-toolbar', '[data-wb-tavotto-toolbar]')
  await inspect('graphical-inspector', '[data-wb-inspector]')
  const canvas = await page.locator('[data-canvas-stage]').boundingBox()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  if (!canvas || canvas.x < 0 || canvas.y < 0 || canvas.x + canvas.width > viewport.width + 1 || canvas.y + canvas.height > viewport.height + 1) throw Error('Canvas viewport is outside the usable window')
  await page.locator('[data-wb-tavotto-cancel]').click()
  await page.locator('[data-wb-tavotto]').waitFor({ state: 'detached' })
  await page.locator('[data-wb-nav-home]').click()
  const nativeViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  // This extra responsive check changes CSS viewport size; scale verification
  // above uses the actual WebView process argument and devicePixelRatio.
  if (scale === 1) {
    await page.setViewportSize({ width: 1000, height: 720 })
    await inspect('home-narrow')
    await page.locator('[data-wb-settings]').click()
    await inspect('settings-narrow', '[data-dialog="workbench-settings"]')
    await page.keyboard.press('Escape')
  }
  await writeFile(resolve(directory, 'layout.json'), JSON.stringify({ scale, actualScale, nativeViewport, narrowViewport: scale === 1 ? { width: 1000, height: 720 } : null, results }, null, 2))
  console.log(`PASS native WebView2 layout at ${scale * 100}%`)
} catch (error) {
  if (page) {
    await writeFile(resolve(directory, 'failure.txt'), await page.locator('[data-workbench-app]').innerText().catch(() => 'Page unavailable'))
    await page.screenshot({ path: resolve(directory, 'failure.png'), timeout: 5000 }).catch(() => {})
  }
  throw error
} finally {
  // Disconnecting CDP leaves the owned native app for the Python WM_CLOSE check.
  await browser.close()
}
