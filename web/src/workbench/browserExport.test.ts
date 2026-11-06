import { expect, it, vi } from 'vitest'
import { chooseBrowserExportDirectory, saveBrowserExport } from './browserExport'

it('writes the original export blob into the selected folder and closes before reporting success', async () => {
  const write = vi.fn(async () => {}), close = vi.fn(async () => {}), abort = vi.fn(async () => {})
  const getFileHandle = vi.fn().mockRejectedValueOnce(new DOMException('missing', 'NotFoundError')).mockResolvedValue({ createWritable: async () => ({ write, close, abort }) })
  const folder = { name: 'exports', getFileHandle } as unknown as FileSystemDirectoryHandle
  const blob = new Blob(['original PNG or ZIP bytes'])
  expect(await saveBrowserExport(folder, '导出.zip', blob)).toBe('exports / 导出.zip')
  expect(getFileHandle.mock.calls).toEqual([['导出.zip'], ['导出.zip', { create: true }]])
  expect(write).toHaveBeenCalledWith(blob)
  expect(close).toHaveBeenCalledOnce(); expect(abort).not.toHaveBeenCalled()
})
it('refuses existing files and invalid names before opening a writer', async () => {
  const getFileHandle = vi.fn(async () => ({}))
  const folder = { name: 'exports', getFileHandle } as unknown as FileSystemDirectoryHandle
  await expect(saveBrowserExport(folder, 'exists.zip', new Blob())).rejects.toThrow('已有同名')
  expect(getFileHandle).toHaveBeenCalledOnce()
  await expect(saveBrowserExport(folder, '../outside.zip', new Blob())).rejects.toThrow('文件名')
  expect(getFileHandle).toHaveBeenCalledOnce()
})
it('aborts failed writes and propagates the error without claiming success', async () => {
  const abort = vi.fn(async () => {}), close = vi.fn(async () => {})
  const getFileHandle = vi.fn().mockRejectedValueOnce(new DOMException('missing', 'NotFoundError')).mockResolvedValue({ createWritable: async () => ({ write: async () => { throw new Error('disk full') }, close, abort }) })
  await expect(saveBrowserExport({ name: 'exports', getFileHandle } as unknown as FileSystemDirectoryHandle, 'test.zip', new Blob())).rejects.toThrow('disk full')
  expect(abort).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled()
})
it('treats a cancelled native folder chooser as cancellation', async () => {
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: vi.fn(async () => { throw new DOMException('cancel', 'AbortError') }) })
  expect(await chooseBrowserExportDirectory()).toBeNull()
})
