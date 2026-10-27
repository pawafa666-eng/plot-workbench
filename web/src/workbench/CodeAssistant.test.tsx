import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { fetchAiCapabilities, type AiCapabilities } from '@/lib/api'
import { useAiStore } from '@/store/aiStore'
import { useUiStore } from '@/store/uiStore'
import { CodeAssistant, type AssistantRun } from './CodeAssistant'
import type { Snapshot } from './api'
import { DEFAULT_SCHEMA } from './model'

vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), fetchAiCapabilities: vi.fn() }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const caps: AiCapabilities = {
  checked_at_ms: 1, endpoints: [], presets: [], agents: [{
    id: 'codex', display_name: 'Codex', icon_key: 'codex', state: 'ready', installed: true, enabled: true, usable: true,
    version: '1.0', executable_path: null, path_override: null, detection_source: null,
    models: ['detected-model'], default_model: null, efforts: ['detected-effort'], default_effort: null,
    endpoint: null, active_endpoint_id: null,
    features: { third_party_endpoints: true, model_selection: true, effort_selection: true, wire_api_selection: true, readiness_probe: true },
    diagnostics: { searched: [], broken_path: null, readiness: 'ready', readiness_detail: null },
  }],
}
const data: Snapshot = { columns: ['time', 'load'], dtypes: ['int64', 'float64'], row_count: 1, column_count: 2, index: [0], values: [[12345, 98765]], row_sources: [0], column_sources: [0, 1], source: { path: 'private.csv' } }
const generated: AssistantRun = { id: 'task-one', status: 'done', changed: true, code: 'new code', diff: '-old code\n+new code', transcript: [{ kind: 'message', text: 'finished' }] }
const onApply = vi.fn(async () => {})
const onClose = vi.fn()
const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { resolve, promise } }
const button = (name: string) => document.querySelector<HTMLButtonElement>(`[data-wb-assistant-${name}]`)!
async function render(overrides: Partial<React.ComponentProps<typeof CodeAssistant>> = {}) {
  await act(async () => root.render(<TooltipProvider><CodeAssistant code="old code" data={data} schema={DEFAULT_SCHEMA} contextKey="template-one" onApply={onApply} onClose={onClose} {...overrides} /></TooltipProvider>))
}
async function request() {
  await act(async () => {
    const prompt = document.querySelector<HTMLInputElement>('[data-wb-assistant-prompt]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(prompt, 'add error bars')
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('start').click())
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  useAiStore.setState({ models: {}, efforts: {} })
  useUiStore.setState({ settingsOpen: false, settingsSection: null })
  vi.mocked(fetchAiCapabilities).mockResolvedValue(caps)
  document.body.innerHTML = ''
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => json(init?.method === 'POST' ? { id: 'task-one', status: 'running' } : generated)))
})
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

it('sends structural data only, shows live output and requires explicit application of a completed result', async () => {
  let polls = 0
  vi.mocked(fetch).mockImplementation(async (_input, init) => json(init?.method === 'POST' ? { id: 'task-one', status: 'running' } : ++polls === 1 ? { ...generated, status: 'running', transcript: [{ kind: 'message', text: 'working' }] } : generated))
  await render()
  expect(fetchAiCapabilities).toHaveBeenCalledWith(false)
  expect(document.querySelector('[data-wb-assistant-model]')?.textContent).toContain('跟随 Codex 默认模型')
  await request()
  const requestBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
  expect(requestBody).toEqual({ code: 'old code', prompt: 'add error bars', schema: DEFAULT_SCHEMA, data_context: { row_count: 1, column_count: 2, columns: data.columns, dtypes: data.dtypes } })
  expect(document.querySelector('[data-wb-assistant-transcript]')?.textContent).toBe('working')
  expect(button('apply').disabled).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(650))
  expect(document.querySelector('[data-wb-assistant-diff]')?.textContent).toBe(generated.diff)
  expect(onApply).not.toHaveBeenCalled()
  await act(async () => button('apply').click())
  expect(onApply).toHaveBeenCalledWith(generated)
  expect(onClose).toHaveBeenCalledOnce()
})

it('uses the backend usable fact and the detected model and effort preferences', async () => {
  vi.mocked(fetchAiCapabilities).mockResolvedValue({ ...caps, agents: [{ ...caps.agents[0], installed: false, state: 'needs_auth', usable: true }] })
  useAiStore.setState({ models: { codex: 'detected-model' }, efforts: { codex: 'detected-effort' } })
  await render()
  await request()
  const payload = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
  expect(payload.model).toBe('detected-model')
  expect(payload.effort).toBe('detected-effort')
})

it('routes unavailable Codex to the existing agent settings', async () => {
  vi.mocked(fetchAiCapabilities).mockResolvedValue({ ...caps, agents: [{ ...caps.agents[0], usable: false, state: 'needs_auth' }] })
  await render()
  await request()
  expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  expect(button('start').disabled).toBe(true)
  await act(async () => button('settings').click())
  expect(onClose).toHaveBeenCalledOnce()
  expect(useUiStore.getState().settingsOpen).toBe(true)
  expect(useUiStore.getState().settingsSection).toBe('ai')
})

it('rejects a result after data values change even when the transmitted structure is unchanged', async () => {
  await render(); await request()
  expect(button('apply').disabled).toBe(false)
  await render({ data: { ...data, values: [[3, 4]] } })
  expect(document.querySelector('[data-wb-assistant-stale]')).toBeTruthy()
  expect(button('apply').disabled).toBe(true)
  await act(async () => button('apply').click())
  expect(onApply).not.toHaveBeenCalled()
})

it('cancels a task whose create response arrives after the assistant unmounts', async () => {
  const created = deferred<Response>()
  vi.mocked(fetch).mockImplementation((_input, init) => init?.method === 'POST' && String(_input).endsWith('/runs') ? created.promise : Promise.resolve(json({})))
  await render(); await request()
  await act(async () => root.render(null))
  await act(async () => created.resolve(json({ id: 'late-task', status: 'running' })))
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/assistant/runs/late-task/cancel'))).toBe(true)
  expect(onApply).not.toHaveBeenCalled()
})

it('ignores completed progress that arrives after cancellation', async () => {
  const progress = deferred<Response>()
  vi.mocked(fetch).mockImplementation((_input, init) => init?.method === 'POST' ? Promise.resolve(json({ id: 'task-one', status: 'running' })) : progress.promise)
  await render(); await request()
  await act(async () => button('cancel').click())
  await act(async () => progress.resolve(json(generated)))
  expect(document.querySelector('[data-wb-assistant-diff]')).toBeNull()
  expect(button('apply').disabled).toBe(true)
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(true)
  expect(onApply).not.toHaveBeenCalled()
})

it('keeps the proposal open when staged application fails', async () => {
  onApply.mockRejectedValueOnce(new Error('candidate verification failed'))
  await render(); await request()
  await act(async () => button('apply').click())
  expect(document.querySelector('[data-wb-assistant-error]')?.textContent).toContain('candidate verification failed')
  expect(document.querySelector('[data-wb-assistant-diff]')?.textContent).toBe(generated.diff)
  expect(onClose).not.toHaveBeenCalled()
})

it('passes the session identity and current overrides without a client code replacement', async () => {
  const patches = [{ gid: 'title', prop: 'text', value: 'kept' }]
  await render({ sessionId: 'session-one', patches })
  await request()
  const payload = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
  expect(payload.session_id).toBe('session-one')
  expect(payload.patches).toEqual(patches)
  expect(payload.code).toBeUndefined()
})

it('keeps the newest capability probe when StrictMode replays the opening effect', async () => {
  const older = deferred<AiCapabilities>()
  const newer = deferred<AiCapabilities>()
  vi.mocked(fetchAiCapabilities).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
  await act(async () => root.render(<StrictMode><TooltipProvider><CodeAssistant code="old code" data={data} schema={DEFAULT_SCHEMA} contextKey="template-one" onApply={onApply} onClose={onClose} /></TooltipProvider></StrictMode>))
  await act(async () => newer.resolve(caps))
  await act(async () => older.resolve({ ...caps, agents: [{ ...caps.agents[0], usable: false, state: 'needs_auth' }] }))
  await request()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/assistant/runs'))).toBe(true)
})

it('blocks dismissal while the explicit apply operation is pending', async () => {
  const applied = deferred<void>()
  onApply.mockImplementationOnce(() => applied.promise)
  await render(); await request()
  await act(async () => button('apply').click())
  expect(button('close').disabled).toBe(true)
  expect(document.querySelector('[data-dialog="workbench-code-assistant"] [data-dialog-close]')).toBeNull()
  await act(async () => {
    button('close').click()
    document.querySelector('[data-dialog="workbench-code-assistant"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(onClose).not.toHaveBeenCalled()
  await act(async () => applied.resolve())
  expect(onClose).toHaveBeenCalledOnce()
})
