import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { RefreshCw, Trash2 } from '@/components/ui/icons'
import { errorText, post } from './api'
import { formatDateTime } from './dateTime'

interface TrashItem { id: string; name?: string; kind?: string; deleted_at?: string; deletion_pending?: boolean }
export function TrashPanel({ items, root, refresh, onRestored }: { items: TrashItem[]; root: string; refresh: () => Promise<void>; onRestored: () => Promise<void> }) {
  const [selected, setSelected] = useState<TrashItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function purge() {
    if (!selected || busy) return
    setBusy(true); setError('')
    try {
      const result = await post<{ deleted: string[]; failed: { id: string; message: string }[] }>('/trash/delete', { library_root: root, ids: selected.map((item) => item.id) })
      setSelected(null); await refresh()
      if (result.failed.length) setError(`已删除 ${result.deleted.length} 项；${result.failed.length} 项未完成：${result.failed.map((item) => item.message).join('；')}`)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <>
    <div className="wb-page-heading"><div><h1>回收站</h1><p>恢复已删除的项目、图和模板，或永久删除。</p></div><div className="wb-toolbar"><Button disabled={busy} variant="secondary" onClick={() => void refresh()}><RefreshCw />刷新</Button><Button data-wb-trash-empty variant="danger" disabled={busy || !items.length} onClick={() => setSelected([...items])}><Trash2 />清空回收站</Button></div></div>
    {error && <p className="wb-error" role="alert">{error}</p>}
    <div className="wb-trash-list">{items.map((item) => <div key={item.id} data-wb-trash-item={item.id}><Trash2 /><strong>{item.name ?? item.id}</strong><span className="wb-muted">{item.kind === 'project' ? '项目' : item.kind === 'plot' ? '图' : '模板'}</span><time className="wb-muted" dateTime={item.deleted_at}>{formatDateTime(item.deleted_at)}</time><Button variant="secondary" disabled={busy || item.deletion_pending} onClick={async () => { setBusy(true); setError(''); try { await post(`/trash/${item.id}/restore`); await onRestored(); await refresh() } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }}>恢复</Button><Button data-wb-trash-delete variant="danger" disabled={busy} onClick={() => setSelected([item])}>{item.deletion_pending ? '重试删除' : '永久删除'}</Button></div>)}</div>
    {!items.length && <div className="wb-empty-state"><Trash2 /><h2>回收站是空的</h2><p>已删除的内容可在此恢复。</p></div>}
    {selected && <Dialog open title={selected.length === 1 ? '永久删除此项目？' : `清空 ${selected.length} 个项目？`} description="永久删除后无法恢复。只清理本次列出的回收站内容，外部项目的原始文件不受影响。" busy={busy} anchor="workbench-trash-delete" onOpenChange={(open) => { if (!open && !busy) setSelected(null) }} footer={<><Button disabled={busy} onClick={() => setSelected(null)}>取消</Button><Button data-wb-trash-confirm variant="danger" disabled={busy} onClick={() => void purge()}>{busy ? '正在删除…' : '永久删除'}</Button></>}><ul>{selected.map((item) => <li key={item.id}>{item.name ?? item.id}</li>)}</ul></Dialog>}
  </>
}
