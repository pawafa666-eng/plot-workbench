import { useEffect, useRef, useState } from 'react'
import { Button, IconButton } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { Plus, Trash2, Upload, RefreshCw } from '@/components/ui/icons'
import { api, errorText, post, type Snapshot } from './api'
import { expandRanges, type Range } from './model'

function cellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    const tag = value as { $type?: string; value?: unknown }
    if (tag.$type) return tag.$type === 'null' || tag.$type === 'nan' ? '' : String(tag.value ?? tag.$type)
    return JSON.stringify(value)
  }
  return String(value)
}
export function DataTable({ data, caption = '数据预览' }: { data: Snapshot | null; caption?: string }) {
  if (!data) return <div className="wb-empty-inline">尚未导入数据</div>
  return <section className="wb-table-panel" data-wb-data-preview>
    <div className="wb-table-caption"><strong>{caption}</strong><span>{data.row_count} 行 × {data.column_count} 列<span className="wb-muted"> · 最多预览 50 × 50</span></span></div>
    <div className="wb-table-scroll"><table><thead><tr><th className="wb-row-number">#</th>{data.columns.slice(0, 50).map((c, i) => <th key={i} title={String(c)}>{String(c)}</th>)}</tr></thead>
      <tbody>{data.values.slice(0, 50).map((row, i) => <tr key={i}><th className="wb-row-number">{data.row_sources?.[i] ?? i + 1}</th>{row.slice(0, 50).map((v, j) => <td key={j} title={cellText(v)}>{cellText(v)}</td>)}</tr>)}</tbody></table></div>
  </section>
}
export function DataWizard({ onClose, onImport }: { onClose: () => void; onImport: (data: Snapshot) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [sheet, setSheet] = useState('')
  const [encoding, setEncoding] = useState('utf-8')
  const [delimiter, setDelimiter] = useState(',')
  const [sheets, setSheets] = useState<string[]>([])
  const [tableId, setTableId] = useState('')
  const [raw, setRaw] = useState<Snapshot | null>(null)
  const [selected, setSelected] = useState<Snapshot | null>(null)
  const [rows, setRows] = useState<Range[]>([{ start: 0, end: 0 }])
  const [columns, setColumns] = useState<Range[]>([{ start: 0, end: 0 }])
  const [header, setHeader] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!file) return
    let active = true
    setSelected(null); setTableId(''); setBusy(true); setError('')
    const form = new FormData(); form.set('file', file); form.set('encoding', encoding); form.set('delimiter', delimiter)
    if (sheet) form.set('sheet', sheet)
    void api<{ table_id: string; sheets: (string | { name: string })[]; row_count: number; column_count: number; preview: Snapshot }>('/data/inspect', { method: 'POST', body: form }).then((r) => {
      if (!active) return
      setTableId(r.table_id); setSheets((r.sheets ?? []).map((s) => typeof s === 'string' ? s : s.name))
      setRaw({ ...r.preview, row_count: r.row_count, column_count: r.column_count })
    }).catch((e) => { if (active) setError(errorText(e)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [file, sheet, encoding, delimiter])
  useEffect(() => {
    if (!tableId || !raw) return
    let active = true
    setSelected(null); setError(''); setBusy(false)
    try { expandRanges(rows, raw.row_count); expandRanges(columns, raw.column_count) }
    catch (e) { setError(errorText(e)); return }
    const timer = setTimeout(() => {
      setBusy(true)
      void post<{ data: Snapshot; preview: Snapshot }>('/data/select', { table_id: tableId, rows, columns, header }).then((r) => {
        if (active) setSelected(r.data)
      }).catch((e) => { if (active) setError(errorText(e)) }).finally(() => { if (active) setBusy(false) })
    }, 180)
    return () => { active = false; clearTimeout(timer) }
  }, [tableId, raw, rows, columns, header])
  const isCsv = file ? /\.csv$/i.test(file.name) : false
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }} title="导入表格数据" description="Excel / CSV · 独立选择行列范围" width={1120} height="720px" chrome="shell" anchor="workbench-data-import" footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!selected || busy || !!error} data-wb-import-confirm onClick={() => { if (selected) onImport(selected) }}>导入所选数据</Button></>}>
    <div className="wb-data-wizard">
      <aside className="wb-data-settings">
        <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" hidden data-wb-data-file onChange={(e) => { setFile(e.target.files?.[0] ?? null); setSheet(''); setRows([{ start: 0, end: 0 }]); setColumns([{ start: 0, end: 0 }]) }} />
        <Button variant="secondary" className="wb-wide" onClick={() => inputRef.current?.click()}><Upload />选择 Excel / CSV</Button>
        {file && <p className="wb-filename">{file.name}</p>}
        {sheets.length > 0 && <label className="wb-field">工作表<Select ariaLabel="工作表" value={sheet || sheets[0]} onChange={setSheet} options={sheets.map((s) => ({ value: s, label: s }))} /></label>}
        {isCsv && <><label className="wb-field">文件编码<Select ariaLabel="文件编码" value={encoding} onChange={setEncoding} options={[{ value: 'utf-8', label: 'UTF-8' }, { value: 'gb18030', label: 'GB18030 / GBK' }, { value: 'utf-16', label: 'UTF-16' }]} /></label><label className="wb-field">分隔符<Select ariaLabel="分隔符" value={delimiter} onChange={setDelimiter} options={[{ value: ',', label: '逗号 ,' }, { value: '\t', label: '制表符 Tab' }, { value: ';', label: '分号 ;' }, { value: '|', label: '竖线 |' }]} /></label></>}
        <RangeEditor title="行范围" value={rows} onChange={setRows} />
        <RangeEditor title="列范围" value={columns} onChange={setColumns} />
        <p className="wb-help">从 1 开始，包含起止位置。第一段起始 0 表示开头，最后一段结束 0 表示末尾；0 至 0 表示全部。多个范围按添加顺序合并，不能重叠。</p>
        <label className="wb-checkbox"><Checkbox checked={header} onChange={(e) => setHeader(e.target.checked)} />所选第一行作为表头</label>
      </aside>
      <div className="wb-data-preview"><div className="wb-preview-heading"><span>{selected ? '所选数据' : '原始表格'}</span>{busy && <span className="wb-muted">正在读取…</span>}</div>{error && <div className="wb-error" role="alert">{error}</div>}<DataTable data={selected ?? raw} caption="" />{!file && <div className="wb-data-empty"><Upload /><h3>把数据带到图里</h3><p>选择工作表，逐段截取需要的行和列。</p></div>}</div>
    </div>
  </Dialog>
}
function RangeEditor({ title, value, onChange }: { title: string; value: Range[]; onChange: (ranges: Range[]) => void }) {
  return <section className="wb-range-group"><div className="wb-section-heading"><strong>{title}</strong><IconButton label={`添加${title}`} tip={false} onClick={() => onChange([...value, { start: 1, end: 1 }])}><Plus /></IconButton></div>{value.map((range, index) => <div className="wb-range-row" key={index}>
    <TextInput type="number" min={0} aria-label={`${title}${index + 1}起始`} value={range.start} onChange={(e) => onChange(value.map((v, i) => i === index ? { ...v, start: Number(e.target.value) } : v))} />
    <span className="wb-muted">至</span><TextInput type="number" min={0} aria-label={`${title}${index + 1}结束`} value={range.end} onChange={(e) => onChange(value.map((v, i) => i === index ? { ...v, end: Number(e.target.value) } : v))} />
    <IconButton label={`删除${title}${index + 1}`} tip={false} disabled={value.length === 1} onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 /></IconButton>
  </div>)}</section>
}
export function DataTransform({ data, onChange, disabled }: { data: Snapshot; onChange: (data: Snapshot) => void; disabled?: boolean }) {
  const [i, setI] = useState(1); const [j, setJ] = useState(2); const [error, setError] = useState('')
  async function transform(operation: 'transpose' | 'swap_rows' | 'swap_columns') {
    setError('')
    try { const result = await post<{ data: Snapshot }>('/data/transform', { data, operation, i, j }); onChange(result.data) }
    catch (e) { setError(errorText(e)) }
  }
  return <div className="wb-data-transform"><div className="wb-toolbar"><span className="wb-muted">交换</span><TextInput type="number" min={1} aria-label="第一个位置" value={i} onChange={(e) => setI(Number(e.target.value))} disabled={disabled} /><span>与</span><TextInput type="number" min={1} aria-label="第二个位置" value={j} onChange={(e) => setJ(Number(e.target.value))} disabled={disabled} /><Button disabled={disabled} onClick={() => transform('swap_rows')}>交换行</Button><Button disabled={disabled} onClick={() => transform('swap_columns')}>交换列</Button><Button disabled={disabled} onClick={() => transform('transpose')}><RefreshCw />转置</Button></div>{error && <p className="wb-error" role="alert">{error}</p>}</div>
}
