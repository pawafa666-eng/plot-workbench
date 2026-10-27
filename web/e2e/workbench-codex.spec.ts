import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Locator, Page, TestInfo } from '@playwright/test'
import { expect, test } from './fixtures'

const REPO = path.resolve(import.meta.dirname, '..', '..')
const TITLE = 'Codex browser check'
const SCHEMA = { rows: { mode: 'variable', min: 1 }, columns: { mode: 'variable', min: 1 } }
const CODE = `import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(3.2, 2.4))
ax.plot([0, 1, 2], [1, 3, 2])
ax.set(xlabel="x", ylabel="y", title="Before Codex one")
fig.tight_layout()
fig2, ax2 = plt.subplots(figsize=(3.2, 2.4))
ax2.plot([0, 1, 2], [3, 1, 2])
ax2.set(xlabel="x", ylabel="y", title="Before Codex two")
fig2.tight_layout()
`

/**
 * Only the paid provider boundary is replaced. The actual app, workbench routes,
 * staged scripts, workers, candidate checks, save verification and artifacts run.
 * This preload is scoped to this test's child process and temporary output dir;
 * it never alters an installed CLI, account, agent config or production module.
 */
function deterministicCodex(testInfo: TestInfo): Record<string, string> {
  const directory = testInfo.outputPath('codex-preload')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'sitecustomize.py'), `from pathlib import Path
import copy
import difflib
import uuid
from tavotto.engine import ai_bridge

_CAPS = {
    "agents": [{
        "id": "codex", "display_name": "Codex", "icon_key": "codex",
        "state": "ready", "installed": True, "enabled": True, "usable": True,
        "version": "0.0.0-test", "executable_path": None, "path_override": None,
        "detection_source": None, "models": [], "default_model": None,
        "efforts": [], "default_effort": None, "endpoint": None,
        "active_endpoint_id": None,
        "features": {"third_party_endpoints": False, "model_selection": False,
                     "effort_selection": False, "wire_api_selection": False,
                     "readiness_probe": True},
        "diagnostics": {"searched": [], "broken_path": None,
                        "readiness": "ready", "readiness_detail": None}
    }], "endpoints": [], "presets": [], "checked_at_ms": 1
}

def _capabilities(refresh=False):
    return copy.deepcopy(_CAPS)

def _run(*, script, figures_dir, **kwargs):
    target = Path(figures_dir) / script
    before = target.read_text("utf-8")
    after = before + "\\nimport matplotlib.pyplot as plt\\nfor _number in plt.get_fignums():\\n    for _axes in plt.figure(_number).axes:\\n        _axes.set_title('${TITLE}')\\n"
    target.write_text(after, encoding="utf-8")
    sid = uuid.uuid4().hex
    ai_bridge.SESSIONS[sid] = {
        "id": sid, "agent": "codex", "status": "done", "changed": True,
        "script_path": str(target),
        "diff": "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True))),
        "transcript": [{"kind": "message", "text": "Deterministic browser test proposal ready"}]
    }
    return sid

ai_bridge.capabilities = _capabilities
ai_bridge.run = _run
`, 'utf-8')
  return { PYTHONPATH: [directory, path.join(REPO, 'src'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) }
}

async function post<T>(request: APIRequestContext, baseURL: string, route: string, body: unknown = {}): Promise<T> {
  const response = await request.post(`${baseURL}/api/workbench${route}`, { data: body })
  expect(response.ok(), `${route}: ${await response.text()}`).toBe(true)
  return response.json() as Promise<T>
}

async function get<T>(request: APIRequestContext, baseURL: string, route: string): Promise<T> {
  const response = await request.get(`${baseURL}/api/workbench${route}`)
  expect(response.ok(), `${route}: ${await response.text()}`).toBe(true)
  return response.json() as Promise<T>
}

async function openWorkbench(page: Page, baseURL: string) {
  const status = await get<{ root: string }>(page.request, baseURL, '/status')
  await page.addInitScript((root) => localStorage.setItem('workbench.selectedRoot', root), status.root)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(baseURL)
  await expect(page.locator('[data-workbench-app]')).toBeVisible()
}

/** One concrete control must be entirely visible and its center unobstructed. */
async function expectUsable(page: Page, locator: Locator) {
  await expect(locator).toHaveCount(1)
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  const viewport = page.viewportSize()!
  expect(box!.width).toBeGreaterThan(0)
  expect(box!.height).toBeGreaterThan(0)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 0.5)
  expect(await locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const top = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    return !!top && (top === element || element.contains(top))
  })).toBe(true)
}

async function propose(page: Page, entry: string) {
  const trigger = page.locator(entry)
  await expectUsable(page, trigger)
  await expect(trigger).toBeEnabled()
  await trigger.click()
  const prompt = page.locator('[data-wb-assistant-prompt]')
  await expectUsable(page, prompt)
  await prompt.fill('Add the title Codex browser check to each figure; preserve all existing data and figures.')
  const start = page.locator('[data-wb-assistant-start]')
  await expect(start).toBeEnabled()
  await expectUsable(page, start)
  await start.click()
  await expect(page.locator('[data-wb-assistant-diff]')).toContainText(TITLE)
  await expect(page.locator('[data-wb-assistant-apply]')).toBeEnabled()
}

async function expectLoadedImage(image: Locator) {
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true)
}

async function expectPaintedLabel(svg: Locator, gid: string, text: string) {
  const group = svg.locator(`[id="${gid}"]`)
  await expect(group).toHaveCount(1)
  // Matplotlib's default SVG turns text into glyph paths. Its comment retains
  // the source label, while a nonempty rendered glyph box verifies actual ink.
  await expect.poll(() => group.innerHTML()).toContain(`<!-- ${text} -->`)
  const box = await group.evaluate((element) => {
    const bounds = (element as SVGGraphicsElement).getBBox()
    return { width: bounds.width, height: bounds.height }
  })
  expect(box.width).toBeGreaterThan(0)
  expect(box.height).toBeGreaterThan(0)
  return group
}

test('Codex template proposal requires application and fresh validation before save', { tag: '@feature:workbench.template-codex' }, async ({ page, app }, testInfo) => {
  const instance = await app({ noProject: true, env: deterministicCodex(testInfo) })
  await openWorkbench(page, instance.baseURL)
  await page.locator('[data-wb-nav-templates]').click()
  await page.locator('[data-wb-template-create]').click()
  const code = page.locator('[data-wb-code]')
  const originalCode = await code.inputValue()
  const save = page.locator('[data-wb-template-save]')
  await page.locator('[data-wb-template-run]').click()
  await expect(save).toBeEnabled({ timeout: 90_000 })
  await expectLoadedImage(page.locator('[data-wb-preview-image]'))
  const previousPreview = await page.locator('[data-wb-preview-image]').getAttribute('src')
  await propose(page, '[data-wb-template-assistant]')
  await page.screenshot({ path: testInfo.outputPath('codex-proposal.png') })
  await expect(code).toHaveValue(originalCode)
  const apply = page.locator('[data-wb-assistant-apply]')
  await expectUsable(page, apply)
  await apply.click()
  await expect(page.locator('[data-dialog="workbench-code-assistant"]')).toHaveCount(0)
  await expect(code).toHaveValue(new RegExp(TITLE))
  await expect(save).toBeDisabled()
  await page.locator('[data-wb-template-run]').click()
  await expect(save).toBeEnabled({ timeout: 90_000 })
  await expectLoadedImage(page.locator('[data-wb-preview-image]'))
  await expect(page.locator('[data-wb-preview-image]')).not.toHaveAttribute('src', previousPreview!)
  const savedResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url() === `${instance.baseURL}/api/workbench/templates`)
  await expectUsable(page, save)
  await save.click()
  const saved = await (await savedResponse).json() as { id: string; revision: number; code: string; preview_url: string }
  expect(saved.revision).toBeGreaterThan(0)
  expect(saved.code).toContain(TITLE)
  const persisted = await get<{ code: string }>(page.request, instance.baseURL, `/templates/${saved.id}`)
  expect(persisted.code).toBe(saved.code)
  const card = page.locator(`[data-wb-template-card="${saved.id}"]`)
  await expectLoadedImage(card.locator('img'))
  const png = await page.request.get(`${instance.baseURL}${saved.preview_url}`)
  expect(png.ok()).toBe(true)
  expect((await png.body()).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  await card.locator('button:has(img)').click()
  await expect(page.locator('[data-wb-code]')).toHaveValue(saved.code)
})

test('Codex figure proposal preserves overrides through verified save and reopen', { tag: '@feature:workbench.tavotto-codex' }, async ({ page, app }, testInfo) => {
  const instance = await app({ noProject: true, env: deterministicCodex(testInfo) })
  const directory = testInfo.outputPath('scientific-project')
  mkdirSync(directory, { recursive: true })
  const project = await post<{ id: string }>(page.request, instance.baseURL, '/projects', { name: 'Codex browser project', path: directory })
  const plot = await post<{ id: string }>(page.request, instance.baseURL, `/projects/${project.id}/plots`, { name: 'Two figures' })
  const started = await post<{ job_id: string }>(page.request, instance.baseURL, `/plots/${plot.id}/render`, { code: CODE, data: null, schema: SCHEMA })
  await expect.poll(async () => (await get<{ status: string }>(page.request, instance.baseURL, `/jobs/${started.job_id}`)).status, { timeout: 90_000 }).toBe('success')
  await post(page.request, instance.baseURL, `/plots/${plot.id}/save`, { run_id: started.job_id })
  const first = await post<{ session_id: string }>(page.request, instance.baseURL, `/plots/${plot.id}/tavotto/open`, { stem: 'figure_2' })
  const overrides = [{ gid: 'axes_0.xlabel', prop: 'text', value: 'Retained browser label' }]
  await post(page.request, instance.baseURL, `/sessions/${first.session_id}/render`, { patches: overrides })
  const before = await post<{ revision: number }>(page.request, instance.baseURL, `/sessions/${first.session_id}/finish`, { patches: overrides })
  await openWorkbench(page, instance.baseURL)
  await page.locator(`[data-wb-project-nav="${project.id}"]`).click()
  await page.locator(`[data-wb-plot-card="${plot.id}"] button:has(img)`).click()
  await page.locator('[data-wb-output="figure_2"]').click()
  await page.locator('[data-wb-open-tavotto]').click()
  const svg = page.locator('[data-element-svg] > svg')
  await expect(svg).toBeVisible({ timeout: 90_000 })
  const oldTitle = await expectPaintedLabel(svg, 'axes_0.title', 'Before Codex two')
  await expectPaintedLabel(svg, 'axes_0.xlabel', 'Retained browser label')
  const beforeTitlePixels = await oldTitle.screenshot()
  await propose(page, '[data-wb-tavotto-assistant]')
  await page.screenshot({ path: testInfo.outputPath('codex-proposal.png') })
  const apply = page.locator('[data-wb-assistant-apply]')
  await expectUsable(page, apply)
  await apply.click()
  await expect(page.locator('[data-dialog="workbench-code-assistant"]')).toHaveCount(0, { timeout: 90_000 })
  const newTitle = await expectPaintedLabel(svg, 'axes_0.title', TITLE)
  expect((await newTitle.screenshot()).equals(beforeTitlePixels)).toBe(false)
  await expectPaintedLabel(svg, 'axes_0.xlabel', 'Retained browser label')
  const staged = await get<{ revision: number; base_code: string }>(page.request, instance.baseURL, `/plots/${plot.id}`)
  expect(staged.revision).toBe(before.revision)
  expect(staged.base_code).not.toContain(TITLE)
  const finish = page.locator('[data-wb-tavotto-finish]')
  await expect(finish).toBeEnabled()
  await expectUsable(page, finish)
  await finish.click()
  await expect(page.locator('[data-wb-plot-editor]')).toBeVisible({ timeout: 90_000 })
  const saved = await get<{ revision: number; base_code: string; outputs: { stem: string }[]; output_overrides: Record<string, unknown[]> }>(page.request, instance.baseURL, `/plots/${plot.id}`)
  expect(saved.revision).toBe(before.revision + 1)
  expect(saved.base_code).toContain(TITLE)
  expect(saved.outputs.map((output) => output.stem).sort()).toEqual(['figure', 'figure_2'])
  expect(saved.output_overrides.figure_2).toEqual(overrides)
  for (const stem of ['figure', 'figure_2']) {
    const response = await page.request.get(`${instance.baseURL}/api/workbench/plots/${plot.id}/export?format=svg&stem=${stem}`)
    expect(response.ok()).toBe(true)
    expect(await response.text()).toContain(TITLE)
  }
  await page.locator('[data-wb-open-tavotto]').click()
  await expect(svg).toBeVisible({ timeout: 90_000 })
  await expectPaintedLabel(svg, 'axes_0.title', TITLE)
  await expectPaintedLabel(svg, 'axes_0.xlabel', 'Retained browser label')
  await page.screenshot({ path: testInfo.outputPath('codex-reopened.png') })
})
