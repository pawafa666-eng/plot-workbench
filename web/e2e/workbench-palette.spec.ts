import { expect, test } from './fixtures'
import { mkdirSync } from 'node:fs'

test('creates, edits, interpolates and samples a local palette', { tag: '@feature:workbench.palettes' }, async ({ page, app }, testInfo) => {
  const instance = await app({ noProject: true })
  const status = await (await page.request.get(`${instance.baseURL}/api/workbench/status`)).json() as { root: string }
  await page.addInitScript((root) => localStorage.setItem('workbench.selectedRoot', root), status.root)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(instance.baseURL)
  await page.locator('[data-wb-nav-palettes]').click()
  await expect(page.locator('[data-palette-card]')).toHaveCount(15)
  await page.locator('[data-palette-create]').click()
  await page.locator('[data-palette-name]').fill('测试配色')
  await page.locator('[data-palette-hex]').fill('#000000')
  await page.locator('[data-palette-add]').click()
  await page.locator('[data-palette-hex]').fill('#FFFFFF')
  await page.locator('[data-palette-add]').click()
  await page.locator('[data-palette-multiselect]').click()
  await page.locator('[data-palette-swatch="0"]').click()
  await page.locator('[data-palette-swatch="1"]').click()
  await page.locator('[data-palette-gradient]').click()
  await page.locator('[data-palette-gradient-count]').fill('5')
  await page.locator('[data-palette-gradient-confirm]').click()
  await expect(page.locator('[data-palette-swatch]')).toHaveCount(5)
  await expect(page.locator('[data-palette-swatch="2"]')).toContainText('#808080')

  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 40
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#29B37F'; ctx.fillRect(0, 0, 40, 40)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.locator('[data-palette-image-upload]').setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  const image = page.locator('.wb-palette-image-viewport img')
  await expect(image).toBeVisible()
  await image.hover()
  await expect(page.locator('[data-palette-magnifier]')).toContainText('#29B37F')
  await image.click()
  await expect(page.locator('[data-palette-hex]')).toHaveValue('#29B37F')
  await page.locator('[data-palette-add]').click()
  await expect(page.locator('[data-palette-swatch]')).toHaveCount(6)
  // The visible image and the sampling canvas must use the same frozen frame.
  const gif = 'R0lGODlhKAAoAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQADwAAACwAAAAAKAAoAAAIQwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzgJBgQAIfkEAQ8AAQAsAAAAACgAKACBAP8AAAAAAAAAAAAACEMAAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMoU6pcybKly5cwY8qcSbOmzZs4CQYEADs='
  await page.locator('[data-palette-image-upload]').setInputFiles({ name: 'animated.gif', mimeType: 'image/gif', buffer: Buffer.from(gif, 'base64') })
  await expect(image).toBeVisible()
  const frozen = await image.screenshot()
  await page.waitForTimeout(250)
  expect((await image.screenshot()).equals(frozen)).toBe(true)
  await image.click()
  const sampled = await page.locator('[data-palette-hex]').inputValue()
  expect(['#FF0000', '#00FF00']).toContain(sampled)
  await page.screenshot({ path: testInfo.outputPath('palette-editor.png'), fullPage: true })
  await page.locator('[data-palette-save]').click()
  await expect(page.locator('[data-palette-card]')).toHaveCount(16)
  await page.locator('[data-palette-card]').filter({ hasText: '测试配色' }).locator('.wb-palette-card-main').click()
  await expect(page.locator('[data-palette-swatch]')).toHaveCount(6)
  await expect(page.locator('[data-palette-swatch="5"]')).toContainText('#29B37F')
})

test('applies a saved palette to a heatmap and keeps it after verified save', { tag: '@feature:workbench.palettes' }, async ({ page, app }, testInfo) => {
  const instance = await app({ noProject: true })
  const base = `${instance.baseURL}/api/workbench`
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(`${base}${path}`, { data })
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  const status = await (await page.request.get(`${base}/status`)).json() as { root: string }
  await page.addInitScript((root) => localStorage.setItem('workbench.selectedRoot', root), status.root)
  const folder = testInfo.outputPath('project'); mkdirSync(folder, { recursive: true })
  const project = await post('/projects', { name: 'Palette project', path: folder }) as { id: string }
  const plot = await post(`/projects/${project.id}/plots`, { name: 'Heatmap' }) as { id: string }
  const palette = await post('/palettes', { name: 'Blue to red', colors: ['#0000FF', '#FF0000'] }) as { id: string }
  const job = await post(`/plots/${plot.id}/render`, { code: 'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nim = ax.imshow([[0, 1], [2, 3]], cmap="viridis")\nfig.colorbar(im, ax=ax)\n', data: null, schema: {} }) as { job_id: string }
  await expect.poll(async () => (await (await page.request.get(`${base}/jobs/${job.job_id}`)).json()).status, { timeout: 90_000 }).toBe('success')
  await post(`/plots/${plot.id}/save`, { run_id: job.job_id })
  await page.setViewportSize({ width: 1440, height: 950 })
  await page.goto(instance.baseURL)
  await page.locator(`[data-wb-project-nav="${project.id}"]`).click()
  await page.locator(`[data-wb-plot-card="${plot.id}"] button:has(img)`).click()
  await page.locator('[data-wb-open-tavotto]').click()
  const image = page.locator('[data-element-svg] [id="axes_0.images_0"]')
  await expect(image).toBeVisible({ timeout: 90_000 })
  const pixels = () => image.evaluate((element) => {
    const raster = element.tagName.toLowerCase() === 'image' ? element : element.querySelector('image')
    return raster?.getAttribute('href') ?? raster?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
  })
  const before = await pixels()
  expect(before).toContain('data:image/png;base64,')
  const box = await image.boundingBox(); expect(box).not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
  const row = page.locator('[data-prop="cmap"]').first()
  await expect(row).toBeVisible()
  await row.locator('[data-palette-picker]').click()
  await page.locator('[data-palette-picker-panel] select').first().selectOption(palette.id)
  const request = page.waitForRequest((item) => item.url().endsWith('/render') && item.method() === 'POST' && JSON.stringify(item.postDataJSON()).includes('workbench_palette_v1'))
  await page.locator('[data-palette-picker-panel] button').filter({ hasText: '应用配色' }).click()
  const sent = (await request).postDataJSON()
  expect(sent.patches.some((item: { prop: string; value: { colors: string[] } }) => item.prop === 'cmap' && item.value.colors.join(',') === '#0000FF,#FF0000')).toBe(true)
  await expect(page.locator('[data-wb-tavotto-finish]')).toBeEnabled({ timeout: 90_000 })
  const recolored = await pixels()
  expect(recolored).not.toBe(before)
  await page.locator('[data-wb-tavotto-finish]').click()
  await expect(page.locator('[data-wb-plot-editor]')).toBeVisible({ timeout: 90_000 })
  const saved = await (await page.request.get(`${base}/plots/${plot.id}`)).json() as { overrides: { prop: string; value: { colors: string[] } }[] }
  expect(saved.overrides.find((item) => item.prop === 'cmap')?.value.colors).toEqual(['#0000FF', '#FF0000'])
  await page.request.delete(`${base}/palettes/${palette.id}`)
  await page.locator('[data-wb-open-tavotto]').click()
  await expect(page.locator('[data-element-svg] svg')).toBeVisible({ timeout: 90_000 })
  const reopened = await pixels()
  expect(reopened).toBe(recolored)
})
