/** Browser-selected folders stay in the browser; their names are never server paths. */
export async function chooseBrowserExportDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as Window & { showDirectoryPicker?: (options: { mode: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
  if (!picker) throw new Error('当前浏览器不支持系统目录选择，请使用 Chrome、Edge 或桌面版；也可以手填完整目录。')
  try { return await picker.call(window, { mode: 'readwrite' }) }
  catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return null; throw error }
}

export async function saveBrowserExport(directory: FileSystemDirectoryHandle, filename: string, content: Blob): Promise<string> {
  if (!filename.trim() || /[<>:"/\\|?*\x00-\x1f]/.test(filename) || filename.endsWith('.') || filename.endsWith(' ')) throw new Error('请输入有效的导出文件名。')
  try {
    await directory.getFileHandle(filename)
    throw new Error('已有同名文件，请修改导出名称后重试。')
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
  }
  const file = await directory.getFileHandle(filename, { create: true })
  const writable = await file.createWritable()
  try { await writable.write(content); await writable.close() }
  catch (error) { await writable.abort().catch(() => {}); throw error }
  return `${directory.name} / ${filename}`
}
