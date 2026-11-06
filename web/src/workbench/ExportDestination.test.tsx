import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isDesktop, isRemoteEngineWindow, pickDirectory } from '@/lib/desktop'
import { ExportDestination } from './ExportDestination'

vi.mock('@/lib/desktop', () => ({ isDesktop: vi.fn(() => false), isRemoteEngineWindow: vi.fn(() => false), pickDirectory: vi.fn() }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(isDesktop).mockReturnValue(false); vi.mocked(isRemoteEngineWindow).mockReturnValue(false)
  document.body.innerHTML = '<div id="destination-test"></div>'; root = createRoot(document.getElementById('destination-test')!)
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: vi.fn(async () => ({ name: 'chosen' })) })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ path: 'D:\\chosen' }) } as Response)))
})
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); document.body.innerHTML = '' })
function Example() { const [path, setPath] = useState('D:\\original'); const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null); return <ExportDestination directory={path} filename="export.zip" onDirectory={setPath} onFilename={() => {}} browserDirectory={handle} onBrowserDirectory={setHandle} /> }
async function render() { await act(async () => root.render(<Example />)) }
async function browse() { await act(async () => document.querySelector<HTMLButtonElement>('[data-export-browse]')!.click()) }

it('offers a system folder picker in the browser preview and fills the chosen path', async () => {
  await render(); await browse()
  expect((window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker).toHaveBeenCalledWith({ mode: 'readwrite' })
  expect(fetch).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLInputElement>('[data-export-directory]')!.value).toBe('chosen')
  expect(document.querySelector('[data-export-selected-folder]')?.textContent).toContain('chosen')
})
it('uses the existing desktop picker and preserves manual input when selection is cancelled', async () => {
  vi.mocked(isDesktop).mockReturnValue(true); vi.mocked(pickDirectory).mockResolvedValue(null)
  await render(); await browse()
  expect(pickDirectory).toHaveBeenCalledWith('选择导出目录')
  expect(fetch).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLInputElement>('[data-export-directory]')!.value).toBe('D:\\original')
})
it('shows a picker failure and never replaces the current directory', async () => {
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: vi.fn(async () => { throw new Error('窗口已打开') }) })
  await render(); await browse()
  expect(document.querySelector('[data-export-browse-error]')?.textContent).toContain('窗口已打开')
  expect(document.querySelector<HTMLInputElement>('[data-export-directory]')!.value).toBe('D:\\original')
})
it('keeps remote engine paths separate from the local Windows picker', async () => {
  vi.mocked(isRemoteEngineWindow).mockReturnValue(true)
  await render()
  expect(document.querySelector('[data-export-browse]')).toBeNull()
  expect(document.querySelector<HTMLInputElement>('[data-export-directory]')!.disabled).toBe(false)
})
