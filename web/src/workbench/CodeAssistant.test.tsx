import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { fetchAiCapabilities, type AiCapabilities } from '@/lib/api'
import { useAiStore } from '@/store/aiStore'
import { useUiStore } from '@/store/uiStore'
import { CodeAssistant, type AssistantRun } from './CodeAssistant'
import { WorkbenchError, type Snapshot } from './api'
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
  await typePrompt('add error bars')
  await act(async () => button('start').click())
}
async function typePrompt(value: string) {
  await act(async () => {
    const prompt = document.querySelector<HTMLTextAreaElement>('[data-wb-assistant-prompt]')!
    const prototype = prompt.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(prompt, value)
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function expandDiff() { await act(async () => button('diff-toggle').click()) }
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
  expect(document.querySelector('[data-wb-assistant-status]')?.textContent).toContain('正在')
  expect(button('apply').disabled).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(650))
  expect(document.querySelector('[data-wb-assistant-diff]')).toBeNull()
  await expandDiff()
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

it('keeps a running conversation alive when its window is hidden and announces completion', async () => {
  let polls = 0
  vi.mocked(fetch).mockImplementation(async (_input, init) => json(init?.method === 'POST' ? { id: 'task-one', status: 'running' } : ++polls === 1 ? { ...generated, status: 'running' } : generated))
  await render({ open: true }); await request()
  await render({ open: false })
  expect(document.querySelector('[data-dialog="workbench-code-assistant"]')).toBeNull()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false)
  await act(async () => vi.advanceTimersByTimeAsync(650))
  expect(document.querySelector('[data-wb-assistant-notification]')?.textContent).toContain('Codex 已完成')
  await render({ open: true })
  expect(document.querySelector('[data-wb-assistant-messages]')?.textContent).toContain('finished')
})

it('shows before and after images and waits for their preview before applying', async () => {
  const preview = deferred<{ before: string; after: string }>()
  const onPreview = vi.fn(() => preview.promise)
  await render({ onPreview }); await request()
  expect(onPreview).not.toHaveBeenCalled()
  expect(button('apply').disabled).toBe(true)
  await act(async () => button('preview').click())
  expect(onPreview).toHaveBeenCalledOnce()
  await act(async () => preview.resolve({ before: '/before.png', after: '/after.png' }))
  expect(document.querySelector<HTMLImageElement>('[data-wb-assistant-before]')?.getAttribute('src')).toBe('/before.png')
  expect(document.querySelector<HTMLImageElement>('[data-wb-assistant-after]')?.getAttribute('src')).toBe('/after.png')
  expect(document.querySelector('[data-wb-assistant-diff-toggle]')).toBeNull()
  expect(button('apply').disabled).toBe(false)
})

it('invalidates a comparison for a different selected figure and permits retry after returning', async () => {
  const onPreview = vi.fn(async () => ({ before: '/before.png', after: '/after.png' }))
  await render({ previewKey: 'figure-one', onPreview }); await request()
  await render({ previewKey: 'figure-two', onPreview })
  expect(document.querySelector('[data-wb-assistant-stale]')).toBeTruthy()
  expect(button('preview').disabled).toBe(true)
  await render({ previewKey: 'figure-one', onPreview })
  await act(async () => button('preview').click())
  expect(onPreview).toHaveBeenCalledOnce()
  expect(button('apply').disabled).toBe(false)
})

it.each(['assistant_preview_changed', 'assistant_preview_required'])('allows a new preview when the server rejects proof: %s', async (code) => {
  const onPreview = vi.fn(async () => ({ before: '/before.png', after: '/after.png' }))
  onApply.mockRejectedValueOnce(new WorkbenchError('请重新预览', code))
  await render({ onPreview }); await request()
  await act(async () => button('preview').click())
  await act(async () => button('apply').click())
  expect(button('apply').disabled).toBe(true)
  await act(async () => button('preview').click())
  expect(onPreview).toHaveBeenCalledTimes(2)
  expect(button('apply').disabled).toBe(false)
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
  await expandDiff()
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

it('keeps a readable conversation and sends completed history with the last successful proposal', async () => {
  let task = 0
  vi.mocked(fetch).mockImplementation(async (_input, init) => json(init?.method === 'POST'
    ? { id: `task-${++task}`, status: 'running' }
    : { ...generated, id: `task-${task}`, reply: task === 1 ? '已加入误差棒。' : '已统一字体。', transcript: [{ kind: 'log', text: '{"type":"command_output","text":"raw CLI"}' }] }))
  await render(); await request()
  expect(document.querySelector('[data-wb-assistant-prompt]')?.tagName).toBe('TEXTAREA')
  expect(document.querySelector('[data-wb-assistant-messages]')?.textContent).toContain('已加入误差棒。')
  expect(document.querySelector('[data-wb-assistant-messages]')?.textContent).not.toContain('raw CLI')
  expect(document.querySelector<HTMLTextAreaElement>('[data-wb-assistant-prompt]')!.value).toBe('')
  await typePrompt('统一字体')
  await act(async () => button('start').click())
  const requests = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST' && String(init.body).includes('prompt'))
  const payload = JSON.parse(String(requests[1][1]?.body))
  expect(payload).toMatchObject({ code: 'old code', prompt: '统一字体', parent_id: 'task-1', history: [{ role: 'user', text: 'add error bars' }, { role: 'assistant', text: '已加入误差棒。' }] })
  expect(document.querySelectorAll('[data-wb-assistant-message="user"]')).toHaveLength(2)
  expect(document.querySelectorAll('[data-wb-assistant-message="assistant"]')).toHaveLength(2)
  expect(document.querySelector('[data-wb-assistant-messages]')?.textContent).toContain('已统一字体。')
})

it('sends with Enter but preserves Shift+Enter and IME composition for multiline input', async () => {
  await render(); await typePrompt('增加误差棒\n保留颜色')
  const prompt = document.querySelector<HTMLTextAreaElement>('[data-wb-assistant-prompt]')!
  await act(async () => {
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
  })
  expect(fetch).not.toHaveBeenCalled()
  await act(async () => prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).prompt).toBe('增加误差棒\n保留颜色')
})

it('allows a normal reply without code changes and keeps Apply disabled', async () => {
  vi.mocked(fetch).mockImplementation(async (_input, init) => json(init?.method === 'POST' ? { id: 'hello', status: 'running' } : { ...generated, id: 'hello', changed: false, diff: '', code: 'old code', reply: '你好，可以告诉我你想怎样调整图形。' }))
  await render(); await request()
  expect(document.querySelector('[data-wb-assistant-messages]')?.textContent).toContain('你好，可以告诉我你想怎样调整图形。')
  expect(button('apply').disabled).toBe(true)
  expect(document.querySelector('[data-wb-assistant-error]')).toBeNull()
})

it('retains the successful proposal, conversation and input when a follow-up fails, then retries that turn', async () => {
  let task = 0
  vi.mocked(fetch).mockImplementation(async (_input, init) => json(init?.method === 'POST'
    ? { id: `task-${++task}`, status: 'running' }
    : task === 2 ? { ...generated, id: 'task-2', status: 'failed', changed: false, error: '模型暂时不可用' } : { ...generated, id: `task-${task}`, reply: task === 1 ? '已加入误差棒。' : '字体已调整。' }))
  await render(); await request(); await typePrompt('统一字体')
  await act(async () => button('start').click())
  expect(document.querySelector<HTMLTextAreaElement>('[data-wb-assistant-prompt]')!.value).toBe('统一字体')
  expect(document.querySelectorAll('[data-wb-assistant-message="user"]')).toHaveLength(2)
  expect(button('apply').disabled).toBe(false)
  await act(async () => button('retry').click())
  const requests = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST' && String(init.body).includes('prompt'))
  const payload = JSON.parse(String(requests[2][1]?.body))
  expect(payload.history).toEqual([{ role: 'user', text: 'add error bars' }, { role: 'assistant', text: '已加入误差棒。' }])
  expect(payload.parent_id).toBe('task-1')
  expect(document.querySelectorAll('[data-wb-assistant-message="user"]')).toHaveLength(2)
  expect(document.querySelector('[data-wb-assistant-messages]')?.textContent).toContain('字体已调整。')
})

it('disables the retained proposal during a follow-up and restores it after cancellation', async () => {
  const progress = deferred<Response>()
  let task = 0
  vi.mocked(fetch).mockImplementation((_input, init) => init?.method === 'POST' ? Promise.resolve(json({ id: `task-${++task}`, status: 'running' })) : task === 1 ? Promise.resolve(json(generated)) : progress.promise)
  await render(); await request(); await typePrompt('统一字体')
  await act(async () => button('start').click())
  expect(button('apply').disabled).toBe(true)
  await act(async () => button('cancel').click())
  expect(button('apply').disabled).toBe(false)
  expect(document.querySelector<HTMLTextAreaElement>('[data-wb-assistant-prompt]')!.value).toBe('统一字体')
  await act(async () => progress.resolve(json({ ...generated, code: 'late code' })))
  await act(async () => button('apply').click())
  expect(onApply).toHaveBeenCalledWith(generated)
})

it('does not cancel an active task when the dialog is closed', async () => {
  const progress = deferred<Response>()
  vi.mocked(fetch).mockImplementation((_input, init) => init?.method === 'POST' ? Promise.resolve(json({ id: 'task-one', status: 'running' })) : progress.promise)
  await render(); await request()
  await act(async () => button('close').click())
  expect(onClose).toHaveBeenCalledOnce()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/task-one/cancel'))).toBe(false)
  await act(async () => progress.resolve(json(generated)))
  expect(button('apply').disabled).toBe(false)
})

it('starts a fresh context after source changes without reusing the old proposal or history', async () => {
  await render(); await request()
  await render({ code: 'manually changed code' })
  expect(button('apply').disabled).toBe(true)
  await typePrompt('调整字号')
  await act(async () => button('start').click())
  const requests = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST' && String(init.body).includes('prompt'))
  const payload = JSON.parse(String(requests[1][1]?.body))
  expect(payload.code).toBe('manually changed code')
  expect(payload.parent_id).toBeUndefined()
  expect(payload.history ?? []).toEqual([])
})

it('expands and restores the centered chat dialog', async () => {
  await render()
  const dialog = document.querySelector<HTMLElement>('[data-dialog="workbench-code-assistant"]')!
  expect(dialog.style.width).toBe('920px')
  await act(async () => button('expand').click())
  expect(dialog.style.width).toBe('1280px')
  await act(async () => button('expand').click())
  expect(dialog.style.width).toBe('920px')
})

it('bounds follow-up history to the latest twelve complete conversation pairs', async () => {
  let task = 0
  vi.mocked(fetch).mockImplementation(async (_input, init) => json(init?.method === 'POST' ? { id: `task-${++task}`, status: 'running' } : { ...generated, id: `task-${task}`, reply: `reply ${task}` }))
  await render()
  for (let index = 1; index <= 14; index++) {
    await typePrompt(`request ${index}`)
    await act(async () => button('start').click())
  }
  const requests = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST' && String(init.body).includes('prompt'))
  const payload = JSON.parse(String(requests[13][1]?.body))
  expect(payload.history).toHaveLength(24)
  expect(payload.history[0]).toEqual({ role: 'user', text: 'request 2' })
  expect(payload.history[23]).toEqual({ role: 'assistant', text: 'reply 13' })
  expect(document.querySelectorAll('[data-wb-assistant-message="user"]')).toHaveLength(14)
})

it('does not submit an oversized UTF-8 conversation pair and explains how to restart', async () => {
  vi.mocked(fetch).mockImplementation(async (_input, init) => json(init?.method === 'POST' ? { id: 'task-one', status: 'running' } : { ...generated, reply: '字'.repeat(22000) }))
  await render(); await request(); await typePrompt('继续')
  await act(async () => button('start').click())
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(document.querySelector('[data-wb-assistant-error]')?.textContent).toContain('重新打开')
  expect(document.querySelector<HTMLTextAreaElement>('[data-wb-assistant-prompt]')!.value).toBe('继续')
})


it('releases the conversation when the server confirms the task no longer exists', async () => {
  const onDiscard = vi.fn()
  vi.mocked(fetch).mockImplementation(async (_input, init) => init?.method === 'POST'
    ? json({ id: 'expired-task', status: 'running' })
    : ({ ok: false, json: async () => ({ code: 'assistant_not_found', message: '任务已过期' }) } as Response))
  await render({ onDiscard })
  await request()
  expect(document.querySelector('[data-wb-assistant-status]')?.textContent).toContain('中断')
  expect(button('discard').disabled).toBe(false)
  await act(async () => button('discard').click())
  expect(onDiscard).toHaveBeenCalledOnce()
})
