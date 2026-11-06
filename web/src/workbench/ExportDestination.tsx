import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Input'
import { isDesktop, isRemoteEngineWindow, pickDirectory } from '@/lib/desktop'
import { errorText } from './api'
import { chooseBrowserExportDirectory } from './browserExport'

export function ExportDestination({ directory, filename, onDirectory, onFilename, disabled = false, browserDirectory, onBrowserDirectory }: {
  directory: string; filename: string; onDirectory: (value: string) => void; onFilename: (value: string) => void; disabled?: boolean
  browserDirectory?: FileSystemDirectoryHandle | null; onBrowserDirectory: (value: FileSystemDirectoryHandle | null) => void
}) {
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState('')
  async function browse() {
    if (choosing || disabled) return
    setChoosing(true); setError('')
    try {
      if (isDesktop()) { const path = await pickDirectory('选择导出目录'); if (path) { onDirectory(path); onBrowserDirectory(null) } }
      else { const handle = await chooseBrowserExportDirectory(); if (handle) { onDirectory(handle.name); onBrowserDirectory(handle) } }
    } catch (e) { setError(errorText(e)) } finally { setChoosing(false) }
  }
  return <div className="wb-export-destination">
    <label className="wb-field">导出目录<div className="wb-path-row"><TextInput data-export-directory aria-label="导出目录" placeholder="请选择目录，或输入本机完整路径" value={directory} disabled={disabled || choosing} onChange={(e) => { onDirectory(e.target.value); onBrowserDirectory(null) }} />{!isRemoteEngineWindow() && <Button data-export-browse disabled={disabled || choosing} onClick={() => void browse()}>{choosing ? '正在选择…' : '浏览…'}</Button>}</div></label>
    {browserDirectory && <p data-export-selected-folder className="wb-help">已通过系统选择器选中「{browserDirectory.name}」。导出将直接保存到此文件夹；浏览器仅显示文件夹名称。</p>}
    {error && <p data-export-browse-error className="wb-error" role="alert">{error}</p>}
    <label className="wb-field">文件名<TextInput data-export-filename aria-label="导出文件名" value={filename} disabled={disabled} onChange={(e) => onFilename(e.target.value)} /></label>
    <p className="wb-help">保留已有同名文件；如名称重复，请修改名称后导出。</p>
  </div>
}
