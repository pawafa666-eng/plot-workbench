import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Locator, Page, TestInfo } from '@playwright/test'
import { expect, test } from './fixtures'

const REPO = path.resolve(import.meta.dirname, '..', '..')
const TITLE = 'Codex browser check'
const REPLY = '已更新图表标题，并保留原有数据与图内修改。你可以继续提出调整要求。'
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
import time
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
        "transcript": [{"kind": "message", "text": "${REPLY}"}]
    }
    return sid

ai_bridge.capabilities = _capabilities
ai_bridge.run = _run
_original_get = ai_bridge.get
_seen = {}
def _get(sid):
    session = _original_get(sid)
    if session and session.get("agent") == "codex":
        first = _seen.setdefault(sid, time.monotonic())
        if time.monotonic() - first < 2:
            return {**session, "status": "running"}
    return session
ai_bridge.get = _get
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

async function propose(page: Page, entry: string, duringRun?: () => Promise<void>) {
  const trigger = page.locator(entry)
  await expectUsable(page, trigger)
  await expect(trigger).toBeEnabled()
  await trigger.click()
  const dialog = page.locator('[data-dialog="workbench-code-assistant"]')
  // Wait for the opening scale animation before measuring the normal width.
  await expect.poll(async () => (await dialog.boundingBox())!.width).toBeCloseTo(920, 0)
  const initialWidth = (await dialog.boundingBox())!.width
  await page.locator('[data-wb-assistant-expand]').click()
  await expect.poll(async () => (await dialog.boundingBox())!.width).toBeGreaterThan(initialWidth + 100)
  await page.locator('[data-wb-assistant-expand]').click()
  await expect.poll(async () => (await dialog.boundingBox())!.width).toBeCloseTo(initialWidth, 0)
  const prompt = page.locator('[data-wb-assistant-prompt]')
  await expectUsable(page, prompt)
  await prompt.fill('请为每张图设置标题 Codex browser check，保留原有数据和其他设置。')
  const start = page.locator('[data-wb-assistant-start]')
  await expect(start).toBeEnabled()
  await expectUsable(page, start)
  await start.click()
  if (duringRun) await duringRun()
  await expect(page.locator('[data-wb-assistant-message="assistant"]').last()).toContainText(REPLY)
  await page.locator('[data-wb-assistant-preview]').click()
  await expectLoadedImage(page.locator('[data-wb-assistant-before]'))
  await expectLoadedImage(page.locator('[data-wb-assistant-after]'))
  // Continue in the same staged draft before applying it to the real editor.
  const followup = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/assistant/runs'))
  await prompt.fill('保留上一轮草稿，请简要解释改动。')
  await start.click()
  const body = (await followup).postDataJSON()
  expect(body.parent_id).toBeTruthy()
  expect(body.history.map((item: { role: string }) => item.role)).toEqual(['user', 'assistant'])
  await expect(page.locator('[data-wb-assistant-message="assistant"]')).toHaveCount(2)
  await expect(page.locator('[data-wb-assistant-preview]')).toBeEnabled()
  await page.locator('[data-wb-assistant-preview]').click()
  await expectLoadedImage(page.locator('[data-wb-assistant-before]'))
  await expectLoadedImage(page.locator('[data-wb-assistant-after]'))
  await expect(page.locator('[data-wb-assistant-apply]')).toBeEnabled({ timeout: 90_000 })
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
  const name = page.getByLabel('模板名称')
  await name.fill('原始模板草稿')
  page.on('dialog', (dialog) => void dialog.accept())
  await propose(page, '[data-wb-template-assistant]', async () => {
    await page.locator('[data-wb-assistant-close]').click()
    await page.locator('[data-wb-nav-home]').click()
    await page.locator('[data-wb-nav-templates]').click()
    await page.locator('[data-wb-template-create]').click()
    await expect(page.getByLabel('模板名称')).toHaveValue('未命名模板')
    const notification = page.locator('[data-wb-assistant-notification]')
    await expect(notification).toContainText('Codex 已完成', { timeout: 30_000 })
    await notification.getByText('查看对话').click()
    await expect(page.locator('[data-wb-assistant-apply]')).toBeDisabled()
    await page.locator('[data-wb-assistant-return]').click()
    await expect(page.getByLabel('模板名称')).toHaveValue('原始模板草稿')
    await expect(page.locator('[data-wb-code]')).toHaveValue(originalCode)
    await page.locator('[data-wb-template-assistant]').click()
  })
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
  const other = await post<{ id: string }>(page.request, instance.baseURL, `/projects/${project.id}/plots`, { name: 'Another plot' })
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
  const cancelled: string[] = []
  page.on('request', (request) => { if (request.url().includes('/assistant/runs/') && request.url().endsWith('/cancel')) cancelled.push(request.url()) })
  page.on('dialog', (dialog) => void dialog.accept())
  await propose(page, '[data-wb-tavotto-assistant]', async () => {
    await page.locator('[data-wb-assistant-close]').click()
    await expect(page.locator('[data-dialog="workbench-code-assistant"]')).toHaveCount(0)
    await page.locator(`[data-wb-project-nav="${project.id}"]`).click()
    await page.locator(`[data-wb-plot-card="${other.id}"]`).getByText('打开图').click()
    await expect(page.locator('[data-wb-plot-editor]')).toContainText('Another plot')
    const notification = page.locator('[data-wb-assistant-notification]')
    await expect(notification).toContainText('Codex 已完成', { timeout: 30_000 })
    await notification.getByText('查看对话').click()
    await expect(page.locator('[data-wb-assistant-apply]')).toBeDisabled()
    let releaseResume!: () => void
    let sawResume!: () => void
    const pendingResume = new Promise<void>((resolve) => { releaseResume = resolve })
    const intercepted = new Promise<void>((resolve) => { sawResume = resolve })
    const resumeRoute = async (route: import('@playwright/test').Route) => { sawResume(); await pendingResume; await route.continue() }
    await page.route('**/api/workbench/sessions/*/resume', resumeRoute)
    await page.locator('[data-wb-assistant-return]').click()
    await intercepted
    await page.locator('[data-wb-code-toggle]').click()
    await page.locator('[data-wb-code]').fill('print("newer unsaved edit")')
    releaseResume()
    await expect(page.locator('[data-wb-global-error]')).toContainText('当前页面在返回期间发生变化')
    await expect(page.locator('[data-wb-code]')).toHaveValue('print("newer unsaved edit")')
    await page.unroute('**/api/workbench/sessions/*/resume', resumeRoute)
    await notification.getByText('查看对话').click()
    await page.locator('[data-wb-assistant-return]').click()
    await expect(page.locator('[data-wb-tavotto]')).toBeVisible({ timeout: 90_000 })
    await page.locator('[data-wb-tavotto-assistant]').click()
    expect(cancelled).toEqual([])
  })
  await expect(page.locator('[data-wb-assistant-figure]')).toHaveCount(2)
  await expect(page.locator('[data-wb-assistant-figure]').first()).toHaveAttribute('data-wb-assistant-figure', 'figure_2')
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
  await expect(page.locator('[data-wb-output="figure_2"]')).toHaveAttribute('aria-selected', 'true')
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
