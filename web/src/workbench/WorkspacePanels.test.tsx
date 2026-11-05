import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { LibraryLocationDialog } from './StoragePanel'
import { HistoryButton } from './HistoryPanel'
import { ProjectHome } from './ProjectHome'
import { WorkspaceProvider, useWorkspace } from './Recovery'
import type { Plot, Project } from './api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const json = (body: unknown) => ({ ok: true, json: async () => body } as Response)
beforeEach(() => {
  document.body.innerHTML = '<div id="workspace-panels"></div>'
  root = createRoot(document.getElementById('workspace-panels')!)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/drafts') ? json({ drafts: [], problems: [] }) : json({})))
})
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); document.body.innerHTML = '' })
async function render(child: React.ReactNode) { await act(async () => root.render(<TooltipProvider><WorkspaceProvider root="/library">{child}</WorkspaceProvider></TooltipProvider>)) }
async function click(selector: string) { await act(async () => document.querySelector<HTMLButtonElement>(selector)!.click()) }
async function input(selector: string, text: string) { await act(async () => { const e = document.querySelector<HTMLInputElement>(selector)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(e, text); e.dispatchEvent(new Event('input', { bubbles: true })) }) }

it('requires fresh directory inspection and refuses migration into an occupied destination', async () => {
  vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith('/storage/inspect') ? json({ path: '/occupied', empty: false, recognized: true, projects: 2, templates: 3, palettes: 4, trash: 0 }) : String(url).endsWith('/drafts') ? json({ drafts: [], problems: [] }) : json({}))
  const save = vi.fn(async () => {})
  await render(<LibraryLocationDialog current="/library" onClose={() => {}} onSave={save} />)
  await input('[data-wb-path-input]', '/occupied')
  expect(document.querySelector<HTMLButtonElement>('[data-wb-path-confirm]')!.disabled).toBe(true)
  await click('[data-wb-library-inspect]')
  expect(document.querySelector('[data-wb-library-overview]')!.textContent).toContain('3 个模板')
  await click('[data-wb-library-mode="migrate"]')
  expect(document.querySelector<HTMLButtonElement>('[data-wb-path-confirm]')!.disabled).toBe(true)
  await click('[data-wb-library-mode="switch"]')
  await input('[data-wb-path-input]', '/other')
  expect(document.querySelector<HTMLButtonElement>('[data-wb-path-confirm]')!.disabled).toBe(true)
  expect(save).not.toHaveBeenCalled()
})

it('ignores a late history response and restores only the selected revision with current-version CAS', async () => {
  let release!: (response: Response) => void
  const selected = vi.fn()
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const path = String(url)
    if (path.endsWith('/drafts')) return json({ drafts: [], problems: [] })
    if (path.endsWith('/history/plot/p')) return json({ current_revision: 2, versions: [1, 2].map((revision) => ({ revision, outputs: [], data_rows: 0, data_columns: 0 })) })
    if (path.endsWith('/p/1')) return new Promise<Response>((r) => { release = r })
    if (path.endsWith('/p/2')) return json({ code: 'new code' })
    if (path.endsWith('/2/restore')) { expect(JSON.parse(String(init?.body))).toEqual({ library_root: '/library', current_revision: 2 }); return json({ id: 'copy', revision: 1, validation_state: 'pending' }) }
    return json({})
  })
  await render(<HistoryButton kind="plot" entity={{ id: 'p', revision: 2, name: 'P', code: 'current', data: null } as Plot} onRestored={selected} />)
  await click('[data-wb-history-open]'); await click('[data-wb-history-version="1"]'); await click('[data-wb-history-version="2"]')
  await act(async () => release(json({ code: 'stale code' })))
  await click('[data-wb-history-restore]')
  expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: 'copy', validation_state: 'pending' }))
  expect(vi.mocked(fetch).mock.calls.some(([url]) => /render|validate/.test(String(url)))).toBe(false)
})

it('filters projects by path and orders them by their last saved modification', async () => {
  const projects = [{ id: 'old', name: 'Old', path: '/trial/a', updated_at: '2026-10-01' }, { id: 'new', name: 'New', path: '/research/b', updated_at: '2026-11-01' }] as Project[]
  await render(<ProjectHome projects={projects} templateCount={3} onOpen={() => {}} onCreate={() => {}} onOpenFolder={() => {}} onRecovery={() => {}} />)
  expect([...document.querySelectorAll('[data-wb-project-card]')].map((e) => e.getAttribute('data-wb-project-card'))).toEqual(['new', 'old'])
  await input('[data-wb-project-search]', 'research')
  expect([...document.querySelectorAll('[data-wb-project-card]')].map((e) => e.getAttribute('data-wb-project-card'))).toEqual(['new'])
})

it('keeps an explicit display choice when initial preference loading returns late', async () => {
  let release!: (value: Response) => void
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/drafts')) return json({ drafts: [], problems: [] })
    if (init?.method === 'PATCH') return json({ sidebar_collapsed: true })
    return new Promise<Response>((resolve) => { release = resolve })
  })
  function Choice() {
    const workspace = useWorkspace()
    return <button data-preference-choice onClick={() => workspace.setPreferences({ sidebar_collapsed: true })}>{String(workspace.preferences.sidebar_collapsed)}</button>
  }
  await render(<Choice />)
  await click('[data-preference-choice]')
  await act(async () => release(json({ sidebar_collapsed: false, density: 'compact' })))
  expect(document.querySelector('[data-preference-choice]')!.textContent).toBe('true')
})
