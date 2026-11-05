import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { TextInput } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Download, Upload } from '@/components/ui/icons'
import { api, download, errorText, type Template } from './api'
import type { Palette } from './paletteModel'

type Kind = 'templates' | 'palettes'
interface ImportResult { templates: { id: string; name: string }[]; palettes: { id: string; name: string }[] }
interface Entry { key: string; id: string; kind: Kind; name: string; detail: string; preview?: string; colors?: string[] }

export function LibrarySharing({ kind, projectId, templateScope = 'global', onImported }: {
  kind: Kind; projectId?: string; templateScope?: 'global' | 'project'; onImported: () => Promise<void>
}) {
  const [mode, setMode] = useState<'export' | 'import' | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [filter, setFilter] = useState<Kind | 'all'>(kind)
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState(templateScope)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [dragging, setDragging] = useState(false)
  const upload = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (mode !== 'export') return
    let live = true
    setEntries([]); setSelected([])
    setLoading(true)
    const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''
    void Promise.all([api<{ templates: Template[] }>(`/templates${query}`), api<{ palettes: Palette[] }>('/palettes')]).then(([templates, palettes]) => {
      if (!live) return
      setEntries([
        ...templates.templates.filter((item) => item.scope === templateScope && (item.scope === 'global' || item.project_id === projectId)).map((item) => ({ key: `templates:${item.id}`, id: item.id, kind: 'templates' as const, name: item.name, detail: '模板 · 含代码、示例数据与参数', preview: item.preview_url })),
        ...palettes.palettes.map((item) => ({ key: `palettes:${item.id}`, id: item.id, kind: 'palettes' as const, name: item.name, detail: `配色 · ${item.colors.length} 色`, colors: item.colors })),
      ])
    }).catch((failure) => { if (live) setError(errorText(failure)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [mode, projectId, templateScope])
  const visible = entries.filter((item) => (filter === 'all' || filter === item.kind) && item.name.toLowerCase().includes(search.toLowerCase()))
  function open(next: 'export' | 'import') {
    setError(''); setMessage(''); setSelected([]); setEntries([]); setSearch(''); setFilter(kind); setScope(templateScope); setMode(next)
  }
  function toggle(key: string) { setSelected((old) => old.includes(key) ? old.filter((value) => value !== key) : [...old, key]) }
  function toggleVisible() {
    const keys = visible.map((item) => item.key)
    setSelected((old) => keys.every((key) => old.includes(key)) ? old.filter((key) => !keys.includes(key)) : [...new Set([...old, ...keys])])
  }
  async function exportZip() {
    if (busyRef.current || !selected.length) return
    busyRef.current = true; setBusy(true); setError('')
    try {
      const chosen = entries.filter((item) => selected.includes(item.key))
      await download('/library/export', 'library-share.zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template_ids: chosen.filter((item) => item.kind === 'templates').map((item) => item.id), palette_ids: chosen.filter((item) => item.kind === 'palettes').map((item) => item.id), project_id: projectId }) })
      if (mounted.current) { setMessage(`已导出 ${chosen.length} 项，可将 ZIP 文件发给其他人。`); setMode(null) }
    } catch (failure) { if (mounted.current) setError(errorText(failure)) }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  async function importZip(file?: File) {
    if (!file || busyRef.current) return
    if (!/\.zip$/i.test(file.name)) { setError('请选择 ZIP 分享文件。'); return }
    busyRef.current = true; setBusy(true); setError('')
    const form = new FormData()
    form.append('file', file); form.append('scope', scope)
    if (scope === 'project' && projectId) form.append('project_id', projectId)
    try {
      const result = await api<ImportResult>('/library/import', { method: 'POST', body: form })
      if (!mounted.current) return
      const summary = `已导入 ${result.templates.length} 个模板、${result.palettes.length} 个配色方案。同名项目已另存为副本。`
      setMessage(summary); setMode(null)
      try { await onImported() } catch { if (mounted.current) setMessage(`${summary} 列表刷新失败，请重新进入库查看。`) }
    } catch (failure) { if (mounted.current) setError(errorText(failure)) }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  return <>
    <div className="wb-share-controls">
    <Button variant="secondary" disabled={busy} data-library-import={kind} onClick={() => open('import')}><Upload />导入 ZIP</Button>
    <Button variant="secondary" disabled={busy} data-library-export={kind} onClick={() => open('export')}><Download />批量导出</Button>
    {message && <p className="wb-share-message" data-library-share-result>{message}</p>}
    </div>
    {mode && <Dialog open anchor={`library-${mode}`} width={mode === 'export' ? 680 : 520} busy={busy} title={mode === 'export' ? '导出模板与配色' : '导入分享包'} description={mode === 'export' ? '勾选需要分享的项目，打包为一个 ZIP 文件。' : '自动识别包内模板与配色，保存到本地。已有内容保留，同名项目另存为副本。'} onOpenChange={(value) => { if (!value && !busyRef.current) setMode(null) }} footer={mode === 'export' ? <><span className="wb-muted" data-share-selected-count>已选 {selected.length} 项</span><Button onClick={() => setMode(null)} disabled={busy}>取消</Button><Button variant="primary" data-share-export-confirm onClick={() => void exportZip()} disabled={busy || loading || !selected.length}>{busy ? '正在打包…' : '导出 ZIP'}</Button></> : <Button onClick={() => setMode(null)} disabled={busy}>关闭</Button>}>
      {error && <p className="wb-error" role="alert" data-share-error>{error}</p>}
      {mode === 'export' ? <div className="wb-share-export">
        <div className="wb-share-filters"><div className="wb-share-kind" data-share-kind><Select ariaLabel="分享内容类型" value={filter} disabled={busy} onChange={(value) => setFilter(value as Kind | 'all')} options={[{ value: 'all', label: '模板和配色' }, { value: 'templates', label: '模板' }, { value: 'palettes', label: '配色方案' }]} /></div><TextInput data-share-search disabled={busy} aria-label="搜索分享项目" placeholder="搜索名称…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <div className="wb-share-select-all"><Button data-share-select-all onClick={toggleVisible} disabled={busy || loading || !visible.length}>全选 / 取消当前列表</Button><span className="wb-muted">{visible.length} 项</span></div>
        <div className="wb-share-list">{visible.map((item) => <label className={`wb-share-row ${selected.includes(item.key) ? 'is-selected' : ''}`} key={item.key}>
          <Checkbox aria-label={`选择 ${item.name}`} data-share-item={item.key} checked={selected.includes(item.key)} onChange={() => toggle(item.key)} disabled={busy} />
          {item.preview && <img src={item.preview} alt="" loading="lazy" />}
          {item.colors && <span className="wb-share-swatches">{item.colors.slice(0, 12).map((color, index) => <i key={index} style={{ backgroundColor: color }} />)}</span>}
          <span className="wb-share-item-name"><strong>{item.name}</strong><small>{item.detail}</small></span>
        </label>)}{loading ? <p className="wb-muted">正在读取模板与配色…</p> : !visible.length && <p className="wb-muted">没有匹配的项目。</p>}</div>
      </div> : <div className="wb-share-import">
        <label className="wb-field">模板存放位置<Select ariaLabel="导入模板存放位置" value={scope} disabled={busy} onChange={(value) => setScope(value as 'global' | 'project')} options={[{ value: 'global', label: '全局模板库 · 所有项目可用' }, ...(projectId ? [{ value: 'project', label: '当前项目模板库' }] : [])]} /></label>
        <input hidden ref={upload} type="file" accept=".zip,application/zip" data-share-file onChange={(event) => { void importZip(event.target.files?.[0]); event.currentTarget.value = '' }} />
        <div data-share-drop className={`wb-share-drop ${dragging ? 'is-dragging' : ''}`} aria-busy={busy} onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length !== 1) { setError('请一次拖入一个 ZIP 分享文件。'); return }; void importZip(event.dataTransfer.files[0]) }}>
          <Upload /><strong>{busy ? '正在解析并保存…' : '拖入 ZIP 分享文件'}</strong><span className="wb-muted">支持模板、配色或混合分享包</span><Button variant="primary" data-share-file-trigger disabled={busy} onClick={() => upload.current?.click()}>选择 ZIP 文件</Button>
        </div><p className="wb-muted">配色保存到配色库；模板保留分享预览，首次保存前需运行验证。</p>
      </div>}
    </Dialog>}
  </>
}
