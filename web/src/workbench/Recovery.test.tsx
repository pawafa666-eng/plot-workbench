import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { DraftStatus, RecoveryDialog, WorkspaceProvider, useEditorDraft, type EditorDraft } from './Recovery'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let records: Map<string, EditorDraft>
const json = (body: unknown, ok = true) => ({ ok, json: async () => body } as Response)
function Harness() {
  const [code, setCode] = useState('original')
  const [saved, setSaved] = useState('original')
  const draft = useEditorDraft({ kind: 'template', name: '试验', base_revision: 0, content: { code, data: null, schema: {} }, signature: code, dirty: code !== saved })
  return <><textarea data-recovery-code value={code} onChange={(e) => setCode(e.target.value)} /><button data-recovery-save onClick={async () => { setSaved(code); await draft.clear() }}>Save</button><DraftStatus draft={draft} /></>
}
beforeEach(() => {
  vi.useFakeTimers(); records = new Map()
  document.body.innerHTML = '<div id="recovery-test"></div>'
  root = createRoot(document.getElementById('recovery-test')!)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), id = url.split('/').at(-1)!
    if (url.endsWith('/preferences')) return json({})
    if (url.endsWith('/drafts')) return json({ drafts: [...records.values()], problems: [] })
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)), prior = records.get(id)
      if (body.generation !== (prior?.generation ?? 0)) return json({ message: '草稿冲突' }, false)
      const record = { ...body, id, generation: body.generation + 1, updated_at: '2026-11-05T00:00:00Z' }
      records.set(id, record); return json(record)
    }
    if (init?.method === 'DELETE') { records.delete(id); return json({ ok: true }) }
    if (url.endsWith('/restore')) return json({ draft: records.get(url.split('/').at(-2)!), entity: null, copied: false })
    return json(records.get(id))
  }))
})
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = '' })
async function render(children = <Harness />) { await act(async () => root.render(<TooltipProvider><WorkspaceProvider root="/library">{children}</WorkspaceProvider></TooltipProvider>)) }
async function edit(value: string) { await act(async () => { const input = document.querySelector<HTMLTextAreaElement>('[data-recovery-code]')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(800) }) }

it('persists unexecuted edits and starts a fresh draft after a formal save', async () => {
  await render(); await edit('first unfinished code'); await tick()
  const first = [...records.values()][0]
  expect(first.content.code).toBe('first unfinished code')
  expect(document.querySelector('[data-wb-draft-status]')!.textContent).toContain('草稿已保存')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-recovery-save]')!.click())
  expect(records.size).toBe(0)
  await edit('another change'); await tick()
  const next = [...records.values()][0]
  expect(next.id).not.toBe(first.id)
  expect(next.generation).toBe(1)
  expect(next.content.code).toBe('another change')
  expect(vi.mocked(fetch).mock.calls.some(([url]) => /render|validate/.test(String(url)))).toBe(false)
})

it('queues newer edits behind an in-flight save so the latest code wins', async () => {
  let finish!: () => void
  const original = vi.mocked(fetch).getMockImplementation()!
  let held = false
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (init?.method === 'PUT' && !held) { held = true; await new Promise<void>((resolve) => { finish = resolve }) }
    return original(input, init)
  })
  await render(); await edit('earlier'); await tick()
  await edit('newest'); await tick()
  expect(records.size).toBe(0)
  await act(async () => { finish(); await Promise.resolve(); await Promise.resolve() })
  await tick()
  expect([...records.values()][0].content.code).toBe('newest')
  expect([...records.values()][0].generation).toBe(2)
})

it('keeps a conflicting draft and saves this editor to a separate new draft', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!
  let conflictId = ''
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (init?.method === 'PUT' && !conflictId) {
      const body = JSON.parse(String(init.body)); conflictId = String(input).split('/').at(-1)!
      records.set(conflictId, { ...body, id: conflictId, generation: 2, content: { code: 'other window' } })
    }
    return original(input, init)
  })
  await render(); await edit('my edits'); await tick()
  expect(document.querySelector('[data-wb-draft-status]')!.textContent).toContain('冲突')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-draft-fork]')!.click())
  expect(records.size).toBe(2)
  expect(records.get(conflictId)!.content.code).toBe('other window')
  expect([...records.values()].some((r) => r.id !== conflictId && r.content.code === 'my edits')).toBe(true)
})

it('restores a selected draft without starting a render or validation', async () => {
  const draft: EditorDraft = { id: 'a'.repeat(32), kind: 'template', scope: 'global', name: '恢复测试', base_revision: 0, generation: 3, content: { code: 'raise RuntimeError()', schema: {}, data: null } }
  records.set(draft.id, draft)
  const recover = vi.fn(async () => {})
  await render(<RecoveryDialog onClose={() => {}} onRecover={recover} />)
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-draft-item]')!.click())
  expect(document.querySelector('.wb-recovery-detail')!.textContent).toContain('raise RuntimeError()')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-draft-restore]')!.click())
  expect(recover).toHaveBeenCalledWith(draft, null, false)
  expect(vi.mocked(fetch).mock.calls.some(([url]) => /render|validate|draft-session/.test(String(url)))).toBe(false)
})
