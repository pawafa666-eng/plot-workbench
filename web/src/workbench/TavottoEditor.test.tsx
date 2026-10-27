import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { useDocumentStore } from '@/store/documentStore'
import { useRenderStore } from '@/store/renderStore'
import type { Manifest } from '@/lib/api'
import type { PanelObject } from '@/types/document'
import { TavottoEditor, type TavottoSession } from './TavottoEditor'
import type { AssistantRun } from './CodeAssistant'

const assistant = vi.hoisted(() => ({ props: null as null | { onApply: (result: AssistantRun) => Promise<void>; onClose: () => void; patches: unknown[] } }))
vi.mock('@/canvas/CanvasStage', () => ({ CanvasStage: () => <div data-wb-test-canvas /> }))
vi.mock('@/components/inspector/ElementInspector', () => ({ ElementInspector: () => <div /> }))
vi.mock('@/hooks/useEngineSync', () => ({ useEngineSync: () => {} }))
vi.mock('./CodeAssistant', () => ({ CodeAssistant: (props: NonNullable<typeof assistant.props>) => { assistant.props = props; return <div data-wb-test-assistant /> } }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const session: TavottoSession = { session_id: 'session-one', project: 'local', stem: 'figure', script: 'plot.py', manifest: { stem: 'figure', size_mm: [100, 75], elements: [] } as unknown as Manifest, svg: '<svg/>', overrides: [{ gid: 'title', prop: 'text', value: 'kept' }] }
const generated: AssistantRun = { id: 'task-one', status: 'done', code: 'new code', changed: true, diff: '-old\n+new' }
beforeEach(() => {
  vi.clearAllMocks(); assistant.props = null
  document.body.innerHTML = ''
  useRenderStore.getState().clear()
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({ ok: true, json: async () => String(input).endsWith('/apply') ? { ...session, svg: '<svg><g/></svg>', renderRevision: 2 } : { id: 'plot-one' } } as Response)))
})
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); document.body.innerHTML = '' })
async function render(current = session, onFinish = vi.fn()) {
  await act(async () => root.render(<TooltipProvider><TavottoEditor session={current} onFinish={onFinish} onCancel={() => {}} /></TooltipProvider>))
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { resolve, promise } }

it('offers Codex after synchronization and stages its candidate before the existing finish transaction', async () => {
  const onFinish = vi.fn()
  await render(session, onFinish)
  const open = document.querySelector<HTMLButtonElement>('[data-wb-tavotto-assistant]')
  expect(open).toBeTruthy()
  expect(open!.disabled).toBe(false)
  await act(async () => open!.click())
  expect(assistant.props?.patches).toEqual(session.overrides)
  const oldPanelId = useDocumentStore.getState().doc.objects[0].id
  await act(async () => assistant.props!.onApply(generated))
  const panel = useDocumentStore.getState().doc.objects[0] as PanelObject
  expect(panel.id).not.toBe(oldPanelId)
  expect(panel.overrides).toEqual(session.overrides)
  const apply = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/assistant/task-one/apply'))
  expect(JSON.parse(String(apply?.[1]?.body))).toEqual({ patches: session.overrides })
  expect(onFinish).not.toHaveBeenCalled()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/finish'))).toBe(false)
  await act(async () => assistant.props!.onClose())
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-tavotto-finish]')!.click())
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/sessions/session-one/finish'))).toBe(true)
  expect(onFinish).toHaveBeenCalledOnce()
})

it('disables the assistant while current overrides have not been rendered', async () => {
  await render()
  await act(async () => {
    const doc = useDocumentStore.getState().doc
    useDocumentStore.setState({ doc: { ...doc, objects: doc.objects.map((object) => object.type === 'panel' ? { ...object, overrides: [...object.overrides, { gid: 'title', prop: 'fontsize', value: 15 }] } : object) } })
  })
  expect(document.querySelector<HTMLButtonElement>('[data-wb-tavotto-assistant]')!.disabled).toBe(true)
})

it('rejects an old assistant callback after switching to another session', async () => {
  await render()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-tavotto-assistant]')!.click())
  const oldApply = assistant.props!.onApply
  await render({ ...session, session_id: 'session-two', stem: 'another' })
  await act(async () => { await expect(oldApply(generated)).rejects.toThrow('图形会话已经变化') })
  expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  expect((useDocumentStore.getState().doc.objects[0] as PanelObject).fileId).toBe('another.pdf')
  expect(document.querySelector<HTMLButtonElement>('[data-wb-tavotto-assistant]')!.disabled).toBe(false)
})

it('does not load a delayed applied session into a new figure', async () => {
  const response = deferred<Response>()
  vi.mocked(fetch).mockImplementation(() => response.promise)
  await render()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-tavotto-assistant]')!.click())
  let application!: Promise<void>
  await act(async () => { application = assistant.props!.onApply(generated) })
  await render({ ...session, session_id: 'session-two', stem: 'another' })
  await act(async () => {
    response.resolve({ ok: true, json: async () => ({ ...session, svg: '<svg><g/></svg>' }) } as Response)
    await expect(application).rejects.toThrow('图形会话已经变化')
  })
  expect((useDocumentStore.getState().doc.objects[0] as PanelObject).fileId).toBe('another.pdf')
  expect(document.querySelector<HTMLButtonElement>('[data-wb-tavotto-assistant]')!.disabled).toBe(false)
})
