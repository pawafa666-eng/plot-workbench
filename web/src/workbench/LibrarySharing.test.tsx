import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { LibrarySharing } from './LibrarySharing'

vi.mock('@/components/ui/Select', () => ({ Select: ({ value, onChange, options, disabled }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; disabled?: boolean }) => <select data-test-select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
beforeEach(() => {
  document.body.innerHTML = '<div id="sharing-test"></div>'
  root = createRoot(document.getElementById('sharing-test')!)
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem('workbench.exportDirectory', 'D:\\exports')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => ({ ok: true, json: async () => String(input).includes('/library/import')
    ? { templates: [{ id: 'new', name: 'Imported' }], palettes: [{ id: 'new-palette', name: 'Imported palette' }] }
    : String(input).includes('/library/export') ? { path: 'D:\\exports\\分享.zip' }
    : String(input).includes('/templates') ? { templates: [{ id: 't1', name: '曲线模板', scope: 'global' }, { id: 'other', name: '其他项目', scope: 'project', project_id: 'other-project' }] }
    : { palettes: [{ id: 'p1', name: '蓝橙', colors: ['#123456', '#ABCDEF'] }, { id: 'p2', name: '灰度', colors: ['#111111'] }] } } as Response)))
})
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); document.body.innerHTML = '' })
async function render(onImported = vi.fn(async () => {})) {
  await act(async () => root.render(<TooltipProvider><LibrarySharing kind="palettes" onImported={onImported} /></TooltipProvider>))
}
async function click(selector: string) { await act(async () => document.querySelector<HTMLButtonElement>(selector)!.click()) }
async function drop(file = new File(['zip bytes'], '分享.zip')) {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } })
  await act(async () => document.querySelector('[data-share-drop]')!.dispatchEvent(event))
}

it('exports only checked entries and retains selections when switching type', async () => {
  await render()
  await click('[data-library-export]')
  expect(document.querySelector<HTMLButtonElement>('[data-share-export-confirm]')!.disabled).toBe(true)
  await click('[data-share-item="palettes:p1"]')
  await act(async () => { const select = document.querySelector<HTMLSelectElement>('[data-share-kind] select')!; select.value = 'templates'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(document.querySelectorAll('[data-share-item]')).toHaveLength(1)
  await click('[data-share-item="templates:t1"]')
  await click('[data-share-export-confirm]')
  const init = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/library/export'))![1]!
  expect(JSON.parse(String(init.body))).toEqual({ template_ids: ['t1'], palette_ids: ['p1'], directory: 'D:\\exports', filename: expect.stringMatching(/^导出-\d{4}-\d{2}-\d{2}\.zip$/) })
  expect(document.querySelector('[data-library-share-result]')!.textContent).toContain('2 项')
})

it('imports a dropped ZIP once and refreshes both libraries after saving', async () => {
  const refresh = vi.fn(async () => {})
  await render(refresh)
  await click('[data-library-import]')
  await drop()
  const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/library/import'))!
  const body = request[1]!.body as FormData
  expect(body.get('scope')).toBe('global')
  expect((body.get('file') as File).name).toBe('分享.zip')
  expect(refresh).toHaveBeenCalledOnce()
  expect(document.querySelector('[data-library-share-result]')!.textContent).toContain('1 个模板、1 个配色方案')
})

it('keeps an invalid upload visible with an error and does not report success', async () => {
  await render()
  await click('[data-library-import]')
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ message: '分享包格式或版本不受支持' }) } as Response)
  await drop()
  expect(document.querySelector('[data-share-error]')!.textContent).toContain('格式或版本不受支持')
  expect(document.querySelector('[data-share-drop]')).not.toBeNull()
  expect(document.querySelector('[data-library-share-result]')).toBeNull()
})

it('does not misreport a completed import as failed when refreshing the list fails', async () => {
  await render(vi.fn(async () => { throw new Error('network') }))
  await click('[data-library-import]')
  await drop()
  expect(document.querySelector('[data-library-share-result]')!.textContent).toContain('已导入')
  expect(document.querySelector('[data-library-share-result]')!.textContent).toContain('列表刷新失败')
  expect(document.querySelector('[data-share-drop]')).toBeNull()
})
