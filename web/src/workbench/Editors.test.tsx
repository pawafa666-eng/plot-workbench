import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { fetchAiCapabilities, type AiCapabilities } from '@/lib/api'
import { PlotEditor, TemplateEditor } from './Editors'
import { download, type Plot } from './api'
import { DEFAULT_SCHEMA } from './model'

vi.mock('./TavottoEditor', () => ({ TavottoEditor: () => <div data-wb-test-tavotto /> }))
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), download: vi.fn(async () => {}) }))
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), fetchAiCapabilities: vi.fn(async () => ({ agents: [], endpoints: [], presets: [], checked_at_ms: 1 })) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
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

it('selects every saved figure and exports the selected stem', async () => {
  await renderPlot()
  const second = document.querySelector<HTMLButtonElement>('[data-wb-output="figure_2"]')
  expect(second).toBeTruthy()
  await act(async () => second!.click())
  expect(document.querySelector<HTMLImageElement>('[data-wb-preview-image]')?.getAttribute('src')).toBe('/second.png')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-export]')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-export-format="png"]')!.click())
  expect(download).toHaveBeenCalledWith('/plots/plot-one/export?format=png&stem=figure_2', '普通脚本-figure_2.png')
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

it('saves the complete successful run even after selecting another figure', async () => {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.endsWith('/render') ? { job_id: 'run-job' }
      : url.endsWith('/jobs/run-job') ? { id: 'run-job', status: 'success', result: { run_id: 'all-figures-run', preview_url: '/first.png', outputs } }
      : plot
    return { ok: true, json: async () => body } as Response
  })
  await renderPlot()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-run]')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-output="figure_2"]')!.click())
  const save = document.querySelector<HTMLButtonElement>('[data-wb-save]')!
  expect(save.disabled).toBe(false)
  await act(async () => save.click())
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
  await act(async () => root.render(<TooltipProvider><TemplateEditor categories={[]} onSaved={() => {}} onBack={() => {}} /></TooltipProvider>))
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
    const body = url.endsWith('/templates/validate') ? { job_id: 'validation' }
      : url.endsWith('/jobs/validation') ? { id: 'validation', status: 'success', result: { run_id: 'validated', preview_url: '/first.png', outputs } }
      : url.endsWith('/assistant/runs') && init?.method === 'POST' ? { id: 'assistant-one', status: 'running' }
      : { id: 'assistant-one', status: 'done', code: 'new template code', changed: true, diff: '+new template code' }
    return { ok: true, json: async () => body } as Response
  })
  await act(async () => root.render(<TooltipProvider><TemplateEditor categories={[]} onSaved={() => {}} onBack={() => {}} /></TooltipProvider>))
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-template-run]')!.click())
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
  expect(document.querySelector<HTMLImageElement>('[data-wb-preview-image]')?.getAttribute('src')).toBe('/first.png')
})
