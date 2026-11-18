import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { fetchAiCapabilities, type AiCapabilities } from '@/lib/api'
import { PlotEditor, TemplateEditor } from './Editors'
import { download, type Plot, type Snapshot } from './api'
import { DEFAULT_SCHEMA } from './model'
import { menuActionEnabled, performEditorMenuAction } from './menu'

vi.mock('./TavottoEditor', () => ({ TavottoEditor: () => <div data-wb-test-tavotto /> }))
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), download: vi.fn(async () => {}) }))
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), fetchAiCapabilities: vi.fn(async () => ({ agents: [], endpoints: [], presets: [], checked_at_ms: 1 })) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const inputData: Snapshot = { row_count: 2, column_count: 2, columns: ['x', 'y'], index: [1,2], values: [[1,2],[2,4]], dtypes: ['int64','int64'], row_sources: [2,3], column_sources: [1,2], source: { filename: 'example.xlsx' } }
const templateSchema = { ...DEFAULT_SCHEMA, input_format: 'excel' as const, code_filename: 'plot.py' }
const outputs = [{ stem: 'figure', title: '曲线', preview_url: '/first.png' }, { stem: 'figure_2', title: '散点', preview_url: '/second.png' }]
const plot = { id: 'plot-one', project_id: 'project-one', name: '普通脚本', state: 'CODE_EDITABLE', code: 'import matplotlib.pyplot as plt\nplt.plot([1, 2])', data: null, schema: DEFAULT_SCHEMA, source: { kind: 'code' }, revision: 1, saved_revision: 1, preview_url: '/first.png', outputs } satisfies Plot

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({ ok: true, json: async () => String(input).endsWith('/save') ? plot : { session_id: 'test-session' } } as Response)))
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); document.body.innerHTML = '' })
async function renderPlot(initial: Plot = plot) { await act(async () => root.render(<TooltipProvider><PlotEditor initial={initial} templates={[]} onChanged={() => {}} onBack={() => {}} /></TooltipProvider>)) }

it('can restore script-directory inputs after using an Excel selection', async () => {
  const originalPath = 'D:\\project\\code.py'
  await renderPlot({ ...plot, data: inputData, schema: templateSchema, source: { kind: 'external', original_path: originalPath } })
  const inputMode = document.querySelector('[data-wb-input-mode]')
  expect(inputMode?.textContent).toBe('输入：Excel 选区')
  expect(document.querySelector('[data-wb-import-data]')?.textContent).toBe('更换 Excel 选区')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-restore-input]')!.click())
  expect(inputMode?.textContent).toBe('输入：原脚本目录')
  expect(document.querySelector('[data-wb-import-data]')?.textContent).toBe('改用 Excel 选区')
  expect(document.querySelector<HTMLButtonElement>('[data-wb-export]')!.disabled).toBe(true)
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-run]')!.click())
  const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/render'))!
  expect(JSON.parse(String(request[1]?.body))).toEqual({ code: plot.code, original_path: originalPath, data: null, schema: DEFAULT_SCHEMA })
})

it('requires a fresh verified run before saving a shared template draft', async () => {
  await act(async () => root.render(<TooltipProvider><TemplateEditor initial={{ id: 'imported', name: 'Shared', scope: 'global', favorite: false, code: 'print(1)', data: inputData, schema: templateSchema, revision: 0, validation_state: 'pending' }} categories={[]} onBack={() => {}} onSaved={() => {}} /></TooltipProvider>))
  expect(document.querySelector('[data-template-pending]')).not.toBeNull()
  expect(document.querySelector<HTMLButtonElement>('[data-wb-template-save]')!.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('[data-wb-template-run]')!.disabled).toBe(false)
})

it('allows a note on a legacy template without Excel or a new run', async () => {
  const template = { id: 'legacy', name: '旧模板', scope: 'global' as const, favorite: false, code: 'print(1)', data: null, schema: DEFAULT_SCHEMA, revision: 1 }
  await act(async () => root.render(<TooltipProvider><TemplateEditor initial={template} categories={[]} onBack={() => {}} onSaved={() => {}} /></TooltipProvider>))
  const note = document.querySelector<HTMLTextAreaElement>('[aria-label="模板备注"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, '旧模板备注'); note.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(document.querySelector<HTMLButtonElement>('[data-wb-template-save]')!.disabled).toBe(false)
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-template-save]')!.click())
  const request = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).endsWith('/templates/legacy') && init?.method === 'PATCH')!
  expect(JSON.parse(String(request[1]?.body))).toEqual({ name: '旧模板', category_id: 'uncategorized', description: '旧模板备注' })
})

it('edits long template notes and saves metadata without running or changing the category', async () => {
  const template = { id: 'notes', name: '模板', scope: 'global' as const, category_id: 'category-a', favorite: false, code: 'import math', data: inputData, schema: templateSchema, revision: 1, description: '短备注' }
  const onSaved = vi.fn()
  await act(async () => root.render(<TooltipProvider><TemplateEditor initial={template} categories={[]} onBack={() => {}} onSaved={onSaved} /></TooltipProvider>))
  const note = document.querySelector<HTMLTextAreaElement>('[aria-label="模板备注"]')!
  expect(note.value).toBe('短备注')
  expect(document.querySelector('[data-wb-note-expand]')).toBeNull()
  Object.defineProperty(note, 'clientHeight', { configurable: true, value: 40 })
  Object.defineProperty(note, 'scrollHeight', { configurable: true, get: () => note.value.length > 50 ? 100 : 40 })
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, '长备注'.repeat(60)); note.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-note-expand]')!.click())
  const full = document.querySelector<HTMLTextAreaElement>('[aria-label="完整模板备注"]')!
  expect(full.value).toBe('长备注'.repeat(60))
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(full, '最终备注'); full.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[data-dialog="workbench-template-notes"] button')].find((button) => button.textContent === '完成')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-template-save]')!.click())
  const call = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).endsWith('/templates/notes') && init?.method === 'PATCH')!
  expect(JSON.parse(String(call[1]?.body))).toEqual({ name: '模板', category_id: 'category-a', description: '最终备注' })
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/templates/validate'))).toBe(false)
  expect(onSaved).toHaveBeenCalled()
})

it('opens the data in a modal and retains transformations while invalidating the render', async () => {
  const template = { id: 'data', name: '模板', scope: 'global' as const, favorite: false, code: 'import math', data: inputData, schema: templateSchema, revision: 1 }
  const transposed = { ...inputData, values: [[1, 2], [2, 4]], columns: ['a', 'b'] }
  vi.mocked(fetch).mockImplementation(async (input) => ({ ok: true, json: async () => String(input).endsWith('/data/transform') ? { data: transposed } : {} } as Response))
  await act(async () => root.render(<TooltipProvider><TemplateEditor initial={template} categories={[]} onBack={() => {}} onSaved={() => {}} /></TooltipProvider>))
  const show = [...document.querySelectorAll('button')].find((button) => button.textContent?.startsWith('查看数据'))!
  await act(async () => show.click())
  expect(document.querySelector('[data-dialog="workbench-data-preview"] [data-wb-data-preview]')).not.toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-transform="transpose"]')!.click())
  const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/data/transform'))!
  expect(JSON.parse(String(request[1]?.body)).operation).toBe('transpose')
  expect(document.querySelector('[data-dialog="workbench-data-preview"]')?.textContent).toContain('a')
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[data-dialog="workbench-data-preview"] button')].find((button) => button.textContent === '完成')!.click())
  expect(document.querySelector<HTMLButtonElement>('[data-wb-template-save]')!.disabled).toBe(true)
  expect(document.querySelector('[data-wb-template-state]')?.textContent).toContain('未运行')
})

it('keeps a data transformation in the dialog until the request finishes', async () => {
  const template = { id: 'slow-data', name: '模板', scope: 'global' as const, favorite: false, code: 'import math', data: inputData, schema: templateSchema, revision: 1 }
  let finish!: (response: Response) => void
  vi.mocked(fetch).mockImplementation(async (input) => String(input).endsWith('/data/transform') ? new Promise<Response>((resolve) => { finish = resolve }) : { ok: true, json: async () => ({}) } as Response)
  await act(async () => root.render(<TooltipProvider><TemplateEditor initial={template} categories={[]} onBack={() => {}} onSaved={() => {}} /></TooltipProvider>))
  await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent?.startsWith('查看数据'))!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-transform="transpose"]')!.click())
  const dialog = document.querySelector('[data-dialog="workbench-data-preview"]')!
  expect(dialog.getAttribute('aria-busy')).toBe('true')
  expect(dialog.querySelector('[data-dialog-close]')).toBeNull()
  expect([...dialog.querySelectorAll('button')].find((button) => button.textContent === '完成')!.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('[data-wb-transform="transpose"]')!.disabled).toBe(true)
  await act(async () => { finish({ ok: true, json: async () => ({ data: inputData }) } as Response); await Promise.resolve() })
  expect(dialog.getAttribute('aria-busy')).toBeNull()
  expect([...dialog.querySelectorAll('button')].find((button) => button.textContent === '完成')!.disabled).toBe(false)
})

it('selects every saved figure and exports the selected stem', async () => {
  localStorage.setItem('workbench.exportDirectory', 'D:\\figure')
  await renderPlot()
  const second = document.querySelector<HTMLButtonElement>('[data-wb-output="figure_2"]')
  expect(second).toBeTruthy()
  await act(async () => second!.click())
  expect(document.querySelector<HTMLImageElement>('[data-wb-preview-image]')?.getAttribute('src')).toBe('/second.png')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-export]')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-export-format="png"]')!.click())
  const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/export-image'))!
  expect(JSON.parse(String(request[1]?.body))).toEqual({ format: 'png', stem: 'figure_2', revision: 1, directory: 'D:\\figure', filename: '普通脚本-figure_2.png' })
  expect(download).not.toHaveBeenCalled()
})

it('hands the selected figure to Tavotto and preserves locked code', async () => {
  await renderPlot({ ...plot, state: 'TAVOTTO_ONLY' })
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-output="figure_2"]')!.click())
  expect(document.querySelector<HTMLButtonElement>('[data-wb-run]')!.disabled).toBe(true)
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-open-tavotto]')!.click())
  const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/tavotto/open'))
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ stem: 'figure_2' })
})

it('keeps single-output projects compatible without an outputs field', async () => {
  const { outputs: _outputs, ...legacy } = plot
  await renderPlot(legacy)
  expect(document.querySelector<HTMLImageElement>('[data-wb-preview-image]')?.getAttribute('src')).toBe('/first.png')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-open-tavotto]')!.click())
  const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/tavotto/open'))
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ stem: 'figure' })
})

it('runs and saves every figure through the native menu, including after changing the selected output', async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.endsWith('/render') ? { job_id: 'run-job' }
      : url.endsWith('/jobs/run-job') ? { id: 'run-job', status: 'success', result: { run_id: 'all-figures-run', preview_url: '/first.png', outputs } }
      : plot
    return { ok: true, json: async () => body } as Response
  })
  await renderPlot()
  await act(async () => { performEditorMenuAction('menu-run') })
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-output="figure_2"]')!.click())
  const save = document.querySelector<HTMLButtonElement>('[data-wb-save]')!
  expect(save.disabled).toBe(false)
  await act(async () => { performEditorMenuAction('menu-save') })
  const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/save'))
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ run_id: 'all-figures-run' })
})

it('retains every output in template previews', async () => {
  const template = { id: 'template-one', name: '模板', scope: 'global' as const, code: plot.code, data: null, schema: DEFAULT_SCHEMA, favorite: false, revision: 1, preview_url: '/first.png', outputs }
  await act(async () => root.render(<TooltipProvider><TemplateEditor initial={template} categories={[]} onSaved={() => {}} onBack={() => {}} /></TooltipProvider>))
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-output="figure_2"]')!.click())
  expect(document.querySelector<HTMLImageElement>('[data-wb-preview-image]')?.getAttribute('src')).toBe('/second.png')
})

it('opens Codex assistance from the template editor without running or saving the template', async () => {
  const saved = { id: 'existing', name: '已有模板', scope: 'global' as const, code: plot.code, data: inputData, schema: templateSchema, favorite: false, revision: 1 }
  await act(async () => root.render(<TooltipProvider><TemplateEditor initial={saved} categories={[]} onSaved={() => {}} onBack={() => {}} /></TooltipProvider>))
  const assistant = document.querySelector<HTMLButtonElement>('[data-wb-template-assistant]')
  expect(assistant).toBeTruthy()
  await act(async () => assistant!.click())
  expect(document.querySelector('[data-dialog="workbench-code-assistant"]')).toBeTruthy()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/templates/validate') || String(url).endsWith('/templates'))).toBe(false)
})

it('invalidates template validation when the user applies a Codex proposal', async () => {
  const caps: AiCapabilities = { agents: [{ id: 'codex', display_name: 'Codex', icon_key: 'codex', usable: true, state: 'ready', installed: true, enabled: true, version: null, executable_path: null, path_override: null, detection_source: null, models: [], default_model: null, efforts: [], default_effort: null, endpoint: null, active_endpoint_id: null, diagnostics: { searched: [], broken_path: null, readiness: 'ready', readiness_detail: null }, features: { model_selection: false, effort_selection: false, third_party_endpoints: false, wire_api_selection: false, readiness_probe: true } }], endpoints: [], presets: [], checked_at_ms: 1 }
  vi.mocked(fetchAiCapabilities).mockResolvedValue(caps)
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    const body = url.endsWith('/dimensions') ? { schema: templateSchema } : url.endsWith('/templates/validate') ? { job_id: 'validation' }
      : url.endsWith('/jobs/validation') ? { id: 'validation', status: 'success', result: { run_id: 'validated', preview_url: '/first.png', outputs } }
      : url.endsWith('/assistant/runs') && init?.method === 'POST' ? { id: 'assistant-one', status: 'running' }
      : { id: 'assistant-one', status: 'done', code: 'new template code', changed: true, diff: '+new template code' }
    return { ok: true, json: async () => body } as Response
  })
  await act(async () => root.render(<TooltipProvider><TemplateEditor initial={{ id: 'pending-template', name: '测试', scope: 'global', favorite: false, revision: 0, validation_state: 'pending', code: plot.code, data: inputData, schema: templateSchema }} categories={[]} onSaved={() => {}} onBack={() => {}} /></TooltipProvider>))
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-template-run]')!.click())
  expect(document.querySelector<HTMLButtonElement>('[data-wb-template-save]')!.disabled).toBe(true)
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-dimensions-confirm]')!.click())
  expect(document.querySelector<HTMLButtonElement>('[data-wb-template-save]')!.disabled).toBe(false)
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-template-assistant]')!.click())
  await act(async () => {
    const prompt = document.querySelector<HTMLTextAreaElement>('[data-wb-assistant-prompt]')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'add a legend')
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-assistant-start]')!.click())
  expect(document.querySelector<HTMLTextAreaElement>('[data-wb-code]')!.value).not.toBe('new template code')
  expect(document.querySelector<HTMLButtonElement>('[data-wb-assistant-apply]')!.disabled).toBe(true)
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-assistant-preview]')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-assistant-apply]')!.click())
  expect(document.querySelector<HTMLTextAreaElement>('[data-wb-code]')!.value).toBe('new template code')
  expect(document.querySelector<HTMLButtonElement>('[data-wb-template-save]')!.disabled).toBe(true)
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-template-run]')!.click())
  expect(document.querySelector<HTMLButtonElement>('[data-wb-template-save]')!.disabled).toBe(true)
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-dimensions-confirm]')!.click())
  expect(document.querySelector<HTMLButtonElement>('[data-wb-template-save]')!.disabled).toBe(false)
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/templates'))).toBe(false)
})

it('blocks export, save and Tavotto when edited code no longer matches the saved preview', async () => {
  await renderPlot()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-code-toggle]')!.click())
  const code = document.querySelector<HTMLTextAreaElement>('[data-wb-code]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(code, `${plot.code}\nplt.title('changed')`)
    code.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(document.querySelector<HTMLButtonElement>('[data-wb-export]')?.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('[data-wb-open-tavotto]')?.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('[data-wb-save]')?.disabled).toBe(true)
  expect(menuActionEnabled('menu-save', true)).toBe(false)
  expect(menuActionEnabled('menu-export', true)).toBe(false)
  await act(async () => { performEditorMenuAction('menu-save'); performEditorMenuAction('menu-export') })
  expect(document.querySelector('[data-dialog="workbench-export"]')).toBeNull()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/save'))).toBe(false)
  expect(document.querySelector<HTMLImageElement>('[data-wb-preview-image]')?.getAttribute('src')).toBe('/first.png')
})


it('requires imported data before choosing a template instead of injecting its example values', async () => {
  await renderPlot()
  expect(document.querySelector<HTMLButtonElement>('[data-wb-template-picker-open]')!.disabled).toBe(true)
  await act(async () => root.render(null))
  await renderPlot({ ...plot, data: inputData })
  expect(document.querySelector<HTMLButtonElement>('[data-wb-template-picker-open]')!.disabled).toBe(false)
})
