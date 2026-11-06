import { CodeComparison, type Comparison } from './CodeComparison'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Select } from '@/components/ui/Select'
import { RotateCcwClock } from '@/components/ui/icons'
import { api, errorText, post, type Plot, type Template } from './api'
import { useWorkspace } from './Recovery'
import { formatDateTime } from './dateTime'

interface Version { revision: number; updated_at?: string; legacy: boolean; pending: boolean; outputs: { stem: string; title: string; preview_url: string }[]; data_rows: number; data_columns: number }
export function HistoryButton({ kind, entity, onRestored }: { kind: 'plot' | 'template'; entity: Plot | Template; onRestored: (value: Plot | Template) => void }) {
  const [open, setOpen] = useState(false)
  return <><Button variant="secondary" disabled={!entity.revision} data-wb-history-open onClick={() => setOpen(true)}><RotateCcwClock />版本历史</Button>{open && <HistoryDialog kind={kind} entity={entity} onClose={() => setOpen(false)} onRestored={onRestored} />}</>
}
function HistoryDialog({ kind, entity, onClose, onRestored }: { kind: 'plot' | 'template'; entity: Plot | Template; onClose: () => void; onRestored: (value: Plot | Template) => void }) {
  const workspace = useWorkspace()
  const [versions, setVersions] = useState<Version[]>([])
  const [currentRevision, setCurrentRevision] = useState(entity.revision)
  const [selected, setSelected] = useState<Version | null>(null)
  const [record, setRecord] = useState<{ code: string; display_code?: string; comparison?: Comparison; graph_comparison?: Comparison; current_revision?: number; current_outputs?: { stem: string; preview_url: string }[]; data?: { row_count: number; column_count: number } } | null>(null)
  const [view, setView] = useState<'figure' | 'code'>('figure')
  const [stem, setStem] = useState('figure')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selection = useRef(0)
  const route = `/history/${kind}/${entity.id}`
  useEffect(() => {
    let live = true
    void api<{ current_revision: number; versions: Version[] }>(route).then((result) => { if (live) { setVersions(result.versions); setCurrentRevision(result.current_revision) } }).catch((e) => { if (live) setError(errorText(e)) })
    return () => { live = false; selection.current++ }
  }, [route])
  async function choose(version: Version) {
    const seq = ++selection.current; setSelected(version); setRecord(null); setError(''); setStem(version.outputs[0]?.stem ?? 'figure')
    try { const next = await api<{ code: string }>(`${route}/${version.revision}`); if (seq === selection.current) setRecord(next) }
    catch (e) { if (seq === selection.current) setError(errorText(e)) }
  }
  async function restore() {
    if (!selected) return
    setBusy(true); setError('')
    try {
      await workspace.flushAll()
      const value = await post<Plot | Template>(`${route}/${selected.revision}/restore`, { library_root: workspace.root, current_revision: currentRevision })
      onRestored(value); onClose()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const previous = selected?.outputs.find((o) => o.stem === stem)
  const current = (record?.current_outputs ?? entity.outputs)?.find((o) => o.stem === stem)?.preview_url ?? (stem === 'figure' ? entity.preview_url : undefined)
  return <Dialog open title={`${entity.name} · 版本历史`} description="查看历史预览、代码和数据规模。恢复会创建独立副本，重新验证后保存，原图或模板保持完整。" width={1040} anchor="workbench-history" busy={busy} onOpenChange={(v) => { if (!v) onClose() }} footer={<><Button onClick={onClose} disabled={busy}>关闭</Button><Button variant="primary" disabled={busy || !selected || !record} onClick={() => void restore()} data-wb-history-restore>恢复为待验证副本</Button></>}>
    {error && <p className="wb-error" role="alert">{error}</p>}
    <div className="wb-history-layout"><aside className="wb-history-sidebar"><div className="wb-history-list-heading"><strong>已保存版本</strong><span>{versions.length} 个</span></div><ol className="wb-history-versions">{versions.map((version) => <li key={version.revision}><Button className="wb-history-version" active={selected?.revision === version.revision} aria-pressed={selected?.revision === version.revision} disabled={busy} onClick={() => void choose(version)} data-wb-history-version={version.revision}><span className="wb-history-revision">r{version.revision}</span><span className="wb-history-version-info"><span>{version.pending ? '待验证副本' : version.legacy ? '旧版历史存档' : '已保存'}{version.revision === currentRevision && <small className="wb-history-current">当前版本</small>}</span><time dateTime={version.updated_at}>{formatDateTime(version.updated_at)}</time></span></Button></li>)}</ol>{!versions.length && <p className="wb-muted">还没有历史版本。</p>}</aside>
    <div className="wb-history-detail">{selected ? <><div className="wb-toolbar"><div data-wb-history-view><Select ariaLabel="历史对比内容" value={view} onChange={(v) => setView(v as 'figure' | 'code')} options={[{ value: 'figure', label: '图形对比' }, { value: 'code', label: '代码对比' }]} /></div>{view === 'figure' && <Select ariaLabel="历史图形" value={stem} onChange={setStem} options={selected.outputs.map((o) => ({ value: o.stem, label: o.title || o.stem }))} />}</div><p className="wb-muted">历史数据：{selected.data_rows} 行 × {selected.data_columns} 列；当前数据：{entity.data?.row_count ?? 0} 行 × {entity.data?.column_count ?? 0} 列</p>{view === 'code' ? record ? <div data-wb-history-code><CodeComparison value={record.comparison ?? { before: record.display_code ?? record.code, after: ('base_code' in entity ? entity.base_code : undefined) ?? entity.code, opcodes: [['replace', 0, (record.display_code ?? record.code).split('\n').length, 0, entity.code.split('\n').length]] }} beforeTitle={`历史 r${selected.revision}`} afterTitle={`当前 r${record.current_revision ?? currentRevision}`} />{record.graph_comparison && <details className="wb-graph-diff"><summary>图内编辑差异（样式、位置与坐标轴等）</summary><CodeComparison value={record.graph_comparison} beforeTitle="历史图内编辑" afterTitle="当前图内编辑" python={false} /></details>}</div> : <p>正在读取代码…</p> : <div className="wb-history-comparison"><section><h3>历史 r{selected.revision}</h3>{previous ? <img src={previous.preview_url} alt={`历史版本 r${selected.revision}`} /> : <p>此版本没有该图形。</p>}</section><section><h3>当前 r{record?.current_revision ?? currentRevision}</h3>{current ? <img src={current} alt="当前版本" /> : <p>当前版本没有该图形。</p>}</section></div>}<p className="wb-muted">历史预览仅供比较。恢复和查看均不自动执行脚本。</p></> : <p className="wb-muted">选择左侧版本进行比较。</p>}</div></div>
  </Dialog>
}
